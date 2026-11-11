// Messages Tether sends to a harness on the person's behalf (an answer passed on after a runner
// restart, SPEC §7) start with this marker. The harness stores them as user turns; readers (live
// and stored alike) recognize the marker and show them as Tether's, not as something you typed.

import { parseShellMessage } from "./shellRun";

export const FROM_TETHER = "[From Tether] ";

/** The text without the marker when it is one of Tether's messages, else undefined. */
export const fromTether = (text: string): string | undefined => (text.startsWith(FROM_TETHER) ? text.slice(FROM_TETHER.length) : undefined);

/** Who wrote a message Tether passed on. `session`: another session (the peers module), by title and id. */
export interface TetherOrigin {
  kind: "tether" | "shell" | "session";
  name?: string;
  sessionId?: string;
  /** a session's note to every session (tether_broadcast) */
  all?: boolean;
}

/**
 * A message from another session (SPEC §9a) starts with this marker: `[From session "<title>"
 * (<id>)] ` (` to all]` for a broadcast), and may end with a hint for the agent on how to answer,
 * `\n\n[Tether: …]`, which the transcript doesn't show.
 */
const SESSION_MARK = /^\[From session "([^"\n]{0,200})" \(([a-z]+:[^\s()]{1,200})\)( to all)?\] /;
const HINT = /\n\n\[Tether: [^\n]*\]$/;

/** A title as it goes in the marker: one line, no quotes. */
const markTitle = (title: string) => title.replace(/[\x00-\x1f\x7f"]+/g, " ").trim().slice(0, 120) || "Untitled";

/** A message from session `from` to another, with the hint the receiving agent reads. */
export function sessionMessage(from: { id: string; title: string }, text: string, hint?: string, all = false): string {
  return `[From session "${markTitle(from.title)}" (${from.id})${all ? " to all" : ""}] ${text}${hint ? `\n\n[Tether: ${hint.replace(/[\n\]]+/g, " ")}]` : ""}`;
}

/** A message from another session: who sent it and its text without the marker and hint. */
export function parseSessionMessage(text: string): { title: string; sessionId: string; all: boolean; text: string } | undefined {
  const m = SESSION_MARK.exec(text);
  if (!m) return undefined;
  return { title: m[1]!, sessionId: m[2]!, all: !!m[3], text: text.slice(m[0].length).replace(HINT, "") };
}

/**
 * A message Tether sent, as the transcript shows it (live and stored alike): its own messages as
 * Tether's, a `!` command's output as that command's (shared/shellRun.ts), and another session's
 * message as that session's, never as something you typed. Undefined for anything else.
 */
export function tetherOrigin(text: string): { origin: TetherOrigin; text: string } | undefined {
  const t = fromTether(text);
  if (t !== undefined) return { origin: { kind: "tether" }, text: t };
  const sh = parseShellMessage(text);
  if (sh) return { origin: { kind: "shell", name: sh.command }, text: sh.text };
  const peer = parseSessionMessage(text);
  if (peer) return { origin: { kind: "session", name: peer.title, sessionId: peer.sessionId, ...(peer.all ? { all: true } : {}) }, text: peer.text };
  return undefined;
}

/**
 * A title made from a first message (the sidebar's): Tether's own markers never show. A command's
 * output reads as its command ("$ npm test"), Tether's own message as its text.
 */
export function titleText(text: string): string {
  const t = text.trimStart();
  // Typed by a person (defang's mark): their text, as it reads.
  if (t.startsWith("\u200b")) return t.slice(1);
  const sh = parseShellMessage(t);
  if (sh) return `$ ${sh.command}`;
  return fromTether(t) ?? parseSessionMessage(t)?.text ?? text;
}

/** Text a person typed never passes for one of Tether's own messages (a zero-width space in front). */
export const defang = (text: string): string => (tetherOrigin(text.trimStart()) ? `\u200b${text}` : text);

/** The text as shown and copied: without defang's mark (the agent still gets it). */
export const undefang = (text: string): string => (text.startsWith("\u200b") && tetherOrigin(text.slice(1).trimStart()) ? text.slice(1) : text);
