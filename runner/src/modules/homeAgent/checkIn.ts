// "Ask all agents if they're done": the Home agent's check-in. It asks each idle session whether its
// task is done and all of its work is merged or applied, in a line it can parse, checks that claim
// against git where git can tell, and archives the sessions that are finished. The pieces here are
// pure or only read git; homeAgent/index.ts keeps the batches and does the asking and archiving.
//
// "All" is what Recent lists: top-level sessions from the last few days that aren't archived, other
// than the Home agent's own chats (optionally one project's, or named ones). Only those idle right
// now are asked; one running a turn, waiting for the person, with messages queued or background
// work, or open in a terminal is skipped and reported, never interrupted. The main checkout's
// uncommitted changes count as applied; a separate worktree or branch must be clean and in main.
//
// A session that is done and merged also removes the worktrees it made (and their merged local
// branches) in that same turn, and says so. It's told which folders it must never touch: the main
// checkout, its own folder, and every other recent session's folder in the same repo. A session is
// archived only when no worktree it used is left (git checks that too).

import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { SessionLook } from "..";
import type { SessionSummary } from "../../../../shared/transcript";
import { ANSWER_TAG, parseAnswer, type Answer } from "../../../../shared/checkIn";

// The answer line and its parsing are shared: the transcript and previews hide that line.
export { ANSWER_TAG, parseAnswer, type Answer };

/** How long a check-in waits for answers before reporting the rest as unanswered. */
export const CHECKIN_WAIT_MS = 10 * 60_000;
/** The most sessions one check-in asks: each answer is a turn. */
export const CHECKIN_MAX = 40;

/**
 * What a session is asked. `keep`: folders it must never remove (other sessions' folders in its
 * repo); its own folder and the main checkout are always named as off limits.
 */
export function checkInMessage(ownFolder: string, keep: string[] = []): string {
  const others = keep.filter((f) => resolve(f) !== resolve(ownFolder));
  return `Check-in from the Home agent: the person wants to know which sessions are finished, so finished ones can be archived.

Don't start or continue any task work in this turn. From what you know and a quick look at git:
1. Is the task you were given done (finished and verified, nothing left you meant to do)?
2. Is all of your work merged or applied? That means: everything is committed and merged into the main branch, or your changes are in the project's own working tree (uncommitted is fine there). It is NOT merged if any of it is only on a separate branch or in a separate worktree, or a PR is still open.
   Or is there nothing to merge? That is: the task never needed code kept (research, running a command, seeding local data, other local-only work), or the person asked you to discard the work. Then answer merged: false and nothing_to_merge: true, but only if no branch or PR with your unmerged work is left: delete a discarded branch (git branch -D <branch> only for work the person asked you to discard; also its remote branch if you pushed one) and close its PR.
3. Only if the task is done and its work is merged or there's nothing to merge: clean up before you answer. Remove each git worktree you created for this task (git worktree remove <path>, without --force) and delete its local branch if it's merged (git branch -d <branch>; -D only as above). If a worktree has uncommitted changes or its branch isn't merged (and wasn't discarded), leave it and answer merged: false, nothing_to_merge: false. Never remove or change:
   - the main checkout (the first entry of git worktree list),
   - your own folder (${ownFolder}),
   - any worktree you didn't create yourself${others.length ? `, including these, which other sessions are using:\n${others.map((f) => `     ${f}`).join("\n")}` : "."}
   If you're done but don't clean up (for one of those reasons), say why.

Give one or two sentences, then end your reply with exactly one line in this form (valid JSON after the tag, on one line):
${ANSWER_TAG} {"done": true, "merged": true, "nothing_to_merge": false, "cleaned_up": true, "branch": "the branch you worked on, or null", "worktree": "the absolute path of a separate worktree you used (even if you removed it), or null", "note": "a few words on what's left, or what you did"}
cleaned_up is true when no worktree you created is left (also when you never made one), false otherwise. branch is the branch you worked on even if you deleted it.`;
}

/** Why a session isn't asked, or undefined when it can be. */
export function skipReason(row: SessionSummary, look: SessionLook | undefined): string | undefined {
  if (row.mode === "terminal" || look?.state.terminal) return "it's open in a terminal";
  if (!look) return row.status === "idle" ? undefined : "it's running a turn";
  if (look.requests.length) return "it's waiting for the person";
  if (look.status !== "idle") return "it's running a turn";
  if (look.state.queue.length || look.state.queueHeld) return "it has messages queued";
  if (look.busy) return "it has work running";
  return undefined;
}

