// Which session a text reply is for. Every text Tether sends starts with its session's number
// ("[2] Claude has a question for you."); a session stays open for replies for OPEN_MS after its last
// text. A reply that names a number, or answers one of Tether's texts in a thread, goes to that
// session; plain text goes to the only open session, or is held while Tether asks which one with a
// numbered picker. Pure: the clock is passed in and the state is plain data, saved by the caller.
//
// The Home agent can be texted too (homeLine.ts), when it runs. It has several homes (its chats):
// `h` (the primary one, the Texts tab) and `h1`, `h2`, … (Home's other tabs). Its texts start with
// "[home]" (the primary one) or "[h1]", "[h2]", …. Only while it runs, a text whose first word is
// one of these, in any case, followed by a space, a colon, a comma or nothing, is a command for it
// (parseHome):
// - "h …" / "home …" (and "@h", "[home]"): to the primary home; "h1 …" / "home1 …": to home 1.
// - "hn …" / "homenew …" / "home-new …": a new home, the rest its first message (at most
//   MAX_EXTRA_HOMES besides h). Not "home new …": "Home new build is broken" is words to h.
// - "hd1" / "hd 1" / "homedelete 1" / "home-delete 1", as the whole text: deletes home 1 (never `h`).
// Never a word that only starts with them ("hey", "how", "Homer", "homework", "hnn", "h1n1"). A
// threaded reply to a home's text, and plain text when Tether's last text was a home's (or no
// session is open: the primary one) go to that home.
//
// A reply is about what was just texted: a home's text can say which session it's about (`about`).
// A text to that same home within REPLY_MS of it carries the session (Decision `about`), and the
// Home agent reads it as about that session (replyContext in homeLine.ts) unless it names another.
// A threaded reply to a home's text carries that text's session, however old. A number, another
// home, or a session's own text since turn away from it; a session's own texts keep the rules
// above (a plain reply with several open still gets the picker: a "y" mustn't approve the wrong
// request).
//
// Tether owns every reply on the thread: the text-me skill (textme), which used to share the
// Photon number and split replies with it, is gone; agents text through Tether's text_person.

import { HOME_SENDER, homeLabel, homeList, MAX_EXTRA_HOMES, type Home } from "../homeLine";
import { TEXTS } from "./texts";

export const OPEN_MS = 30 * 60_000;
/** The `sessionId` a Home agent text is noted under (`sent`). */
export const HOME = HOME_SENDER;
/** How a Home agent text starts. */
export const HOME_TAG = "[home]";
export const HELD_MS = 10 * 60_000;
/** How long after Tether's last text about a session a reply is still taken as being about it. */
export const REPLY_MS = 30 * 60_000;
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
  /** plain text waiting for the person to pick a session (`id`: which one, for what came with it) */
  held?: { text: string; at: number; id?: number; images?: number };
  /** the last held text's id */
  heldSeq?: number;
  /** the person sent just a number (or a home's name: `home`): their next text goes there */
  aimed?: { n: number; at: number; home?: boolean; chat?: string };
  /**
   * Tether's own texts, newest last: a threaded reply names one (`about`: the session a Home text
   * was about; `home`: the chat of a home other than the primary one that sent it)
   */
  sent: { id: string; sessionId: string; requestId?: string; about?: string; home?: string }[];
  /** when Tether last texted anything */
  lastOut?: number;
  /** Tether's last text about something was the Home agent's: plain text goes back to it */
  homeLast?: boolean;
  /** with homeLast: the chat of the home that sent it, when it isn't the primary one */
  homeChat?: string;
  /** the session a home's last text was about, and when (none: Tether's last text wasn't about one); `home` as in `sent` */
  about?: { sessionId: string; at: number; byHome?: boolean; home?: string };
}

/** What a reply to the Home agent is about: the session Tether's text it answers was about. */
export interface About {
  sessionId: string;
  /** the Home agent sent that text */
  byHome?: boolean;
}

