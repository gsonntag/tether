// Turn checkpoints against real temporary repos: snapshots leave the index, HEAD, stash and files
// alone, take untracked files and never ignored ones; a turn's diff; restore and its undo; refusal
// while the session works; pruning; a folder outside git; identical snapshots shared.

import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHECKPOINT_TTL_MS, CHECKPOINTS_MAX } from "../../../../shared/checkpoints";
import type { Msg } from "../../../../shared/transcript";
import { EventBus } from "../../core/bus";
import { OpRegistry } from "../../core/ops";
import type { SessionLook } from "..";
import { gitModule } from "../git";
import { Checkpoints } from ".";
import { snapshotTree } from "./snap";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const sh = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString();
};
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "tether-cp-"));
  dirs.push(d);
  return d;
};
function repo() {
  const d = temp();
  sh(d, "init", "-q", "-b", "main");
  writeFileSync(join(d, "a.txt"), "one\ntwo\n");
  writeFileSync(join(d, "keep.txt"), "keep\n");
  writeFileSync(join(d, ".gitignore"), "*.log\n");
  sh(d, "add", ".");
  sh(d, "commit", "-qm", "first");
  return d;
}
const read = (d: string, p: string) => readFileSync(join(d, p), "utf8");

function setup(folder: string, now = () => Date.now()) {
  const look: SessionLook = { summary: { id: "claude:s1", projectPath: folder, title: "S1", mode: "live", status: "idle" } as never, status: "idle", requests: [], state: { queue: [] } as never, busy: false, background: false };
  const others: SessionLook["summary"][] = [];
  const logs: string[] = [];
  const c = new Checkpoints({ dir: temp(), look: () => look, open: async () => look, list: () => [look.summary, ...others], log: (l) => logs.push(l), now });
  const turn = async (work?: () => void, prompt = "do it") => {
    look.status = "running";
    c.turnStarted("claude:s1");
    c.message("claude:s1", { id: `m${Math.random()}`, role: "user", parts: [{ type: "text", text: prompt }], ts: 0 } as Msg);
    await c.settled("claude:s1");
    work?.();
    look.status = "idle";
    c.turnEnded("claude:s1");
    await c.settled("claude:s1");
  };
  return { c, look, others, turn, logs };
}

test("a snapshot leaves the index, HEAD, stash and working tree alone; untracked in, ignored out", async () => {
  const d = repo();
  writeFileSync(join(d, "a.txt"), "one\nTWO\n");
  writeFileSync(join(d, "staged.txt"), "s\n");
  sh(d, "add", "staged.txt");
  sh(d, "stash", "-q");
  writeFileSync(join(d, "a.txt"), "one\nchanged\n");
  writeFileSync(join(d, "new.txt"), "new\n");
  writeFileSync(join(d, "noise.log"), "ignored\n");
  sh(d, "add", "a.txt");
  writeFileSync(join(d, "a.txt"), "one\nchanged again\n");
  const index = readFileSync(join(d, ".git", "index"));
  const head = sh(d, "rev-parse", "HEAD");
  const stash = sh(d, "stash", "list");
  const status = sh(d, "status", "--porcelain");
  const { c, turn } = setup(d);
  await turn();

  expect(readFileSync(join(d, ".git", "index")).equals(index)).toBe(true);
  expect(sh(d, "rev-parse", "HEAD")).toBe(head);
  expect(sh(d, "stash", "list")).toBe(stash);
  expect(sh(d, "status", "--porcelain")).toBe(status);
  expect(read(d, "a.txt")).toBe("one\nchanged again\n");
  const [cp] = (await c.list("claude:s1")).checkpoints;
  expect(cp).toMatchObject({ kind: "turn", n: 1, prompt: "do it", files: 0 });
  const ref = sh(d, "rev-parse", "refs/tether/checkpoints/claude-s1/1").trim();
  const files = sh(d, "ls-tree", "-r", "--name-only", ref).trim().split("\n");
  expect(files.sort()).toEqual([".gitignore", "a.txt", "keep.txt", "new.txt"]);
  expect(sh(d, "show", `${ref}:a.txt`)).toBe("one\nchanged again\n");
  // No branch, tag or reflog entry: only the hidden ref.
  expect(sh(d, "branch", "--list")).toBe("* main\n");
  expect(sh(d, "for-each-ref", "--format=%(refname)").trim().split("\n").sort()).toEqual(["refs/heads/main", "refs/stash", "refs/tether/checkpoints/claude-s1/1"]);
});

