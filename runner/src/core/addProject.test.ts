import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRepo } from "../../../shared/repo";
import { cloneRepo, listFolders } from "./addProject";

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

  test("clones into a new folder, making its parents", async () => {
    fakeGitHub();
    const dest = join(scratch(), "projects", "widget");
    expect(await cloneRepo("https://github.com/acme/widget", dest)).toEqual({ path: dest });
    expect(existsSync(join(dest, "README"))).toBe(true);
  });

  test("a folder already holding the same repo is used as it is", async () => {
    fakeGitHub();
    const dest = join(scratch(), "widget");
    await cloneRepo("acme/widget", dest);
    git("-C", dest, "remote", "set-url", "origin", "https://github.com/acme/widget");
    expect(await cloneRepo("acme/widget", dest)).toEqual({ path: dest });
  });

  test("refuses an existing folder that is something else", async () => {
    const dest = scratch();
    await expect(cloneRepo("acme/widget", dest)).rejects.toThrow("already exists");
    expect(existsSync(dest)).toBe(true);
  });

  test("a failed clone leaves nothing behind", async () => {
    fakeGitHub();
    const dest = join(scratch(), "missing");
    await expect(cloneRepo("acme/missing", dest)).rejects.toThrow("git clone git@github.com:acme/missing.git failed");
    expect(existsSync(dest)).toBe(false);
  });

  test("refuses a relative path", async () => {
    await expect(cloneRepo("acme/widget", "projects/widget")).rejects.toThrow("full path");
  });
});
