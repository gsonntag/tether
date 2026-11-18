// Turn checkpoints against real temporary repos: snapshots leave the index, HEAD, stash and files
// alone, take untracked files and never ignored ones; a turn's diff; restore and its undo; refusal
// while the session works; pruning; a folder outside git; identical snapshots shared.

import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHECKPOINT_TTL_MS, CHECKPOINTS_MAX } from "../../../../shared/checkpoints";
import type { Msg } from "../../../../shared/transcript";
import { EventBus } from "../../core/bus";
import { OpRegistry } from "../../core/ops";
import type { SessionLook } from "..";
import { gitModule } from "../git";
import { blockedWhy, Checkpoints } from ".";
import { snapshot, writeAll } from "./snap";
import { gitDiff } from "../git/diff";
import { refSafe } from "./store";

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
  const holds: string[] = [];
  const c = new Checkpoints({ dir: temp(), look: (id) => (id === "claude:s1" ? look : undefined), open: async () => look, list: () => [look.summary, ...others], log: (l) => logs.push(l), now, holdFolder: (f, why) => (holds.push(`hold ${f} ${why}`), () => holds.push(`release ${f}`)) });
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
  return { c, look, others, turn, logs, holds };
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
  const ref = sh(d, "rev-parse", "refs/tether/checkpoints/claude_3As1/1").trim();
  const files = sh(d, "ls-tree", "-r", "--name-only", ref).trim().split("\n");
  expect(files.sort()).toEqual([".gitignore", "a.txt", "keep.txt", "new.txt"]);
  expect(sh(d, "show", `${ref}:a.txt`)).toBe("one\nchanged again\n");
  // No branch, tag or reflog entry: only the hidden ref.
  expect(sh(d, "branch", "--list")).toBe("* main\n");
  expect(sh(d, "for-each-ref", "--format=%(refname)").trim().split("\n").sort()).toEqual(["refs/heads/main", "refs/stash", "refs/tether/checkpoints/claude_3As1/1"]);
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
  expect(sh(d, "for-each-ref", "--format=%(refname)", "refs/tether/").trim().split("\n")).toEqual(["refs/tether/checkpoints/claude_3As1/2", "refs/tether/checkpoints/claude_3As1/3"]);
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
  expect((await snapshot(d, temp())).tree).toBe((await snapshot(d, temp())).tree);
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

// ---------- the undo puts back exactly what a restore touched ----------

/** Every file under `d` but .git: its bytes (or link target) and mode. */
function files(d: string, at = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of readdirSync(join(d, at))) {
    const p = at ? `${at}/${n}` : n;
    if (p === ".git") continue;
    const st = lstatSync(join(d, p));
    if (st.isSymbolicLink()) out[p] = `link:${readlinkSync(join(d, p))}`;
    else if (st.isDirectory()) Object.assign(out, files(d, p));
    else out[p] = `${(st.mode & 0o777).toString(8)}:${st.mode & 0o400 ? readFileSync(join(d, p)).toString("base64") : "?"}`;
  }
  return out;
}

async function roundTrip(d: string, c: Checkpoints, id: string) {
  const before = files(d);
  const r = await c.restore("claude:s1", id);
  const between = files(d);
  const u = await c.restore("claude:s1", r.checkpoint.id);
  expect(files(d)).toEqual(before);
  return { r, u, between };
}

test("undo round trip: an untracked file that grew past the size cap during the turn", async () => {
  const d = repo();
  writeFileSync(join(d, "data.bin"), "small\n");
  const { c, turn } = setup(d);
  const big = Buffer.alloc(33 * 1024 * 1024, 7);
  await turn(() => writeFileSync(join(d, "data.bin"), big));
  const { between } = await roundTrip(d, c, "1");
  expect(between["data.bin"]!.split(":")[1]).toBe(Buffer.from("small\n").toString("base64"));
  expect(readFileSync(join(d, "data.bin")).equals(big)).toBe(true);
}, 30_000);

test("a restore never removes a file its target left out for size", async () => {
  const d = repo();
  writeFileSync(join(d, "huge.bin"), Buffer.alloc(33 * 1024 * 1024, 1));
  const { c, turn } = setup(d);
  // The turn shrinks it: now it's in the snapshot, but not in the target's.
  await turn(() => writeFileSync(join(d, "huge.bin"), "tiny\n"));
  const { r } = await roundTrip(d, c, "1");
  expect(r.skipped).toContainEqual({ path: "huge.bin", why: "notTaken" });
}, 30_000);