test("a turn's diff: before → after, and before → working tree while it runs", async () => {
  const d = repo();
  const { c, look } = setup(d);
  look.status = "running";
  c.turnStarted("claude:s1");
  await c.settled("claude:s1");
  writeFileSync(join(d, "a.txt"), "one\ntwo\nthree\n");
  writeFileSync(join(d, "made.txt"), "made\n");
  const live = await c.diff("claude:s1", undefined);
  expect(live).toMatchObject({ scope: "turn", state: "ok", checkpoint: "1", base: "turn 1: before → now" });
  expect(live.files.map((f) => [f.path, f.status])).toEqual([["a.txt", "modified"], ["made.txt", "added"]]);
  expect((await c.list("claude:s1")).checkpoints[0]).toMatchObject({ open: true });
  look.status = "idle";
  c.turnEnded("claude:s1");
  await c.settled("claude:s1");
  // Changes after the turn aren't the turn's.
  writeFileSync(join(d, "later.txt"), "later\n");
  const done = await c.diff("claude:s1", "1");
  expect(done.files.map((f) => [f.path, f.status, f.added])).toEqual([["a.txt", "modified", 1], ["made.txt", "added", 1]]);
  expect((await c.list("claude:s1")).checkpoints[0]).toMatchObject({ files: 2 });
  expect((await c.diff("claude:s1", "nope")).state).toBe("noBase");
});

test("restore: created files removed, deleted ones back, modified reverted, ignored untouched; undo puts it all back", async () => {
  const d = repo();
  writeFileSync(join(d, "untracked.txt"), "was here\n");
  const { c, turn } = setup(d);
  const indexBefore = readFileSync(join(d, ".git", "index"));
  await turn(() => {
    writeFileSync(join(d, "a.txt"), "rewritten\n");
    rmSync(join(d, "keep.txt"));
    rmSync(join(d, "untracked.txt"));
    mkdirSync(join(d, "deep", "er"), { recursive: true });
    writeFileSync(join(d, "deep", "er", "made.txt"), "made\n");
    writeFileSync(join(d, "build.log"), "ignored output\n");
  });
  const r = await c.restore("claude:s1", "1");
  expect(r).toMatchObject({ written: 3, removed: 1, checkpoint: { kind: "restore", n: 2, to: "1", toN: 1 } });
  expect(read(d, "a.txt")).toBe("one\ntwo\n");
  expect(read(d, "keep.txt")).toBe("keep\n");
  expect(read(d, "untracked.txt")).toBe("was here\n");
  expect(existsSync(join(d, "deep"))).toBe(false);
  expect(read(d, "build.log")).toBe("ignored output\n");
  expect(readFileSync(join(d, ".git", "index")).equals(indexBefore)).toBe(true);
  const list = (await c.list("claude:s1")).checkpoints;
  expect(list.map((x) => [x.n, x.kind])).toEqual([[2, "restore"], [1, "turn"]]);
  // The restore's own diff is what it put back.
  expect((await c.diff("claude:s1", "2")).files.map((f) => f.path)).toEqual(["a.txt", "deep/er/made.txt", "keep.txt", "untracked.txt"]);

  // Undo: back to the files as they were before the restore.
  const u = await c.restore("claude:s1", "2");
  expect(u.checkpoint).toMatchObject({ kind: "restore", to: "2" });
  expect(read(d, "a.txt")).toBe("rewritten\n");
  expect(existsSync(join(d, "keep.txt"))).toBe(false);
  expect(existsSync(join(d, "untracked.txt"))).toBe(false);
  expect(read(d, "deep/er/made.txt")).toBe("made\n");
});

test("restore keeps a file the target's ignore rules ignore, and never writes through a symlinked folder", async () => {
  const d = repo();
  const outside = temp();
  const { c, turn } = setup(d);
  await turn(() => {
    // The turn un-ignores logs and makes one; and swaps a folder for a symlink out of the repo.
    writeFileSync(join(d, ".gitignore"), "\n");
    writeFileSync(join(d, "secret.log"), "keep me\n");
    symlinkSync(outside, join(d, "link"));
  });
  await c.restore("claude:s1", "1");
  expect(read(d, ".gitignore")).toBe("*.log\n");
  expect(read(d, "secret.log")).toBe("keep me\n");
  expect(existsSync(join(d, "link"))).toBe(false);
  expect(statSync(outside).isDirectory()).toBe(true);
});

test("restore is refused while the session works or has waiting messages", async () => {
  const d = repo();
  const { c, look, turn } = setup(d);
  await turn(() => writeFileSync(join(d, "a.txt"), "x\n"));
  look.status = "running";
  await expect(c.restore("claude:s1", "1")).rejects.toThrow(/working/);
  expect((await c.list("claude:s1")).blocked).toMatch(/working/);
  look.status = "waiting";
  await expect(c.restore("claude:s1", "1")).rejects.toThrow(/waiting on you/);
  look.status = "idle";
  look.state.queue = [{ id: "q" } as never];
  await expect(c.restore("claude:s1", "1")).rejects.toThrow(/messages waiting/);
  expect(read(d, "a.txt")).toBe("x\n");
  look.state.queue = [];
  await expect(c.restore("claude:s1", "9")).rejects.toThrow(/gone/);
});

test("the list names live sessions in the same repo", async () => {
  const d = repo();
  mkdirSync(join(d, "pkg"));
  const { c, others } = setup(d);
  others.push({ id: "codex:x", projectPath: join(d, "pkg"), title: "Other", mode: "live", status: "running" } as never);
  others.push({ id: "codex:y", projectPath: d, title: "Stored", mode: "stored", status: "idle" } as never);
  others.push({ id: "codex:z", projectPath: `${d}-sibling`, title: "Elsewhere", mode: "live", status: "idle" } as never);
  expect((await c.list("claude:s1")).others).toEqual([{ id: "codex:x", title: "Other", status: "running" }]);
});

