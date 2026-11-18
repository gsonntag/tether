// Turn checkpoints (SPEC §10 Checkpoints): at each turn's start, and again at its end, the session's
// repo working tree is snapshotted into a commit under refs/tether/checkpoints/<session>/<n>
// (snap.ts: the real index, HEAD and stash are never touched). The Changes pane's Turn scope diffs a
// turn's pair; Restore puts the files back to a turn's start, after checkpointing them as they are,
// so the restore is a checkpoint too and can be undone the same way.
//
// Ordering. turnStarted comes when the core marks the session running, before it hands the message
// to the harness; the snapshot starts then, not awaited (a turn never waits on git). The harness
// needs a model round trip before its first write, so the before snapshot normally holds none of
// the turn's edits; one that finished over LATE_MS after the turn started is marked `late` (it may
// hold the turn's first edits). Each session's jobs run in order. Snapshots in a repo run side by
// side; a restore has the repo to itself (nothing else snapshots or restores meanwhile), holds its
// session (what's sent waits in the queue) and is refused while any live session in the repo works.
// Looking at an open turn snapshots outside both, so it never delays a turn's start. A turn the
// runner restart cut off has no end snapshot: the next turn's start closes it.
//
// Started by the git module (its gitDiff answers the turn scope from here); the core knows nothing
// of it.

import { join } from "node:path";
import { mkdirSync, realpathSync, rmSync } from "node:fs";
import { CHECKPOINT_TTL_MS, CHECKPOINTS_MAX, type CheckpointInfo, type CheckpointList, type OtherSession, type RestoreResult } from "../../../../shared/checkpoints";
import type { GitDiff } from "../../../../shared/gitDiff";
import type { Msg, SessionSummary } from "../../../../shared/transcript";
import type { ModuleContext, SessionLook } from "..";
import { currentBranch, diffRange, repoRoot } from "../git/diff";
import { changedFiles, commitTree, restoreTo, snapshot, treeOf, updateRefs, type Snap } from "./snap";
import { CheckpointStore, refName, type Checkpoint, type SessionCheckpoints } from "./store";

const PROMPT_MAX = 140;
/** A before snapshot done later than this after its turn started is marked late. */
export const LATE_MS = 2000;

interface Turn {
  at: number;
  prompt?: string;
  msgId?: string;
  rec?: Checkpoint;
  /** ended `recovering` (a rate-limit retry follows): the retry continues this turn */
  recovering?: boolean;
  /** started again after `recovering`: a message that isn't the retried one starts a new turn */
  resumed?: boolean;
}

export interface CheckpointsOpts {
  dir: string;
  look(id: string): SessionLook | undefined;
  open(id: string): Promise<SessionLook>;
  list(): SessionSummary[];
  /** holds a session: what's sent to it waits in its queue until the release */
  hold?(id: string, why: string): () => void;
  log(line: string): void;
  now?: () => number;
}

const info = ({ before: _b, after: _a, left: _l, noUntracked: _n, snapAt: _s, ...rest }: Checkpoint): CheckpointInfo => rest;
const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};
const inside = (root: string, p: string) => p === root || p.startsWith(root.endsWith("/") ? root : `${root}/`);
const snapOf = (c: Checkpoint, tree: string): Snap => ({ tree, ...(c.left ? { left: c.left } : {}), ...(c.noUntracked ? { noUntracked: true } : {}) });

/** Why a restore can't run now, if it can't. */
export function blockedWhy(look: SessionLook, others: OtherSession[] = []): string | undefined {
  if (look.status === "running") return "The session is working. Wait for its turn to finish, or stop it.";
  if (look.status === "waiting") return "The session is waiting on you. Answer it or stop it first.";
  if (look.busy || look.background) return "The session is still running something (a command, a subagent or a background task).";
  if (look.state.queue?.length) return "The session has messages waiting to go. Send or cancel them first.";
  const other = others.find((o) => o.status !== "idle");
  if (other) return `“${other.title || "Another session"}” in this repository is ${other.status === "waiting" ? "waiting on you" : "working"}. Wait for it first.`;
  return undefined;
}

export class Checkpoints {
  readonly store: CheckpointStore;
  private tmp: string;
  private chains = new Map<string, Promise<unknown>>();
  /** per repo: the restore chain, and the snapshots running now */
  private locks = new Map<string, { excl: Promise<void>; shared: Set<Promise<unknown>> }>();
  private turns = new Map<string, Turn>();
  private now: () => number;

  constructor(private o: CheckpointsOpts) {
    this.store = new CheckpointStore(o.dir);
    this.tmp = join(o.dir, "tmp");
    rmSync(this.tmp, { recursive: true, force: true });
    mkdirSync(this.tmp, { recursive: true });
    this.now = o.now ?? Date.now;
  }