export type Decision =
  /** `requestId`: the request the text it answers was about */
  | { kind: "deliver"; sessionId: string; n: number; text: string; requestId?: string; held?: number }
  /**
   * the person's words to the Home agent: to home `home`, chat `chat` (the chat decides: a number may
   * be taken again by another tab before it's handed over; absent: the primary one); `gone`: the home
   * it was for was deleted, so it goes to h and the person is told; `about`: the
   * session the text they answer was about; `held`: the held text's id when this took it over (its words, or these instead)
   */
  | { kind: "home"; text: string; about?: About; home?: number; chat?: string; held?: number; gone?: boolean }
  /** a new home, `text` its first message (maybe none) */
  | { kind: "newHome"; text: string; held?: number }
  /** delete home `n` (checked: open, and not the primary one) */
  | { kind: "deleteHome"; n: number }
  | { kind: "reply"; text: string }
  | { kind: "none" };

export const emptyState = (): RouterState => ({ slots: [], sent: [] });

/** What a text says to the Home agent, if it's a command for it (see the top of this file). */
export type HomeCommand = { cmd: "to"; n: number; rest: string } | { cmd: "new"; rest: string } | { cmd: "delete"; n: number };

/** "hd1", "hd 1", "homedelete 1", "home-delete 1": the whole text. */
const DELETE_HOME = /^\s*(?:hd|home-?delete)\s*(\d{1,2})\s*[.!]?\s*$/i;
/** "hn", "homenew", "home-new", as the first word. */
const NEW_HOME = /^\s*(?:hn|home-?new)(?=[\s:,]|$)[\s:,]*([\s\S]*)$/i;
/** "h", "home", "h1", "home12" (and in brackets, or after @), as the first word. */
const TO_HOME = /^\s*(?:\[\s*(?:home|h)(\d{1,2})?\s*\]|@(?:home|h)(\d{1,2})?(?![\w-])|(?:home|h)(\d{1,2})?(?=[\s:,]|$))[\s:,]*([\s\S]*)$/i;

/** The Home agent command a text starts with, else undefined. */
export function parseHome(text: string): HomeCommand | undefined {
  const d = DELETE_HOME.exec(text);
  if (d) return { cmd: "delete", n: Number(d[1]) };
  const nw = NEW_HOME.exec(text);
  if (nw) return { cmd: "new", rest: nw[1]!.trim() };
  const t = TO_HOME.exec(text);
  if (t) return { cmd: "to", n: Number(t[1] ?? t[2] ?? t[3] ?? 0), rest: t[4]!.trim() };
  return undefined;
}

/** The words of a text addressed to the primary home (prefix and separator taken off; "" for just "home"), else undefined. */
export function toHomeWords(text: string): string | undefined {
  const c = parseHome(text);
  return c?.cmd === "to" && c.n === 0 ? c.rest : undefined;
}

