// The git side of a worktree per session (SPEC §4): which repo a folder is in, where a new worktree
// starts, a branch and folder nobody has yet, making the worktree, and the repo's setup.
//
// git runs as argv (never through a shell), with a time limit, no prompts (GIT_TERMINAL_PROMPT=0)
// and without Tether's secrets in its environment. Hooks: `git worktree add` runs the repo's
// post-checkout hook, as it does when a person types it. Tether leaves that on on purpose: it is the
// repo's own code (an LFS or husky hook may be what makes the checkout usable), and the session's
// agent runs with the same access in that folder a moment later anyway. Nothing is fetched: a new
// worktree starts from the remote-tracking branch as the last fetch left it.

import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { childEnv } from "../../childEnv";
import { folderForBranch, randomSlug, slugOf, WORKTREE_BRANCH_PREFIX } from "../../../../shared/worktree";

export interface GitResult {
  ok: boolean;
  out: string;
  err: string;
}

export type Git = (cwd: string, args: string[], ms?: number) => Promise<GitResult>;

/** How long a quick git question may take. */
const QUICK_MS = 10_000;
/** How long `git worktree add` may take (a big checkout, a slow hook). */
export const ADD_MS = 5 * 60_000;

/**
 * git in a folder: argv, no shell, no prompts, a time limit. It runs in a process group of its own,
 * so a hook still running at the limit is killed with it.
 */
export const runGit: Git = (cwd, args, ms = QUICK_MS) =>
  new Promise((done) => {
    let p: ChildProcess;
    try {
      p = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], detached: true, env: childEnv({ GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "" }) });
    } catch (e) {
      return done({ ok: false, out: "", err: (e as Error).message });
    }
    let out = "";
    let err = "";
    p.stdout!.on("data", (b: Buffer) => (out += b.toString()));
    p.stderr!.on("data", (b: Buffer) => (err += b.toString()));
    const t = setTimeout(() => {
      try {
        process.kill(-p.pid!, "SIGKILL");
      } catch {}
      done({ ok: false, out: out.trim(), err: `git ${args[0]} took longer than ${Math.round(ms / 1000)} s` });
    }, ms);
    p.on("error", (e) => {
      clearTimeout(t);
      done({ ok: false, out: "", err: e.message });
    });
    p.on("close", (code) => {
      clearTimeout(t);
      done({ ok: code === 0, out: out.trim(), err: err.trim() });
    });
  });

export interface Repo {
  /** the checkout `folder` is in (a worktree's own top, or the main one) */
  top: string;
  /** the repo's main checkout: new worktrees go beside it */
  main: string;
}

/** The repo a folder is in, or undefined outside git (or in a bare repo, which has no main checkout). */
export async function repoOf(folder: string, git: Git = runGit): Promise<Repo | undefined> {
  if (!existsSync(folder) || !statSync(folder).isDirectory()) return undefined;
  const top = await git(folder, ["rev-parse", "--show-toplevel"]);
  if (!top.ok || !top.out) return undefined;
  const list = await git(folder, ["worktree", "list", "--porcelain"]);
  const first = list.ok ? list.out.split(/\n\s*\n/)[0] : undefined;
  if (!first || /^bare$/m.test(first)) return undefined;
  const main = /^worktree (.+)$/m.exec(first)?.[1];
  return main ? { top: resolve(top.out), main: resolve(main) } : undefined;
}

const exists = async (git: Git, cwd: string, ref: string) => (await git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).ok;

/**
 * Where a new worktree starts: origin's default branch (origin/HEAD), else main or master (the
 * remote-tracking one when there is one), else the main checkout's HEAD.
 */
