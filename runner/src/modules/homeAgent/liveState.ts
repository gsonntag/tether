// live_state: what's true now, for the Home agent, which has no shell. A session's last message is a
// claim as of when it was written ("PR #95 is ready to merge"); this checks such claims against the
// world: a GitHub PR's state (open, merged, closed; checks; via gh), and a folder's git state (does it
// still exist, which branch, uncommitted changes, pushed or not, merged into the default branch or
// not, the default branch's latest commits, the branch's PRs).
//
// Read-only: git reads, plus `git fetch origin` (only remote-tracking refs move, never a branch, the
// index or the working tree) so "pushed" and "merged" are as on the remote now; gh only views.
// Everything is an argv with a time limit; a PR reference is validated before it's passed.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { checksOf } from "../../../../shared/gitActions";
import { gh as runGh } from "../git/gh";
import { runGit, type Git } from "./checkIn";

/** gh with args in a folder: its stdout, or an error line. */
export type Gh = (cwd: string, args: string[]) => Promise<{ out?: string; error?: string }>;

export interface LiveDeps {
  git: Git;
  /** git fetch (slower limit); none: no fetch */
  fetch?: Git;
  gh: Gh;
  now: () => number;
}

export const systemGh: Gh = async (cwd, args) => {
  const bin = Bun.which("gh");
  if (!bin) return { error: "gh isn't installed on this machine" };
  const r = await runGh(bin, cwd, args);
  if (r.code === 0) return { out: r.out };
  return { error: (r.err.trim().split("\n").pop() || `gh failed (${r.code})`).slice(0, 300) };
};

export const liveDeps = (): LiveDeps => ({ git: runGit(), fetch: runGit(20_000), gh: systemGh, now: Date.now });

/** A time as "<iso> (<n> ago)". */
export function when(iso: string | number | undefined, now: number): string {
  if (iso === undefined || iso === "") return "unknown time";
  const t = typeof iso === "number" ? iso : Date.parse(iso);
  if (!Number.isFinite(t)) return String(iso);
  const m = Math.floor((now - t) / 60_000);
  const rel = m < 1 ? "just now" : m < 60 ? `${m}m ago` : m < 48 * 60 ? `${Math.floor(m / 60)}h ago` : `${Math.floor(m / 1440)}d ago`;
  return `${new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z")} (${rel})`;
}