  /** `f` after everything queued under `key` (errors don't break the chain). */
  serial<T>(key: string, f: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const run = prev.then(f, f);
    const tail = run.catch(() => {});
    this.chains.set(key, tail);
    void tail.then(() => this.chains.get(key) === tail && this.chains.delete(key));
    return run;
  }

  private lock(root: string) {
    let l = this.locks.get(root);
    if (!l) this.locks.set(root, (l = { excl: Promise.resolve(), shared: new Set() }));
    return l;
  }

  /** `f` beside other snapshots in the repo, but never during a restore there. */
  shared<T>(root: string, f: () => Promise<T>): Promise<T> {
    const l = this.lock(root);
    const run = l.excl.then(f);
    l.shared.add(run);
    void run.then(() => l.shared.delete(run), () => l.shared.delete(run));
    return run;
  }

  /** `f` with the repo to itself: after the snapshots running now, before any asked for later. */
  exclusive<T>(root: string, f: () => Promise<T>): Promise<T> {
    const l = this.lock(root);
    const running = [...l.shared];
    const run = l.excl.then(() => Promise.allSettled(running)).then(f);
    l.excl = run.then(() => {}, () => {});
    return run;
  }

  /** Everything queued for a session so far is done (tests, and the list before it answers). */
  settled(sessionId: string): Promise<void> {
    return this.serial(`s:${sessionId}`, async () => {});
  }

  // ---------- core events ----------

  turnStarted(sessionId: string, from?: string) {
    if (from === "waiting") return; // the same turn goes on after an answer
    const look = this.o.look(sessionId);
    if (!look || look.summary.parentSessionId) return;
    const prev = this.turns.get(sessionId);
    if (prev?.recovering) return void Object.assign(prev, { recovering: false, resumed: true });
    this.startTurn(sessionId, look.summary.projectPath);
  }

  private startTurn(sessionId: string, path: string): Turn {
    const t: Turn = { at: this.now() };
    this.turns.set(sessionId, t);
    this.serial(`s:${sessionId}`, () => this.begin(sessionId, path, t)).catch((e) => this.o.log(`${sessionId}: no checkpoint at the turn's start: ${(e as Error).message}`));
    return t;
  }

  turnEnded(sessionId: string, recovering?: boolean) {
    const t = this.turns.get(sessionId);
    if (!t) return;
    if (recovering) return void (t.recovering = true);
    this.turns.delete(sessionId);
    this.serial(`s:${sessionId}`, () => this.finish(sessionId, t)).catch((e) => this.o.log(`${sessionId}: no checkpoint at the turn's end: ${(e as Error).message}`));
  }

  /**
   * The turn's first message from the person labels its checkpoint. After a rate-limit retry
   * resumed the turn, a different message means something else was sent instead: a new turn.
   */
  message(sessionId: string, msg: Msg) {
    let t = this.turns.get(sessionId);
    if (!t || msg.role !== "user" || msg.origin || msg.localCommand) return;
    const text = msg.parts.find((p) => p.type === "text")?.text?.trim().replace(/\s+/g, " ");
    if (!text) return;
    const prompt = text.length > PROMPT_MAX ? `${text.slice(0, PROMPT_MAX - 1)}…` : text;
    if (t.msgId) {
      const look = this.o.look(sessionId);
      if (!t.resumed || msg.id === t.msgId || prompt === t.prompt || !look) return;
      this.turnEnded(sessionId);
      t = this.startTurn(sessionId, look.summary.projectPath);
    }
    t.prompt = prompt;
    t.msgId = msg.id;
    if (t.rec) {
      Object.assign(t.rec, { prompt: t.prompt, msgId: t.msgId });
      const sc = this.store.get(sessionId);
      if (sc) this.store.put(sc);
    }
  }

  // ---------- taking them ----------

  private async record(sessionId: string, root: string): Promise<SessionCheckpoints> {
    const sc = this.store.get(sessionId);
    if (sc && sc.root === root) return sc;
    // The folder is in another repo now: the old repo's refs go, and the list starts afresh.
    if (sc?.items.length) {
      const old = sc.root;
      await this.shared(old, () => updateRefs(old, {}, sc.items.map((c) => refName(sessionId, c.n)))).catch((e) => this.o.log(`${sessionId}: couldn't remove the checkpoints in ${old}: ${(e as Error).message}`));
    }
    return { sessionId, root, next: sc?.next ?? 1, items: [] };
  }