export async function defaultBase(main: string, git: Git = runGit): Promise<string> {
  const head = await git(main, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (head.ok && head.out && (await exists(git, main, `refs/remotes/${head.out}`))) return head.out;
  for (const n of ["main", "master"]) {
    if (await exists(git, main, `refs/remotes/origin/${n}`)) return `origin/${n}`;
    if (await exists(git, main, `refs/heads/${n}`)) return n;
  }
  return "HEAD";
}

/** Where a worktree for `branch` goes: `<repo>/../<repo>-worktrees/<slug>`. */
export const worktreePath = (main: string, branch: string) => join(dirname(main), `${basename(main)}-worktrees`, folderForBranch(branch));

/** Whether git takes `name` as a new branch's name. */
export async function branchNameOk(main: string, name: string, git: Git = runGit): Promise<boolean> {
  if (!name || name.startsWith("-") || name.length > 200) return false;
  return (await git(main, ["check-ref-format", "--branch", name])).ok;
}

/** Whether a branch or a folder is taken: the branch exists, or something is at its worktree's path. */
export async function taken(main: string, branch: string, git: Git = runGit): Promise<string | undefined> {
  if (await exists(git, main, `refs/heads/${branch}`)) return `The branch ${branch} already exists.`;
  const path = worktreePath(main, branch);
  if (existsSync(path)) return `${path} already exists.`;
  return undefined;
}

/**
 * A branch nobody has yet, and its folder: `tether/<slug>` from `text` (a first message, a title),
 * else a short random one; `-2`, `-3`, … after a slug that's taken.
 */
export async function freeBranch(main: string, text = "", git: Git = runGit): Promise<string> {
  const slug = slugOf(text) || randomSlug();
  for (let n = 1; n < 50; n++) {
    const branch = `${WORKTREE_BRANCH_PREFIX}${n === 1 ? slug : `${slug}-${n}`}`;
    if (!(await taken(main, branch, git))) return branch;
  }
  return `${WORKTREE_BRANCH_PREFIX}${randomSlug()}`;
}

/**
 * Makes the worktree: `git worktree add --no-track -b <branch> <path> <base>` from the main
 * checkout. `--no-track`: the new branch doesn't take the base as its upstream, so a push makes its
 * own. Refuses a branch or folder that is taken. Throws with git's words when it fails.
 */
export async function addWorktree(main: string, branch: string, base: string, git: Git = runGit): Promise<string> {
  const why = await taken(main, branch, git);
  if (why) throw new Error(why);
  const path = worktreePath(main, branch);
  const r = await git(main, ["worktree", "add", "--no-track", "-b", branch, path, base], ADD_MS);
  if (!r.ok) {
    // Whatever half of it git left (a hook that failed after the checkout) goes too.
    if (existsSync(path)) await removeWorktree(main, path, branch, { force: true }, git);
    throw new Error(`git worktree add failed: ${lastLines(r.err) || "no reason given"}`);
  }
  return path;
}

/**
 * Removes a worktree and its branch. Without `force` (Archive done): only a clean worktree goes
 * (`git worktree remove` refuses one with changes or untracked files), and its branch with
 * `branch -d`, or `-D` when `merged` says its commits are in main. With `force`: one Tether just
 * made and nobody has used (a session that didn't start).
 */
export async function removeWorktree(main: string, path: string, branch: string, o: { force?: boolean; merged?: boolean } = {}, git: Git = runGit): Promise<{ ok: boolean; why?: string; branchKept?: string }> {
  if (existsSync(path)) {
    const r = await git(main, ["worktree", "remove", ...(o.force ? ["--force"] : []), path], 60_000);
    if (!r.ok) return { ok: false, why: lastLines(r.err) || "git worktree remove failed" };
  } else await git(main, ["worktree", "prune"]);
  if (!(await exists(git, main, `refs/heads/${branch}`))) return { ok: true };
  const d = await git(main, ["branch", o.force || o.merged ? "-D" : "-d", branch]);
  return d.ok ? { ok: true } : { ok: true, branchKept: lastLines(d.err) };
}

const lastLines = (s: string) => s.split("\n").filter(Boolean).slice(-3).join(" ").slice(0, 400);

/** A repo's setup for new worktrees: what the card shows, and how it runs. */
export interface Setup {
  /** ".tether/setup", or the config's command */
  label: string;
  /** an executable, run directly */
  argv?: string[];
  /** a command, run by $SHELL -c */
  command?: string;
}

/**
 * The setup new worktrees run before the first message: `.tether/setup` (an executable file), else
 * `.tether/config.json`'s `"setup"` command. The worktree's own (committed) files first, then the
 * main checkout's (one kept out of git there still counts).
 */
export function findSetup(...dirs: string[]): Setup | undefined {
  for (const dir of dirs) {
    const script = join(dir, ".tether", "setup");
    try {
      if (statSync(script).isFile()) {
        accessSync(script, constants.X_OK);
        return { label: ".tether/setup", argv: [script] };
      }
    } catch {}
    try {
      const cfg = JSON.parse(readFileSync(join(dir, ".tether", "config.json"), "utf8"));
      const cmd = typeof cfg?.setup === "string" ? cfg.setup.trim() : "";
      if (cmd) return { label: cmd, command: cmd };
    } catch {}
  }
  return undefined;
}
