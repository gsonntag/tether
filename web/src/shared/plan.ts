// Plan review: comments a person leaves on a plan, and the one message they go back to the agent as.

/** A comment anchored to a quoted bit of the plan. */
export interface PlanComment {
  id: string;
  /** the plan text it's about, as selected */
  quote: string;
  text: string;
  /** follow-ups added under the comment, oldest first */
  replies?: string[];
  /** where the quote starts in the rendered plan, for ordering (and the margin position) */
  offset: number;
}

/** Markdown blockquote of `text`, one `>` per line. */
export function quote(text: string): string {
  return text
    .trim()
    .split("\n")
    .map((l) => (l.trim() ? `> ${l.trimEnd()}` : ">"))
    .join("\n");
}

/**
 * The comments as one message, in plan order: each quote followed by its comment and follow-ups,
 * then the general comment, if any. Empty when there is nothing to send.
 */
export function formatPlanFeedback(comments: PlanComment[], general = ""): string {
  const blocks = [...comments]
    .map((c) => ({ ...c, body: [c.text, ...(c.replies ?? [])].map((t) => t.trim()).filter(Boolean).join("\n") }))
    .filter((c) => c.body)
    .sort((a, b) => a.offset - b.offset)
    .map((c) => (c.quote.trim() ? `${quote(c.quote)}\n${c.body}` : c.body));
  if (general.trim()) blocks.push(general.trim());
  return blocks.join("\n\n");
}

/** A checklist plan (ACP `plan` entries) as a markdown task list. */
export function checklistMarkdown(entries: { content: string; status?: string }[]): string {
  return entries
    .map((e) => {
      const text = String(e.content ?? "").replace(/\s+/g, " ").trim();
      if (e.status === "completed") return `- [x] ${text}`;
      return `- [ ] ${text}${e.status === "in_progress" ? " _(in progress)_" : ""}`;
    })
    .join("\n");
}