test("pruning: past the newest 200, and older than 14 days", async () => {
  const d = repo();
  let now = Date.now();
  const { c, turn } = setup(d, () => now);
  now -= CHECKPOINT_TTL_MS + 60_000;
  await turn();
  now += CHECKPOINT_TTL_MS;
  await turn();
  expect((await c.list("claude:s1")).checkpoints.map((x) => x.n)).toEqual([2, 1]);
  now += 120_000;
  await turn();
  expect((await c.list("claude:s1")).checkpoints.map((x) => x.n)).toEqual([3, 2]);
  expect(sh(d, "for-each-ref", "--format=%(refname)", "refs/tether/").trim().split("\n")).toEqual(["refs/tether/checkpoints/claude-s1/2", "refs/tether/checkpoints/claude-s1/3"]);
  const sc = c.store.get("claude:s1")!;
  for (let i = 0; i < CHECKPOINTS_MAX; i++) sc.items.push({ ...sc.items.at(-1)!, id: String(sc.next), n: sc.next++ });
  await turn();
  const left = (await c.list("claude:s1")).checkpoints;
  expect(left.length).toBe(CHECKPOINTS_MAX);
  expect(left.at(-1)!.n).toBe(sc.next - CHECKPOINTS_MAX);
}, 20_000);

test("a folder outside git: nothing taken", async () => {
  const d = temp();
  writeFileSync(join(d, "f.txt"), "f\n");
  const { c, turn } = setup(d);
  await turn(() => writeFileSync(join(d, "f.txt"), "g\n"));
  expect(await c.list("claude:s1")).toMatchObject({ state: "notRepo", checkpoints: [] });
  expect((await c.diff("claude:s1", undefined)).state).toBe("notRepo");
  expect(c.store.sessions()).toEqual([]);
});

test("identical working trees share their snapshot; a turn that changed nothing has after = before", async () => {
  const d = repo();
  writeFileSync(join(d, "u.txt"), "u\n");
  const { c, turn } = setup(d);
  await turn();
  await turn();
  const sc = c.store.get("claude:s1")!;
  expect(sc.items[0]!.after).toBe(sc.items[0]!.before);
  expect(sc.items[1]!.before).toBe(sc.items[0]!.before);
  expect(sc.items.map((x) => x.files)).toEqual([0, 0]);
  expect(await snapshotTree(d, temp())).toBe(await snapshotTree(d, temp()));
});

test("a turn answered after waiting is the same turn; a restart's cut-off turn closes at the next start", async () => {
  const d = repo();
  const { c, look } = setup(d);
  look.status = "running";
  c.turnStarted("claude:s1");
  await c.settled("claude:s1");
  writeFileSync(join(d, "a.txt"), "edit\n");
  c.turnStarted("claude:s1", "waiting");
  await c.settled("claude:s1");
  expect((await c.list("claude:s1")).checkpoints.length).toBe(1);
  // A fresh process (the restart): the open turn is closed by the next one's start.
  const again = new Checkpoints({ dir: (c as never as { o: { dir: string } }).o.dir, look: () => look, open: async () => look, list: () => [], log: () => {} });
  again.turnStarted("claude:s1");
  await again.settled("claude:s1");
  const list = (await again.list("claude:s1")).checkpoints;
  expect(list.map((x) => [x.n, x.open ?? false, x.files])).toEqual([[2, true, undefined], [1, false, 1]]);
});

test("ops: checkpoints, gitDiff's turn scope and restoreCheckpoint through the git module", async () => {
  const d = repo();
  const bus = new EventBus<any>();
  const ops = new OpRegistry();
  const look: SessionLook = { summary: { id: "claude:o", projectPath: d, title: "O", mode: "live", status: "idle" } as never, status: "idle", requests: [], state: { queue: [] } as never, busy: false, background: false };
  await gitModule.start({ ops, bus, dataDir: temp(), log: () => {}, session: () => look, sessions: { open: async () => look, list: () => [] } } as never);
  bus.emit("turnStarted", { sessionId: "claude:o" });
  bus.emit("message", { sessionId: "claude:o", msg: { id: "u1", role: "user", parts: [{ type: "text", text: "  make\n a   file " }], ts: 1 } });
  const first = await ops.handle("checkpoints", { sessionId: "claude:o" });
  expect(first.ok && (first.data as any).checkpoints[0]).toMatchObject({ n: 1, prompt: "make a file", msgId: "u1", open: true });
  writeFileSync(join(d, "f.txt"), "f\n");
  bus.emit("turnEnded", { sessionId: "claude:o" });
  const diff = await ops.handle("gitDiff", { sessionId: "claude:o", scope: "turn", checkpoint: "1" });
  expect(diff.ok && (diff.data as any).files.map((f: any) => f.path)).toEqual(["f.txt"]);
  const r = await ops.handle("restoreCheckpoint", { sessionId: "claude:o", checkpointId: "1" });
  expect(r.ok).toBe(true);
  expect(existsSync(join(d, "f.txt"))).toBe(false);
});