test("undo round trip: a file that became ignored during the turn", async () => {
  const d = repo();
  writeFileSync(join(d, "x.dat"), "A\n");
  const { c, turn } = setup(d);
  await turn(() => {
    writeFileSync(join(d, ".gitignore"), "*.log\nx.dat\n");
    writeFileSync(join(d, "x.dat"), "B\n");
  });
  const { between } = await roundTrip(d, c, "1");
  expect(between["x.dat"]!.split(":")[1]).toBe(Buffer.from("A\n").toString("base64"));
});

test("an unreadable file is left alone and reported; one the target couldn't read is never removed", async () => {
  const d = repo();
  writeFileSync(join(d, "locked.txt"), "A\n");
  writeFileSync(join(d, "was-locked.txt"), "secret\n");
  chmodSync(join(d, "was-locked.txt"), 0);
  const { c, turn } = setup(d);
  await turn(() => {
    writeFileSync(join(d, "locked.txt"), "B\n");
    chmodSync(join(d, "locked.txt"), 0);
    chmodSync(join(d, "was-locked.txt"), 0o644);
  });
  const { r } = await roundTrip(d, c, "1");
  expect(r.skipped).toContainEqual({ path: "locked.txt", why: "unreadable" });
  expect(r.skipped).toContainEqual({ path: "was-locked.txt", why: "notTaken" });
  chmodSync(join(d, "locked.txt"), 0o644);
  expect(read(d, "locked.txt")).toBe("B\n");
  expect(read(d, "was-locked.txt")).toBe("secret\n");
});

test("undo round trip: a tracked file marked assume-unchanged, edited after", async () => {
  const d = repo();
  const { c, turn } = setup(d);
  await turn(() => {
    writeFileSync(join(d, "a.txt"), "B\n");
    sh(d, "add", "a.txt");
  });
  sh(d, "update-index", "--assume-unchanged", "a.txt");
  writeFileSync(join(d, "a.txt"), "C, edited where git doesn't look\n");
  const { between } = await roundTrip(d, c, "1");
  expect(between["a.txt"]!.split(":")[1]).toBe(Buffer.from("one\ntwo\n").toString("base64"));
  expect(read(d, "a.txt")).toBe("C, edited where git doesn't look\n");
});

test("a file made after the restore's snapshot began is in its undo", async () => {
  const d = repo();
  const { c, turn } = setup(d);
  await turn(() => rmSync(join(d, "keep.txt")));
  const sc = c.store.get("claude:s1")!;
  const { restoreTo } = await import("./snap");
  const target = { tree: sh(d, "rev-parse", `${sc.items[0]!.before}^{tree}`).trim() };
  let undoTree = "";
  await restoreTo(d, target, temp(), async (u) => void (undoTree = u.tree), { afterSnap: () => writeFileSync(join(d, "keep.txt"), "made meanwhile\n") });
  expect(read(d, "keep.txt")).toBe("keep\n");
  expect(sh(d, "show", `${undoTree}:keep.txt`)).toBe("made meanwhile\n");
});

test("nested repositories: nothing written into or removed from one; reported", async () => {
  const d = repo();
  mkdirSync(join(d, "sub"));
  writeFileSync(join(d, "sub", "x.txt"), "tracked here\n");
  sh(d, "add", "sub/x.txt");
  sh(d, "commit", "-qm", "sub");
  const { c, turn } = setup(d);
  await turn(() => {
    // The turn makes the folder a repository of its own, with other files.
    rmSync(join(d, "sub", "x.txt"));
    writeFileSync(join(d, "sub", "y.txt"), "inner\n");
    sh(join(d, "sub"), "init", "-q");
    sh(join(d, "sub"), "add", "y.txt");
    sh(join(d, "sub"), "commit", "-qm", "inner");
  });
  const { r, between } = await roundTrip(d, c, "1");
  // (git sees the files in it, or a gitlink, depending on what the index had there)
  expect(r.skipped).toContainEqual({ path: "sub/x.txt", why: "nested" });
  expect(new Set(r.skipped.map((x) => x.why))).toEqual(new Set(["nested"]));
  expect(between["sub/x.txt"]).toBeUndefined();
  expect(read(d, "sub/y.txt")).toBe("inner\n");
});

