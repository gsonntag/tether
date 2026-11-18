// Git actions (SPEC §10 Git actions): the Changes pane header's branch and ahead/behind, Commit, Push
// and Open PR, and a session's PR chip. The runner's git module runs git and `gh`; this is what it
// sends, and the pure reading of `gh pr view --json`'s output into it.

/** The folder's branch as the header shows it. Local git only: nothing here asks the network. */
export interface GitStatus {
  state: "ok" | "notRepo";
  root?: string;
  /** the checked-out branch; none when detached */
  branch?: string;
  /** HEAD's short commit id; none in a repo with no commits */
  head?: string;
  /** e.g. "origin/feature", as of the last fetch or push */
  upstream?: string;
  /** commits HEAD has that the upstream doesn't, and the reverse */
  ahead: number;
  behind: number;
  /** the default branch's local name ("main"), when there is one */
  defaultBranch?: string;
  /** a remote called origin exists (Push and Open PR need it) */
  origin: boolean;
  /** files in Uncommitted: what Commit would take */
  changed: number;
  /** the committer as git will write it, "Name <email>"; none when git has no identity configured */
  identity?: string;
}

export type PrState = "open" | "draft" | "merged" | "closed";
export type ChecksState = "passing" | "failing" | "pending" | "none";

export interface PrInfo {
  number: number;
  url: string;
  title: string;
  state: PrState;
  checks: ChecksState;
  /** the PR's branch */
  branch?: string;
}

/** A session's PR, as `gitPr` finds it. */
export interface PrLookup {
  /** `missing`: no gh on the runner; `unauthed`: gh isn't signed in; `noRemote`: no origin; `notGithub`: origin isn't a host gh knows; `error`: gh failed (`error` says how) */
  gh: "ok" | "missing" | "unauthed" | "noRemote" | "notGithub" | "error";
  pr?: PrInfo;
  error?: string;
  /** when gh was last asked (ms) */
  at: number;
}

/** What Commit, Push and Open PR answer. A refusal or a failure is `error`; `output` is git's or a hook's, for showing under it. */
export interface GitActionResult {
  ok: boolean;
  error?: string;
  output?: string;
  /** Commit: the new commit, short */
  commit?: string;
  /** Open PR: the PR made */
  pr?: PrInfo;
  /** the branch after the action (or after the failure) */
  status: GitStatus;
}

/** A generated commit message, or PR title and body. `note` when there's none (generation failed or isn't available). */
export interface GitDraft {
  message?: string;
  title?: string;
  body?: string;
  note?: string;
}

/** Output kept for showing a failure: its last lines, up to this many characters. */
export const GIT_OUTPUT_MAX = 4000;

/** The tail of git's or a hook's output, trimmed to GIT_OUTPUT_MAX. */
export function outputTail(s: string, max = GIT_OUTPUT_MAX): string {
  const t = s.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").trim();
  return t.length > max ? `…${t.slice(t.length - max + 1)}` : t;
}

// ---------- gh pr view --json ----------

const FAIL = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"]);
const OK = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

/** gh's statusCheckRollup (CheckRun and StatusContext entries) as one state: any failure fails, else anything unfinished is pending. */
export function checksOf(rollup: unknown): ChecksState {
  if (!Array.isArray(rollup) || !rollup.length) return "none";
  let pending = false;
  for (const c of rollup as Record<string, unknown>[]) {
    const v = String((c?.__typename === "StatusContext" ? c.state : c?.status === "COMPLETED" ? c.conclusion : c?.status) ?? "").toUpperCase();
    if (FAIL.has(v)) return "failing";
    if (!OK.has(v)) pending = true;
  }
  return pending ? "pending" : "passing";
}

/** `gh pr view --json number,url,title,state,isDraft,statusCheckRollup,headRefName`, read. Undefined when it isn't one. */
export function parsePr(json: unknown): PrInfo | undefined {
  const j = json as Record<string, unknown> | null;
  if (!j || typeof j.number !== "number" || typeof j.url !== "string") return undefined;
  const s = String(j.state ?? "").toUpperCase();
  const state: PrState = s === "MERGED" ? "merged" : s === "CLOSED" ? "closed" : j.isDraft ? "draft" : "open";
  return {
    number: j.number,
    url: j.url,
    title: typeof j.title === "string" ? j.title : "",
    state,
    checks: checksOf(j.statusCheckRollup),
    ...(typeof j.headRefName === "string" && j.headRefName ? { branch: j.headRefName } : {}),
  };
}

/** The fields asked of `gh pr view`. */
export const PR_FIELDS = "number,url,title,state,isDraft,statusCheckRollup,headRefName";

// ---------- generated text ----------

/** A model's answer as a commit message: code fences and quotes around it dropped, lines trimmed at the end. */
export function cleanMessage(s: string): string {
  let t = s.trim();
  const fence = t.match(/^```[a-z]*\n([\s\S]*?)\n```$/);
  if (fence) t = fence[1]!.trim();
  if (/^".*"$/s.test(t) && !t.slice(1, -1).includes('"')) t = t.slice(1, -1);
  return t
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** A model's answer as a PR: the first line the title ("Title:" dropped), the rest the body. */
export function splitTitleBody(s: string): { title: string; body: string } {
  const t = cleanMessage(s);
  const nl = t.indexOf("\n");
  const title = (nl < 0 ? t : t.slice(0, nl)).replace(/^(#+\s*|title:\s*)/i, "").trim();
  const body = (nl < 0 ? "" : t.slice(nl + 1)).replace(/^\s*body:\s*/i, "").trim();
  return { title, body };
}
