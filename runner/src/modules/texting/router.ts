// Which session a text reply is for. Every text Tether sends starts with its session's number
// ("[2] Claude has a question for you."); a session stays open for replies for OPEN_MS after its last
// text. A reply that names a number, or answers one of Tether's texts in a thread, goes to that
// session; plain text goes to the open session last texted or answered. Only sessions whose
// "Session can text me" box is ticked text (texting/index.ts), so only they get numbers: with none
// open, plain text is held while a numbered picker of the ticked ones (`texters`, offered numbers
// of their own) asks which. An unticked session's number is dropped (`drop`), and a text to it says
// it can't text. Pure: the clock is passed in and the state is plain data, saved by the caller.
//
// Tether owns every reply on the thread: the text-me skill (textme), which used to share the
// Photon number and split replies with it, is gone; agents text through Tether's text_person.

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
  /** the person answered it (by text, or in Tether) since its last text: not in the picker */
  answered?: boolean;
  /** the request its last text was about: a reply answers that one only, never another, and never
   * goes to the agent as words once it's closed (texting/index.ts) */
  requestId?: string;
  /** the order it was last texted or answered in (RouterState.seq): plain text goes to the latest */
  seq?: number;
  /** a number the picker offered a ticked session that hasn't texted (`status`: its name): plain text never goes to it unpicked */
  offered?: boolean;
}

/** A session that may text (its "Session can text me" box is ticked), for the picker: its name. */
export interface Ticked {
  sessionId: string;
  label: string;
}

export interface RouterState {
  slots: Slot[];
  /** plain text waiting for the person to pick a session (`id`: which one, for what came with it) */
  held?: { text: string; at: number; id?: number; images?: number };
  /** the last held text's id */
  heldSeq?: number;
  /** the person sent just a number: their next text goes there */
  aimed?: { n: number; at: number };
  /** Tether's own texts, newest last: a threaded reply names one */
  sent: { id: string; sessionId: string; requestId?: string }[];
  /** when Tether last texted anything */
  lastOut?: number;
  /** numbers of sessions unticked lately (`drop`): a text to one says it can't text, not where else it might go */
  muted?: { n: number; sessionId: string; at: number }[];
  /** counts texts and answers to sessions, for Slot.seq (a clock can tie) */
  seq?: number;
}

