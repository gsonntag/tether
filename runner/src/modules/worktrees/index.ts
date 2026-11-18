// A worktree per session (SPEC §4). New session's "New worktree" (and the Home agent's start_session
// with worktree: true) makes a git worktree beside the folder's repo, on a new branch from the
// default branch (fetched first, best effort), and starts the session there:
//
//   workspaceInfo        is the folder in git? where would a worktree go, from what, with what setup?
//   newWorktreeSession   (one per repo at a time) fetch -> git worktree add -> newSession in it ->
//                        recorded as the session's own -> setup
//   rerunSetup           the setup again, after it failed or a restart cut it off
//
// The record (runner.json's `worktree` on the session: path, branch, main checkout, and the ignored
// files there once it was set up) is what makes the worktree the session's own: the summary carries
// the main checkout as `worktreeOf`, and the Home agent's check-in (Archive done) removes it, and its
// branch, once the session is done and merged. The setup (`.tether/setup`, or `.tether/config.json`'s
// "setup") runs in the new worktree as a card in the session; until it succeeds what you send waits,
// held (core/queue.ts setupStarted/setupEnded). It gets TETHER_WORKTREE, TETHER_REPO (the main
// checkout, to copy a .env from, say) and TETHER_BRANCH.

import type { Module, ModuleContext, SessionActions } from "..";
import type { OpArgs } from "../../../../shared/protocol";
import type { WorkspaceInfo, WorktreeMade } from "../../../../shared/worktree";
import { SETUP_MAX_MS } from "../../../../shared/worktree";
import type { WorktreeRecord } from "../../config";
import { addWorktree, branchNameOk, defaultBase, fetchBase, findSetup, freeBranch, ignoredFiles, lastFetched, repoOf, runGit, setupAt, shaOf, undoAdd, worktreePath, type Git, type IgnoredFiles, type Setup } from "./git";

/** At most this many ignored files are remembered as there after setup (more: the rest count as new). */
const KNOWN_MAX = 5000;
const capped = (k: IgnoredFiles): IgnoredFiles => Object.fromEntries(Object.entries(k).slice(0, KNOWN_MAX));

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
    // What's ignored there before anyone works in it (a hook's output, say): Archive done may delete it while unchanged.
    const known = ignoredFiles(path);
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
   * Runs the setup as the session's card. When it ends, what it left (ignored files, with their
   * size and time) is taken at once, before anything waiting goes to the agent, and remembered as
   * the worktree's.
   */
  private async runSetup(sessionId: string, rec: WorktreeRecord, setup: Setup) {
    if (!this.o.sessions.setup) return;
    const env = { TETHER_WORKTREE: rec.path, TETHER_REPO: rec.repo, TETHER_BRANCH: rec.branch };
    let after: IgnoredFiles | undefined;
    const beforeRelease = () => void (after = ignoredFiles(rec.path));
    const { done } = await this.o.sessions.setup(sessionId, setup.label, { ...(setup.argv ? { argv: setup.argv } : {}), env, maxMs: this.o.setupMs ?? SETUP_MAX_MS, beforeRelease });
    void done.then(async ({ ok, why }) => {
      this.o.log?.(`${sessionId}: setup ${ok ? "done" : `failed: ${why}`}`);
      const now = this.o.sessions.worktree?.(sessionId);
      const had = now?.known && !Array.isArray(now.known) ? now.known : {};
      if (after && now) await this.o.sessions.setWorktree?.(sessionId, { ...now, known: capped({ ...had, ...after }) }).catch(() => {});
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
}

export const worktreesModule: Module = {
  name: "worktrees",
  start(ctx: ModuleContext) {
    const w = new Worktrees({ sessions: ctx.sessions, newSession: (a) => ctx.ops.call("newSession", a), log: ctx.log });
    ctx.ops.register("workspaceInfo", (a) => w.info(String(a?.projectPath ?? "")));
    ctx.ops.register("newWorktreeSession", (a) => w.create(a));
    ctx.ops.register("rerunSetup", async (a) => (await w.rerun(String(a?.sessionId ?? "")), null));
  },
};
