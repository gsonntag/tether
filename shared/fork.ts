// Forking a session (SPEC §16): a new session with the same conversation, or with the conversation up
// to one message, in the same folder, on the same harness and source. The original is never
// changed. Shared so the runner and the UI agree on where a fork can end.

import type { Msg } from "./transcript";

/** Which session a fork was made from, and the message its conversation ends at (absent: all of it). */
export interface ForkedFrom {
  sessionId: string;
  messageId?: string;
  /** the original's title when it was forked, for when the original isn't listed */
  title?: string;
}

/** A fork's own title. */
export const forkTitle = (title: string) => `${title.trim() || "Untitled"} (fork)`;

/** The notice at the top of what a fork is new: where it came from. */
export const forkedNotice = (title: string) => `Forked from “${title.trim() || "Untitled"}”.`;

/**
 * Where a fork can end: the assistant message that ends a finished turn. That is a reply with no
 * error, not streaming, ending on text (a reply ending on a tool call is mid-turn: the result comes
 * after it), followed by your next message, or by nothing when no turn is running. While a turn runs
 * (`running`), nothing after your latest message counts: that turn isn't finished.
 */
export function forkPoints(msgs: Msg[], running: boolean): Set<string> {
  const out = new Set<string>();
  let lastUser = msgs.length;
  if (running) while (--lastUser >= 0 && msgs[lastUser]!.role !== "user");
  /** the role of the next message that isn't a notice, walking back from the end */
  let next: Msg["role"] | undefined;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!;
    if (m.role === "notice") continue;
    const after = next;
    next = m.role;
    if (m.role !== "assistant" || m.error || m.streaming || i > lastUser) continue;
    // Parts left out to keep it small (shared/limits.ts) hide its end: the runner reads it whole.
    const last = m.parts.at(-1);
    if (!m.partsOmitted && (last?.type !== "text" || !last.text.trim())) continue;
    if (after ? after !== "user" : running) continue;
    out.add(m.id);
  }
  return out;
}

/** The point a fork of the whole session ends at: everything (undefined) when idle, else the last finished turn. */
export function wholeForkPoint(msgs: Msg[], running: boolean): { upTo?: string } | undefined {
  if (!running) return msgs.some((m) => m.role !== "notice") ? {} : undefined;
  const points = forkPoints(msgs, true);
  for (let i = msgs.length - 1; i >= 0; i--) if (points.has(msgs[i]!.id)) return { upTo: msgs[i]!.id };
  return undefined;
}
