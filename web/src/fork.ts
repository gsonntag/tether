// "Fork from here" (the runner's fork.ts): which messages offer it, and what the fork dialog shows.

import type { HarnessId, Msg } from "./shared/protocol";
import { BRIEF_PREFIX } from "./msgTime";
import { REVIEW_PREFIX } from "./shared/review";

/** What the fork dialog is about: one message of one session. */
export interface ForkTarget {
  sessionId: string;
  msgId: string;
  /** the session's harness and model now (the dialog's defaults) */
  harness: HarnessId;
  model?: string;
  /** a message of yours: the new session answers it again */
  atUser: boolean;
  /** the message's text, shortened */
  excerpt: string;
}

const textOf = (m: Msg) => m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join(" ");

/** Your messages and the agent's replies can be forked from; not a reply still being written, a brief, a notice or a `!` run. */
export function canFork(m: Msg): boolean {
  if (m.role === "assistant") return !m.streaming && m.parts.length > 0;
  if (m.role !== "user") return false;
  if (textOf(m).trimStart().startsWith(BRIEF_PREFIX) || textOf(m).trimStart().startsWith(REVIEW_PREFIX)) return false;
  return m.parts.some((p) => p.type === "text" || p.type === "skill" || p.type === "file" || p.type === "image");
}

export function forkExcerpt(m: Msg, max = 80): string {
  const t = textOf(m).replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max).trimEnd() + "…" : t;
}

export function forkTarget(sessionId: string, m: Msg, harness: HarnessId, model?: string): ForkTarget {
  return { sessionId, msgId: m.id, harness, model, atUser: m.role === "user", excerpt: forkExcerpt(m) };
}
