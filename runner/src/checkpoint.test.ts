import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// (the preloaded src/testenv.ts already points it at the shared scratch dir)
if (!process.env.TETHER_TEST_ROOT) process.env.TETHER_CONFIG_DIR = mkdtempSync(join(tmpdir(), "tether-ckpt-cfg-"));
const { computeDiff, diffStat, snapshot, workingTreeStats, DIFF_LIMITS } = await import("./checkpoint");
const { LiveSession } = await import("./session");

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function sh(cwd: string, ...args: string[]) {
  const p = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  if (p.exitCode !== 0) throw new Error(p.stderr.toString());
  return p.stdout.toString();
}

/** A repo with one commit: a.txt (3 lines), gone.txt, and a .gitignore for *.log. */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), "tether-ckpt-"));
  dirs.push(dir);
  sh(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "one\ntwo\nthree\n");
  writeFileSync(join(dir, "gone.txt"), "bye\n");
  writeFileSync(join(dir, ".gitignore"), "*.log\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-q", "-m", "init");
  return dir;
}

const w = (dir: string, f: string, s: string | Uint8Array) => writeFileSync(join(dir, f), s);
const byPath = (d: { files: { path: string }[] }) => Object.fromEntries(d.files.map((f) => [f.path, f]));

describe("computeDiff", () => {
  test("working tree against a checkpoint: modified, added (untracked), deleted; ignored files left out", async () => {
    const dir = repo();
    const cp = (await snapshot(dir, "refs/tether/checkpoints/t/1", "turn 1"))!;
    w(dir, "a.txt", "one\nTWO\nthree\nfour\n");
    w(dir, "new.txt", "hello\nworld\n");
    w(dir, "noise.log", "ignored\n");
    unlinkSync(join(dir, "gone.txt"));
    const statusBefore = sh(dir, "status", "--porcelain");

    const d = await computeDiff(dir, cp);
    expect(d.base).toBe("session");
    const f = byPath(d) as any;
    expect(Object.keys(f).sort()).toEqual(["a.txt", "gone.txt", "new.txt"]);
    expect(f["a.txt"]).toMatchObject({ status: "modified", additions: 2, deletions: 1 });
    expect(f["a.txt"].patch).toStartWith("@@");
    expect(f["a.txt"].patch).toContain("-two\n+TWO");
    expect(f["new.txt"]).toMatchObject({ status: "added", additions: 2, deletions: 0 });
    expect(f["gone.txt"]).toMatchObject({ status: "deleted", additions: 0, deletions: 1 });
    expect(d).toMatchObject({ fileCount: 3, additions: 4, deletions: 2, truncated: false });

    // Reading the diff never touches the user's index.
    expect(sh(dir, "status", "--porcelain")).toBe(statusBefore);
    expect(sh(dir, "diff", "--cached", "--name-only")).toBe("");
  });

  test("between two checkpoints shows only that turn; the latest turn runs to the working tree", async () => {
    const dir = repo();
    const c1 = (await snapshot(dir, "refs/tether/checkpoints/t/1", "turn 1"))!;
    w(dir, "first.txt", "1\n");
    const c2 = (await snapshot(dir, "refs/tether/checkpoints/t/2", "turn 2", c1))!;
    expect(c2).not.toBe(c1);
    w(dir, "second.txt", "2\n");
    w(dir, "a.txt", "one\n");

    expect(Object.keys(byPath(await computeDiff(dir, c1, c2)))).toEqual(["first.txt"]);
    expect(Object.keys(byPath(await computeDiff(dir, c2))).sort()).toEqual(["a.txt", "second.txt"]);
    expect(Object.keys(byPath(await computeDiff(dir, c1))).sort()).toEqual(["a.txt", "first.txt", "second.txt"]);

    expect(await diffStat(dir, c1, c2)).toEqual({ files: 1, additions: 1, deletions: 0 });
    expect(await workingTreeStats(dir, [c1, c2])).toEqual([
      { files: 3, additions: 2, deletions: 2 },
      { files: 2, additions: 1, deletions: 2 },
    ]);
  });

  test("an unchanged tree reuses the previous checkpoint", async () => {
    const dir = repo();
    const c1 = (await snapshot(dir, "refs/tether/checkpoints/t/1", "turn 1"))!;
    expect(await snapshot(dir, "refs/tether/checkpoints/t/2", "turn 2", c1)).toBe(c1);
    expect((await computeDiff(dir, c1)).files).toEqual([]);
  });

  test("binary files get a note instead of a patch", async () => {
    const dir = repo();
    const cp = (await snapshot(dir, "refs/tether/checkpoints/t/1", "turn 1"))!;
    w(dir, "logo.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1, 2, 3, 0, 255]));
    const f = byPath(await computeDiff(dir, cp))["logo.png"] as any;
    expect(f).toMatchObject({ status: "added", binary: true, patch: "", additions: 0, deletions: 0 });
  });

  test("huge files are skipped and long patches are cut at a line end", async () => {
    const dir = repo();
    const cp = (await snapshot(dir, "refs/tether/checkpoints/t/1", "turn 1"))!;
    w(dir, "many.txt", Array.from({ length: DIFF_LIMITS.fileLines + 10 }, (_, i) => `line ${i}`).join("\n") + "\n");
    w(dir, "wide.txt", Array.from({ length: 200 }, (_, i) => `${i} ${"x".repeat(1000)}`).join("\n") + "\n");
    const d = await computeDiff(dir, cp);
    const f = byPath(d) as any;
    expect(f["many.txt"].patch).toBe("");
    expect(f["many.txt"].skipped).toContain("too many");
    expect(f["many.txt"].additions).toBe(DIFF_LIMITS.fileLines + 10);
    expect(f["wide.txt"].truncated).toBe(true);
    expect(f["wide.txt"].patch.length).toBeLessThanOrEqual(DIFF_LIMITS.fileBytes);
    expect(f["wide.txt"].patch.endsWith("\n")).toBe(true);
    expect(d.truncated).toBe(true);
  });

  test("a missing checkpoint falls back to HEAD; outside git it throws", async () => {
    const dir = repo();
    w(dir, "a.txt", "changed\n");
    const d = await computeDiff(dir, "0000000000000000000000000000000000000000");
    expect(d.base).toBe("HEAD");
    expect(Object.keys(byPath(d))).toEqual(["a.txt"]);
    const plain = mkdtempSync(join(tmpdir(), "tether-nogit-"));
    dirs.push(plain);
    await expect(computeDiff(plain)).rejects.toThrow("not a Git repository");
  });
});

describe("session checkpoints", () => {
  class Fake extends LiveSession {
    async start() {}
    protected async send() {}
    async abort() {}
    async applyModel() {}
    async setThinking() {}
    async setPermissionMode() {}
    async rename() {}
    async listCommands() {
      return [];
    }
    async continueTurn() {}
    protected shutdown() {}
  }

  test("one checkpoint per turn; per-turn and whole-session diffs and stats", async () => {
    const dir = repo();
    const s = new Fake("pi", { nativeId: crypto.randomUUID(), projectPath: dir }, { emit: () => {}, summary: () => {}, handoff: async () => {} });
    try {
      await s.checkpoint("turn 1");
      w(dir, "one.txt", "a\nb\n");
      await s.checkpoint("turn 2");
      await s.checkpoint("turn 3"); // turn 2 changed nothing
      w(dir, "a.txt", "one\n");
      await s.refreshDiffStats();

      const cps = s.t.state.checkpoints!;
      expect(cps.map((c) => c.label)).toEqual(["turn 1", "turn 2", "turn 3"]);
      expect(cps[1]!.sha).toBe(cps[2]!.sha);
      expect(cps.map((c) => c.stat)).toEqual([
        { files: 1, additions: 2, deletions: 0 },
        { files: 0, additions: 0, deletions: 0 },
        { files: 1, additions: 0, deletions: 2 },
      ]);
      expect(s.t.state.diffStat).toEqual({ files: 2, additions: 2, deletions: 2 });

      expect((await s.diff(cps[0]!.id)).files.map((f) => f.path)).toEqual(["one.txt"]);
      expect((await s.diff(cps[1]!.id)).files).toEqual([]);
      expect((await s.diff(cps[2]!.id)).files.map((f) => f.path)).toEqual(["a.txt"]);
      expect((await s.diff()).files.map((f) => f.path).sort()).toEqual(["a.txt", "one.txt"]);
      await expect(s.diff("nope")).rejects.toThrow();
      // Refs are named by id, so they stay unique once the list is capped.
      expect(sh(dir, "for-each-ref", "--format=%(refname)", "refs/tether/").trim().split("\n")).toHaveLength(2);
    } finally {
      s.close();
    }
  });
});