/** The Home agent's "number" while the person aims at it (`aimed`). */
const HOME_N = 0;

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
    this.state.homeLast = false;
    this.state.about = { sessionId, at: this.now() };
    // Just the number and the message ("[6] ok"): no folder, no agent.
    return { n: slot.n, text: `[${slot.n}] ${body}` };
  }

  /**
   * A home's text is going out (`about`: the session it's about, if it says; `home`: which home,
   * and its chat when it isn't the primary one): its text, marked so the person (and a threaded
   * reply) can tell it apart: "[home] …", "[h1] …".
   */
  stampHome(body: string, about?: string, home?: { n: number; chat: string }): string {
    this.state.homeLast = true;
    const chat = home && home.n !== 0 ? home.chat : undefined;
    if (chat) this.state.homeChat = chat;
    else delete this.state.homeChat;
    if (about) this.state.about = { sessionId: about, at: this.now(), byHome: true, ...(chat ? { home: chat } : {}) };
    else delete this.state.about;
    return `${chat ? `[${homeLabel(home!.n)}]` : HOME_TAG} ${body}`;
  }

  /**
   * Tether's text went out as message `id` (a threaded reply to it names it). `about`: the session a
   * Home text was about; `home`: the chat of the (non-primary) home that sent it.
   */
  noteSent(id: string, sessionId: string, requestId?: string, about?: string, home?: string) {
    const e = { id, sessionId, ...(requestId ? { requestId } : {}), ...(about ? { about } : {}), ...(home ? { home } : {}) };
    this.state.sent = [...this.state.sent.filter((x) => x.id !== id), e].slice(-MAX_SENT);
  }

  /**
   * The session a home's last text was about, when Tether's last text was that one and went out
   * less than REPLY_MS ago: a text to that same home now answers it. (After a session's own text,
   * or to another home, a text turns away from that session: it carries nothing.) `chat`: the
   * home's chat, none for the primary one.
   */
  recent(chat?: string): About | undefined {
    const a = this.state.about;
    if (!a?.byHome || a.home !== chat || this.now() - a.at >= REPLY_MS) return undefined;
    return { sessionId: a.sessionId, byHome: true };
  }

  /** Home chat `from` went on in `to` (a move): its texts, and what they were about, are `to`'s. */
  movedHome(from: string, to: string) {
    const st = this.state;
    for (const e of st.sent) if (e.home === from) e.home = to;
    if (st.homeChat === from) st.homeChat = to;
    if (st.about?.home === from) st.about.home = to;
    if (st.aimed?.chat === from) st.aimed.chat = to;
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
   * What to do with the person's text. `replyTo`: the message it answers in a thread. `home`: the
   * Home agent runs and takes texts: true, or its open homes (the primary one, n 0, always among
   * them).
   */
  route(raw: string, replyTo?: string, home: boolean | Home[] = false): Decision {
    this.prune();
    const text = raw.trim();
    if (!text) return { kind: "none" };
    const homes: Home[] = home === true ? [{ n: 0 }] : home === false ? [] : home.some((h) => h.n === 0) ? home : [{ n: 0 }, ...home];
    const running = homes.length > 0;
    const primary = homes.find((h) => h.n === 0)!;

    const threaded = replyTo && this.state.sent.find((x) => x.id === replyTo);
    if (threaded) {
      if (threaded.sessionId === HOME) {
        if (!running) return { kind: "reply", text: TEXTS.noHome };
        const thread = threaded.about ? { sessionId: threaded.about, byHome: true } : null;
        const h = threaded.home ? homes.find((x) => x.n !== 0 && x.chat === threaded.home) : primary;
        // Its home was deleted since: to h, and the person is told (as for plain text below).
        if (!h) return this.toHome(text, primary, thread, true);
        return this.toHome(text, h, thread);
      }
      const slot = this.state.slots.find((x) => x.sessionId === threaded.sessionId);
      if (slot) return this.deliver(slot, text, threaded.requestId ?? slot.requestId);
    }

    // Only while the Home agent runs: without it, "Home page" or "H" are words for a session.
    const c = running ? parseHome(text) : undefined;
    if (c?.cmd === "delete") {
      if (c.n === 0) return { kind: "reply", text: TEXTS.cantDeletePrimary };
      if (!homes.some((h) => h.n === c.n)) return { kind: "reply", text: TEXTS.noSuchHome(homeLabel(c.n), homeList(homes)) };
      return { kind: "deleteHome", n: c.n };
    }
    if (c?.cmd === "new") {
      if (homes.filter((h) => h.n !== 0).length >= MAX_EXTRA_HOMES) return { kind: "reply", text: TEXTS.homesFull(homeList(homes)) };
      const held = this.state.held;
      this.state.held = undefined;
      this.state.aimed = undefined;
      return { kind: "newHome", text: c.rest || held?.text || "", ...(held?.id !== undefined ? { held: held.id } : {}) };
    }
    if (c?.cmd === "to") {
      const h = homes.find((x) => x.n === c.n);
      if (!h) return { kind: "reply", text: TEXTS.noSuchHome(homeLabel(c.n), homeList(homes)) };
      if (c.rest) return this.toHome(c.rest, h);
      if (this.state.held) return this.toHome(this.state.held.text, h);
      this.state.aimed = { n: c.n, at: this.now(), home: true, ...(c.n !== 0 && h.chat ? { chat: h.chat } : {}) };
      return { kind: "reply", text: c.n === 0 ? TEXTS.whatToSendHome : TEXTS.whatToSendTo(homeLabel(c.n)) };
    }

    const m = NUMBERED.exec(text);
    if (m) {
      const n = Number(m[1]);
      const rest = m[2]!.trim();
      const slot = this.state.slots.find((x) => x.n === n);
      if (!slot) {
        if (rest) this.hold(rest);
        return { kind: "reply", text: this.open().length || running ? this.picker(TEXTS.notWaiting(n), running) : NOTHING_OPEN };
      }
      if (rest) return this.deliver(slot, rest);
      const held = this.state.held;
      if (held) return this.deliver(slot, held.text);
      this.state.aimed = { n, at: this.now() };
      return { kind: "reply", text: TEXTS.whatToSend(n) };
    }

    const aim = this.state.aimed;
    if (aim && (aim.home || aim.n === HOME_N) && running) {
      // Aimed at a home by its chat: a number freed and taken again since is another home.
      const h = aim.chat ? homes.find((x) => x.n !== 0 && x.chat === aim.chat) : primary;
      if (!h) {
        this.state.aimed = undefined;
        return { kind: "reply", text: TEXTS.homeGone(homeList(homes)) };
      }
      return this.toHome(text, h);
    }
    const aimed = aim && !aim.home && this.state.slots.find((x) => x.n === aim.n);
    if (aimed) return this.deliver(aimed, text);

    // Tether's last text was a home's: this answers it (and is about what that text was about).
    if (running && this.state.homeLast) {
      const from = this.state.homeChat;
      const h = from ? homes.find((x) => x.n !== 0 && x.chat === from) : primary;
      if (h) return this.toHome(text, h);
      // The home that texted last was deleted since: to h, the person told, and h is the last one now.
      delete this.state.homeChat;
      delete this.state.about;
      return this.toHome(text, primary, undefined, true);
    }
    const open = this.open();
    if (!open.length) return running ? this.toHome(text, primary) : { kind: "reply", text: NOTHING_OPEN };
    if (open.length === 1) return this.deliver(open[0]!, text);
    this.hold(text);
    return { kind: "reply", text: this.picker(TEXTS.which, running) };
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
  picker(head: string = TEXTS.which, home = false): string {
    const now = this.now();
    const open = this.open();
    const waiting = open.filter((s) => !s.answered);
    const rows = (waiting.length ? waiting : open).map((s) => `[${s.n}] ${s.status}, ${ago(now - s.at)}`);
    if (home) rows.push(TEXTS.homeRow);
    return `${head}\n${rows.join("\n")}`;
  }

  /**
   * To home `h`, about what its last text was about (or `thread`, a thread's). `held`: the held
   * text's id when there was one, whether its words go or these replace them: what came with it
   * goes the same way (texting/index.ts).
   */
  private toHome(text: string, h: Home, thread?: About | null, gone = false): Decision {
    const about = thread === undefined ? this.recent(h.n === 0 ? undefined : h.chat) : (thread ?? undefined);
    const held = this.state.held?.id;
    this.state.held = undefined;
    this.state.aimed = undefined;
    return { kind: "home", text, ...(about ? { about } : {}), ...(h.n !== 0 ? { home: h.n, ...(h.chat ? { chat: h.chat } : {}) } : {}), ...(held !== undefined ? { held } : {}), ...(gone ? { gone } : {}) };
  }

  private deliver(slot: Slot, text: string, requestId = slot.requestId): Decision {
    const held = this.state.held?.id;
    this.state.held = undefined;
    this.state.aimed = undefined;
    slot.at = this.now();
    slot.answered = true;
    return { kind: "deliver", sessionId: slot.sessionId, n: slot.n, text, ...(requestId ? { requestId } : {}), ...(held !== undefined ? { held } : {}) };
  }

  private prune() {
    const now = this.now();
    const st = this.state;
    st.slots = st.slots.filter((s) => now - s.at < OPEN_MS);
    if (st.held && now - st.held.at >= HELD_MS) st.held = undefined;
    if (st.aimed && (now - st.aimed.at >= HELD_MS || (!st.aimed.home && st.aimed.n !== HOME_N && !st.slots.some((s) => s.n === st.aimed!.n)))) st.aimed = undefined;
  }
}

export const NOTHING_OPEN = TEXTS.nothingOpen;
