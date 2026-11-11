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

import { existsSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
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

Don't start or continue any task work in this turn, and don't stop anything you started that's still running. From what you know and a quick look at git:
1. Is the task you were given done (finished and verified, nothing left you meant to do)?
2. Is all of your work merged or applied? That means: everything is committed and merged into the branch your work targets, or your changes are in the project's own working tree (uncommitted is fine there). The target is usually the main branch, but some projects collect or deploy work from another branch (a deploy branch, say, when the person wants all work there): merged into that intended branch on the remote counts as merged, and you name it as target. It is NOT merged if any of it is only on a separate branch or in a separate worktree, or a PR is still open.
   Or is there nothing to merge? That is: the task never needed code kept (research, running a command, seeding local data, other local-only work), or the person asked you to discard the work. Then answer merged: false and nothing_to_merge: true, but only if no branch or PR with your unmerged work is left: delete a discarded branch (git branch -D <branch> only for work the person asked you to discard; also its remote branch if you pushed one) and close its PR.
3. Did you start anything that's still running and in use: a dev server, a tmux session, docker containers (a local database, say), a watcher, a port-forward? Leave it running and name it in running, with its tmux session names and ports so Tether can check, e.g. "local stack (tmux jungle-dev, Supabase :54421, app :3005)". null if nothing is.
4. Only if the task is done and its work is merged or there's nothing to merge: clean up before you answer. Before removing a worktree, check that nothing is running in it (lsof +D <path>, or ls -l /proc/*/cwd 2>/dev/null | grep <path>): if something is, leave the worktree and answer cleaned_up: false. Remove each other git worktree you created for this task (git worktree remove <path>, without --force) and delete its local branch if it's merged (git branch -d <branch>; -D only as above). If a worktree has uncommitted changes or its branch isn't merged (and wasn't discarded), leave it and answer merged: false, nothing_to_merge: false. Never remove or change:
   - the main checkout (the first entry of git worktree list),
   - your own folder (${ownFolder}),
   - any worktree you didn't create yourself${others.length ? `, including these, which other sessions are using:\n${others.map((f) => `     ${f}`).join("\n")}` : "."}
   If you're done but don't clean up (for one of those reasons), say why.

Give one or two sentences, then end your reply with exactly one line in this form (valid JSON after the tag, on one line):
${ANSWER_TAG} {"done": true, "merged": true, "nothing_to_merge": false, "cleaned_up": true, "branch": "the branch you worked on, or null", "target": "the branch your work was meant to land in, e.g. main, or null", "worktree": "the absolute path of a separate worktree you used (even if you removed it), or null", "running": "what you started that's still running, or null", "note": "a few words on what's left, or what you did"}
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

/** A PR from a branch: its number, state and the branch it goes into. */
export interface Pr {
  number: number;
  state: "OPEN" | "MERGED" | "CLOSED";
  base: string;
}

/** The PRs from a branch, or undefined when that can't be told (no gh, no GitHub remote). */
export type Prs = (cwd: string, branch: string) => Promise<Pr[] | undefined>;

/** A branch's PRs by gh, with a time limit. */
export const ghPrs =
  (ms = 15_000): Prs =>
  async (cwd, branch) => {
    try {
      const p = Bun.spawn(["gh", "pr", "list", "--head", branch, "--state", "all", "--json", "number,state,baseRefName", "--limit", "10"], { cwd, stdout: "pipe", stderr: "ignore", env: { ...process.env, GH_PROMPT_DISABLED: "1" } });
      const t = setTimeout(() => p.kill(), ms);
      const s = await new Response(p.stdout).text();
      clearTimeout(t);
      if ((await p.exited) !== 0) return undefined;
      const v = JSON.parse(s);
      if (!Array.isArray(v)) return undefined;
      return v
        .map((x) => ({ number: Number(x?.number), state: x?.state, base: x?.baseRefName }))
        .filter((x): x is Pr => Number.isFinite(x.number) && ["OPEN", "MERGED", "CLOSED"].includes(x.state) && typeof x.base === "string" && !!x.base);
    } catch {
      return undefined;
    }
  };

