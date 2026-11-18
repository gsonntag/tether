// The git side of a worktree per session (SPEC §4): which repo a folder is in, where a new worktree
// starts, a branch and folder nobody has yet, making the worktree, and the repo's setup.
//
// git runs as argv (never through a shell), with a time limit, no prompts (GIT_TERMINAL_PROMPT=0)
// and without Tether's secrets in its environment. Hooks: `git worktree add` runs the repo's
// post-checkout hook, as it does when a person types it. Tether leaves that on on purpose: it is the
// repo's own code (an LFS or husky hook may be what makes the checkout usable), and the session's
// agent runs with the same access in that folder a moment later anyway. Before branching from
// origin/<x> it fetches that branch, best effort (15 s, no prompts); a failed fetch leaves the base
// as the last fetch left it.

import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, existsSync, readdirSync, readFileSync, rmdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { childEnv } from "../../childEnv";
import { folderForBranch, hashSlug, randomSlug, slugOf, WORKTREE_BRANCH_PREFIX } from "../../../../shared/worktree";

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
  /** it has no commit yet: nothing to branch from */
  unborn?: boolean;
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
  if (!main) return undefined;
  const born = await exists(git, main, "HEAD");
  return { top: resolve(top.out), main: resolve(main), ...(born ? {} : { unborn: true }) };
}

const exists = async (git: Git, cwd: string, ref: string) => (await git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).ok;

/** A ref's commit, or undefined. */
export const shaOf = async (git: Git, cwd: string, ref: string) => {
  const r = await git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  return r.ok && r.out ? r.out : undefined;
};

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

/** How long the fetch before a new worktree may take. */
export const FETCH_MS = 15_000;

/**
 * Best effort, before branching from origin/<x>: `git fetch origin <x>`, with no prompts (ssh in
 * batch mode) and a time limit. Whether it worked; a failure leaves the base as it was.
 */
export async function fetchBase(main: string, base: string, git: Git = runGit): Promise<boolean> {
  const m = /^origin\/(.+)$/.exec(base);
  if (!m) return false;
  return (await git(main, ["-c", "core.sshCommand=ssh -o BatchMode=yes", "fetch", "--quiet", "--no-tags", "origin", `+refs/heads/${m[1]}:refs/remotes/origin/${m[1]}`], FETCH_MS)).ok;
}

