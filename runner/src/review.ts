// /review [harness[:model]] [focus]: another harness (or model) reviews what the session changed.
// It runs as a session of its own in the same directory, read-only (the guard holds back every
// change, and where the harness can, its own tools are narrowed too: Claude Code without its edit
// tools, Codex in its read-only sandbox, pi without edit and write). It gets the session's diff
// since its first checkpoint (diffBase) and reports findings through the `tether-context` tool
// review_report (or, without it, as a JSON block at the end of its reply). The findings show as one
// card in the session reviewed, where each can be sent to the agent to fix.
//
// Codex's own review (app-server review/start) is not used: it reviews uncommitted changes, a
// branch or one commit rather than the session's diff, and reports only rendered text
// (exitedReviewMode.review), so it can't fill the card.
//
// The session side lives in session.ts ("review"); index.ts wires runReview and applyReview into
// the sink. Kept out of index.ts, which connects on import, so tests can run it with stubs.

import type { DiffStat, HarnessId, ReviewFinding, ReviewSeverity, SessionDiff, SessionReview } from "../../web/src/shared/protocol";
import { HARNESSES, parseEntry } from "../../web/src/shared/protocol";
import { findingWhere, REVIEW_PREFIX, SEVERITIES, SEVERITY_LABEL } from "../../web/src/shared/review";
import type { Adapter, Sink } from "./adapters/types";
import { computeDiff, root } from "./checkpoint";
import { config, saveConfig, saveConfigSoon } from "./config";
import { isSensitive } from "./guard";
import { entryLabel, newId, type LiveSession } from "./session";

/** Why a review session's guard held a call back. */
export const REVIEW_READ_ONLY_REASON =
  "Blocked: this is a read-only review session, so nothing may be changed (no edits, and no commands that could write, builds and tests included). Read the code and run read-only commands, then report your findings with review_report (or as the JSON block, if you don't have that tool).";

export interface ReviewRequest {
  harness?: HarnessId;
  model?: string;
  focus?: string;
}

/** Names a harness goes by in /review. */
const ALIASES: Record<string, HarnessId> = {
  "claude-code": "claude-code",
  claude: "claude-code",
  codex: "codex",
  pi: "pi",
  opencode: "opencode",
  kiro: "kiro",
  antigravity: "antigravity",
  agy: "antigravity",
};

/**
 * `/review`, `/review codex`, `/review codex:gpt-6-sol the auth changes`, `/review claude/opus`,
 * `/review check the migrations`. A first word that names a harness picks the reviewer (a model
 * after `:` or `/`); the rest is the focus. Undefined: not /review.
 */
export function parseReviewCommand(text: string): ReviewRequest | undefined {
  const m = text.trim().match(/^\/review(?:\s+([\s\S]*))?$/);
  if (!m) return undefined;
  let rest = m[1]?.trim() ?? "";
  const first = rest.split(/\s+/)[0] ?? "";
  const h = first.match(/^([a-z-]+)(?:[:/](\S+))?$/i);
  const harness = h ? ALIASES[h[1]!.toLowerCase()] : undefined;
  let model: string | undefined;
  if (harness) {
    model = h![2] || undefined;
    rest = rest.slice(first.length).trim();
  }
  return { ...(harness ? { harness } : {}), ...(model ? { model } : {}), ...(rest ? { focus: rest } : {}) };
}

const label = (h: HarnessId) => HARNESSES.find((x) => x.id === h)?.label ?? h;

/**
 * Who reviews: the harness asked for (with its model, or the session's chain's model for it), or
 * else another harness than the session's own: the first one in its fallback chain that's
 * installed, then the first installed. With no other harness, the session's own reviews in a fresh
 * session (`same`). A string: why there's no reviewer.
 */
export async function pickReviewer(
  current: HarnessId,
  chain: string[] | undefined,
  available: (h: HarnessId) => Promise<boolean>,
  req: ReviewRequest,
): Promise<{ harness: HarnessId; model?: string; same?: boolean } | string> {
  const entries = (chain ?? []).map((e) => parseEntry(e, current));
  if (req.harness) {
    if (!(await available(req.harness))) return `${label(req.harness)} isn't installed on this runner.`;
    const model = req.model ?? entries.find((e) => e.harness === req.harness)?.model;
    return { harness: req.harness, ...(model && model !== "default" ? { model } : {}) };
  }
  for (const e of entries) if (e.harness !== current && (await available(e.harness))) return { harness: e.harness, ...(e.model && e.model !== "default" ? { model: e.model } : {}) };
  for (const h of HARNESSES) if (h.id !== current && (await available(h.id))) return { harness: h.id };
  return { harness: current, same: true };
}

/** How much of the diff goes into the prompt; the reviewer can read the rest with git. */
export const PROMPT_DIFF_BYTES = 120_000;