/** A branch name that's safe to put in a ref (no options, no ranges). */
const branchName = (b: string | undefined) => (b && /^[\w][\w./-]{0,200}$/.test(b) && !b.includes("..") ? b : undefined);

export interface Findings {
  /** work git says isn't merged or applied */
  unmerged: string[];
  /** worktrees the session used that are still there */
  leftover: string[];
}

/**
 * What git says against the answer. Merged means in a target branch: the repo's main branch, the
 * target the session names, or the base of a PR from its branch (open or merged), each only as it
 * is on the remote (origin/<target>). Unmerged: the branch the session names, or its own folder
 * when that is a separate worktree, has uncommitted changes or commits in no target, or a PR from
 * its branch is still open. The main
 * checkout's uncommitted changes count as applied (other sessions share it), so they aren't held
 * against anyone. Leftover: a worktree it names, or one on the branch it names, still exists; the
 * main checkout, its own folder and `keep` (other sessions' folders) are never counted as its
 * leftovers. No git: nothing found.
 */
export async function verify(projectPath: string, a: Answer, git: Git = runGit(), fetched = new Set<string>(), keep: string[] = [], prs: Prs = ghPrs()): Promise<Findings> {
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
  const branch = branchName(a.branch);
  // The branch's PRs (undefined: can't tell), and the branches its work may land in.
  const prList = branch && !MAIN_NAMES.includes(branch) ? await prs(projectPath, branch).catch(() => undefined) : undefined;
  const extra: string[] = [];
  for (const t of [branchName(a.target), ...(prList ?? []).filter((p) => p.state !== "CLOSED").map((p) => branchName(p.base))]) {
    const r = t && `origin/${t}`;
    if (r && !mains.includes(r) && !extra.includes(r) && (await git(projectPath, "rev-parse", "--verify", "--quiet", `refs/remotes/${r}^{commit}`))) extra.push(r);
  }
  const targets = [...extra, ...mains];
  const into = targets[0];
  const own = resolve(top);
  const trees = await worktrees(git, projectPath);
  // Its own folder as a separate worktree: Tether started it there, so it stays; its work must be in.
  if (trees.length && trees[0]!.path !== own) {
    const status = await git(own, "status", "--porcelain");
    const n = status ? status.split("\n").length : 0;
    if (n) found.unmerged.push(`its worktree ${own} has ${n} uncommitted change${n === 1 ? "" : "s"}`);
    const head = await git(own, "rev-parse", "--abbrev-ref", "HEAD");
    if (into && head && !MAIN_NAMES.includes(head) && !(await inMain(git, own, "HEAD", targets))) found.unmerged.push(`its worktree ${own} is on ${head}, which has commits not in ${into}`);
  }
  if (branch && into && !MAIN_NAMES.includes(branch) && !mains.includes(branch)) {
    const ref = (await git(projectPath, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`)) ? branch : (await git(projectPath, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`)) ? `origin/${branch}` : undefined;
    // A branch that's gone was usually deleted after its merge. One that is itself the target (work
    // done on a deploy branch) must be on the remote.
    if (ref && !targets.includes(ref) && !(await inMain(git, projectPath, ref, targets))) found.unmerged.push(`branch ${branch} has commits not in ${into}`);
  }
  // A PR from its branch that's still open: not merged, whatever the commits say.
  for (const p of prList ?? []) if (p.state === "OPEN") found.unmerged.push(`PR #${p.number} from ${branch} into ${p.base} is still open`);
  const named = a.worktree ? resolve(isAbsolute(a.worktree) ? a.worktree : join(top, a.worktree)) : undefined;
  const others = new Set(keep.map((f) => resolve(f)));
  for (const w of trees.slice(1))
    if (w.path !== own && !others.has(w.path) && (w.path === named || (!!a.branch && w.branch === a.branch))) found.leftover.push(w.path);
  return found;
}

/** What can be asked of the machine cheaply: whether a tmux session or a listening port is live, and what runs in a folder. */
export interface Probe {
  /** a tmux session by name; undefined: can't tell */
  tmux(name: string): Promise<boolean | undefined>;
  /** the TCP ports something listens on; undefined: can't tell */
  ports(): Promise<Set<number> | undefined>;
  /** how many processes (other than this one) have their working folder in `dir` */
  usersOf(dir: string): Promise<number>;
}

