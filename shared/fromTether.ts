// Messages Tether sends to a harness on the person's behalf (an answer passed on after a runner
// restart, SPEC §7) start with this marker. The harness stores them as user turns; readers (live
// and stored alike) recognize the marker and show them as Tether's, not as something you typed.

import { parseShellMessage } from "./shellRun";

export const FROM_TETHER = "[From Tether] ";

/**
 * The Home agent's check-in (runner/src/modules/homeAgent/checkIn.ts) is marked with what it is:
 * readers know it by this marker, not by its wording, and show it as one quiet line. It is one of
 * Tether's messages like any other (fromTether reads it).
 */
export const FROM_TETHER_CHECKIN = "[From Tether: check-in] ";

/** How check-ins began before they had their own marker: older history is known by its wording. */
const OLD_CHECKIN = "Check-in from the Home agent:";

/** What one of Tether's messages is for, when its marker says (or, in older history, its wording). */
export type TetherPurpose = "checkIn";

/** The text without the marker when it is one of Tether's messages, else undefined. */
export const fromTether = (text: string): string | undefined =>
  text.startsWith(FROM_TETHER) ? text.slice(FROM_TETHER.length) : text.startsWith(FROM_TETHER_CHECKIN) ? text.slice(FROM_TETHER_CHECKIN.length) : undefined;

/** What one of Tether's messages is for: `checkIn` for the Home agent's check-in, else undefined. */
export function tetherPurpose(text: string): TetherPurpose | undefined {
  if (text.startsWith(FROM_TETHER_CHECKIN)) return "checkIn";
  if (text.startsWith(FROM_TETHER) && text.slice(FROM_TETHER.length).startsWith(OLD_CHECKIN)) return "checkIn";
  return undefined;
}

/**
 * The person's own words, texted to the Home agent over iMessage (runner/src/modules/texting), start
 * with this marker: the chat shows them as the person's, marked as a text, and the agent knows its
 * reply goes back to a phone.
 */
export const FROM_IMESSAGE = "[From iMessage] ";

/** The text without the marker when the person texted it, else undefined. */
export const fromImessage = (text: string): string | undefined => (text.startsWith(FROM_IMESSAGE) ? text.slice(FROM_IMESSAGE.length) : undefined);

/** Who wrote a message Tether passed on. `session`: another session (the peers module), by title and id. */
export interface TetherOrigin {
  kind: "tether" | "shell" | "session" | "imessage";
  name?: string;
  sessionId?: string;
  /** a session's note to every session (tether_broadcast) */
  all?: boolean;
  /** tether: what the message is for (shown as one quiet line, not as a message) */
  purpose?: TetherPurpose;
}

/**
 * A message from another session (SPEC §9a) starts with this marker: `[From session "<title>"
 * (<id>)] ` (` to all]` for a broadcast), and may end with a hint for the agent on how to answer,
 * `\n\n[Tether: …]`, which the transcript doesn't show.
 */
const SESSION_MARK = /^\[From session "([^"\n]{0,200})" \(([a-z]+:[^\s()]{1,200})\)( to all)?\] /;
const HINT = /\n\n\[Tether: [^\n]*\]$/;

/** A title as it goes in the marker or a tool's answer: one line, no control characters, no quotes. */
export const markTitle = (title: string) => title.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029"]+/g, " ").trim().slice(0, 120) || "Untitled";

/**
 * A message from session `from` to another, with the hint the receiving agent reads. `hops`: how
 * many sessions passed it on (caps.ts), kept in the hint so a queued message keeps it across a restart.
 */
export function sessionMessage(from: { id: string; title: string }, text: string, hint?: string, all = false, hops?: number): string {
  const h = [hops ? `hop ${hops}.` : "", hint?.replace(/[\n\]]+/g, " ") ?? ""].filter(Boolean).join(" ");
  return `[From session "${markTitle(from.title)}" (${from.id})${all ? " to all" : ""}] ${text}${h ? `\n\n[Tether: ${h}]` : ""}`;
}

/** The hops a message from another session carries (its hint's `hop N.`), else undefined. */
export function peerHops(text: string): number | undefined {
  if (!SESSION_MARK.test(text)) return undefined;
  const m = /\n\n\[Tether: hop (\d+)\.[^\n]*\]$/.exec(text);
  return m ? Number(m[1]) : undefined;
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
  if (t !== undefined) {
    const purpose = tetherPurpose(text);
    return { origin: { kind: "tether", ...(purpose ? { purpose } : {}) }, text: t };
  }
  const im = fromImessage(text);
  if (im !== undefined) return { origin: { kind: "imessage" }, text: im };
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
  return fromTether(t) ?? fromImessage(t) ?? parseSessionMessage(t)?.text ?? text;
}

/** Text a person typed never passes for one of Tether's own messages (a zero-width space in front). */
export const defang = (text: string): string => (tetherOrigin(text.trimStart()) ? `\u200b${text}` : text);

/** The text as shown and copied: without defang's mark (the agent still gets it). */
export const undefang = (text: string): string => (text.startsWith("\u200b") && tetherOrigin(text.slice(1).trimStart()) ? text.slice(1) : text);