/** The diff as the reviewer reads it: one `diff --git` section per file, with what was left out said. */
export function formatDiff(diff: SessionDiff): string {
  const out: string[] = [];
  for (const f of diff.files) {
    const head = `diff --git a/${f.path} b/${f.path}\n# ${f.status}, +${f.additions} -${f.deletions}`;
    // The guard keeps agents off credential files, the reviewer included: their contents stay out of the prompt too.
    if (isSensitive(f.path)) out.push(`${head}\n# not included: a credential or secrets file`);
    else if (f.binary) out.push(`${head}\n# binary file`);
    else if (f.skipped) out.push(`${head}\n# not included: ${f.skipped}`);
    else out.push(`${head}\n${f.patch.trimEnd()}${f.truncated ? "\n# … cut short" : ""}`);
  }
  if (diff.files.length < diff.fileCount) out.push(`# ${diff.fileCount - diff.files.length} more changed files not listed`);
  return out.join("\n\n");
}

/** What the review prompt says about the base the diff starts from, and how to see it all. */
function baseLine(diff: SessionDiff, base: string | undefined): string {
  if (diff.base === "session" && base)
    return `They are the differences between the working tree now and Tether's snapshot of it from before the session's first turn (commit ${base}). \`git diff ${base}\` shows them for tracked files; files the session added and didn't commit are untracked, so read them directly.`;
  if (diff.base === "HEAD") return "Tether has no snapshot from before the session, so these are the uncommitted changes against HEAD (`git diff HEAD`; untracked files are listed as added).";
  return "The repository has no commits yet, so every file counts as added.";
}

export function reviewPrompt(o: {
  diff: SessionDiff;
  base?: string;
  /** the reviewed session: harness and model */
  fromLabel: string;
  /** what the user asked the reviewed session for (LiveSession.goal()) */
  asks?: string;
  focus?: string;
  cwd: string;
  /** the repository's top directory, when it isn't cwd (diff paths are relative to it) */
  top?: string;
}): string {
  const { diff } = o;
  const stat = `${diff.fileCount} ${diff.fileCount === 1 ? "file" : "files"}, +${diff.additions} -${diff.deletions}`;
  const asks = o.asks?.trim() ? `\n## What the session was asked to do\n${o.asks.trim().slice(0, 6000)}\n` : "";
  const focus = o.focus?.trim() ? `\n## Focus\nThe user asked you to focus on: ${o.focus.trim()}\n` : "";
  const top = o.top && o.top !== o.cwd ? ` Paths in the diff are relative to the repository root, ${o.top}.` : "";
  const cut = diff.truncated ? " Some of it was left out or cut short below (marked with #): read those files yourself." : "";
  return `${REVIEW_PREFIX} another coding agent (${o.fromLabel}) made in this repository (${o.cwd}), for the user, as a second pair of eyes.

This is a read-only review: don't change anything. Tether blocks every edit and every command that could write in this session, so you can't run builds or tests either. Read the code, search it, and run read-only commands (git diff, git log, cat, rg…) as needed.
${asks}${focus}
## What changed
${stat}. ${baseLine(diff, o.base)}${top}${cut}

## What to look for
Bugs, regressions, security problems, unhandled edge cases and errors, missing or wrong tests, and changes that don't do what the session was asked to do. Read the surrounding code wherever it matters; don't stop at the diff. Skip style nits unless they hide a real problem. Only report what you're fairly sure of, and say how to fix it.

## How to report
When you're done, call the review_report tool once, with every finding:
- file: the path, relative to ${o.cwd}
- line: the line in the file as it is now
- severity: critical (data loss, security hole, crash on a main path), high (a real bug), medium (an edge case or a risk), or low (minor)
- issue: what's wrong and why it matters, in a sentence or two
- fix: what to change
and a one-line summary of your verdict. An empty list is fine if the changes look right. Then end your turn with a short summary.

If you don't have the review_report tool, end your reply with the same as a JSON block instead:
\`\`\`json
{"summary": "…", "findings": [{"file": "src/app.ts", "line": 42, "severity": "high", "issue": "…", "fix": "…"}]}
\`\`\`

## The diff
${formatDiff(diff)}
`;
}

// ---------------- the report ----------------

const MAX_FINDINGS = 100;
const MAX_TEXT = 4000;

const SEVERITY_ALIASES: Record<string, ReviewSeverity> = {
  critical: "critical",
  blocker: "critical",
  p0: "critical",
  high: "high",
  major: "high",
  error: "high",
  p1: "high",
  medium: "medium",
  moderate: "medium",
  warning: "medium",
  p2: "medium",
  low: "low",
  minor: "low",
  info: "low",
  nit: "low",
  trivial: "low",
  p3: "low",
};

const text = (v: unknown) => (typeof v === "string" ? v.trim().slice(0, MAX_TEXT) : "");

