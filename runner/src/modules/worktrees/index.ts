// A worktree per session (SPEC §4). New session's "New worktree" (and the Home agent's start_session
// with worktree: true) makes a git worktree beside the folder's repo, on a new branch from the
// default branch, and starts the session there:
//
//   workspaceInfo        is the folder in git? where would a worktree go, from what, with what setup?
//   newWorktreeSession   git worktree add -> newSession in it -> recorded as the session's own -> setup
//
// The record (runner.json's `worktree` on the session: path, branch, main checkout) is what makes
// the worktree the session's own: the summary carries the main checkout as `worktreeOf`, and the
// Home agent's check-in (Archive done) removes it, and its branch, once the session is done and
// merged. The setup (`.tether/setup`, or `.tether/config.json`'s "setup") runs in the new worktree
// as a card in the session; until it succeeds what you send waits, held (core/live.ts setupEnded).
// It gets TETHER_WORKTREE, TETHER_REPO (the main checkout, to copy a .env from, say) and
// TETHER_BRANCH.

import type { Module, ModuleContext, SessionActions } from "..";
import type { OpArgs } from "../../../../shared/protocol";
import type { WorkspaceInfo, WorktreeMade } from "../../../../shared/worktree";
import { addWorktree, branchNameOk, defaultBase, findSetup, freeBranch, removeWorktree, repoOf, runGit, taken, worktreePath, type Git } from "./git";

export class Worktrees {
  constructor(
    private o: {
      sessions: SessionActions;
      /** newSession, as a browser calls it */
      newSession: (args: OpArgs<"newSession">) => Promise<{ sessionId: string }>;
      log?: (line: string) => void;
      git?: Git;
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
    if (!repo) return { git: false };
    const branch = await freeBranch(repo.main, "", this.git);
    const setup = findSetup(repo.top, repo.main);
    return { git: true, repo: repo.main, base: await defaultBase(repo.main, this.git), branch, path: worktreePath(repo.main, branch), ...(setup ? { setup: setup.label } : {}) };
  }

  /** Makes the worktree, starts the session in it, records it as the session's own and starts its setup. */
  async create(args: OpArgs<"newWorktreeSession">): Promise<WorktreeMade> {
    const { branch: asked, name, ...rest } = args;
    const folder = this.o.sessions.folder(String(args.projectPath ?? ""));
    const repo = await repoOf(folder, this.git);
    if (!repo) throw new Error(`${folder} isn't in a git repository, so there's no worktree to make.`);
    const base = await defaultBase(repo.main, this.git);
    const typed = typeof asked === "string" ? asked.trim() : "";
    if (typed && !(await branchNameOk(repo.main, typed, this.git))) throw new Error(`${typed} can't be a branch name.`);
    let branch = typed || (await freeBranch(repo.main, typeof name === "string" ? name : "", this.git));
    let path: string | undefined;
    // A branch picked here and taken meanwhile (another session made at the same moment): another one.
    for (let tries = 0; !path; tries++) {
      try {
        path = await addWorktree(repo.main, branch, base, this.git);
      } catch (e) {
        if (typed || tries >= 2 || !(await taken(repo.main, branch, this.git))) throw e;
        branch = await freeBranch(repo.main, typeof name === "string" ? name : "", this.git);
      }
    }
    let sessionId: string;
    try {
      ({ sessionId } = await this.o.newSession({ ...rest, projectPath: path }));
    } catch (e) {
      // Nobody has used it: it goes, branch and all.
      await removeWorktree(repo.main, path, branch, { force: true }, this.git);
      throw e;
    }
    await this.o.sessions.setWorktree?.(sessionId, { path, branch, repo: repo.main });
    this.o.log?.(`${sessionId}: made worktree ${path} on ${branch} from ${base}`);
    const setup = findSetup(path, repo.main);
    if (setup && this.o.sessions.setup) {
      const env = { TETHER_WORKTREE: path, TETHER_REPO: repo.main, TETHER_BRANCH: branch };
      const { done } = await this.o.sessions.setup(sessionId, setup.label, { ...(setup.argv ? { argv: setup.argv } : {}), env });
      void done.then(({ ok, why }) => this.o.log?.(`${sessionId}: setup ${ok ? "done" : `failed: ${why}`}`));
    }
    return { sessionId, path, branch, base, ...(setup ? { setup: setup.label } : {}) };
  }
}

export const worktreesModule: Module = {
  name: "worktrees",
  start(ctx: ModuleContext) {
    const w = new Worktrees({ sessions: ctx.sessions, newSession: (a) => ctx.ops.call("newSession", a), log: ctx.log });
    ctx.ops.register("workspaceInfo", (a) => w.info(String(a?.projectPath ?? "")));
    ctx.ops.register("newWorktreeSession", (a) => w.create(a));
  },
};
