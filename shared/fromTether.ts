// Messages Tether sends to a harness on the person's behalf (an answer passed on after a runner
// restart, SPEC §7) start with this marker. The harness stores them as user turns; readers (live
// and stored alike) recognize the marker and show them as Tether's, not as something you typed.

import { parseShellMessage } from "./shellRun";

export const FROM_TETHER = "[From Tether] ";

/** The text without the marker when it is one of Tether's messages, else undefined. */
export const fromTether = (text: string): string | undefined => (text.startsWith(FROM_TETHER) ? text.slice(FROM_TETHER.length) : undefined);

/**
 * A message Tether sent, as the transcript shows it (live and stored alike): its own messages as
 * Tether's, and a `!` command's output as that command's (shared/shellRun.ts), never as something
 * you typed. Undefined for anything else.
 */
export function tetherOrigin(text: string): { origin: { kind: "tether" | "shell"; name?: string }; text: string } | undefined {
  const t = fromTether(text);
  if (t !== undefined) return { origin: { kind: "tether" }, text: t };
  const sh = parseShellMessage(text);
  if (sh) return { origin: { kind: "shell", name: sh.command }, text: sh.text };
  return undefined;
}