/** review_report's arguments (or the reply's JSON), checked: the report, or why not. Field names other agents use are taken too. */
export function parseReport(args: unknown): { findings: ReviewFinding[]; summary?: string } | string {
  const a: any = args;
  const list = Array.isArray(a) ? a : a?.findings;
  if (!Array.isArray(list)) return "findings must be a list of { file, line, severity, issue, fix } (an empty list if you found nothing).";
  if (list.length > MAX_FINDINGS) return `At most ${MAX_FINDINGS} findings: keep the ones that matter most.`;
  const findings: ReviewFinding[] = [];
  for (const [i, f] of list.entries()) {
    const file = text(f?.file ?? f?.path ?? f?.filePath ?? f?.code_location?.absolute_file_path);
    const issue = text(f?.issue ?? f?.description ?? f?.body ?? f?.title ?? f?.message);
    if (!file) return `Finding ${i + 1} needs a file.`;
    if (!issue) return `Finding ${i + 1} needs an issue: what's wrong.`;
    const raw = String(f?.severity ?? f?.priority ?? "medium").toLowerCase().trim();
    const severity = SEVERITY_ALIASES[raw.replace(/^\[|\]$/g, "")];
    if (!severity) return `Finding ${i + 1}: severity must be one of ${SEVERITIES.join(", ")}.`;
    const lineRaw = f?.line ?? f?.startLine ?? f?.code_location?.line_range?.start;
    const line = typeof lineRaw === "number" ? Math.floor(lineRaw) : parseInt(String(lineRaw ?? ""), 10);
    const fix = text(f?.fix ?? f?.suggestion ?? f?.recommendation ?? f?.suggested_fix);
    findings.push({ file, ...(line > 0 ? { line } : {}), severity, issue, fix });
  }
  const summary = text(a?.summary ?? a?.verdict ?? a?.overall_explanation);
  return { findings, ...(summary ? { summary: summary.slice(0, 500) } : {}) };
}

/** The report a reviewer without review_report wrote as the last JSON block of its reply. */
export function reportFromReply(reply: string): { findings: ReviewFinding[]; summary?: string } | undefined {
  const blocks = [...reply.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]!);
  // No fence: a bare object at the very end.
  const bare = reply.lastIndexOf('{"');
  if (!blocks.length && bare >= 0) blocks.push(reply.slice(bare));
  for (const b of blocks.reverse()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(b.trim());
    } catch {
      continue;
    }
    const r = parseReport(parsed);
    if (typeof r !== "string") return r;
  }
  return undefined;
}

/** The message "Send to agent" / "Send all" queues in the session reviewed. */
export function fixMessage(review: Pick<SessionReview, "harness" | "model" | "findings">, indexes: number[]): string {
  const by = `${label(review.harness)}${review.model ? ` (${entryLabel({ harness: review.harness, model: review.model })})` : ""}`;
  const one = (f: ReviewFinding) => `**${findingWhere(f)}** (${SEVERITY_LABEL[f.severity].toLowerCase()}): ${f.issue}${f.fix ? `\n  Suggested fix: ${f.fix}` : ""}`;
  const picked = indexes.map((i) => review.findings[i]!).filter(Boolean);
  if (picked.length === 1) return `A review by ${by} found this in your changes. Check it, and fix it if it holds:\n\n${one(picked[0]!)}`;
  return `A review by ${by} found these in your changes. Check each one, and fix the ones that hold:\n\n${picked.map((f, i) => `${i + 1}. ${one(f)}`).join("\n")}`;
}

/** One line for the push and the inline wording: "3 findings (1 high)". */
export function describeFindings(findings: ReviewFinding[]): string {
  if (!findings.length) return "No findings";
  const top = SEVERITIES.find((s) => findings.some((f) => f.severity === s))!;
  const n = findings.filter((f) => f.severity === top).length;
  return `${findings.length} ${findings.length === 1 ? "finding" : "findings"}${findings.length > n || top !== "low" ? ` (${n} ${SEVERITY_LABEL[top].toLowerCase()})` : ""}`;
}

// ---------------- running one ----------------

export interface ReviewDeps {
  adapters: Record<HarnessId, Pick<Adapter, "create" | "available">>;
  sink: Sink;
  /** registers the new session as live (index.ts track) */
  track: (s: LiveSession) => void;
}

/** At most this many reviews are kept per session (the oldest go). */
export const MAX_REVIEWS = 10;

/**
 * Starts a review of `from`'s changes: a card in `from` right away, then a read-only session on the
 * reviewer that gets the prompt. Throws (no card) when there's nothing to review or no reviewer;
 * a failure to start after that shows on the card. Returns the review session.
 */
