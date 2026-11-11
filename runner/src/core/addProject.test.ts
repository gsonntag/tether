import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRepo } from "../../../shared/repo";
import { CloneJobs, listFolders, readProgress } from "./addProject";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((f) => f()));
const scratch = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "addproj-")));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
};
const git = (...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
};

describe("parseRepo", () => {
  test.each([
    "acme/widget",
    " acme/widget.git ",
    "github.com/acme/widget",
    "https://github.com/acme/widget",
    "https://github.com/acme/widget.git",
    "https://www.github.com/acme/widget/",
    "git@github.com:acme/widget",
    "git@github.com:acme/widget.git",
    "ssh://git@github.com/acme/widget.git",
  ])("clones over SSH: %s", (input) => expect(parseRepo(input)).toEqual({ url: "git@github.com:acme/widget.git", org: "acme", name: "widget" }));

  test.each(["", "widget", "acme/../x", "acme/.git", "-acme/w", "acme/-w", "gitlab.com/acme/widget", "git@gitlab.com:acme/widget.git", "acme/widget; rm -rf ~", "-c core.sshCommand=x acme/w", "ext::sh -c x/y"])(
    "refuses %p",
    (input) => expect(() => parseRepo(input)).toThrow("Not a GitHub repo"),
  );
});

describe("listFolders", () => {
  test("folders and links to folders, by name, no dot folders or files", () => {
    const d = scratch();
    for (const n of ["b", "A", "c10", "c9", ".hidden"]) mkdirSync(join(d, n));
    writeFileSync(join(d, "file.txt"), "");
    symlinkSync(join(d, "b"), join(d, "link"));
    symlinkSync(join(d, "nowhere"), join(d, "dangling"));
    expect(listFolders(d)).toEqual({ path: d, parent: realpathSync(join(d, "..")), folders: ["A", "b", "c9", "c10", "link"] });
  });

  test("the parent is the folder above; / has none", () => {
    const d = scratch();
    expect(listFolders(d).parent).toBe(realpathSync(join(d, "..")));
    expect(listFolders("/").parent).toBeUndefined();
  });

  test("errors say what's wrong", () => {
    const d = scratch();
    writeFileSync(join(d, "f"), "");
    expect(() => listFolders(join(d, "nope"))).toThrow("doesn't exist");
    expect(() => listFolders(join(d, "f"))).toThrow("isn't a folder");
    expect(() => listFolders("code")).toThrow("full path");
  });
});