/** A PR reference: 95, #95, owner/repo#95, or a GitHub PR URL. Undefined when it isn't one. */
export function parsePrRef(ref: string): { number: number; repo?: string } | undefined {
  const s = ref.trim();
  let m = /^#?(\d{1,9})$/.exec(s);
  if (m) return { number: Number(m[1]) };
  m = /^([\w.-]{1,100})\/([\w.-]{1,100})#(\d{1,9})$/.exec(s);
  if (m) return { repo: `${m[1]}/${m[2]}`, number: Number(m[3]) };
  m = /^https:\/\/github\.com\/([\w.-]{1,100})\/([\w.-]{1,100})\/pull\/(\d{1,9})(?:[/?#].*)?$/.exec(s);
  if (m) return { repo: `${m[1]}/${m[2]}`, number: Number(m[3]) };
  return undefined;
}

const PR_JSON = "number,title,url,state,isDraft,mergedAt,closedAt,mergeCommit,headRefName,baseRefName,statusCheckRollup,reviewDecision,updatedAt";

/** A PR as gh sees it now. `cwd`: a folder in its repo (needed when `ref` names no repo). */
export async function prState(ref: string, cwd: string | undefined, d: LiveDeps): Promise<string> {
  const p = parsePrRef(ref);
  if (!p) return `PR "${ref.slice(0, 100)}": not a PR reference (use 95, #95, owner/repo#95 or a GitHub PR URL).`;
  if (!p.repo && !cwd) return `PR #${p.number}: say which repo (owner/repo#${p.number}, or pass project_path or session_id).`;
  const where = cwd && existsSync(cwd) ? cwd : homedir();
  const r = await d.gh(where, ["pr", "view", String(p.number), "--json", PR_JSON, ...(p.repo ? ["--repo", p.repo] : [])]);
  if (r.error) return `PR #${p.number}: couldn't check (${r.error}).`;
  let j: Record<string, any>;
  try {
    j = JSON.parse(r.out ?? "");
  } catch {
    return `PR #${p.number}: gh answered with something that isn't a PR.`;
  }
  const state = String(j.state ?? "").toUpperCase();
  const head = `PR #${j.number} "${j.title ?? ""}" (${j.url ?? ""}), ${j.headRefName ?? "?"} → ${j.baseRefName ?? "?"}`;
  const lines = [head];
  if (state === "MERGED") lines.push(`State: MERGED at ${when(j.mergedAt, d.now())}${j.mergeCommit?.oid ? `, merge commit ${String(j.mergeCommit.oid).slice(0, 7)}` : ""}.`);
  else if (state === "CLOSED") lines.push(`State: CLOSED without merging at ${when(j.closedAt, d.now())}.`);
  else lines.push(`State: OPEN${j.isDraft ? " (draft)" : ""}, not merged. Last updated ${when(j.updatedAt, d.now())}.`);
  const checks = checksOf(j.statusCheckRollup);
  lines.push(`Checks: ${checks === "none" ? "none reported" : checks}${j.reviewDecision ? `. Review: ${String(j.reviewDecision).toLowerCase().replace(/_/g, " ")}` : ""}.`);
  return lines.join("\n");
}

const MAIN_NAMES = ["main", "master", "trunk"];

/** A branch name that's safe to put in a ref (no options, no ranges). */
const safeBranch = (b: string | undefined) => (b && /^[\w][\w./-]{0,200}$/.test(b) && !b.includes("..") ? b : undefined);

/** Whether every commit of `ref` is in `into`, by ancestry or as equal patches (a rebase merge). */
async function contained(git: Git, cwd: string, ref: string, into: string): Promise<boolean> {
  if ((await git(cwd, "merge-base", "--is-ancestor", ref, into)) !== undefined) return true;
  const cherry = await git(cwd, "cherry", into, ref);
  return cherry !== undefined && cherry.split("\n").every((l) => !l.startsWith("+"));
}

/**
 * A folder's git state now. `repoHint`: the main checkout of the repo it was a worktree of (a
 * session's worktreeOf), to say what's left when the folder is gone.
 */
export async function folderState(folder: string, d: LiveDeps, repoHint?: string): Promise<string> {
  const git = d.git;
  const lines: string[] = [`Folder ${folder}:`];
  if (!existsSync(folder)) {
    lines.push("- It no longer exists (the worktree or folder was removed).");
    if (repoHint && existsSync(repoHint)) {
      const list = await git(repoHint, "worktree", "list");
      if (list !== undefined) lines.push(`- The repo's worktrees now (${repoHint}):\n${indent(list)}`);
    }
    return lines.join("\n");
  }
  const top = await git(folder, "rev-parse", "--show-toplevel");
  if (!top) {
    lines.push("- Not a git repository.");
    return lines.join("\n");
  }
  const hasOrigin = (await git(folder, "remote", "get-url", "origin")) !== undefined;
  let fetched = false;
  if (hasOrigin && d.fetch) fetched = (await d.fetch(folder, "fetch", "--quiet", "--prune", "--no-tags", "origin")) !== undefined;
  const branch = await git(folder, "symbolic-ref", "--quiet", "--short", "HEAD");
  const headLine = await git(folder, "log", "-1", "--format=%h %s (%cr)");
  lines.push(`- ${branch ? `On branch ${branch}` : "Detached HEAD"}${headLine ? `, at ${headLine}` : ""}.`);
  // Which checkout it is.
  const trees = (await git(folder, "worktree", "list", "--porcelain")) ?? "";
  const paths = [...trees.matchAll(/^worktree (.+)$/gm)].map((m) => resolve(m[1]!));
  if (paths.length > 1) lines.push(resolve(top) === paths[0] ? `- It's the main checkout (${paths.length - 1} other worktree${paths.length === 2 ? "" : "s"}).` : `- It's a worktree of ${paths[0]}.`);
  const status = await git(folder, "status", "--porcelain");
  const n = status ? status.split("\n").filter(Boolean).length : 0;
  lines.push(n ? `- ${n} uncommitted change${n === 1 ? "" : "s"} (staged, unstaged or untracked).` : "- No uncommitted changes.");
  if (!hasOrigin) {
    lines.push("- No origin remote: nothing is pushed anywhere.");
    return lines.join("\n");
  }
  if (!fetched) lines.push("- Couldn't fetch from origin just now: remote facts below are as of the last fetch.");
  // The default branch, as on origin.
  const originHead = await git(folder, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD");
  let def = originHead;
  if (!def) for (const m of MAIN_NAMES) if (await git(folder, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${m}^{commit}`)) { def = `origin/${m}`; break; }
  const defName = def?.replace(/^origin\//, "");
  // Pushed or not.
  const b = safeBranch(branch ?? undefined);
  if (b) {
    const remote = await git(folder, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${b}^{commit}`);
    if (!remote) lines.push(`- Not pushed: origin has no branch ${b}${b === defName ? "" : " (never pushed, or deleted after a merge)"}.`);
    else {
      const counts = (await git(folder, "rev-list", "--left-right", "--count", `HEAD...refs/remotes/origin/${b}`))?.split(/\s+/).map(Number);
      const [ahead = 0, behind = 0] = counts ?? [];
      lines.push(ahead === 0 && behind === 0 ? `- Pushed: same as origin/${b}.` : `- origin/${b}: ${ahead ? `${ahead} local commit${ahead === 1 ? "" : "s"} not pushed` : "all local commits pushed"}${behind ? `, ${behind} commit${behind === 1 ? "" : "s"} on origin not pulled here` : ""}.`);
    }
  }
  if (def) {
    if (b && b !== defName) {
      const ahead = Number(await git(folder, "rev-list", "--count", `${def}..HEAD`));
      if (ahead === 0) lines.push(`- Merged: every commit here is in ${def}.`);
      else if (await contained(git, folder, "HEAD", def)) lines.push(`- Merged: its commits are in ${def} (as equal patches).`);
      else lines.push(`- Not in ${def}: ${Number.isFinite(ahead) ? `${ahead} commit${ahead === 1 ? "" : "s"}` : "commits"} here aren't on it (a squash merge doesn't show here: the PR's state below does).`);
    }
    const log = await git(folder, "log", "-5", "--format=%h %s (%cr, %an)", def);
    if (log) lines.push(`- Latest on ${def}:\n${indent(log)}`);
  }
  // The branch's PRs.
  if (b && b !== defName && !MAIN_NAMES.includes(b)) {
    const r = await d.gh(folder, ["pr", "list", "--head", b, "--state", "all", "--json", "number,state,url,mergedAt,closedAt,baseRefName", "--limit", "5"]);
    if (r.error) lines.push(`- Its PRs: couldn't check (${r.error}).`);
    else {
      let prs: Record<string, any>[] = [];
      try {
        const v = JSON.parse(r.out ?? "[]");
        if (Array.isArray(v)) prs = v;
      } catch {}
      if (!prs.length) lines.push(`- No PR from ${b}.`);
      for (const p of prs) {
        const s = String(p.state ?? "").toUpperCase();
        lines.push(`- PR #${p.number} (${p.url}) into ${p.baseRefName}: ${s === "MERGED" ? `MERGED at ${when(p.mergedAt, d.now())}` : s === "CLOSED" ? `CLOSED without merging at ${when(p.closedAt, d.now())}` : "OPEN, not merged"}.`);
      }
    }
  }
  return lines.join("\n");
}

const indent = (s: string) =>
  s
    .split("\n")
    .map((l) => `    ${l}`)
    .join("\n");

/** live_state's whole answer. `last`: when the session's last message was (to set the two apart). */
export async function liveState(a: { folder?: string; repoHint?: string; pr?: string; last?: number }, d: LiveDeps = liveDeps()): Promise<string> {
  const out = [`LIVE, checked just now (${when(d.now(), d.now()).split(" ")[0]}).`];
  if (a.last !== undefined) out.push(`The session's last message was at ${when(a.last, d.now())}: anything it said is as of then; where it differs from what's below, this is current.`);
  if (a.pr) out.push(await prState(a.pr, a.folder, d));
  if (a.folder) out.push(await folderState(a.folder, d, a.repoHint));
  return out.join("\n\n");
}
