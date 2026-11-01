// Plan review: comments a person leaves on a plan the agent proposed, and the messages they go back
// as. Each comment quotes the part of the plan it is about; the feedback is one block per comment,
// in the plan's order: the quote as a markdown blockquote, then the comment. A general comment
// (about no part in particular) goes last. Drafts stay in the browser until they're sent.

/** A comment on a quoted bit of the plan. */
export interface PlanComment {
  id: string;
  /** the plan text it's about, as selected (trimmed) */
  quote: string;
  text: string;
  /** where the quote starts in the rendered plan's text: the order comments go out in */
  offset: number;
  /** the rendered text at `offset` (untrimmed), to find the quote again */
  anchor?: string;
}

export interface PlanDraft {
  comments: PlanComment[];
  general: string;
}

export const EMPTY_DRAFT: PlanDraft = { comments: [], general: "" };

/** What a Codex plan's approval sends: Codex's own wording for "Yes, implement this plan". */
export const IMPLEMENT_PROMPT = "Implement the plan.";

/** The mode id a plan mode goes by, on both harnesses. */
export const PLAN_MODE = "plan";

export const isEmptyDraft = (d: PlanDraft | undefined) => !d || (!d.comments.some((c) => c.text.trim()) && !d.general.trim());

/** A draft from storage, cleaned up: undefined when it isn't one. */
export function cleanDraft(v: any): PlanDraft | undefined {
  if (!v || typeof v !== "object" || !Array.isArray(v.comments)) return undefined;
  const comments = v.comments
    .filter((c: any) => c && typeof c.id === "string" && typeof c.text === "string")
    .map((c: any): PlanComment => ({ id: c.id, quote: String(c.quote ?? ""), text: c.text, offset: Number(c.offset) || 0, ...(typeof c.anchor === "string" ? { anchor: c.anchor } : {}) }));
  return { comments, general: typeof v.general === "string" ? v.general : "" };
}

/** Markdown blockquote of `text`, one `>` per line. */
export function quote(text: string): string {
  return text
    .trim()
    .split("\n")
    .map((l) => (l.trim() ? `> ${l.trimEnd()}` : ">"))
    .join("\n");
}

/** Comments in plan order (where their quotes start), ties in the order they were written. */
export const inPlanOrder = (comments: PlanComment[]) => comments.map((c, i) => [c, i] as const).sort((a, b) => a[0].offset - b[0].offset || a[1] - b[1]).map(([c]) => c);

/**
 * The comments as one message, in plan order: each quote as a blockquote with the comment under it,
 * then the general comment. Empty comments are left out; empty when there's nothing to send.
 */
export function formatPlanFeedback(comments: PlanComment[], general = ""): string {
  const blocks = inPlanOrder(comments)
    .filter((c) => c.text.trim())
    .map((c) => (c.quote.trim() ? `${quote(c.quote)}\n\n${c.text.trim()}` : c.text.trim()));
  if (general.trim()) blocks.push(general.trim());
  return blocks.join("\n\n");
}

/** Revise: the plan goes back with the comments, and a revised plan is asked for. Empty: nothing to send. */
export function reviseMessage(d: PlanDraft): string {
  const body = formatPlanFeedback(d.comments, d.general);
  return body && `Please revise the plan to address my comments, then present the revised plan for review.\n\n${body}`;
}

/** Approve: the comments go along as notes for the work. Empty: none. */
export const approveNotes = (d: PlanDraft) => formatPlanFeedback(d.comments, d.general);

/** What an approval sends when the harness's turn has ended (Codex): go ahead, with the notes. */
export const approveMessage = (notes = "") => (notes.trim() ? `${IMPLEMENT_PROMPT}\n\nNotes on the plan:\n\n${notes.trim()}` : IMPLEMENT_PROMPT);

/** Notes sent into the running turn after an approval (Claude). */
export const notesMessage = (notes: string) => `Notes on the plan:\n\n${notes.trim()}`;

/**
 * Where a comment's quote is in the rendered text now: at its offset if the text there is still
 * its anchor, else the anchor's first occurrence. -1: not found (the plan changed under it).
 */
export function locateAnchor(text: string, c: { offset: number; anchor?: string }): number {
  if (!c.anchor) return -1;
  if (text.slice(c.offset, c.offset + c.anchor.length) === c.anchor) return c.offset;
  return text.indexOf(c.anchor);
}

/** A short stable key for a plan's text (drafts are kept per plan). */
export function planKey(plan: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < plan.length; i++) h = Math.imul(h ^ plan.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}
