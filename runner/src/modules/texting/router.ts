// Which session a text reply is for. Every text Tether sends starts with its session's number
// ("[2] Claude has a question for you."); a session stays open for replies for OPEN_MS after its last
// text. A reply that names a number, or answers one of Tether's texts in a thread, goes to that
// session; plain text goes to the only open session, or is held while Tether asks which one with a
// numbered picker. Pure: the clock is passed in and the state is plain data, saved by the caller.

import { TEXTS } from "./texts";

export const OPEN_MS = 30 * 60_000;
export const HELD_MS = 10 * 60_000;
const MAX_SLOTS = 9;
const MAX_SENT = 50;

export interface Slot {
  n: number;
  sessionId: string;
  /** what the last text said, short: "finished", "wants to run a command" */
  status: string;
  /** when it was last texted or answered */
  at: number;
}

export interface RouterState {
  slots: Slot[];
  /** plain text waiting for the person to pick a session */
  held?: { text: string; at: number };
  /** the person sent just a number: their next text goes there */
  aimed?: { n: number; at: number };
  /** Tether's own texts, newest last: a threaded reply names one */
  sent: { id: string; sessionId: string }[];
}

export type Decision =
  | { kind: "deliver"; sessionId: string; n: number; text: string }
  | { kind: "reply"; text: string }
  | { kind: "none" };

export const emptyState = (): RouterState => ({ slots: [], sent: [] });

/** A number at the start, alone or before the message: "2", "[2]", "2: do it", "(2) do it". */
const NUMBERED = /^[[(]?\s*([1-9])\s*[\])]?(?=$|[\s:.,)\]-])[\s:.,)\]-]*([\s\S]*)$/;

export function ago(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

export class Router {
  constructor(
    public state: RouterState = emptyState(),
    private now: () => number = Date.now,
  ) {}

  /** The open sessions, by number. */
  open(): Slot[] {
    this.prune();
    return [...this.state.slots].sort((a, b) => a.n - b.n);
  }

  /** A text about a session is going out: its number (kept, else the lowest free one) and the text. */
  stamp(sessionId: string, status: string, body: string): { n: number; text: string } {
    this.prune();
    const s = this.state.slots;
    let slot = s.find((x) => x.sessionId === sessionId);
    if (!slot) {
      if (s.length >= MAX_SLOTS) s.splice(s.indexOf(s.reduce((a, b) => (a.at <= b.at ? a : b))), 1);
      const used = new Set(s.map((x) => x.n));
      let n = 1;
      while (used.has(n)) n++;
      slot = { n, sessionId, status, at: 0 };
      s.push(slot);
    }
    Object.assign(slot, { status, at: this.now() });
    // Just the number and the message ("[6] ok"): no folder, no agent.
    return { n: slot.n, text: `[${slot.n}] ${body}` };
  }

  /** Tether's text went out as message `id` (a threaded reply to it names it). */
  noteSent(id: string, sessionId: string) {
    this.state.sent = [...this.state.sent.filter((x) => x.id !== id), { id, sessionId }].slice(-MAX_SENT);
  }

  /** What to do with the person's text. `replyTo`: the message it answers in a thread. */
  route(raw: string, replyTo?: string): Decision {
    this.prune();
    const text = raw.trim();
    if (!text) return { kind: "none" };

    const threaded = replyTo && this.state.sent.find((x) => x.id === replyTo);
    if (threaded) {
      const slot = this.state.slots.find((x) => x.sessionId === threaded.sessionId);
      if (slot) return this.deliver(slot, text);
    }

    const m = NUMBERED.exec(text);
    if (m) {
      const n = Number(m[1]);
      const rest = m[2]!.trim();
      const slot = this.state.slots.find((x) => x.n === n);
      if (!slot) {
        if (rest) this.state.held = { text: rest, at: this.now() };
        return { kind: "reply", text: this.open().length ? this.picker(TEXTS.notWaiting(n)) : NOTHING_OPEN };
      }
      if (rest) return this.deliver(slot, rest);
      const held = this.state.held;
      if (held) return this.deliver(slot, held.text);
      this.state.aimed = { n, at: this.now() };
      return { kind: "reply", text: TEXTS.whatToSend(n) };
    }

    const aimed = this.state.aimed && this.state.slots.find((x) => x.n === this.state.aimed!.n);
    if (aimed) return this.deliver(aimed, text);

    const open = this.open();
    if (!open.length) return { kind: "reply", text: NOTHING_OPEN };
    if (open.length === 1) return this.deliver(open[0]!, text);
    this.state.held = { text, at: this.now() };
    return { kind: "reply", text: this.picker() };
  }

  /** A one-sentence question ("Which session, by number?") and a row per open session. */
  picker(head: string = TEXTS.which): string {
    const now = this.now();
    const rows = this.open().map((s) => `[${s.n}] ${s.status}, ${ago(now - s.at)}`);
    return `${head}\n${rows.join("\n")}`;
  }

  private deliver(slot: Slot, text: string): Decision {
    this.state.held = undefined;
    this.state.aimed = undefined;
    slot.at = this.now();
    return { kind: "deliver", sessionId: slot.sessionId, n: slot.n, text };
  }

  private prune() {
    const now = this.now();
    const st = this.state;
    st.slots = st.slots.filter((s) => now - s.at < OPEN_MS);
    if (st.held && now - st.held.at >= HELD_MS) st.held = undefined;
    if (st.aimed && (now - st.aimed.at >= HELD_MS || !st.slots.some((s) => s.n === st.aimed!.n))) st.aimed = undefined;
  }
}

export const NOTHING_OPEN = TEXTS.nothingOpen;
