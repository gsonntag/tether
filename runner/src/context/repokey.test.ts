import { HOME } from "./testenv";
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeDirCwd, claudeDirName, decodeDirName, isHome, keyDir, normalizeRemote, repoKey } from "./repokey";

const sh = async (cwd: string, ...cmd: string[]) => {
  const p = Bun.spawn(cmd, { cwd, stdout: "ignore", stderr: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  if ((await p.exited) !== 0) throw new Error(`${cmd.join(" ")}: ${await new Response(p.stderr).text()}`);
};

describe("repo keys", () => {
  test("remote URLs normalize to host/path", () => {
    expect(normalizeRemote("git@github.com:Foo/bar.git")).toBe("github.com/Foo/bar");
    expect(normalizeRemote("https://github.com/Foo/bar.git")).toBe("github.com/Foo/bar");
    expect(normalizeRemote("https://user:tok@GitHub.com/Foo/bar/")).toBe("github.com/Foo/bar");
    expect(normalizeRemote("ssh://git@github.com:22/Foo/bar.git")).toBe("github.com/Foo/bar");
    expect(normalizeRemote("git://example.org/x.git")).toBe("example.org/x");
  });

  test("a repo with a remote keys by the remote; its worktrees share the key", async () => {
    const repo = join(HOME, "proj-remote");
    mkdirSync(repo, { recursive: true });
    await sh(repo, "git", "init", "-q", "-b", "main");
    await sh(repo, "git", "remote", "add", "origin", "git@github.com:me/proj.git");
    await sh(repo, "git", "commit", "-q", "--allow-empty", "-m", "x");
    await sh(repo, "git", "worktree", "add", "-q", join(HOME, "proj-remote-wt", "a"));
    expect(await repoKey(repo)).toBe("github.com/me/proj");
    expect(await repoKey(join(HOME, "proj-remote-wt", "a"))).toBe("github.com/me/proj");
  });

  test("without a remote: the main checkout's path, also from a worktree and a subdir", async () => {
    const repo = join(HOME, "proj-local");
    mkdirSync(join(repo, "sub"), { recursive: true });
    await sh(repo, "git", "init", "-q", "-b", "main");
    await sh(repo, "git", "commit", "-q", "--allow-empty", "-m", "x");
    await sh(repo, "git", "worktree", "add", "-q", join(HOME, "proj-local-wt"));
    expect(await repoKey(repo)).toBe(repo);
    expect(await repoKey(join(HOME, "proj-local-wt"))).toBe(repo);
    expect(await repoKey(join(repo, "sub"))).toBe(repo);
  });

  test("paths that aren't repos, or no longer exist, key by the path", async () => {
    const plain = join(HOME, "plain");
    mkdirSync(plain, { recursive: true });
    expect(await repoKey(plain)).toBe(plain);
    expect(await repoKey(join(HOME, "gone", "x"))).toBe(join(HOME, "gone", "x"));
  });

  test("key dirs are filename-safe", () => {
    expect(keyDir("github.com/me/proj")).toBe("github.com-me-proj");
    expect(keyDir("/home/u/my proj")).toBe("home-u-my-proj");
  });

  test("Claude project dir names decode against the filesystem", () => {
    const p = join(HOME, "web-coder", ".claude", "worktrees", "agent-1");
    mkdirSync(p, { recursive: true });
    expect(claudeDirName(p)).toBe(p.replace(/[/.]/g, "-"));
    expect(decodeDirName(claudeDirName(p))).toBe(p);
    expect(decodeDirName("-nope-a-b")).toBe("/nope/a/b");
  });

  test("Claude project dirs prefer the cwd recorded in a transcript", () => {
    const dir = join(HOME, ".claude", "projects", "-x-y");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "s.jsonl"), `{"type":"user","cwd":"/real/path-with-dash","message":{}}\n`);
    expect(claudeDirCwd(dir)).toBe("/real/path-with-dash");
  });

  test("home is the global scope", () => {
    expect(isHome(HOME)).toBe(true);
    expect(isHome(join(HOME, "x"))).toBe(false);
  });
});
