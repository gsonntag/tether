import { HOME } from "./testenv";
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeDirCwd, claudeDirName, claudeProjectScope, decodeDirName, isHome, keyDir, normalizeRemote, repoKey } from "./repokey";

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
    // Mixed separators inside one segment, and underscores.
    const q = join(HOME, "my-app.v2_x", "sub");
    mkdirSync(q, { recursive: true });
    expect(decodeDirName(claudeDirName(q))).toBe(q);
    // Nothing on disk matches: no guess (it used to answer "/nope/a/b").
    expect(decodeDirName("-nope-a-b")).toBeUndefined();
  });

  test("Claude project dirs prefer a transcript cwd that encodes to the dir's name", () => {
    const dir = join(HOME, ".claude", "projects", "-real-path-with-dash");
    mkdirSync(dir, { recursive: true });
    // The session cd'd somewhere else first: that cwd doesn't produce this name and is ignored.
    writeFileSync(join(dir, "s.jsonl"), `{"type":"user","cwd":"/elsewhere"}\n{"type":"user","cwd":"/real/path-with-dash","message":{}}\n`);
    expect(claudeDirCwd(dir)).toBe("/real/path-with-dash");
  });

  test("scope of a Claude project dir: home is global by name, unknown dirs get an opaque key", async () => {
    const projects = join(HOME, ".claude", "projects");
    // The home dir's project, with no transcript and whatever HOME looks like.
    expect(await claudeProjectScope(join(projects, claudeDirName(HOME)))).toEqual({ kind: "global" });
    // A dir that can't be decoded and has no transcript: its own key, never global.
    const gone = await claudeProjectScope(join(projects, "-home-someone-web-coder"));
    expect(gone).toEqual({ kind: "repo", key: "claude-project:-home-someone-web-coder" });
    expect(await claudeProjectScope(join(projects, "-tmp-claude-1001--home-x-scratchpad"))).toEqual({ kind: "scratch" });
    // A dir that does exist decodes to its path (dashes kept).
    const real = join(HOME, "web-coder");
    mkdirSync(real, { recursive: true });
    expect(await claudeProjectScope(join(projects, claudeDirName(real)))).toMatchObject({ kind: "repo", key: real });
  });

  test("`-home-ubuntu` is global for HOME=/home/ubuntu, and a home with a dot stays global", async () => {
    const saved = process.env.HOME;
    try {
      for (const h of ["/home/ubuntu", "/home/first.last", "/Users/a_b"]) {
        process.env.HOME = h;
        // decided from the name alone: nothing is read or written under h
        expect(await claudeProjectScope(join("/nonexistent-projects", claudeDirName(h)))).toEqual({ kind: "global" });
      }
      process.env.HOME = "/home/first.last";
      expect(claudeDirName("/home/first.last")).toBe("-home-first-last");
    } finally {
      process.env.HOME = saved;
    }
  });

  test("home is the global scope", () => {
    expect(isHome(HOME)).toBe(true);
    expect(isHome(join(HOME, "x"))).toBe(false);
  });
});