export type Decision =
  /** `requestId`: the request the text it answers was about */
  | { kind: "deliver"; sessionId: string; n: number; text: string; requestId?: string; held?: number }
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
    Object.assign(slot, { status, at: this.now(), answered: false, requestId, seq: this.next() });
    delete slot.offered;
    // Just the number and the message ("[6] ok"): no folder, no agent.
    return { n: slot.n, text: `[${slot.n}] ${body}` };
  }

  /** Tether's text went out as message `id` (a threaded reply to it names it). */
  noteSent(id: string, sessionId: string, requestId?: string) {
    const e = { id, sessionId, ...(requestId ? { requestId } : {}) };
    this.state.sent = [...this.state.sent.filter((x) => x.id !== id), e].slice(-MAX_SENT);
  }

  /** The text held for the picker now (an expired one gone), if any. */
  heldNow(): RouterState["held"] {
    this.prune();
    return this.state.held;
  }

  /** A session's slot is waiting on the person again (a text that went to it didn't answer its request). */
  unsettle(sessionId: string) {
    const slot = this.state.slots.find((x) => x.sessionId === sessionId);
    if (slot) slot.answered = false;
  }

  /** The request a session's last text was about is closed and the person was told: their next text to it is words to the agent. */
  closedRequest(sessionId: string, requestId: string) {
    const slot = this.state.slots.find((x) => x.sessionId === sessionId);
    if (slot?.requestId === requestId) slot.requestId = undefined;
  }

  /** The session's "Session can text me" box was unticked: its number goes, and a text to that number says it can't text. Whether it had one. */
  drop(sessionId: string): boolean {
    const st = this.state;
    const slot = st.slots.find((x) => x.sessionId === sessionId);
    if (!slot) return false;
    st.slots = st.slots.filter((x) => x !== slot);
    st.muted = [...(st.muted ?? []).filter((m) => m.n !== slot.n && m.sessionId !== sessionId), { n: slot.n, sessionId, at: this.now() }].slice(-MAX_SLOTS);
    if (st.aimed && st.aimed.n === slot.n) st.aimed = undefined;
    return true;
  }

  /** The session's box was ticked (again): a text to its old number no longer says it can't. */
  allow(sessionId: string) {
    if (this.state.muted) this.state.muted = this.state.muted.filter((m) => m.sessionId !== sessionId);
  }

  /** Numbers for the ticked sessions that have none (most recent first, as many as are free), for the picker to offer. */
  private offer(texters: Ticked[]) {
    const s = this.state.slots;
    for (const t of texters) {
      if (s.length >= MAX_SLOTS) break;
      if (s.some((x) => x.sessionId === t.sessionId)) continue;
      const used = new Set(s.map((x) => x.n));
      let n = 1;
      while (used.has(n)) n++;
      s.push({ n, sessionId: t.sessionId, status: t.label, at: this.now(), offered: true });
      // Its number is its own now: it isn't the unticked one that had it.
      if (this.state.muted) this.state.muted = this.state.muted.filter((m) => m.n !== n && m.sessionId !== t.sessionId);
    }
  }

  /** The number an unticked session had, when a text names it (by number, or by a thread on its text) and nothing has it now. */
  private mutedAs(f: (m: { n: number; sessionId: string }) => boolean): number | undefined {
    return this.state.muted?.find((m) => f(m) && !this.state.slots.some((x) => x.n === m.n || x.sessionId === m.sessionId))?.n;
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

  /**
   * What to do with the person's text. `replyTo`: the message it answers in a thread. `files`: files
   * came with it, so just a number with no words delivers them, as `filesOnly` says. `texters`: the
   * sessions that may text, most recent first, for a picker when none is open (none given: only the
   * open ones).
   */
  route(raw: string, replyTo?: string, files?: { filesOnly: string }, texters?: Ticked[]): Decision {
    this.prune();
    const text = raw.trim();
    if (!text) return { kind: "none" };

    const threaded = replyTo && this.state.sent.find((x) => x.id === replyTo);
    if (threaded) {
      const slot = this.state.slots.find((x) => x.sessionId === threaded.sessionId);
      if (slot) return this.deliver(slot, text, threaded.requestId ?? slot.requestId);
      const was = this.mutedAs((m) => m.sessionId === threaded.sessionId);
      if (was !== undefined) return { kind: "reply", text: TEXTS.cantText(was) };
    }

    const m = NUMBERED.exec(text);
    if (m) {
      const n = Number(m[1]);
      const rest = m[2]!.trim();
      const slot = this.state.slots.find((x) => x.n === n);
      if (!slot) {
        const was = this.mutedAs((x) => x.n === n);
        if (was !== undefined) return { kind: "reply", text: TEXTS.cantText(was) };
        if (rest) this.hold(rest);
        // Nothing open: the sessions that may text get numbers, which the person hasn't seen yet.
        if (!this.open().length) {
          this.offer(texters ?? []);
          if (this.open().length) return { kind: "reply", text: this.picker(TEXTS.which) };
        }
        return { kind: "reply", text: this.open().length ? this.picker(TEXTS.notWaiting(n)) : this.nothing(texters) };
      }
      if (rest) return this.deliver(slot, rest);
      const held = this.state.held;
      if (held) return this.deliver(slot, held.text);
      if (files) return this.deliver(slot, files.filesOnly);
      this.state.aimed = { n, at: this.now() };
      return { kind: "reply", text: TEXTS.whatToSend(n) };
    }

    const aim = this.state.aimed;
    const aimed = aim && this.state.slots.find((x) => x.n === aim.n);
    if (aimed) return this.deliver(aimed, text);

    // A thread on a text whose session isn't open, or on a message Tether doesn't know: never plain
    // routing (a "y" there mustn't answer another session's request). Held, and the picker asks.
    if (replyTo) {
      if (!this.open().length) this.offer(texters ?? []);
      if (!this.open().length) return { kind: "reply", text: this.nothing(texters) };
      this.hold(text);
      return { kind: "reply", text: this.picker(TEXTS.threadNotWaiting) };
    }
    // The open session last texted or answered (a number offered by a picker isn't one till it's picked).
    const live = this.open().filter((s) => !s.offered);
    // Two or more waiting on a request: a plain "y" could approve the wrong one, so it asks.
    if (live.filter((s) => s.requestId && !s.answered).length > 1) {
      this.hold(text);
      return { kind: "reply", text: this.picker(TEXTS.which) };
    }
    if (live.length) return this.deliver(live.reduce((a, b) => ((b.seq ?? 0) > (a.seq ?? 0) || ((b.seq ?? 0) === (a.seq ?? 0) && b.at > a.at) ? b : a)), text);
    // None: which of the sessions that may text?
    this.offer(texters ?? []);
    if (this.open().length) {
      this.hold(text);
      return { kind: "reply", text: this.picker(TEXTS.which) };
    }
    return { kind: "reply", text: this.nothing(texters) };
  }

  /** Nothing open to pick: no session may text, when the caller said which may. */
  private nothing(texters?: Ticked[]): string {
    return texters && !texters.length ? TEXTS.noTexters : NOTHING_OPEN;
  }

  /** Holds plain text for the person to pick a session: its id (what came with it is kept under it, texting/index.ts). */
  private hold(text: string): number {
    const id = (this.state.heldSeq ?? 0) + 1;
    this.state.heldSeq = id;
    this.state.held = { text, at: this.now(), id };
    return id;
  }

  /** A one-sentence question ("Which session, by number?") and a row per session still waiting on
   * the person (every open one when none is: a number still reaches any open session). */
  picker(head: string = TEXTS.which): string {
    const now = this.now();
    const open = this.open();
    const waiting = open.filter((s) => !s.answered);
    const rows = (waiting.length ? waiting : open).map((s) => (s.offered ? `[${s.n}] ${s.status}` : `[${s.n}] ${s.status}, ${ago(now - s.at)}`));
    return `${head}\n${rows.join("\n")}`;
  }

  private deliver(slot: Slot, text: string, requestId = slot.requestId): Decision {
    const held = this.state.held?.id;
    this.state.held = undefined;
    this.state.aimed = undefined;
    slot.at = this.now();
    slot.answered = true;
    slot.seq = this.next();
    delete slot.offered;
    return { kind: "deliver", sessionId: slot.sessionId, n: slot.n, text, ...(requestId ? { requestId } : {}), ...(held !== undefined ? { held } : {}) };
  }

  private next(): number {
    return (this.state.seq = (this.state.seq ?? 0) + 1);
  }

  private prune() {
    const now = this.now();
    const st = this.state;
    st.slots = st.slots.filter((s) => now - s.at < OPEN_MS);
    if (st.muted) st.muted = st.muted.filter((m) => now - m.at < OPEN_MS);
    if (st.held && now - st.held.at >= HELD_MS) st.held = undefined;
    // A hold from before holds had ids gets one: what goes with it is kept by its id.
    if (st.held && st.held.id === undefined) st.held.id = st.heldSeq = (st.heldSeq ?? 0) + 1;
    if (st.aimed && (now - st.aimed.at >= HELD_MS || !st.slots.some((s) => s.n === st.aimed!.n))) st.aimed = undefined;
  }
}

export const NOTHING_OPEN = TEXTS.nothingOpen;
