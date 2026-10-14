// How a review (/review, runner/src/review.ts) reads: shared by the runner (the reviewer's prompt,
// the message that asks the agent to fix findings) and the review card in the session reviewed.

import type { Msg, ReviewFinding, ReviewSeverity, SessionReview } from "./protocol";

/** How a review session's prompt starts: the transcript folds it like a brief. */
export const REVIEW_PREFIX = "You are reviewing the changes";

export const SEVERITIES: ReviewSeverity[] = ["critical", "high", "medium", "low"];

export const SEVERITY_LABEL: Record<ReviewSeverity, string> = { critical: "Critical", high: "High", medium: "Medium", low: "Low" };

/** "src/app.ts:42", or the file alone when there's no line. */
export const findingWhere = (f: Pick<ReviewFinding, "file" | "line">) => (f.line ? `${f.file}:${f.line}` : f.file);

/** Most severe first; the reviewer's own order within a severity. */
export function bySeverity<T extends { f: ReviewFinding }>(list: T[]): T[] {
  return list.map((x, i) => ({ x, i })).sort((a, b) => SEVERITIES.indexOf(a.x.f.severity) - SEVERITIES.indexOf(b.x.f.severity) || a.i - b.i).map(({ x }) => x);
}

/**
 * Where each review's card goes: after the message it followed, or after the last message when
 * that one isn't in the transcript (history reloaded after a restart, cards carried by a handoff).
 */
export function reviewAnchors(messages: Pick<Msg, "id">[], reviews: Pick<SessionReview, "id" | "afterMsgId">[]): [SessionReview["id"], string][] {
  if (!messages.length) return [];
  const ids = new Set(messages.map((m) => m.id));
  const last = messages[messages.length - 1]!.id;
  return reviews.map((r) => [r.id, r.afterMsgId && ids.has(r.afterMsgId) ? r.afterMsgId : last]);
}