test("a tracked file the turn added though ignored stays, reported as ignored", async () => {
  const d = repo();
  const { c, turn } = setup(d);
  await turn(() => {
    writeFileSync(join(d, "forced.log"), "kept\n");
    sh(d, "add", "-f", "forced.log");
  });
  const r = await c.restore("claude:s1", "1");
  expect(r.skipped).toContainEqual({ path: "forced.log", why: "ignored" });
  expect(read(d, "forced.log")).toBe("kept\n");
});

test("racy git: a same-size edit in the same second as `git add` is in the snapshot", async () => {
  const d = repo();
  const t = Math.floor(Date.now() / 1000) - 10;
  writeFileSync(join(d, "a.txt"), "aaaa\n");
  utimesSync(join(d, "a.txt"), t, t);
  sh(d, "add", "a.txt");
  utimesSync(join(d, ".git", "index"), t, t);
  writeFileSync(join(d, "a.txt"), "bbbb\n");
  utimesSync(join(d, "a.txt"), t, t);
  const { tree } = await snapshot(d, temp());
  expect(sh(d, "show", `${tree}:a.txt`)).toBe("bbbb\n");
});

test("restore holds the session throughout, and is refused when it works in the background or another session in the repo works", async () => {
  const d = repo();
  const { c, look, others, turn, holds } = setup(d);
  await turn(() => writeFileSync(join(d, "a.txt"), "x\n"));
  look.background = true;
  await expect(c.restore("claude:s1", "1")).rejects.toThrow(/background/);
  look.background = false;
  // Through a symlink to the repo (macOS /var → /private/var): still the same repo.
  const link = join(temp(), "link");
  symlinkSync(d, link);
  others.push({ id: "codex:o", projectPath: link, title: "Other", mode: "live", status: "running" } as never);
  await expect(c.restore("claude:s1", "1")).rejects.toThrow(/“Other” in this repository is working/);
  expect((await c.list("claude:s1")).blocked).toMatch(/Other/);
  others[0]!.status = "waiting";
  await expect(c.restore("claude:s1", "1")).rejects.toThrow(/waiting on you/);
  others[0]!.status = "idle";
  await c.restore("claude:s1", "1");
  // The whole repo is held while files change: every session in it, the other one too.
  expect(holds).toEqual([`hold ${d} Restoring files…`, `release ${d}`]);
  expect(read(d, "a.txt")).toBe("one\ntwo\n");
});

test("a session that starts working while the undo point is saved: the restore is called off, nothing changed", async () => {
  const d = repo();
  const { c, look, turn } = setup(d);
  await turn(() => writeFileSync(join(d, "a.txt"), "x\n"));
  const put = c.store.put.bind(c.store);
  let n = 0;
  c.store.put = (v) => {
    put(v);
    if (n++ === 0) look.status = "running";
  };
  await expect(c.restore("claude:s1", "1")).rejects.toThrow(/working/);
  expect(read(d, "a.txt")).toBe("x\n");
  expect(c.store.get("claude:s1")!.items.map((x) => x.kind)).toEqual(["turn"]);
});

test("a before snapshot done well after the turn started is marked late", async () => {
  const d = repo();
  let now = 1_000_000;
  const { c, look } = setup(d, () => now);
  look.status = "running";
  c.turnStarted("claude:s1");
  now += 5000;
  await c.settled("claude:s1");
  expect((await c.list("claude:s1")).checkpoints[0]).toMatchObject({ late: true });
});

test("viewing an open turn doesn't queue ahead of (or behind) a turn's start", async () => {
  const d = repo();
  const { c, look } = setup(d);
  look.status = "running";
  c.turnStarted("claude:s1");
  await c.settled("claude:s1");
  // A restore-like exclusive job holds the repo: viewing still answers.
  let free!: () => void;
  const held = c.exclusive(d, () => new Promise<void>((r) => (free = r)));
  writeFileSync(join(d, "v.txt"), "v\n");
  const v = await c.diff("claude:s1", undefined);
  expect(v.files.map((f) => f.path)).toEqual(["v.txt"]);
  free();
  await held;
});

