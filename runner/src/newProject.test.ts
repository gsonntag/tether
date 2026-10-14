import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkName, checkOwner, createProject, type Run } from "./newProject";

describe("checkName", () => {
  test("keeps GitHub-safe names", () => {
    expect(checkName("  email-reply ")).toBe("email-reply");
    expect(checkName("my_app.v2")).toBe("my_app.v2");
  });
  test("refuses paths, spaces and dot names", () => {
    for (const bad of ["", "a/b", "my app", ".hidden", "..", "x;rm"]) expect(() => checkName(bad)).toThrow("can't be a project name");
  });
  test("refuses what gh would read as a flag, names over 100 and .git names", () => {
    for (const bad of ["--help", "-x", "a".repeat(101), "site.git", "Site.GIT"]) expect(() => checkName(bad)).toThrow("can't be a project name");
    expect(checkName("a".repeat(100))).toHaveLength(100);
    expect(checkName("git-tools")).toBe("git-tools");
  });
});

describe("checkOwner", () => {
  test("GitHub logins and orgs only", () => {
    expect(checkOwner("acme-corp")).toBe("acme-corp");
    for (const bad of ["", "-acme", "--help", "acme/x", "ac me", "acme_corp", "a".repeat(40)]) expect(() => checkOwner(bad)).toThrow("isn't a GitHub");
  });
});

/** git for real; gh answers from `gh`, keyed by its subcommand ("repo create", "repo view", "config get"). */
function fakeGh(gh: Record<string, (cmd: string[]) => string>): Run {
  return async (cmd, o) => {
    if (cmd[0] === "git") {
      const r = Bun.spawnSync(cmd, { cwd: o?.cwd });
      if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed`);
      return r.stdout.toString();
    }
    const f = gh[`${cmd[1]} ${cmd[2]}`];
    if (!f) throw new Error(`unexpected ${cmd.join(" ")}`);
    return f(cmd);
  };
}
const origin = (dir: string) => Bun.spawnSync(["git", "-C", dir, "remote", "get-url", "origin"]).stdout.toString().trim();

describe("createProject with GitHub", () => {
  const view = (isEmpty: boolean) => () => JSON.stringify({ url: "https://github.com/me/app", sshUrl: "git@github.com:me/app.git", isEmpty });
  const timedOut = () => {
    throw new Error("gh repo create failed: timed out");
  };

  test("gh made the repo but failed after: the folder stays, with origin added", async () => {
    const parent = mkdtempSync(join(tmpdir(), "tether-new-"));
    const dir = await createProject({ name: "app", parent, github: { private: true } }, fakeGh({ "repo create": timedOut, "repo view": view(true), "config get": () => "https\n" }));
    expect(origin(dir)).toBe("https://github.com/me/app.git");
  });

  test("ssh users get the ssh URL; an origin gh already set is kept", async () => {
    const parent = mkdtempSync(join(tmpdir(), "tether-new-"));
    const dir = await createProject({ name: "app", parent, github: { private: true } }, fakeGh({ "repo create": timedOut, "repo view": view(true), "config get": () => "ssh\n" }));
    expect(origin(dir)).toBe("git@github.com:me/app.git");
    const setThenFail = (cmd: string[]) => {
      Bun.spawnSync(["git", "-C", cmd[cmd.indexOf("--source") + 1]!, "remote", "add", "origin", "https://github.com/me/other.git"]);
      return timedOut();
    };
    const dir2 = await createProject({ name: "other", parent, github: { private: true } }, fakeGh({ "repo create": setThenFail, "repo view": view(true) }));
    expect(origin(dir2)).toBe("https://github.com/me/other.git");
  });

  test("no repo on GitHub: the folder is removed and gh's error stands", async () => {
    const parent = mkdtempSync(join(tmpdir(), "tether-new-"));
    const notFound = () => {
      throw new Error("Could not resolve to a Repository");
    };
    await expect(createProject({ name: "app", parent, github: { private: true } }, fakeGh({ "repo create": timedOut, "repo view": notFound }))).rejects.toThrow("timed out");
    expect(existsSync(join(parent, "app"))).toBe(false);
  });

  test("somebody's repo with commits isn't taken over", async () => {
    const parent = mkdtempSync(join(tmpdir(), "tether-new-"));
    await expect(createProject({ name: "app", parent, github: { private: true } }, fakeGh({ "repo create": timedOut, "repo view": view(false) }))).rejects.toThrow("already exists on GitHub");
    expect(existsSync(join(parent, "app"))).toBe(false);
  });

  test("a bad owner never reaches gh", async () => {
    const parent = mkdtempSync(join(tmpdir(), "tether-new-"));
    await expect(createProject({ name: "app", parent, github: { owner: "--help", private: true } }, fakeGh({}))).rejects.toThrow("isn't a GitHub");
    expect(existsSync(join(parent, "app"))).toBe(false);
  });
});

describe("createProject (no GitHub)", () => {
  test("makes parent/name with git init on main, creating the parent too", async () => {
    const parent = join(mkdtempSync(join(tmpdir(), "tether-new-")), "projects");
    const dir = await createProject({ name: "email-reply", parent });
    expect(dir).toBe(join(parent, "email-reply"));
    expect(existsSync(join(dir, ".git"))).toBe(true);
    expect(Bun.spawnSync(["git", "-C", dir, "symbolic-ref", "--short", "HEAD"]).stdout.toString().trim()).toBe("main");
  });
  test("an existing empty folder is fine; one with files is refused", async () => {
    const parent = mkdtempSync(join(tmpdir(), "tether-new-"));
    mkdirSync(join(parent, "empty"));
    expect(await createProject({ name: "empty", parent })).toBe(join(parent, "empty"));
    mkdirSync(join(parent, "full"));
    writeFileSync(join(parent, "full", "a.txt"), "x");
    await expect(createProject({ name: "full", parent })).rejects.toThrow("isn't empty");
  });
});
