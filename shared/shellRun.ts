// `!` commands from the composer (SPEC §9 Shell commands): a one-off `$SHELL -c` in the session's
// folder, run by the runner at once, whose output then goes to the agent as a message through the
// queue. Shared by the runner (running, capping, the message) and the browser (the card).
//
// Output is kept bounded however much a command prints: the first bytes and the last bytes, with
// what lies between counted and dropped. The card shows SHELL_CARD_HEAD + SHELL_CARD_TAIL of it
// (under PART_TEXT_MAX, so it travels whole); the agent gets SHELL_AGENT_HEAD + SHELL_AGENT_TAIL,
// far under the queue's limits.

import { formatSize } from "./attachments";
import { cutBytes, utf8Length } from "./limits";

/** A command's text, at most (UTF-8 bytes). */
export const SHELL_COMMAND_MAX = 8000;
/** Commands running at once in one session. */
export const SHELL_RUNS_MAX = 5;
/** What the card shows: the start and the end of the output (UTF-8 bytes). */
export const SHELL_CARD_HEAD = 16 * 1024;
export const SHELL_CARD_TAIL = 44 * 1024;
/** What notices.json keeps of a finished card (it shows after a restart). */
export const SHELL_SAVED_HEAD = 4 * 1024;
export const SHELL_SAVED_TAIL = 12 * 1024;
/** What the agent gets (about what Claude Code itself keeps of a command's output). */
export const SHELL_AGENT_HEAD = 8 * 1024;
export const SHELL_AGENT_TAIL = 22 * 1024;

/**
 * A command's card, on its transcript message (`Msg.shell`). It is the person's (role "user"), and
 * only Tether has it (an "n-sh-" id, kept like Tether's notices).
 *
 *   running ──► queued ──► sent
 *        └────────────┴──► notSent (removed from the queue, the queue was full, the runner restarted)
 */
export interface ShellRun {
  state: "running" | "queued" | "sent" | "notSent";
  /** how it ended: its exit code, or the signal that ended it */
  exitCode?: number;
  signal?: string;
  /** you pressed Stop */
  stopped?: boolean;
  /** bytes of output dropped from the middle (the card and the agent see the start and the end) */
  omitted?: number;
  /** all the output it printed, in bytes */
  bytes?: number;
  /** the queued message that carries the output to the agent */
  queuedId?: string;
  /** notSent: why */
  why?: string;
  startedAt: number;
  endedAt?: number;
}

/** The card's tool part's id for a card message id ("n-sh-x" -> "sh-x"). */
export const shellToolId = (cardId: string) => cardId.replace(/^n-/, "");

/** The longest end of `s` that fits in `max` UTF-8 bytes (never splitting a surrogate pair). */
export function tailBytes(s: string, max: number): string {
  if (s.length * 3 <= max || utf8Length(s) <= max) return s;
  let bytes = 0;
  let i = s.length;
  while (i > 0) {
    const c = s.charCodeAt(i - 1);
    const low = c >= 0xdc00 && c <= 0xdfff && i > 1 && s.charCodeAt(i - 2) >= 0xd800 && s.charCodeAt(i - 2) <= 0xdbff;
    const w = low ? 4 : c < 0x80 ? 1 : c < 0x800 ? 2 : 3;
    if (bytes + w > max) break;
    bytes += w;
    i -= low ? 2 : 1;
  }
  return s.slice(i);
}

// Colors and cursor moves mean nothing outside a terminal (the output isn't a TTY, but some tools
// color it anyway).
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;
export const stripAnsi = (s: string) => s.replace(ANSI, "");

/**
 * A command's output, bounded: the first `head` bytes and the last `tail` bytes are kept, the rest
 * is only counted. Memory stays small whatever the command prints.
 */
export class OutputBuffer {
  private head = "";
  private headFull = false;
  private tail = "";
  /** UTF-8 bytes seen in all */
  total = 0;
  /** UTF-8 bytes in `tail` (kept up to date as it grows and is trimmed) */
  private tailLen = 0;

  constructor(
    readonly headMax = SHELL_CARD_HEAD,
    readonly tailMax = SHELL_CARD_TAIL,
  ) {}

  push(text: string) {
    if (!text) return;
    const n = utf8Length(text);
    this.total += n;
    if (!this.headFull) {
      const room = this.headMax - utf8Length(this.head);
      const take = cutBytes(text, room);
      this.head += take;
      if (take.length === text.length) return;
      this.headFull = true;
      text = text.slice(take.length);
    }
    this.tail += text;
    this.tailLen += utf8Length(text);
    // Trimmed once it is twice its size, so pushing stays cheap.
    if (this.tailLen > 2 * this.tailMax) {
      this.tail = tailBytes(this.tail, this.tailMax);
      this.tailLen = utf8Length(this.tail);
    }
  }

  /** Bytes between what the head and the tail keep. */
  get omitted(): number {
    const kept = utf8Length(this.head) + Math.min(this.tailLen, this.tailMax);
    return Math.max(0, this.total - kept);
  }

  /**
   * The output with at most `head` bytes from the start and `tail` from the end (no more than
   * this buffer keeps), and a line saying what was cut between them.
   */
  text(head = this.headMax, tail = this.tailMax): { text: string; omitted: number } {
    // Nothing dropped yet: the head and the tail are one piece, and the end may reach into the head.
    const contiguous = this.total === utf8Length(this.head) + this.tailLen;
    const start = cutBytes(this.head, head);
    const end = tailBytes(contiguous ? this.head.slice(start.length) + this.tail : this.tail, tail);
    const omitted = this.total - utf8Length(start) - utf8Length(end);
    if (omitted <= 0) return { text: start + end, omitted: 0 };
    return { text: `${start}${start.endsWith("\n") || !start ? "" : "\n"}${cutNote(omitted)}\n${end}`, omitted };
  }
}

export const cutNote = (bytes: number) => `[… ${formatSize(bytes)} of output cut from the middle …]`;

/** How a finished command ended, in words: "exit code 0", "stopped". */
export function endedHow(r: Pick<ShellRun, "exitCode" | "signal" | "stopped">): string {
  if (r.stopped) return "stopped";
  if (r.signal) return `ended by ${r.signal}`;
  return `exit code ${r.exitCode ?? "?"}`;
}

/** Messages carrying a command's output to the agent start with this marker. */
export const SHELL_MARKER = "[Shell command run from Tether] ";

/** A fence that no run of backticks in `text` closes early. */
function fence(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  return "`".repeat(longest + 1);
}

/** The message the agent gets for a finished command. */
export function shellMessage(command: string, output: string, r: Pick<ShellRun, "exitCode" | "signal" | "stopped" | "omitted">): string {
  const how = r.stopped
    ? "I stopped it before it finished. Its output up to then:"
    : r.signal
      ? `It was ended by ${r.signal}. Its output:`
      : `It exited with code ${r.exitCode ?? "?"}. Its output:`;
  const body = output.trim() ? output.replace(/\n+$/, "") : "(no output)";
  const f = fence(body);
  return `${SHELL_MARKER}I ran a shell command in the project folder:\n\n$ ${command}\n\n${how}\n\n${f}\n${body}\n${f}`;
}

/** A message made by shellMessage: the command it ran (the rest is the output). */
export function parseShellMessage(text: string): { command: string; text: string } | undefined {
  if (!text.startsWith(SHELL_MARKER)) return undefined;
  const body = text.slice(SHELL_MARKER.length);
  const m = body.match(/^[^\n]*\n\n\$ ([^\n]*)/);
  return { command: m?.[1] ?? "", text: body };
}