export type Git = (cwd: string, ...args: string[]) => Promise<string | undefined>;

/** git in a folder, read-mostly, with a time limit; undefined when it fails. */
export const runGit =
  (ms = 5000): Git =>
  async (cwd, ...args) => {
    try {
      const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" } });
      const t = setTimeout(() => p.kill(), ms);
      const s = await new Response(p.stdout).text();
      clearTimeout(t);
      return (await p.exited) === 0 ? s.trim() : undefined;
    } catch {
      return undefined;
    }
  };

const MAIN_NAMES = ["main", "master", "trunk"];

/** The repo's main branch refs that exist here: origin's default, then local and remote main/master. */
async function mainRefs(git: Git, cwd: string): Promise<string[]> {
  const out: string[] = [];
  const head = await git(cwd, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD");
  if (head) out.push(head);
  for (const n of MAIN_NAMES) for (const r of [n, `origin/${n}`]) if (!out.includes(r) && (await git(cwd, "rev-parse", "--verify", "--quiet", `${r}^{commit}`))) out.push(r);
  return out;
}

/** Whether every commit of `ref` is in one of `mains`, by ancestry or as an equal patch (a squash or rebase merge). */
async function inMain(git: Git, cwd: string, ref: string, mains: string[]): Promise<boolean> {
  for (const m of mains) {
    if ((await git(cwd, "merge-base", "--is-ancestor", ref, m)) !== undefined) return true;
    const cherry = await git(cwd, "cherry", m, ref);
    if (cherry !== undefined && cherry.split("\n").every((l) => !l.startsWith("+"))) return true;
  }
  return false;
}

/** The repo a folder is in (its common git dir), or undefined outside git. */
export async function repoOf(folder: string, git: Git = runGit()): Promise<string | undefined> {
  if (!existsSync(folder)) return undefined;
  const c = await git(folder, "rev-parse", "--path-format=absolute", "--git-common-dir");
  return c ? resolve(c) : undefined;
}

/** A repo's worktrees from git worktree list: the main checkout first. */
async function worktrees(git: Git, cwd: string): Promise<{ path: string; branch?: string }[]> {
  const out = await git(cwd, "worktree", "list", "--porcelain");
  if (!out) return [];
  return out
    .split(/\n\s*\n/)
    .map((block) => {
      const path = /^worktree (.+)$/m.exec(block)?.[1];
      const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1];
      return path ? { path: resolve(path), ...(branch ? { branch } : {}) } : undefined;
    })
    .filter((w): w is { path: string; branch?: string } => !!w);
}

/** The open PRs for a branch (their numbers), or undefined when that can't be told (no gh, no remote). */
export type OpenPrs = (cwd: string, branch: string) => Promise<number[] | undefined>;

/** Open PRs by gh, with a time limit. */
export const ghOpenPrs =
  (ms = 15_000): OpenPrs =>
  async (cwd, branch) => {
    try {
      const p = Bun.spawn(["gh", "pr", "list", "--head", branch, "--state", "open", "--json", "number", "--limit", "5"], { cwd, stdout: "pipe", stderr: "ignore", env: { ...process.env, GH_PROMPT_DISABLED: "1" } });
      const t = setTimeout(() => p.kill(), ms);
      const s = await new Response(p.stdout).text();
      clearTimeout(t);
      if ((await p.exited) !== 0) return undefined;
      const v = JSON.parse(s);
      return Array.isArray(v) ? v.map((x) => Number(x?.number)).filter((n) => Number.isFinite(n)) : undefined;
    } catch {
      return undefined;
    }
  };

export interface Findings {
  /** work git says isn't merged or applied */
  unmerged: string[];
  /** worktrees the session used that are still there */
  leftover: string[];
}

/**
 * What git says against the answer. Unmerged: the branch the session names, or its own folder
 * when that is a separate worktree, has uncommitted changes or commits not in main. The main
 * checkout's uncommitted changes count as applied (other sessions share it), so they aren't held
 * against anyone. Leftover: a worktree it names, or one on the branch it names, still exists; the
 * main checkout, its own folder and `keep` (other sessions' folders) are never counted as its
 * leftovers. No git: nothing found.
 */