test("after a rate-limit retry resumed a turn, a different message starts a new one", async () => {
  const d = repo();
  const { c, look } = setup(d);
  const msg = (id: string, text: string) => ({ id, role: "user", parts: [{ type: "text", text }], ts: 0 }) as Msg;
  look.status = "running";
  c.turnStarted("claude:s1");
  c.message("claude:s1", msg("u1", "first"));
  await c.settled("claude:s1");
  writeFileSync(join(d, "first.txt"), "1\n");
  c.turnEnded("claude:s1", true);
  c.turnStarted("claude:s1");
  c.message("claude:s1", msg("u1b", "first")); // the retry: the same words
  await c.settled("claude:s1");
  expect((await c.list("claude:s1")).checkpoints.length).toBe(1);
  c.message("claude:s1", msg("u2", "something else"));
  await c.settled("claude:s1");
  const list = (await c.list("claude:s1")).checkpoints;
  expect(list.map((x) => [x.n, x.prompt, x.files])).toEqual([[2, "something else", undefined], [1, "first", 1]]);
});

test("a folder now in another repo: the old repo's refs go", async () => {
  const a = repo();
  const b = repo();
  const { c, look, turn } = setup(a);
  await turn();
  expect(sh(a, "for-each-ref", "refs/tether/")).not.toBe("");
  look.summary.projectPath = b;
  await turn();
  expect(sh(a, "for-each-ref", "refs/tether/")).toBe("");
  expect((await c.list("claude:s1")).checkpoints.map((x) => x.n)).toEqual([2]);
});

test("too many untracked files to list: tracked files are still taken, and a restore removes no untracked file", async () => {
  const d = repo();
  const { c, turn } = setup(d);
  await turn(() => writeFileSync(join(d, "a.txt"), "changed\n"));
  const sc = c.store.get("claude:s1")!;
  sc.items[0]!.noUntracked = true;
  writeFileSync(join(d, "new-untracked.txt"), "n\n");
  const r = await c.restore("claude:s1", "1");
  expect(read(d, "a.txt")).toBe("one\ntwo\n");
  expect(read(d, "new-untracked.txt")).toBe("n\n");
  expect(r.skipped).toContainEqual({ path: "new-untracked.txt", why: "notTaken" });
});

test("session ids map to ref names one to one", () => {
  const ids = ["claude:a", "claude-a", "claude_a", "claude__3Aa", "claude_3Aa", "x.y", "x_2Ey", "", "é"];
  const safe = ids.map(refSafe);
  expect(new Set(safe).size).toBe(ids.length);
  for (const s of safe) {
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Bun.spawnSync(["git", "check-ref-format", `refs/tether/checkpoints/${s}/1`]).exitCode).toBe(0);
  }
  expect(refSafe("a".repeat(300)).length).toBeLessThanOrEqual(120);
  expect(refSafe("a".repeat(300))).not.toBe(refSafe("a".repeat(301)));
});

test("refused while the session waits on a restart, a rate-limit retry, or its terminal", async () => {
  const d = repo();
  const { c, look, turn } = setup(d);
  await turn(() => writeFileSync(join(d, "a.txt"), "x\n"));
  look.state.restartWait = true;
  await expect(c.restore("claude:s1", "1")).rejects.toThrow(/restart/);
  look.state.restartWait = undefined;
  look.state.retry = { phase: "waiting" } as never;
  await expect(c.restore("claude:s1", "1")).rejects.toThrow(/rate limit/);
  look.state.retry = undefined;
  look.state.mode = "terminal";
  await expect(c.restore("claude:s1", "1")).rejects.toThrow(/terminal/);
  expect(read(d, "a.txt")).toBe("x\n");
});

test("refused while another live session in the repo is busy (a command, a subagent, a retry), though idle", async () => {
  const d = repo();
  const other: SessionLook = { summary: { id: "codex:o", projectPath: d, title: "Other", mode: "live", status: "idle" } as never, status: "idle", requests: [], state: { queue: [] } as never, busy: true, background: false };
  const look: SessionLook = { summary: { id: "claude:s1", projectPath: d, title: "S1", mode: "live", status: "idle" } as never, status: "idle", requests: [], state: { queue: [] } as never, busy: false, background: false };
  const c = new Checkpoints({ dir: temp(), look: (id) => (id === "codex:o" ? other : look), open: async () => look, list: () => [look.summary, other.summary], log: () => {} });
  look.status = "running";
  c.turnStarted("claude:s1");
  await c.settled("claude:s1");
  look.status = "idle";
  c.turnEnded("claude:s1");
  await expect(c.restore("claude:s1", "1")).rejects.toThrow(/“Other” in this repository is still running something/);
  other.busy = false;
  other.state.retry = { phase: "waiting" } as never;
  await expect(c.restore("claude:s1", "1")).rejects.toThrow(/“Other”.*rate limit/);
});

