// A worktree per session (SPEC §4). New session's "New worktree" (and tether_start with a
// worktree) makes a git worktree beside the folder's repo, on a new branch from the
// default branch (fetched first, best effort), and starts the session there. "Existing worktree"
// starts one in a worktree that's already there (made for another session, or by hand):
//
//   workspaceInfo           is the folder in git? where would a worktree go, from what, with what setup?
//   newWorktreeSession      (one per repo at a time) fetch -> git worktree add -> newSession in it ->
//                           recorded as the session's own -> setup
//   listWorktrees           the repo's other worktrees (git worktree list), and who works in each
//   existingWorktreeSession newSession in one of them -> recorded as one of its users (no setup)
//   rerunSetup              the setup again, after it failed or a restart cut it off
//   (archived event)        cleanUp: archiving a session removes the worktree Tether made, once safe
//
// The record (runner.json's `worktree` on the session: path, branch, main checkout, and the ignored
// files there once it was set up) is what makes the worktree the session's own: the summary carries
// the main checkout as `worktreeOf`, and archiving the session removes it, and its branch, once it's
// merged and clean and no other session uses it (one with a record there, or whose folder is in it). One made by hand is recorded too (`handMade`), but never removed; so is
// one whose only records are archived or name another branch (it may have been made again by hand). The
// setup (`.tether/setup`, or `.tether/config.json`'s "setup") runs in the new worktree as a card in
// the session; until it succeeds what you send waits, held (core/queue.ts setupStarted/setupEnded).
// It gets TETHER_WORKTREE, TETHER_REPO (the main checkout, to copy a .env from, say) and
// TETHER_BRANCH. Joining doesn't run it again: the worktree was set up when it was made.

import type { Module, ModuleContext, SessionActions, SessionLook } from "..";
import type { OpArgs } from "../../../../shared/protocol";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { WorkspaceInfo, WorktreeJoined, WorktreeList, WorktreeMade } from "../../../../shared/worktree";
import { pickWorktree, SETUP_MAX_MS } from "../../../../shared/worktree";
import type { WorktreeRecord } from "../../config";
import { addWorktree, branchNameOk, defaultBase, fetchBase, findSetup, freeBranch, gitWorktrees, ignoredFiles, lockWorktree, lastFetched, outsideUsers, removeOwnWorktree, repoOf, runGit, setupAt, shaOf, undoAdd, worktreePath, type Git, type IgnoredFiles, type Setup, sameStamp } from "./git";

/** At most this many ignored files are remembered as there after setup (more: the rest count as new). */
const KNOWN_MAX = 5000;
const capped = (k: IgnoredFiles): IgnoredFiles => Object.fromEntries(Object.entries(k).slice(0, KNOWN_MAX));


/**
 * What's known after a setup: the earlier known files still unchanged, and what the setup made or
 * changed (`after` against `before`, its start). Nothing new is known when `before` couldn't be
 * taken: those files then stay precious.
 */
export function knownAfter(had: IgnoredFiles, before: IgnoredFiles | undefined, after: IgnoredFiles): IgnoredFiles {
  const kept = Object.entries(had).filter(([p, st]) => sameStamp(after[p], st));
  const made = before ? Object.entries(after).filter(([p, st]) => !sameStamp(before[p], st)) : [];
  return Object.fromEntries([...kept, ...made]);
}

export class Worktrees {
  /** creates in progress, by repo: one at a time, so two can't pick (or clean up) the same branch */
  private locks = new Map<string, Promise<unknown>>();

  constructor(
    private o: {
      sessions: SessionActions;
      /** newSession, as a browser calls it */
      newSession: (args: OpArgs<"newSession">) => Promise<{ sessionId: string }>;
      log?: (line: string) => void;
      git?: Git;
      /** a setup's time limit (tests shorten it) */
      setupMs?: number;
      /** how many processes outside this runner work in a folder, undefined: can't tell (tests stub it) */
      usersOf?: (dir: string) => number | undefined;
      /** every session in memory */
      loaded?: () => SessionLook[];
    },
  ) {}

  private get git() {
    return this.o.git ?? runGit;
  }