  private async begin(sessionId: string, path: string, t: Turn) {
    const root = await repoRoot(path).catch(() => undefined);
    if (!root) return;
    const sc = await this.record(sessionId, root);
    await this.shared(root, async () => {
      const snapAt = this.now();
      const snap = await snapshot(root, this.tmp);
      const late = this.now() - t.at > LATE_MS;
      const before = await commitTree(root, snap.tree, "Tether checkpoint");
      const last = sc.items.at(-1);
      if (last?.open) await this.close(root, sessionId, last, snap.tree);
      const rec: Checkpoint = {
        id: String(sc.next),
        n: sc.next,
        kind: "turn",
        at: t.at,
        snapAt,
        before,
        open: true,
        ...(late ? { late: true as const } : {}),
        ...(snap.left ? { left: snap.left } : {}),
        ...(snap.noUntracked ? { noUntracked: true as const } : {}),
        ...(t.prompt ? { prompt: t.prompt } : {}),
        ...(t.msgId ? { msgId: t.msgId } : {}),
      };
      sc.items.push(rec);
      sc.next++;
      const drop = this.prune(sc);
      await updateRefs(root, { [refName(sessionId, rec.n)]: before }, drop);
      t.rec = rec;
      this.store.put(sc);
    });
  }

  private async finish(sessionId: string, t: Turn) {
    const rec = t.rec;
    const sc = this.store.get(sessionId);
    if (!rec || !sc || !rec.open) return;
    await this.shared(sc.root, async () => {
      await this.close(sc.root, sessionId, rec, (await snapshot(sc.root, this.tmp)).tree);
      this.store.put(sc);
    });
  }

  /** Gives an open checkpoint its after snapshot. */
  private async close(root: string, sessionId: string, rec: Checkpoint, tree: string) {
    const beforeTree = await treeOf(root, rec.before);
    rec.after = beforeTree === tree ? rec.before : await commitTree(root, tree, "Tether checkpoint", rec.before);
    rec.files = beforeTree ? (beforeTree === tree ? 0 : await changedFiles(root, beforeTree, tree)) : undefined;
    rec.endedAt = this.now();
    delete rec.open;
    await updateRefs(root, { [refName(sessionId, rec.n)]: rec.after });
  }

  /** Drops what's past the newest CHECKPOINTS_MAX or older than CHECKPOINT_TTL_MS: the refs to delete. */
  private prune(sc: SessionCheckpoints): string[] {
    const cutoff = this.now() - CHECKPOINT_TTL_MS;
    const keep = sc.items.filter((c) => c.at >= cutoff).slice(-CHECKPOINTS_MAX);
    const kept = new Set(keep);
    const drop = sc.items.filter((c) => !kept.has(c)).map((c) => refName(sc.sessionId, c.n));
    sc.items = keep;
    return drop;
  }

  /** The TTL prune for every session on disk (at start). */
  async pruneAll() {
    for (const id of this.store.sessions()) {
      await this.serial(`s:${id}`, async () => {
        const sc = this.store.get(id);
        if (!sc) return;
        const drop = this.prune(sc);
        if (!drop.length) return;
        await this.shared(sc.root, () => updateRefs(sc.root, {}, drop)).catch(() => {});
        this.store.put(sc);
      });
    }
  }

  // ---------- ops ----------

  async list(sessionId: string): Promise<CheckpointList> {
    const look = await this.o.open(sessionId);
    const root = await repoRoot(look.summary.projectPath);
    if (!root) return { state: "notRepo", checkpoints: [], others: [] };
    await this.settled(sessionId);
    const sc = this.store.get(sessionId);
    const items = sc?.root === root ? sc.items : [];
    const others = this.others(sessionId, root);
    const blocked = blockedWhy(look, others);
    return { state: "ok", root, checkpoints: items.map(info).reverse(), others, ...(blocked ? { blocked } : {}) };
  }

  /** Live sessions in the repo besides this one (paths compared as real paths). */
  private others(sessionId: string, root: string): OtherSession[] {
    const r = real(root);
    return this.o
      .list()
      .filter((s) => s.id !== sessionId && !s.parentSessionId && (s.mode !== "stored" || s.status !== "idle") && inside(r, real(s.projectPath)))
      .map((s) => ({ id: s.id, title: s.title, status: s.status }));
  }

  /** What a checkpoint changed: before → after, or → the working tree while it's open. */
  async diff(sessionId: string, id: string | undefined): Promise<GitDiff> {
    const look = await this.o.open(sessionId);
    const root = await repoRoot(look.summary.projectPath);
    const none = { scope: "turn" as const, files: [], added: 0, removed: 0 };
    if (!root) return { ...none, state: "notRepo" };
    await this.settled(sessionId);
    const branch = await currentBranch(root);
    const where = { root, ...(branch ? { branch } : {}) };
    const sc = this.store.get(sessionId);
    const rec = sc?.root === root ? (id ? sc.items.find((c) => c.id === id) : sc.items.at(-1)) : undefined;
    if (!rec || !(await treeOf(root, rec.before))) return { ...none, ...where, state: "noBase" };
    // Outside the repo's lock: only a look, it never waits behind (or delays) a turn's snapshot.
    const to = rec.after ?? (await snapshot(root, this.tmp)).tree;
    return { scope: "turn", state: "ok", ...where, checkpoint: rec.id, base: `${rec.kind === "turn" ? `turn ${rec.n}` : "restore"}: before → ${rec.after ? "after" : "now"}`, ...(await diffRange(root, rec.before, { to })) };
  }