test("undo round trip under core.autocrlf=input: CRLF files come back byte for byte", async () => {
  const d = repo();
  sh(d, "config", "core.autocrlf", "input");
  const { c, turn } = setup(d);
  await turn(() => {
    writeFileSync(join(d, "a.txt"), "x\r\ny\r\n");
    writeFileSync(join(d, "crlf-new.txt"), "n\r\n");
  });
  const { between } = await roundTrip(d, c, "1");
  expect(between["crlf-new.txt"]).toBeUndefined();
  expect(read(d, "a.txt")).toBe("x\r\ny\r\n");
  expect(read(d, "crlf-new.txt")).toBe("n\r\n");
});

test("a checkpoint keeps at most 200 left-out paths, with their count; past them a restore removes no untracked file", async () => {
  const d = repo();
  const { c, turn } = setup(d);
  await turn(() => writeFileSync(join(d, "a.txt"), "changed\n"));
  const rec = c.store.get("claude:s1")!.items[0]!;
  rec.left = Array.from({ length: 200 }, (_, i) => `big${i}.bin`);
  rec.leftCount = 250;
  writeFileSync(join(d, "made-later.txt"), "m\n");
  const r = await c.restore("claude:s1", "1");
  expect(read(d, "made-later.txt")).toBe("m\n");
  expect(r.skipped).toContainEqual({ path: "made-later.txt", why: "notTaken" });
  expect(read(d, "a.txt")).toBe("one\ntwo\n");
});

test("a snapshot that leaves out many paths keeps the first 200 and the count", async () => {
  const d = repo();
  for (let i = 0; i < 205; i++) {
    writeFileSync(join(d, `locked${i}.txt`), "x\n");
    chmodSync(join(d, `locked${i}.txt`), 0);
  }
  const { c, turn } = setup(d);
  await turn();
  const rec = c.store.get("claude:s1")!.items[0]!;
  expect(rec.left!.length).toBe(200);
  expect(rec.leftCount).toBe(205);
  for (let i = 0; i < 205; i++) chmodSync(join(d, `locked${i}.txt`), 0o644);
});

test("thousands of long paths: no path goes on git's command line, and the undo round-trips them all", async () => {
  const d = repo();
  const n = 3000;
  // About 2.2 MB of path names: past Linux's 2 MB argv limit, were they passed as arguments.
  const dir = (i: number) => `${"d".repeat(240)}${i % 10}/${"e".repeat(240)}`;
  const path = (i: number) => `${dir(i)}/${"f".repeat(240)}${i}`;
  for (let i = 0; i < 10; i++) mkdirSync(join(d, dir(i)), { recursive: true });
  for (let i = 0; i < n; i++) writeFileSync(join(d, path(i)), `before ${i}\n`);
  const { c, turn } = setup(d);
  await turn(() => {
    for (let i = 0; i < n; i++) writeFileSync(join(d, path(i)), `after ${i}\r\n`);
  });
  const { r, between } = await roundTrip(d, c, "1");
  expect(r.written).toBe(n);
  expect(between[path(2345)]!.split(":")[1]).toBe(Buffer.from("before 2345\n").toString("base64"));
  expect(read(d, path(2345))).toBe("after 2345\r\n");
}, 120_000);

test("removing thousands of files from one folder is quick, and the emptied folders go", async () => {
  const d = repo();
  const { c, turn } = setup(d);
  // All in one folder: listing it after each removal (as before) took minutes for tens of thousands.
  const n = Number(process.env.NREM ?? 8000);
  await turn(() => {
    mkdirSync(join(d, "gen", "deep"), { recursive: true });
    for (let i = 0; i < n; i++) writeFileSync(join(d, "gen", "deep", `f${i}.txt`), `${i}\n`);
  });
  const t0 = performance.now();
  const r = await c.restore("claude:s1", "1");
  const ms = performance.now() - t0;
  expect(r.removed).toBe(n);
  expect(existsSync(join(d, "gen"))).toBe(false);
  if (process.env.NREM) console.log(`removed ${n} in ${Math.round(ms)} ms`);
  expect(ms).toBeLessThan(10_000); // about 4 s; 16 s when each removal listed the folder
}, 60_000);