/** When origin was last fetched here (FETCH_HEAD's time), or undefined. */
export async function lastFetched(main: string, git: Git = runGit): Promise<number | undefined> {
  const dir = await git(main, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  try {
    return dir.ok ? statSync(join(dir.out, "FETCH_HEAD")).mtimeMs : undefined;
  } catch {
    return undefined;
  }
}

/** Where a worktree for `branch` goes: `<repo>/../<repo>-worktrees/<slug>`. */
export const worktreesDir = (main: string) => join(dirname(main), `${basename(main)}-worktrees`);
export const worktreePath = (main: string, branch: string) => join(worktreesDir(main), folderForBranch(branch));

/** Whether git takes `name`, exactly as typed, as a new branch's name. */
export async function branchNameOk(main: string, name: string, git: Git = runGit): Promise<boolean> {
  if (!name || name.startsWith("-") || name.length > 200 || name === "@" || name.includes("@{")) return false;
  const r = await git(main, ["check-ref-format", "--branch", name]);
  return r.ok && r.out === name;
}

/**
 * Whether a branch or a folder is taken: the branch exists here or on a remote (`origin/<name>`),
 * or something is at its worktree's path.
 */
export async function taken(main: string, branch: string, git: Git = runGit): Promise<string | undefined> {
  if (await exists(git, main, `refs/heads/${branch}`)) return `The branch ${branch} already exists.`;
  const remotes = await git(main, ["for-each-ref", "--format=%(refname)", "refs/remotes"]);
  const remote = remotes.out.split("\n").find((r) => /^refs\/remotes\/[^/]+\//.test(r) && r.replace(/^refs\/remotes\/[^/]+\//, "") === branch);
  if (remote) return `The branch ${branch} already exists on ${remote.split("/")[2]}.`;
  const path = worktreePath(main, branch);
  if (existsSync(path)) return `${path} already exists.`;
  return undefined;
}

/**
 * A branch nobody has yet, and its folder: `tether/<slug>` from `text` (a first message, a title),
 * else one from a hash of the text (the same text, the same slug), else a short random one; `-2`,
 * `-3`, … after a slug that's taken.
 */
export async function freeBranch(main: string, text = "", git: Git = runGit): Promise<string> {
  const slug = slugOf(text) || (text.trim() ? hashSlug(text) : randomSlug());
  for (let n = 1; n < 50; n++) {
    const branch = `${WORKTREE_BRANCH_PREFIX}${n === 1 ? slug : `${slug}-${n}`}`;
    if (!(await taken(main, branch, git))) return branch;
  }
  return `${WORKTREE_BRANCH_PREFIX}${randomSlug()}`;
}

/**
 * Makes the worktree: `git worktree add --no-track -b <branch> <path> <base>` from the main
 * checkout. `--no-track`: the new branch doesn't take the base as its upstream, so a push makes its
 * own. Refuses a branch or folder that is taken. When git fails, only what this call made goes: the
 * folder if it wasn't there before and git lists it as a worktree on this branch, the branch if it
 * wasn't there before and still points at the base, and the `<repo>-worktrees` folder if this made it
 * and it's empty. A path git refused because it exists is never touched.
 */
export async function addWorktree(main: string, branch: string, base: string, git: Git = runGit): Promise<string> {
  const why = await taken(main, branch, git);
  if (why) throw new Error(why);
  const path = worktreePath(main, branch);
  const parent = worktreesDir(main);
  const parentBefore = existsSync(parent);
  const baseSha = await shaOf(git, main, base);
  if (!baseSha) throw new Error(`There's no ${base} to start from.`);
  const r = await git(main, ["worktree", "add", "--no-track", "-b", branch, path, baseSha], ADD_MS);
  if (!r.ok) {
    // Refused because the folder or the branch exists (someone else's, made meanwhile): never touched.
    if (!/already exists/i.test(r.err)) await undoAdd(main, path, branch, baseSha, git);
    if (!parentBefore) rmEmpty(parent);
    throw new Error(`git worktree add failed: ${lastLines(r.err) || "no reason given"}`);
  }
  return path;
}

/** What a failed (or unused) add of ours left: the worktree if git lists it on our branch, the branch if it's still at `sha`. */
export async function undoAdd(main: string, path: string, branch: string, sha: string, git: Git = runGit) {
  if ((await worktreeOn(main, path, git)) === branch) await git(main, ["worktree", "remove", "--force", path], 60_000);
  await git(main, ["worktree", "prune"]);
  await git(main, ["update-ref", "-d", `refs/heads/${branch}`, sha]);
}

/** The branch git lists the worktree at `path` on (undefined: not a worktree of this repo). */
export async function worktreeOn(main: string, path: string, git: Git = runGit): Promise<string | undefined> {
  const list = await git(main, ["worktree", "list", "--porcelain"]);
  for (const block of list.out.split(/\n\s*\n/)) {
    if (/^worktree (.+)$/m.exec(block)?.[1] && resolve(/^worktree (.+)$/m.exec(block)![1]!) === resolve(path)) return /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? "";
  }
  return undefined;
}

function rmEmpty(dir: string) {
  try {
    if (!readdirSync(dir).length) rmdirSync(dir);
  } catch {}
}

/** Ignored folders that only hold what a build or an install makes again: Archive done may delete them. */
export const REGENERABLE = new Set(["node_modules", "dist", "build", "target", ".venv", "venv", "__pycache__", ".next", ".turbo", "coverage", ".cache"]);

/** A worktree's ignored files and folders (`ls-files -o -i --directory`), as git lists them ("dir/" for a folder). */
export async function ignoredIn(path: string, git: Git = runGit): Promise<string[] | undefined> {
  const r = await git(path, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"], 30_000);
  if (!r.ok) return undefined;
  const all = r.out.split("\0").filter(Boolean);
  // A folder git lists beside what's ignored inside it ("pkg/" with "pkg/build/") adds nothing.
  return all.filter((p) => !(p.endsWith("/") && all.some((q) => q !== p && q.startsWith(p))));
}

/**
 * The ignored files removing a worktree would lose: all but regenerable folders (anywhere in the
 * tree) and what was already there right after it was made and set up (`known`).
 */
export function precious(ignored: string[], known: string[] = []): string[] {
  const k = new Set(known);
  return ignored.filter((p) => !k.has(p) && !p.replace(/\/$/, "").split("/").some((seg) => REGENERABLE.has(seg)));
}

/**
 * Removes a worktree and its branch. Without `force` (Archive done): only a clean worktree goes
 * (`git worktree remove` refuses one with changes or untracked files), and its branch only as
 * `branchAt` says: deleted when it still points at that commit (checked against main by the caller),
 * else kept. With `force`: one Tether just made and nobody has used (a session that didn't start).
 */
export async function removeWorktree(main: string, path: string, branch: string, o: { force?: boolean; branchAt?: string } = {}, git: Git = runGit): Promise<{ ok: boolean; why?: string; branchKept?: string; gone?: boolean }> {
  let gone = false;
  if (existsSync(path)) {
    const r = await git(main, ["worktree", "remove", ...(o.force ? ["--force"] : []), path], 60_000);
    if (!r.ok) return { ok: false, why: lastLines(r.err) || "git worktree remove failed" };
  } else {
    gone = true;
    await git(main, ["worktree", "prune"]);
  }
  if (!(await exists(git, main, `refs/heads/${branch}`))) return { ok: true, ...(gone ? { gone } : {}) };
  if (!o.branchAt) return { ok: true, branchKept: "its commits aren't all in main", ...(gone ? { gone } : {}) };
  const d = await git(main, ["update-ref", "-d", `refs/heads/${branch}`, o.branchAt]);
  return { ok: true, ...(d.ok ? {} : { branchKept: "it moved while Tether checked it" }), ...(gone ? { gone } : {}) };
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
  /** the script's text (shown before it's made) */
  text?: string;
}

const SETUP_TEXT_MAX = 2000;

const configCommand = (json: string): string | undefined => {
  try {
    const cfg = JSON.parse(json);
    const cmd = typeof cfg?.setup === "string" ? cfg.setup.trim() : "";
    return cmd || undefined;
  } catch {
    return undefined;
  }
};

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
        return { label: ".tether/setup", argv: [script], text: readFileSync(script, "utf8").slice(0, SETUP_TEXT_MAX) };
      }
    } catch {}
    try {
      const cmd = configCommand(readFileSync(join(dir, ".tether", "config.json"), "utf8"));
      if (cmd) return { label: cmd, command: cmd };
    } catch {}
  }
  return undefined;
}

/**
 * The setup a worktree made from `ref` will run, read from git before it's made: the ref's own
 * `.tether/setup` (mode 100755) or config.json, else the main checkout's files (findSetup's order).
 */
export async function setupAt(main: string, ref: string, git: Git = runGit): Promise<Setup | undefined> {
  const tree = await git(main, ["ls-tree", ref, ".tether/setup", ".tether/config.json"]);
  const mode = /^(\d+) blob \S+\t\.tether\/setup$/m.exec(tree.out)?.[1];
  if (mode === "100755") {
    const text = await git(main, ["cat-file", "blob", `${ref}:.tether/setup`]);
    return { label: ".tether/setup", text: text.out.slice(0, SETUP_TEXT_MAX) };
  }
  if (/\t\.tether\/config\.json$/m.test(tree.out)) {
    const cmd = configCommand((await git(main, ["cat-file", "blob", `${ref}:.tether/config.json`])).out);
    if (cmd) return { label: cmd, command: cmd };
  }
  return findSetup(main);
}