describe("cloneRepo", () => {
  /** git@github.com:acme/<x>.git is read from a local bare repo instead of GitHub */
  const fakeGitHub = () => {
    const root = scratch();
    const src = join(root, "src");
    git("init", "-q", "-b", "main", src);
    writeFileSync(join(src, "README"), "hi");
    git("-C", src, "add", ".");
    git("-C", src, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "first");
    mkdirSync(join(root, "acme"));
    git("clone", "-q", "--bare", src, join(root, "acme", "widget.git"));
    const saved = { ...process.env };
    Object.assign(process.env, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.${root}/.insteadOf`, GIT_CONFIG_VALUE_0: "git@github.com:" });
    cleanups.push(() => {
      for (const k of ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"]) delete process.env[k];
      Object.assign(process.env, saved);
    });
    return root;
  };

  /** git@github.com: never answers: a command that sleeps stands in for it (git's ext transport) */
  const stalledGitHub = () => {
    const root = scratch();
    writeFileSync(join(root, "slow.sh"), "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 });
    Object.assign(process.env, { GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: `url.ext::${root}/slow.sh .insteadOf`, GIT_CONFIG_VALUE_0: "git@github.com:", GIT_CONFIG_KEY_1: "protocol.ext.allow", GIT_CONFIG_VALUE_1: "always" });
    cleanups.push(() => void ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "GIT_CONFIG_KEY_1", "GIT_CONFIG_VALUE_1"].forEach((k) => delete process.env[k]));
  };

  /** clones and waits for the end, like the dialog's polling */
  const clone = async (repo: string, path: string, jobs = new CloneJobs()) => {
    const { cloneId } = jobs.start(repo, path);
    for (let i = 0; i < 400; i++) {
      const st = jobs.status(cloneId);
      if (st.state !== "running") return st;
      await Bun.sleep(25);
    }
    throw new Error("clone never ended");
  };

  test("clones into a new folder, making its parents", async () => {
    fakeGitHub();
    const dest = join(scratch(), "projects", "widget");
    expect(await clone("https://github.com/acme/widget", dest)).toEqual({ state: "done", path: dest, percent: 100 });
    expect(existsSync(join(dest, "README"))).toBe(true);
  });

  test("a folder already holding the same repo is done at once", async () => {
    fakeGitHub();
    const dest = join(scratch(), "widget");
    await clone("acme/widget", dest);
    git("-C", dest, "remote", "set-url", "origin", "https://github.com/acme/widget");
    const jobs = new CloneJobs();
    expect(jobs.status(jobs.start("acme/widget", dest).cloneId)).toEqual({ state: "done", path: dest, percent: 100 });
  });

  test("a folder whose origin is an alias git rewrites to the repo (url.<x>.insteadOf) is the same repo", async () => {
    fakeGitHub();
    const dest = join(scratch(), "widget");
    await clone("acme/widget", dest);
    git("-C", dest, "remote", "set-url", "origin", "gh:acme/widget");
    git("-C", dest, "config", "url.https://github.com/.insteadOf", "gh:");
    const jobs = new CloneJobs();
    expect(jobs.status(jobs.start("acme/widget", dest).cloneId)).toEqual({ state: "done", path: dest, percent: 100 });
  });

  test("what an interrupted clone left is cloned again, not taken as done", async () => {
    fakeGitHub();
    const dest = join(scratch(), "widget");
    // A killed clone: .git already points at the repo, nothing fetched or checked out.
    git("init", "-q", dest);
    git("-C", dest, "remote", "add", "origin", "git@github.com:acme/widget.git");
    expect(await clone("acme/widget", dest)).toEqual({ state: "done", path: dest, percent: 100 });
    expect(existsSync(join(dest, "README"))).toBe(true);
  });

  test("a clone killed while checking out (no index yet) is cloned again", async () => {
    fakeGitHub();
    const dest = join(scratch(), "widget");
    await clone("acme/widget", dest);
    rmSync(join(dest, ".git", "index"));
    rmSync(join(dest, "README"));
    expect(await clone("acme/widget", dest)).toMatchObject({ state: "done" });
    expect(existsSync(join(dest, "README"))).toBe(true);
  });

  test("refuses an existing folder that is something else, before starting", () => {
    const dest = scratch();
    expect(() => new CloneJobs().start("acme/widget", dest)).toThrow("already exists");
    expect(existsSync(dest)).toBe(true);
  });

  test("a failed clone says why and leaves nothing behind", async () => {
    fakeGitHub();
    const dest = join(scratch(), "missing");
    const st = await clone("acme/missing", dest);
    expect(st.state).toBe("failed");
    expect(st.error).toContain("git clone git@github.com:acme/missing.git failed");
    expect(existsSync(dest)).toBe(false);
  });

  test("cancel stops a clone and removes what it wrote", async () => {
    stalledGitHub();
    const jobs = new CloneJobs();
    const dest = join(scratch(), "widget");
    const { cloneId } = jobs.start("acme/widget", dest);
    await Bun.sleep(200);
    expect(jobs.status(cloneId).state).toBe("running");
    expect(() => jobs.start("acme/widget", dest)).toThrow("already being cloned");
    jobs.cancel(cloneId);
    expect(jobs.status(cloneId)).toMatchObject({ state: "failed", error: "Canceled." });
    for (let i = 0; i < 200 && existsSync(dest); i++) await Bun.sleep(25);
    expect(existsSync(dest)).toBe(false);
  });

  test("a clone that runs too long is stopped", async () => {
    stalledGitHub();
    const dest = join(scratch(), "w");
    const st = await clone("acme/widget", dest, new CloneJobs({ timeoutMs: 300 }));
    expect(st).toMatchObject({ state: "failed" });
    expect(st.error).toContain("took over");
    expect(existsSync(dest)).toBe(false);
  });

  test("running clones are listed with their repo, finished ones aren't", async () => {
    stalledGitHub();
    const jobs = new CloneJobs();
    const dest = join(scratch(), "widget");
    const { cloneId } = jobs.start(" acme/widget ", dest);
    expect(jobs.active()).toEqual([{ cloneId, repo: "acme/widget", status: expect.objectContaining({ state: "running", path: dest }) }]);
    jobs.cancel(cloneId);
    expect(jobs.active()).toEqual([]);
  });

  test("refuses a relative path", () => {
    expect(() => new CloneJobs().start("acme/widget", "projects/widget")).toThrow("full path");
  });
});

describe("readProgress", () => {
  test("phases map onto one bar", () => {
    expect(readProgress("Receiving objects:  40% (4/10), 1.00 MiB | 2.00 MiB/s")).toEqual({ phase: "Receiving objects", percent: 30, detail: "1.00 MiB · 2.00 MiB/s" });
    expect(readProgress("Resolving deltas: 100% (3/3), done.")).toEqual({ phase: "Resolving deltas", percent: 90 });
    expect(readProgress("Receiving objects: 100% (3/3), 10.96 MiB | 1.55 MiB/s, done.")).toMatchObject({ detail: "10.96 MiB · 1.55 MiB/s" });
    expect(readProgress("Updating files:  50% (1/2)")).toEqual({ phase: "Updating files", percent: 95 });
    expect(readProgress("remote: Counting objects:  12% (1/8)")).toEqual({ phase: "Counting objects" });
    expect(readProgress("Cloning into 'x'...")).toBeUndefined();
    expect(readProgress("fatal: repository not found")).toBeUndefined();
  });
});