export async function runReview(deps: ReviewDeps, from: LiveSession, req: ReviewRequest): Promise<LiveSession | undefined> {
  const pick = await pickReviewer(from.harness, from.t.state.chain, async (h) => (deps.adapters[h] ? deps.adapters[h].available().catch(() => false) : false), req);
  if (typeof pick === "string") throw new Error(pick);
  const base = from.diffBase ?? from.t.state.checkpoints?.[0]?.sha;
  let diff: SessionDiff;
  try {
    diff = await computeDiff(from.projectPath, base, undefined, { limits: { totalBytes: PROMPT_DIFF_BYTES } });
  } catch (e: any) {
    throw new Error(`Couldn't read the changes: ${e?.message ?? e}`);
  }
  if (!diff.fileCount) throw new Error(diff.base === "session" ? "Nothing to review: this session hasn't changed any files." : "Nothing to review: there are no uncommitted changes.");

  const stat: DiffStat = { files: diff.fileCount, additions: diff.additions, deletions: diff.deletions };
  const now = Date.now();
  const review: SessionReview = {
    id: newId("rv"),
    status: "starting",
    harness: pick.harness,
    ...(pick.model ? { model: pick.model } : {}),
    ...(req.focus ? { focus: req.focus } : {}),
    stat,
    findings: [],
    sent: [],
    afterMsgId: from.t.messages[from.t.messages.length - 1]?.id,
    createdAt: now,
    updatedAt: now,
  };
  from.putReview(review);

  let next: LiveSession | undefined;
  try {
    next = deps.adapters[pick.harness].create(from.projectPath, { model: pick.model }, deps.sink);
    // Before start: the launch narrows the harness's own tools and offers review_report.
    next.t.state.reviewOf = { sessionId: from.id, reviewId: review.id };
    // Never Dangerously skip: Codex would then ask nothing at all (the read-only hold is in checkTool).
    next.t.state.guard = "auto";
    await next.start();
    deps.track(next);
    const title = `Review of ${from.title}`;
    config().titles[next.id] = title;
    saveConfig();
    next.setTitle(title);
    next.setState({ reviewOf: { sessionId: from.id, reviewId: review.id }, guard: "auto" });
    if (pick.model && next.t.state.model !== pick.model) await next.applyModel(pick.model);
    from.updateReview(review.id, { status: "running", sessionId: next.id, ...(next.t.state.model && next.t.state.model !== "default" ? { model: next.t.state.model } : {}) });
    next.notice(
      `A read-only review of the changes in a ${label(from.harness)} session${pick.same ? ` (no other harness is installed, so ${label(pick.harness)} reviews in a fresh session)` : ""}. Tether blocks every change here; the findings show in the session reviewed.`,
      "info",
    );
    const top = await root(from.projectPath).catch(() => undefined);
    const prompt = reviewPrompt({
      diff,
      base,
      fromLabel: `${label(from.harness)}, ${entryLabel(from.currentEntry)}`,
      asks: from.goal(),
      focus: req.focus,
      cwd: from.projectPath,
      top,
    });
    await next.prompt(prompt);
    deps.sink.summary(next.summary());
    return next;
  } catch (e: any) {
    from.updateReview(review.id, { status: "failed", error: `Couldn't start the review: ${e?.message ?? e}` });
    next?.close();
    return undefined;
  }
}

/**
 * A review session's result reaches the session it reviews: live, its card updates; closed, its
 * stored reviews do (the card shows it when the session is opened again).
 */
export function applyReview(
  live: (id: string) => LiveSession | undefined,
  sessionId: string,
  reviewId: string,
  patch: Partial<SessionReview>,
  /** a session that isn't running had its stored reviews changed (index.ts tells browsers on it) */
  storedChanged?: (sessionId: string, reviews: SessionReview[]) => void,
) {
  // Handed off meanwhile: the sessions it went on in have the card too.
  const seen = new Set<string>();
  for (let id: string | undefined = sessionId; id && !seen.has(id) && seen.size < 10; ) {
    seen.add(id);
    const s = live(id);
    if (s && !s.closed) {
      s.updateReview(reviewId, patch);
      id = s.t.state.handoffTo?.sessionId;
      continue;
    }
    const p = config().sessions[id];
    const i = p?.reviews?.findIndex((r) => r.id === reviewId) ?? -1;
    if (p?.reviews && i >= 0) {
      p.reviews[i] = mergeReview(p.reviews[i]!, patch);
      saveConfigSoon();
      storedChanged?.(id, p.reviews);
    }
    id = p?.handoffTo?.sessionId;
  }
}

/** A review with a change applied: new findings start unsent. */
export function mergeReview(cur: SessionReview, patch: Partial<SessionReview>): SessionReview {
  return { ...cur, ...patch, ...(patch.findings && !patch.sent ? { sent: [] } : {}), id: cur.id, updatedAt: Date.now() };
}