export async function verify(projectPath: string, a: Answer, git: Git = runGit(), fetched = new Set<string>(), keep: string[] = [], prs: OpenPrs = ghOpenPrs()): Promise<Findings> {
  const found: Findings = { unmerged: [], leftover: [] };
  if (!existsSync(projectPath)) return found;
  const top = await git(projectPath, "rev-parse", "--show-toplevel");
  if (!top) return found;
  const common = await repoOf(projectPath, git);
  // Remote branches as they are now (a PR merged on the website), once per repo per check-in.
  if (common && !fetched.has(common)) {
    fetched.add(common);
    // --prune: a branch deleted on the remote (merged, or discarded) is gone here too.
    await runGit(15_000)(projectPath, "fetch", "--quiet", "--prune", "--no-tags", "origin").catch(() => undefined);
  }
  const mains = await mainRefs(git, projectPath);
  const own = resolve(top);
  const trees = await worktrees(git, projectPath);
  // Its own folder as a separate worktree: Tether started it there, so it stays; its work must be in.
  if (trees.length && trees[0]!.path !== own) {
    const status = await git(own, "status", "--porcelain");
    const n = status ? status.split("\n").length : 0;
    if (n) found.unmerged.push(`its worktree ${own} has ${n} uncommitted change${n === 1 ? "" : "s"}`);
    const branch = await git(own, "rev-parse", "--abbrev-ref", "HEAD");
    if (mains.length && branch && !MAIN_NAMES.includes(branch) && !(await inMain(git, own, "HEAD", mains))) found.unmerged.push(`its worktree ${own} is on ${branch}, which has commits not in ${mains[0]}`);
  }
  if (a.branch && mains.length && !MAIN_NAMES.includes(a.branch) && !mains.includes(a.branch)) {
    const ref = (await git(projectPath, "rev-parse", "--verify", "--quiet", `refs/heads/${a.branch}`)) ? a.branch : (await git(projectPath, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${a.branch}`)) ? `origin/${a.branch}` : undefined;
    // A branch that's gone was usually deleted after its merge.
    if (ref && !(await inMain(git, projectPath, ref, mains))) found.unmerged.push(`branch ${a.branch} has commits not in ${mains[0]}`);
  }
  // Nothing to merge: no PR may still be open for its branch.
  if (a.nothingToMerge && !a.merged && a.branch && !MAIN_NAMES.includes(a.branch) && !mains.includes(a.branch)) {
    const open = await prs(projectPath, a.branch).catch(() => undefined);
    if (open?.length) found.unmerged.push(`PR ${open.map((n) => `#${n}`).join(", ")} for ${a.branch} is still open`);
  }
  const named = a.worktree ? resolve(isAbsolute(a.worktree) ? a.worktree : join(top, a.worktree)) : undefined;
  const others = new Set(keep.map((f) => resolve(f)));
  for (const w of trees.slice(1))
    if (w.path !== own && !others.has(w.path) && (w.path === named || (!!a.branch && w.branch === a.branch))) found.leftover.push(w.path);
  return found;
}

/** Whether a session is finished, and why not. */
export function judge(a: Answer | undefined, f: Findings = { unmerged: [], leftover: [] }): { archive: boolean; reason: string } {
  if (!a) return { archive: false, reason: "its reply had no check-in line to go by" };
  if (!a.done) return { archive: false, reason: `not done${a.note ? `: ${a.note}` : ""}` };
  if (!a.merged && !a.nothingToMerge) return { archive: false, reason: `done, but not merged or applied${a.note ? `: ${a.note}` : ""}${a.branch ? ` (branch ${a.branch})` : ""}` };
  // Merged, or nothing to merge (discarded on request, local or data-only work, research): git must agree either way.
  const what = a.merged ? "merged" : "nothing to merge";
  if (f.unmerged.length) return { archive: false, reason: `says it's done and ${what}, but git disagrees: ${f.unmerged.join("; ")}` };
  if (f.leftover.length) return { archive: false, reason: `done and ${what}, but its worktree is still there: ${f.leftover.join(", ")}` };
  if (a.cleanedUp !== true) return { archive: false, reason: `done and ${what}, but it ${a.cleanedUp === false ? "didn't clean up its worktrees" : "didn't say whether it cleaned up its worktrees"}${a.note ? `: ${a.note}` : ""}` };
  return { archive: true, reason: a.note ?? `done, ${what} and cleaned up` };
}