  async info(projectPath: string): Promise<WorkspaceInfo> {
    let folder: string;
    try {
      folder = this.o.sessions.folder(projectPath);
    } catch {
      return { git: false };
    }
    const repo = await repoOf(folder, this.git);
    if (!repo || repo.unborn) return { git: false };
    const base = await defaultBase(repo.main, this.git);
    const branch = await freeBranch(repo.main, "", this.git);
    // What will run: as the base has it (the worktree is made from it), else the main checkout's.
    const setup = await setupAt(repo.main, base, this.git);
    const remote = base.startsWith("origin/");
    const fetchedAt = remote ? await lastFetched(repo.main, this.git) : undefined;
    return {
      git: true,
      repo: repo.main,
      base,
      branch,
      path: worktreePath(repo.main, branch),
      ...(setup ? { setup: setup.label, ...(setup.text !== undefined ? { setupText: setup.text } : {}), ...(setup.cut ? { setupTextCut: true } : {}) } : {}),
      setupId: setup?.id ?? "",
      ...(remote ? { remote: true } : {}),
      ...(fetchedAt ? { fetchedAt } : {}),
    };
  }

  /** `f` once the repo's earlier creates are done. */
  private async locked<T>(repo: string, f: () => Promise<T>): Promise<T> {
    const before = this.locks.get(repo) ?? Promise.resolve();
    const run = before.catch(() => {}).then(f);
    const tail = run.catch(() => {});
    this.locks.set(repo, tail);
    try {
      return await run;
    } finally {
      if (this.locks.get(repo) === tail) this.locks.delete(repo);
    }
  }

  /** Makes the worktree, starts the session in it, records it as the session's own and starts its setup. */
  async create(args: OpArgs<"newWorktreeSession">): Promise<WorktreeMade> {
    const { branch: asked, name, expectSetup, ...rest } = args;
    const folder = this.o.sessions.folder(String(args.projectPath ?? ""));
    const repo = await repoOf(folder, this.git);
    if (!repo) throw new Error(`${folder} isn't in a git repository, so there's no worktree to make.`);
    if (repo.unborn) throw new Error(`${repo.main} has no commits yet, so there's nothing to make a worktree from.`);
    const typed = typeof asked === "string" ? asked.trim() : "";
    if (typed && !(await branchNameOk(repo.main, typed, this.git))) throw new Error(`${typed} can't be a branch name.`);
    const text = typeof name === "string" ? name : "";
    const made = await this.locked(repo.main, async () => {
      const base = await defaultBase(repo.main, this.git);
      const fetched = base.startsWith("origin/") ? await fetchBase(repo.main, base, this.git) : undefined;
      const sha = await shaOf(this.git, repo.main, base);
      if (!sha) throw new Error(`There's no ${base} to start from.`);
      const setup = await setupAt(repo.main, sha, this.git);
      // The setup shown in the dialog came from before this fetch: one nobody saw never runs.
      if (typeof expectSetup === "string" && (setup?.id ?? "") !== expectSetup)
        throw new Error(setup ? `The setup changed on origin since you looked. Nothing was made. It's now ${setup.text ? `.tether/setup:\n${setup.text}` : `\`${setup.label}\``}\nCheck it, then create again.` : "The setup changed on origin since you looked: there's none now. Nothing was made; create again.");
      // A terminal starts its TUI at once: nothing would wait for the setup.
      if (args.terminal && setup) throw new Error(`This repo has a setup (${setup.label}) that runs before the first message, which a terminal start can't wait for. Start it in Tether, or in This folder.`);
      const branch = typed || (await freeBranch(repo.main, text, this.git));
      const path = await addWorktree(repo.main, branch, sha, this.git);
      return { base, branch, path, sha, ...(fetched !== undefined ? { fetched } : {}) };
    });
    const { base, branch, path, sha } = made;
    // What's ignored there before anyone works in it (a hook's output, say): removal on archive may delete it while unchanged.
    const known = await ignoredFiles(path, this.git);
    let sessionId: string;
    try {
      ({ sessionId } = await this.o.newSession({ ...rest, projectPath: path }));
    } catch (e) {
      // Nobody has used it: what this made goes, branch and all (only while it's still at its start).
      await undoAdd(repo.main, path, branch, sha, this.git);
      throw e;
    }
    await this.o.sessions.setWorktree?.(sessionId, { path, branch, repo: repo.main, ...(known && Object.keys(known).length ? { known: capped(known) } : {}) });
    this.o.log?.(`${sessionId}: made worktree ${path} on ${branch} from ${base}${made.fetched === false ? " (fetch failed: as last fetched)" : ""}`);
    const setup = findSetup(path, repo.main);
    if (setup) await this.runSetup(sessionId, { path, branch, repo: repo.main }, setup);
    return { sessionId, path, branch, base, ...(setup ? { setup: setup.label } : {}), ...(made.fetched !== undefined ? { fetched: made.fetched } : {}) };
  }

