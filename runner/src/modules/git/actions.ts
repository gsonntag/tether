// Git actions (SPEC §10 Git actions): the branch as the Changes pane header shows it, Commit and Push.
// git as an argv in the session's folder (run.ts), with time limits; Commit and Push run the repo's
// hooks, as git itself would, and show what they printed when they fail. Push is never forced.
//
// Commit takes what the Uncommitted scope shows: `git add -A` (tracked changes, staged or not, and
// untracked files that aren't ignored), then `git commit` with the message on stdin. A commit a hook
// refused leaves those changes staged. git's own identity is used, never one it would make up
// (`user.useConfigOnly`): none configured, Commit says so. The default branch refuses unless the box
// says to commit there anyway (`onDefault`).

import { outputTail, type GitActionResult, type GitStatus } from "../../../../shared/gitActions";
import { currentBranch, defaultBranch, repoRoot } from "./diff";
import { git, GitError } from "./run";

const COMMIT_MS = 120_000;
const PUSH_MS = 90_000;

/** git's identity, never auto-detected. */
const OWN_IDENTITY = ["-c", "user.useConfigOnly=true"];

const NOT_REPO: GitStatus = { state: "notRepo", ahead: 0, behind: 0, origin: false, changed: 0 };

/** The default branch's local name: "origin/main" → "main". */
export const localName = (ref: string) => ref.replace(/^origin\//, "");

/** Entries in `git status --porcelain -z`: a rename or copy carries its old path as one more field. */
export function countStatus(out: string): number {
  const t = out.split("\0");
  let n = 0;
  for (let i = 0; i < t.length; i++) {
    const e = t[i]!;
    if (e.length < 4) continue;
    n++;
    if (e[0] === "R" || e[0] === "C") i++;
  }
  return n;
}

/** The repo's root and its branch, ahead/behind its upstream (as of the last fetch or push), the default branch and git's identity. */
export async function gitStatus(cwd: string): Promise<GitStatus> {
  const root = await repoRoot(cwd);
  if (!root) return NOT_REPO;
  const opt = { ok: [0, 1, 128] };
  const [branch, head, up, def, origin, st, ident] = await Promise.all([
    currentBranch(root),
    git(root, ["rev-parse", "--verify", "--quiet", "--short", "HEAD"], opt),
    git(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], opt),
    defaultBranch(root),
    git(root, ["config", "--get", "remote.origin.url"], opt),
    git(root, ["status", "--porcelain", "-z", "--untracked-files=all"]),
    git(root, [...OWN_IDENTITY, "var", "GIT_COMMITTER_IDENT"], opt),
  ]);
  const upstream = up.code === 0 ? up.out.trim() || undefined : undefined;
  let ahead = 0;
  let behind = 0;
  if (upstream) {
    const c = await git(root, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], opt);
    const m = c.out.trim().match(/^(\d+)\s+(\d+)$/);
    if (m) [ahead, behind] = [Number(m[1]), Number(m[2])];
  }
  const identity = ident.code === 0 ? ident.out.trim().replace(/\s+\d+\s+[+-]\d{4}$/, "") : "";
  return {
    state: "ok",
    root,
    ...(branch ? { branch } : {}),
    ...(head.code === 0 && head.out.trim() ? { head: head.out.trim() } : {}),
    ...(upstream ? { upstream } : {}),
    ahead,
    behind,
    ...(def ? { defaultBranch: localName(def) } : {}),
    origin: origin.code === 0 && !!origin.out.trim(),
    changed: countStatus(st.out),
    ...(identity ? { identity } : {}),
  };
}

const fail = (status: GitStatus, error: string, output?: string): GitActionResult => ({ ok: false, error, ...(output ? { output } : {}), status });

export const NO_IDENTITY = 'git has no name and email to commit with on this computer. Set them there: git config --global user.name "Your Name" and git config --global user.email you@example.com.';

/** `git add -A` and `git commit` with `message`. Refusals and failures come back as `error` (with git's or a hook's output). */
export async function commit(cwd: string, message: string, onDefault = false): Promise<GitActionResult> {
  const status = await gitStatus(cwd);
  if (status.state !== "ok" || !status.root) return fail(status, "This folder isn't in a git repository.");
  if (!message.trim()) return fail(status, "Write a commit message first.");
  if (!status.changed) return fail(status, "Nothing to commit.");
  if (!status.branch) return fail(status, "HEAD is detached: check out a branch to commit on.");
  if (status.branch === status.defaultBranch && !onDefault) return fail(status, `${status.branch} is the default branch. Tick “Commit to ${status.branch} anyway” to commit to it.`);
  if (!status.identity) return fail(status, NO_IDENTITY);
  const root = status.root;
  try {
    await git(root, ["add", "-A"], { timeoutMs: COMMIT_MS });
    await git(root, [...OWN_IDENTITY, "commit", "-q", "--file=-"], { input: message.trim() + "\n", hooks: true, timeoutMs: COMMIT_MS, env: { GIT_EDITOR: ":" } });
  } catch (e) {
    const after = await gitStatus(cwd).catch(() => status);
    if (!(e instanceof GitError)) return fail(after, (e as Error).message);
    const out = outputTail(e.stderr);
    return fail(after, /too long/.test(e.message) ? "git commit took too long (a hook?)." : /identity|tell me who you are/i.test(e.stderr) ? NO_IDENTITY : "The commit failed. Nothing was committed.", out);
  }
  const after = await gitStatus(cwd);
  return { ok: true, ...(after.head ? { commit: after.head } : {}), status: after };
}

/** What a failed push says, in a line. */
export function pushError(stderr: string): string {
  if (/\[rejected\]|non-fast-forward|fetch first|\(stale info\)/i.test(stderr)) return "origin has commits this branch doesn't. Pull or rebase first: Tether never forces a push.";
  if (/authentication failed|could not read (username|password)|permission denied|denied to|403|terminal prompts disabled/i.test(stderr)) return "origin refused the sign-in. Check git's credentials for it on this computer.";
  if (/could not resolve host|unable to access|connection (refused|timed out)|could not read from remote/i.test(stderr)) return "Couldn't reach origin.";
  if (/pre-push hook|hook declined/i.test(stderr)) return "The pre-push hook refused the push.";
  return "The push failed.";
}

/** `git push -u origin <branch>`: never forced. */
export async function push(cwd: string): Promise<GitActionResult> {
  const status = await gitStatus(cwd);
  if (status.state !== "ok" || !status.root) return fail(status, "This folder isn't in a git repository.");
  if (!status.branch) return fail(status, "HEAD is detached: check out a branch to push.");
  if (!status.origin) return fail(status, "There's no remote called origin to push to.");
  if (!status.head) return fail(status, "There are no commits to push.");
  try {
    await git(status.root, ["push", "-u", "origin", `refs/heads/${status.branch}:refs/heads/${status.branch}`], { hooks: true, timeoutMs: PUSH_MS });
  } catch (e) {
    const after = await gitStatus(cwd).catch(() => status);
    if (!(e instanceof GitError)) return fail(after, (e as Error).message);
    return fail(after, /too long/.test(e.message) ? "The push took too long." : pushError(e.stderr), outputTail(e.stderr));
  }
  return { ok: true, status: await gitStatus(cwd) };
}