/** The listening ports in a /proc/net/tcp file's text (state 0A). */
export function listeningPorts(text: string): number[] {
  return text
    .split("\n")
    .slice(1)
    .map((l) => l.trim().split(/\s+/))
    .filter((f) => f[3] === "0A" && f[1]?.includes(":"))
    .map((f) => parseInt(f[1]!.split(":").pop()!, 16))
    .filter((n) => Number.isFinite(n));
}

export const systemProbe: Probe = {
  async tmux(name) {
    try {
      const p = Bun.spawn(["tmux", "has-session", "-t", `=${name}`], { stdout: "ignore", stderr: "ignore" });
      const t = setTimeout(() => p.kill(), 3000);
      const code = await p.exited;
      clearTimeout(t);
      return code === 0;
    } catch {
      return undefined;
    }
  },
  async ports() {
    const out = new Set<number>();
    let read = false;
    for (const f of ["/proc/net/tcp", "/proc/net/tcp6"]) {
      try {
        for (const n of listeningPorts(readFileSync(f, "utf8"))) out.add(n);
        read = true;
      } catch {}
    }
    return read ? out : undefined;
  },
  async usersOf(dir) {
    const root = resolve(dir);
    let n = 0;
    let pids: string[] = [];
    try {
      pids = readdirSync("/proc").filter((p) => /^\d+$/.test(p) && Number(p) !== process.pid);
    } catch {
      return 0;
    }
    for (const pid of pids) {
      try {
        const cwd = readlinkSync(`/proc/${pid}/cwd`);
        if (cwd === root || cwd.startsWith(`${root}/`)) n++;
      } catch {}
    }
    return n;
  },
};

/** The tmux sessions and ports a running-description names ("tmux jungle-dev", ":54421", "port 3005"). */
export function namedInRunning(desc: string): { tmux: string[]; ports: number[] } {
  const tmux = [...desc.matchAll(/\btmux(?:\s+session)?\s+[`'"]?([\w.-]+)/gi)].map((m) => m[1]!);
  const ports = [...desc.matchAll(/(?:\bport\s+|:)(\d{2,5})\b/gi)].map((m) => Number(m[1])).filter((n) => n > 0 && n < 65536);
  return { tmux: [...new Set(tmux)], ports: [...new Set(ports)] };
}

/**
 * What a session still has running, as far as the machine confirms: its own description when one
 * thing it names is live, or nothing it names can be checked (then its word is taken); undefined
 * when everything it names is gone. Also any process working in the separate worktree it names.
 */
export async function stillRunning(a: Answer, probe: Probe = systemProbe, ownFolder?: string): Promise<string | undefined> {
  const out: string[] = [];
  if (a.running) {
    const named = namedInRunning(a.running);
    const checks: (boolean | undefined)[] = await Promise.all(named.tmux.map((t) => probe.tmux(t).catch(() => undefined)));
    if (named.ports.length) {
      const live = await probe.ports().catch(() => undefined);
      checks.push(...named.ports.map((p) => (live ? live.has(p) : undefined)));
    }
    if (!checks.length || checks.some((c) => c !== false)) out.push(a.running);
  }
  const wt = a.worktree && isAbsolute(a.worktree) ? resolve(a.worktree) : undefined;
  if (wt && wt !== (ownFolder && resolve(ownFolder)) && existsSync(wt)) {
    const n = await probe.usersOf(wt).catch(() => 0);
    if (n) out.push(`${n} process${n === 1 ? "" : "es"} working in ${wt}`);
  }
  return out.length ? out.join("; ") : undefined;
}

/**
 * Whether a session is finished, and why not. `running`: what it still has running (stillRunning),
 * which keeps it whatever else is true, and leads the reason.
 */
export function judge(a: Answer | undefined, f: Findings = { unmerged: [], leftover: [] }, running?: string): { archive: boolean; reason: string } {
  const v = judgeWork(a, f);
  if (!running) return v;
  return { archive: false, reason: `still running: ${running}${v.archive ? "" : `. Also ${v.reason}`}` };
}

function judgeWork(a: Answer | undefined, f: Findings): { archive: boolean; reason: string } {
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