  /**
   * Runs the setup as the session's card. Ignored files are taken just before it starts and again
   * when it ends (at once, before anything waiting goes to the agent): what the setup made or
   * changed is remembered as the worktree's, with what was known and is still unchanged. Files made
   * by hand before it (a `!` command while it had failed) aren't, so they stay precious.
   */
  private async runSetup(sessionId: string, rec: WorktreeRecord, setup: Setup) {
    if (!this.o.sessions.setup) return;
    const env = { TETHER_WORKTREE: rec.path, TETHER_REPO: rec.repo, TETHER_BRANCH: rec.branch };
    const before = await ignoredFiles(rec.path, this.git);
    let after: IgnoredFiles | undefined;
    // Awaited before the queue is let go: the setup's gate holds meanwhile.
    const beforeRelease = async () => void (after = await ignoredFiles(rec.path, this.git));
    const { done } = await this.o.sessions.setup(sessionId, setup.label, { ...(setup.argv ? { argv: setup.argv } : {}), env, maxMs: this.o.setupMs ?? SETUP_MAX_MS, beforeRelease });
    void done.then(async ({ ok, why }) => {
      this.o.log?.(`${sessionId}: setup ${ok ? "done" : `failed: ${why}`}`);
      const now = this.o.sessions.worktree?.(sessionId);
      if (!after || !now) return;
      const had = now.known && !Array.isArray(now.known) ? now.known : {};
      await this.o.sessions.setWorktree?.(sessionId, { ...now, known: capped(knownAfter(had, before, after)) }).catch(() => {});
    });
  }

  /**
   * The sessions working in a worktree, not archived: those the lists show whose folder is in it,
   * and any recorded as its users (however old).
   */
  users(path: string): { id: string; title?: string }[] {
    const p = resolve(path);
    const out = new Map<string, string | undefined>();
    for (const r of this.o.sessions.list()) {
      const f = resolve(r.projectPath);
      if (!r.archived && !r.parentSessionId && (f === p || f.startsWith(`${p}/`))) out.set(r.id, r.title);
    }
    for (const u of this.o.sessions.worktreeUsers?.(p) ?? []) if (!u.archived && !out.has(u.id)) out.set(u.id, undefined);
    return [...out].map(([id, title]) => ({ id, ...(title ? { title } : {}) }));
  }

  /** The folder's repo's worktrees other than the main checkout (one whose folder is gone neither). */
  async list(projectPath: string): Promise<WorktreeList> {
    let folder: string;
    try {
      folder = this.o.sessions.folder(projectPath);
    } catch {
      return { worktrees: [] };
    }
    const repo = await repoOf(folder, this.git);
    if (!repo) return { worktrees: [] };
    const trees = (await gitWorktrees(repo.main, this.git)).filter((w) => !w.bare && !w.prunable && w.path !== repo.main && existsSync(w.path));
    return {
      repo: repo.main,
      worktrees: trees.map((w) => {
        const made = this.trusted(w.path, w.branch);
        return { path: w.path, ...(w.branch ? { branch: w.branch } : {}), sessions: this.users(w.path), ...(made && !made.handMade ? { tether: true } : {}) };
      }),
    };
  }

  /**
   * The record to go by for the worktree at `path`, now on `branch`: a user's still at work there
   * (not archived) on that same branch, one Tether made first. An archived user's, or one on another
   * branch, may be about a worktree long removed and made again by hand at that path: not trusted.
   */
  private trusted(path: string, branch: string | undefined): WorktreeRecord | undefined {
    const live = (this.o.sessions.worktreeUsers?.(path) ?? []).filter((u) => !u.archived && !!branch && u.worktree.branch === branch);
    return (live.find((u) => !u.worktree.handMade) ?? live[0])?.worktree;
  }