  /** Puts the files back to before checkpoint `id`, after checkpointing them as they are. */
  async restore(sessionId: string, id: string): Promise<RestoreResult> {
    const look = await this.o.open(sessionId);
    const root = await repoRoot(look.summary.projectPath);
    if (!root) throw new Error("This folder isn't in a git repository.");
    const blocked = () => blockedWhy(this.o.look(sessionId) ?? look, this.others(sessionId, root));
    const why = blocked();
    if (why) throw new Error(why);
    return this.serial(`s:${sessionId}`, () =>
      this.exclusive(root, async () => {
        const again = blocked();
        if (again) throw new Error(again);
        // Checked and held with no await between: from here what's sent waits in the queue.
        const release = this.o.hold?.(sessionId, "Restoring files…");
        try {
          return await this.restoring(sessionId, root, id, blocked);
        } finally {
          release?.();
        }
      }),
    );
  }

  private async restoring(sessionId: string, root: string, id: string, blocked: () => string | undefined): Promise<RestoreResult> {
    const sc = this.store.get(sessionId);
    const target = sc?.root === root ? sc.items.find((c) => c.id === id) : undefined;
    const targetTree = target && (await treeOf(root, target.before));
    if (!sc || !target || !targetTree) throw new Error("That checkpoint is gone.");
    let rec: Checkpoint | undefined;
    const r = await restoreTo(root, snapOf(target, targetTree), this.tmp, async (u) => {
      // The undo point, saved before any file changes; then a last look that nothing started.
      rec = {
        id: String(sc.next),
        n: sc.next,
        kind: "restore",
        at: this.now(),
        before: await commitTree(root, u.tree, "Tether checkpoint"),
        open: true,
        to: target.id,
        toN: target.n,
        ...(u.left ? { left: u.left } : {}),
        ...(u.noUntracked ? { noUntracked: true as const } : {}),
      };
      sc.items.push(rec);
      sc.next++;
      await updateRefs(root, { [refName(sessionId, rec.n)]: rec.before }, this.prune(sc));
      this.store.put(sc);
      const why = blocked();
      if (why) {
        sc.items = sc.items.filter((c) => c !== rec);
        await updateRefs(root, {}, [refName(sessionId, rec.n)]).catch(() => {});
        this.store.put(sc);
        throw new Error(why);
      }
    });
    const done = rec!;
    try {
      if (r.skipped.length) done.skipped = r.skipped.slice(0, 200);
      await this.close(root, sessionId, done, (await snapshot(root, this.tmp)).tree);
      this.o.log(`${sessionId}: restored files to before checkpoint ${target.n} (${r.written} written, ${r.removed} removed${r.skipped.length ? `, ${r.skipped.length} left alone` : ""})`);
      return { checkpoint: info(done), written: r.written, removed: r.removed, skipped: r.skipped };
    } finally {
      this.store.put(sc);
    }
  }
}

/** Subscribes checkpoints to the core's turns and messages; registers its ops. */
export function startCheckpoints(ctx: ModuleContext): { checkpoints: Checkpoints; stop: () => void } {
  const c = new Checkpoints({
    dir: join(ctx.dataDir, "checkpoints"),
    look: (id) => ctx.session(id),
    open: (id) => (ctx.session(id) ? Promise.resolve(ctx.session(id)!) : ctx.sessions.open(id)),
    list: () => ctx.sessions.list(),
    hold: ctx.sessions.hold ? (id, why) => ctx.sessions.hold!(id, why) : undefined,
    log: ctx.log,
  });
  const offs = [
    ctx.bus.on("turnStarted", ({ sessionId, from }) => c.turnStarted(sessionId, from)),
    ctx.bus.on("turnEnded", ({ sessionId, recovering }) => c.turnEnded(sessionId, recovering)),
    ctx.bus.on("message", ({ sessionId, msg }) => c.message(sessionId, msg)),
  ];
  ctx.ops.register("checkpoints", ({ sessionId }) => c.list(sessionId));
  ctx.ops.register("restoreCheckpoint", ({ sessionId, checkpointId }) => {
    if (typeof checkpointId !== "string") throw new Error("Which checkpoint?");
    return c.restore(sessionId, checkpointId);
  });
  void c.pruneAll().catch((e) => ctx.log(`checkpoints prune: ${(e as Error).message}`));
  return { checkpoints: c, stop: () => offs.forEach((f) => f()) };
}