test("a big file (streamed, never held in memory) comes back by undo with its bytes and mode", async () => {
  const d = repo();
  const { c, turn } = setup(d);
  const big = Buffer.alloc(20 * 1024 * 1024);
  for (let i = 0; i < big.length; i += 4096) big[i] = i % 251;
  await turn(() => {
    writeFileSync(join(d, "tool.bin"), big);
    // Executable as git makes one (it keeps the x bit only): 777 less the umask.
    chmodSync(join(d, "tool.bin"), 0o777 & ~process.umask());
  });
  await roundTrip(d, c, "1");
  expect(readFileSync(join(d, "tool.bin")).equals(big)).toBe(true);
  expect(statSync(join(d, "tool.bin")).mode & 0o100).toBe(0o100);
  expect(readdirSync(d).filter((f) => f.startsWith(".tether-restore-"))).toEqual([]);
}, 30_000);

test("a live session whose folder holds the repo counts as in it", async () => {
  const parent = temp();
  const d = join(parent, "repo");
  mkdirSync(d);
  sh(d, "init", "-q", "-b", "main");
  writeFileSync(join(d, "a.txt"), "a\n");
  sh(d, "add", ".");
  sh(d, "commit", "-qm", "a");
  const { c, others } = setup(d);
  others.push({ id: "codex:up", projectPath: parent, title: "Above", mode: "live", status: "running" } as never);
  const l = await c.list("claude:s1");
  expect(l.others.map((o) => o.id)).toEqual(["codex:up"]);
  expect(l.blocked).toMatch(/“Above”/);
});

test("a restore's leftover temporary files: never in a snapshot or a diff, swept by the next restore", async () => {
  const d = repo();
  const { c, turn } = setup(d);
  mkdirSync(join(d, "sub"));
  const left = [".tether-restore-0123456789ab", "sub/.tether-restore-abcdef012345"];
  await turn(() => {
    writeFileSync(join(d, "a.txt"), "changed\n");
    for (const p of left) writeFileSync(join(d, p), "half a file");
  });
  expect((await c.diff("claude:s1", "1")).files.map((f) => f.path)).toEqual(["a.txt"]);
  expect((await gitDiff(d, "uncommitted")).files.map((f) => f.path)).toEqual(["a.txt"]);
  const { tree } = await snapshot(d, temp());
  expect(sh(d, "ls-tree", "-r", "--name-only", tree)).not.toContain("tether-restore");
  await c.restore("claude:s1", "1");
  for (const p of left) expect(existsSync(join(d, p))).toBe(false);
  expect(read(d, "a.txt")).toBe("one\ntwo\n");
});

test("streaming writes all of each chunk, however short the writes", async () => {
  const got: number[] = [];
  const fh = { write: async (b: Uint8Array, off: number, len: number) => (got.push(...b.subarray(off, off + Math.min(3, len))), { bytesWritten: Math.min(3, len) }) };
  await writeAll(fh, Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
  expect(got).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  await expect(writeAll({ write: async () => ({ bytesWritten: 0 }) }, Uint8Array.from([1]))).rejects.toThrow();
});

test("a restore isn't refused for a scheduled message not due yet, only for ones waiting now (SPEC §9)", () => {
  const look = (queue: object[]): SessionLook => ({ summary: { id: "claude:q", projectPath: "/p", title: "Q", mode: "live", status: "idle" } as never, status: "idle", requests: [], state: { queue } as never, busy: false, background: false });
  const now = Date.now();
  expect(blockedWhy(look([{ id: "a", text: "later", queuedAt: now, at: now + 3_600_000 }]))).toBeUndefined();
  expect(blockedWhy(look([{ id: "a", text: "due", queuedAt: now, at: now - 1000 }]))).toContain("messages waiting");
  expect(blockedWhy(look([{ id: "a", text: "plain", queuedAt: now }]))).toContain("messages waiting");
});