  /**
   * Starts a session in an existing worktree of the folder's repo (its path or branch), and records
   * it as one of the worktree's users: as a trusted record of it says (whether Tether made it), else
   * as one made by hand (never removed by Tether). Nothing is made and the setup doesn't run again.
   * Under the worktree's lock, which the removal on archive takes too: it can't go meanwhile.
   */
  async join(args: OpArgs<"existingWorktreeSession">): Promise<WorktreeJoined> {
    const { worktree: wanted, ...rest } = args;
    const folder = this.o.sessions.folder(String(args.projectPath ?? ""));
    const repo = await repoOf(folder, this.git);
    if (!repo) throw new Error(`${folder} isn't in a git repository, so it has no worktrees.`);
    const typed = typeof wanted === "string" ? wanted.trim() : "";
    if (!typed) throw new Error("Say which worktree: its path or branch.");
    const expand = (p: string) => {
      if (!p.startsWith("/") && !p.startsWith("~")) return p;
      try {
        return resolve(this.o.sessions.folder(p));
      } catch {
        return resolve(p.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
      }
    };
    const found = pickWorktree((await gitWorktrees(repo.main, this.git)).filter((x) => !x.bare), typed, expand);
    if (!found) throw new Error(`${typed} isn't one of ${repo.main}'s worktrees (git worktree list names them; a folder name several share doesn't say which).`);
    if (found.path === repo.main) throw new Error(`${found.path} is the repo's main checkout, not a worktree: start in This folder.`);
    return lockWorktree(found.path, async () => {
      // As git has it now: a removal may have finished while this waited.
      const w = (await gitWorktrees(repo.main, this.git)).find((x) => x.path === found.path);
      if (!w || w.prunable || !existsSync(w.path)) throw new Error(`${found.path} isn't there any more${w ? " (its folder is gone)" : ""}.`);
      const { sessionId } = await this.o.newSession({ ...rest, projectPath: w.path });
      const from = this.trusted(w.path, w.branch);
      const rec: WorktreeRecord = from ? { path: w.path, branch: from.branch, repo: from.repo, joined: true, ...(from.handMade ? { handMade: true } : {}) } : { path: w.path, branch: w.branch ?? "", repo: repo.main, joined: true, handMade: true };
      await this.o.sessions.setWorktree?.(sessionId, rec);
      this.o.log?.(`${sessionId}: joined worktree ${w.path}${w.branch ? ` on ${w.branch}` : ""}${rec.handMade ? " (not one Tether is sure it made: never removed by Tether)" : ""}`);
      return { sessionId, path: w.path, ...(w.branch ? { branch: w.branch } : {}), ...(rec.handMade ? {} : { tether: true }) };
    });
  }

  /** Re-run setup, after it failed (or a restart cut it off). */
  async rerun(sessionId: string) {
    // Claimed before anything waits: a double tap runs it once.
    if (this.rerunning.has(sessionId)) throw new Error("The setup is already running.");
    this.rerunning.add(sessionId);
    try {
      const rec = this.o.sessions.worktree?.(sessionId);
      if (!rec) throw new Error("This session isn't in a worktree Tether made.");
      const look = await this.o.sessions.open(sessionId);
      if (look.state.setup !== "failed") throw new Error(look.state.setup === "running" ? "The setup is already running." : "The setup isn't waiting to run again.");
      const setup = findSetup(rec.path, rec.repo);
      if (!setup) throw new Error(`There's no setup in ${rec.path} any more.`);
      await this.runSetup(sessionId, rec, setup);
    } finally {
      this.rerunning.delete(sessionId);
    }
  }

  /** sessions whose Re-run setup is on its way (until the setup has started) */
  private rerunning = new Set<string>();

  /**
   * A session was archived: the worktree Tether made for it (or another, that it joined) goes, with
   * its branch, once that's safe, and a notice in the session says so. Never one made by hand, nor
   * while another session that isn't archived works there, any session that uses it (recorded or in
   * memory, archived or not, the side chats of each too) still has work going or a side chat open,
   * a process outside this runner (a tmux session, a dev server) has its folder there or Tether
   * can't tell, or git can't confirm everything is in main and the tree is clean
   * (removeOwnWorktree). The work checks run again under the worktree's lock, right before the
   * removal. When it stays for a reason other than another session at work there, the notice says
   * why (`quiet`, the sweep: only the log). Unsure: it stays. Undefined: nothing to do.
   */
  async cleanUp(sessionId: string, o: { quiet?: boolean } = {}): Promise<{ removed: boolean; why?: string } | undefined> {
    const own = this.o.sessions.worktree?.(sessionId);
    if (!own || own.handMade || !own.branch) return undefined;
    const look = await this.o.sessions.open(sessionId).catch(() => undefined);
    // Only the session whose folder it is (one moved elsewhere since doesn't own it any more).
    if (!look || resolve(look.summary.projectPath) !== resolve(own.path)) return undefined;
    const early = busyWhy(look);
    if (early) return this.kept(sessionId, own.path, early, o.quiet);
    // Merged on the remote since the last fetch (a PR merged on the website): fetched first, best effort.
    const base = await defaultBase(own.repo, this.git).catch(() => "HEAD");
    if (base.startsWith("origin/")) await fetchBase(own.repo, base, this.git).catch(() => false);
    // One session of a worktree at a time, and never while one joins it.
    const r = await lockWorktree(own.path, async (): Promise<{ removed: boolean; why?: string; quiet?: boolean; gone?: boolean; branchKept?: string }> => {
      const users = this.o.sessions.worktreeUsers?.(own.path) ?? [];
      // Unarchived meanwhile: it's in use again.
      if (!users.find((u) => u.id === sessionId)?.archived) return { removed: false, why: "it was unarchived", quiet: true };
      const others = [...this.o.sessions.list().filter((r) => r.id !== sessionId && !r.archived).map((r) => r.projectPath), ...users.filter((u) => u.id !== sessionId && !u.archived).map((u) => u.worktree.path)];
      const user = others.map((f) => resolve(f)).find((f) => f === resolve(own.path) || f.startsWith(`${resolve(own.path)}/`));
      if (user) return { removed: false, why: `another session works in ${user}`, quiet: true };
      // Every session that uses it, archived or not, as it is now: none may have work going.
      const working = await this.atWork(own.path, [sessionId, ...users.map((u) => u.id)]);
      if (working) return { removed: false, why: working };
      const outside = existsSync(own.path) ? (this.o.usersOf ?? outsideUsers)(own.path) : 0;
      if (outside === undefined) return { removed: false, why: "Tether can't tell whether a process outside it works there" };
      if (outside) return { removed: false, why: `${outside} process${outside === 1 ? "" : "es"} outside Tether ${outside === 1 ? "works" : "work"} in it (a tmux session or a server, say)` };
      // What each session's setup left there (the one that made it ran it): files unchanged since may go.
      const known = Object.assign({}, ...users.map((u) => (u.worktree.known && !Array.isArray(u.worktree.known) ? u.worktree.known : {})), own.known && !Array.isArray(own.known) ? own.known : {});
      return removeOwnWorktree({ ...own, known }, [], this.git).catch((e) => ({ removed: false, why: (e as Error).message }));
    });
    if (!r.removed) {
      if (r.quiet) {
        this.o.log?.(`${sessionId}: archived; its worktree ${own.path} stays: ${r.why}`);
        return { removed: false, ...(r.why ? { why: r.why } : {}) };
      }
      return this.kept(sessionId, own.path, r.why ?? "git couldn't confirm it's safe to remove", o.quiet);
    }
    const what = r.gone ? `Its worktree folder ${own.path} was already gone, so Tether pruned git's record of it` : `Tether removed its worktree ${own.path}`;
    const branch = r.branchKept ? ` (its branch stays: ${r.branchKept})` : ` and branch ${own.branch}`;
    await this.notify(sessionId, `Archived: everything was merged. ${what}${branch}.`, "info");
    this.o.log?.(`${sessionId}: archived; removed its worktree ${own.path}`);
    return { removed: true };
  }

  /**
   * Why a worktree can't go yet because of the sessions in it: each of `ids` (opened as it is now),
   * any session in memory whose folder is in it, and the side chats of each. Undefined: none is at
   * work. A session that can't be opened counts as unsure.
   */
  private async atWork(path: string, ids: string[]): Promise<string | undefined> {
    const root = resolve(path);
    const inside = (f: string) => resolve(f) === root || resolve(f).startsWith(`${root}/`);
    const all = new Set(ids);
    for (const l of this.o.loaded?.() ?? []) if (inside(l.summary.projectPath)) all.add(l.summary.id);
    for (const id of [...all]) for (const side of this.o.sessions.sideChatsOf?.(id) ?? []) all.add(side);
    for (const id of all) {
      const look = await this.o.sessions.open(id).catch(() => undefined);
      if (!look) {
        // Gone from its harness's store: nothing runs it. Still in memory: unsure.
        if (this.o.loaded?.().some((l) => l.summary.id === id)) return `Tether couldn't check session ${id}`;
        continue;
      }
      const who = id === ids[0] ? "it" : look.summary.sideOf ? `its side chat ${id}` : `session ${id}`;
      const why = busyWhy(look);
      if (why) return `${who === "it" ? "" : `${who}: `}${why}`;
      if (look.summary.sideOf && !look.summary.archived) return `${who} is open`;
    }
    return undefined;
  }

  /**
   * At start and every SWEEP_MS: the archived sessions with a worktree Tether made that's still
   * there get cleanUp again (a restart cut one short, or it was busy when it was archived). Quiet:
   * only a removal is said in the session. Only a worktree git still lists on the record's branch
   * (one made again by hand at that path isn't Tether's).
   */
  async sweep(): Promise<void> {
    const seen = new Set<string>();
    for (const u of this.o.sessions.worktreeUsers?.() ?? []) {
      const path = resolve(u.worktree.path);
      if (!u.archived || u.worktree.handMade || !u.worktree.branch || seen.has(path) || !existsSync(path)) continue;
      const w = (await gitWorktrees(u.worktree.repo, this.git)).find((x) => x.path === path);
      if (!w || w.branch !== u.worktree.branch) continue;
      seen.add(path);
      await this.cleanUp(u.id, { quiet: true }).catch((e) => this.o.log?.(`${u.id}: worktree cleanup failed: ${(e as Error).message}`));
    }
  }

  private async kept(sessionId: string, path: string, why: string, quiet = false) {
    this.o.log?.(`${sessionId}: archived; its worktree ${path} stays: ${why}`);
    if (!quiet) await this.notify(sessionId, `Archived. Tether kept its worktree ${path}: ${why}.`, "info");
    return { removed: false, why };
  }

  private notify(sessionId: string, text: string, level: "info" | "warning") {
    return this.o.sessions.notice(sessionId, { id: `n-worktree-${Date.now().toString(36)}`, role: "notice", level, ts: Date.now(), parts: [{ type: "text", text }] }).catch(() => {});
  }
}

/** How often archived sessions' worktrees are looked at again (Worktrees.sweep). */
export const SWEEP_MS = 60 * 60_000;

/** Why a session still has work going (its worktree can't go), or undefined. */
export function busyWhy(look: SessionLook): string | undefined {
  const st = look.state;
  if (st.terminal || look.summary.mode === "terminal") return "it's open in a terminal";
  if (look.status !== "idle" || look.requests.length) return "it's still running a turn";
  if (st.retry) return "it's waiting to retry after a rate limit";
  if (st.setup === "running") return "its setup is still running";
  if (st.queue.length || st.queueHeld) return "it has messages waiting";
  if (look.busy || look.background || st.watching?.length) return "it still has work running";
  return undefined;
}

export const worktreesModule: Module = {
  name: "worktrees",
  start(ctx: ModuleContext) {
    const w = new Worktrees({ sessions: ctx.sessions, newSession: (a) => ctx.ops.call("newSession", a), log: ctx.log, ...(ctx.loaded ? { loaded: ctx.loaded } : {}) });
    ctx.ops.register("workspaceInfo", (a) => w.info(String(a?.projectPath ?? "")));
    ctx.ops.register("newWorktreeSession", (a) => w.create(a));
    ctx.ops.register("listWorktrees", (a) => w.list(String(a?.projectPath ?? "")));
    ctx.ops.register("existingWorktreeSession", (a) => w.join(a));
    ctx.ops.register("rerunSetup", async (a) => (await w.rerun(String(a?.sessionId ?? "")), null));
    const off = ctx.bus.on("archived", ({ sessionId, archived }) => {
      if (archived) void w.cleanUp(sessionId).catch((e) => ctx.log(`${sessionId}: worktree cleanup failed: ${(e as Error).message}`));
    });
    // What a restart cut short, or a session busy when it was archived: looked at again, soon after start and hourly.
    const sweep = () => void w.sweep().catch((e) => ctx.log(`worktree sweep failed: ${(e as Error).message}`));
    const first = setTimeout(sweep, 60_000);
    const every = setInterval(sweep, SWEEP_MS);
    first.unref?.();
    every.unref?.();
    return () => {
      off();
      clearTimeout(first);
      clearInterval(every);
    };
  },
};
