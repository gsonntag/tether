// Which session a text reply is for. Every text Tether sends starts with its session's number
// ("[2] Claude has a question for you."); a session stays open for replies for OPEN_MS after its last
// text. A reply that names a number, or answers one of Tether's texts in a thread, goes to that
// session; plain text goes to the only open session, or is held while Tether asks which one with a
// numbered picker. Pure: the clock is passed in and the state is plain data, saved by the caller.
//
// The thread is shared with textme (thread.ts): a reply that answers a waiting textme's text in a
// thread or starts with its [tag], or any reply that isn't for one of Tether's open sessions by number while a textme texted
// more recently than Tether did, isn't Tether's, and Tether says nothing.

import { TEXTS } from "./texts";
import { addressedToWaiter, type TetherNote, type Waiter } from "./thread";

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
  /** the person answered it (by text, or in Tether) since its last text: not in the picker */
  answered?: boolean;
  /** the request its last text was about: a reply answers that one only, never another, and never
   * goes to the agent as words once it's closed (texting/index.ts) */
  requestId?: string;
}

export interface RouterState {
  slots: Slot[];
  /** plain text waiting for the person to pick a session */
  held?: { text: string; at: number };
  /** the person sent just a number: their next text goes there */
  aimed?: { n: number; at: number };
  /** Tether's own texts, newest last: a threaded reply names one */
  sent: { id: string; sessionId: string; requestId?: string }[];
  /** when Tether last texted anything */
  lastOut?: number;
}

export type Decision =
  /** `requestId`: the request the text it answers was about */
  | { kind: "deliver"; sessionId: string; n: number; text: string; requestId?: string }
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

  /** A text about a session (about `requestId`, when it's a request) is going out: its number (kept, else the lowest free one) and the text. */
  stamp(sessionId: string, status: string, body: string, requestId?: string): { n: number; text: string } {
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
    Object.assign(slot, { status, at: this.now(), answered: false, requestId });
    // Just the number and the message ("[6] ok"): no folder, no agent.
    return { n: slot.n, text: `[${slot.n}] ${body}` };
  }

  /** Tether's text went out as message `id` (a threaded reply to it names it). */
  noteSent(id: string, sessionId: string, requestId?: string) {
    this.state.sent = [...this.state.sent.filter((x) => x.id !== id), { id, sessionId, ...(requestId ? { requestId } : {}) }].slice(-MAX_SENT);
  }

  /** The request a session's last text was about is closed and the person was told: their next text to it is words to the agent. */
  closedRequest(sessionId: string, requestId: string) {
    const slot = this.state.slots.find((x) => x.sessionId === sessionId);
    if (slot?.requestId === requestId) slot.requestId = undefined;
  }

  /** Tether texted something (any text: a picker too). */
  noteOut() {
    this.state.lastOut = this.now();
  }

  /** The session was answered elsewhere (in Tether, the terminal): it isn't waiting on a text now. */
  settle(sessionId: string) {
    const slot = this.state.slots.find((x) => x.sessionId === sessionId);
    if (slot) slot.answered = true;
  }

  /** What textme needs to know to leave Tether's replies alone (thread.ts). */
  note(): TetherNote {
    return {
      lastOut: this.state.lastOut ?? 0,
      open: this.open().map((s) => ({ n: s.n, until: s.at + OPEN_MS })),
      sent: this.state.sent.map((x) => x.id),
    };
  }

  /**
   * What to do with the person's text. `replyTo`: the message it answers in a thread. `waiters`:
   * the textme processes waiting for a reply on the same thread (thread.ts).
   */
  route(raw: string, replyTo?: string, waiters: Waiter[] = []): Decision {
    this.prune();
    const text = raw.trim();
    if (!text) return { kind: "none" };

    const threaded = replyTo && this.state.sent.find((x) => x.id === replyTo);
    if (threaded) {
      const slot = this.state.slots.find((x) => x.sessionId === threaded.sessionId);
      if (slot) return this.deliver(slot, text, threaded.requestId ?? slot.requestId);
    }
    // A threaded answer to a textme's text is that textme's.
    if (replyTo && waiters.some((w) => w.id === replyTo)) return { kind: "none" };
    // So is one that starts with its tag.
    if (addressedToWaiter(text, waiters)) return { kind: "none" };

    const m = NUMBERED.exec(text);
    const named = m && this.state.slots.find((x) => x.n === Number(m[1]));
    // Not for an open session by number, and a textme texted after Tether did: it's answering that.
    if (!named && waiters.some((w) => w.sentAt > (this.state.lastOut ?? 0))) return { kind: "none" };

    if (m) {
      const n = Number(m[1]);
      const rest = m[2]!.trim();
      const slot = named;
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

  /** A one-sentence question ("Which session, by number?") and a row per session still waiting on
   * the person (every open one when none is: a number still reaches any open session). */
  picker(head: string = TEXTS.which): string {
    const now = this.now();
    const open = this.open();
    const waiting = open.filter((s) => !s.answered);
    const rows = (waiting.length ? waiting : open).map((s) => `[${s.n}] ${s.status}, ${ago(now - s.at)}`);
    return `${head}\n${rows.join("\n")}`;
  }

  private deliver(slot: Slot, text: string, requestId = slot.requestId): Decision {
    this.state.held = undefined;
    this.state.aimed = undefined;
    slot.at = this.now();
    slot.answered = true;
    return { kind: "deliver", sessionId: slot.sessionId, n: slot.n, text, ...(requestId ? { requestId } : {}) };
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
