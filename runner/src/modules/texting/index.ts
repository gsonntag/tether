// Texting (SPEC §11 Texting): a request, "needs you" in the terminal, a failed turn, a turn that ended
// with the agent asking you something, and the agent's answer to anything you texted it go to the
// person's phone as iMessages through Photon Spectrum, with a link to the session in Tether now and
// then (LINK_EVERY_MS; never on the back-and-forth of a texted conversation). A
// turn that just finishes doesn't text. Replies go back to the session: y or n (or a letter) answers
// a request, anything else is the person's words to the agent (describe.ts). Each text starts with
// its session's number; a reply that isn't clear gets a numbered picker (router.ts). The runner sends
// them, not the app: a Foliation app has no internet egress (server/src/push.ts).
//
// The person can text the Home agent too (homeLine.ts, router.ts): "home: ..." or plain words when
// nothing else claims them go to its Texts chat, and its short replies come back as "[home] ..."
// texts (homeAgent/index.ts decides which replies).
//
// An agent can text the person itself with its text_person tool (personText): a short text stamped with its session's
// number like any other, whose reply comes back to that session (rate-capped: AgentTextCaps).
//
// Texts go over messaging connectors (connector.ts, connectors.ts): iMessage through Photon, a Discord
// bot, … Everything above is the same on each: one router, one set of session numbers. Tether's texts
// go to the connector the person picked in settings, else the one they last wrote on, else the first
// one connected. An answer goes back the way the person's message came: the reply to a picker, and a
// session's (or the Home agent's) answer to what they wrote it, by the connector they last wrote
// it on (replyVia), whatever "Send to" says. Files they send come along to the session or the Home
// agent (stash), held with their words while the picker asks which session; none is dropped
// without saying so.
//
// Texts carry what the agent wants and says (the person asked for that over push's lock-screen
// wording), a request as one "Can I …? y/n" question with no raw command (describe.ts, summary.ts); known secrets
// are redacted. Tether's own words read like a human's: "[6] ok", one
// casual sentence at most, never that something works, and no acknowledgment after a reply is
// passed on (texts.ts has the whole rule).

import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Msg, Request, RequestAnswer } from "../../../../shared/transcript";
import { isImageType, safeName, type Attachment } from "../../../../shared/attachments";
import { ATTACH_FILE_MAX, ATTACH_IMAGE_MAX, ATTACH_MAX } from "../../../../shared/limits";
import type { MessagingStatus } from "../../../../shared/protocol";
import type { Module, ModuleContext } from "..";
import { sessionKey } from "../../core/attachments";
import { agentOf, endWorthTelling, failureKind, FINISH_DELAY_MS, REQUEST_DELAY_MS, requestStillOpen } from "../push";
import { Channel, type Connector, type Inbound, type InboundFile } from "./connector";
import { connectors, type ConnectorDeps } from "./connectors";
import { clip, readReply, requestText } from "./describe";
import { IMESSAGE } from "./imessage";
import { openSpectrum, type OpenLink } from "./link";
import { HELD_MS, HOME, Router } from "./router";
import { PERSON_TEXT_MAX } from "../homeLine";
import { TextingStore } from "./store";
import { TEXTS } from "./texts";
import { replyForPeople } from "../../../../shared/checkIn";

/** The reaction on a text Tether read and passed on to its session. */
export const READ = "✅";

/** Whether an agent's message ends by asking the person something: its last paragraph (code left out) has a question. */
export function asksQuestion(text: string): boolean {
  const prose = text.replace(/```[\s\S]*?(```|$)/g, "").replace(/`[^`\n]*`/g, "").trim();
  const last = prose.split(/\n\s*\n/).pop() ?? "";
  return /\?(?=["')\]*_]*(\s|$))/.test(last);
}

type Ctx = Pick<ModuleContext, "session" | "viewersOf" | "log" | "runnerId" | "appUrl" | "homeLine" | "links" | "attachmentsDir"> & { sessions: Pick<ModuleContext["sessions"], "tell" | "answer"> };

/** What the agent reads for a message with only files in it. */
export const FILES_ONLY = "(sent a file)";
/** A message with only files, while it's routed (no one can type it: NUL is taken out of what they send). */
const NO_WORDS = "\u0000";

/** Where an answer goes back: the connector, and the place on it (a Discord channel or DM). */
export interface Back {
  via: string;
  place?: string;
}

/** How long an agent's answer may be in a text. */
const SAID_MAX = 1500;
/** How long a Home agent text may be: it's meant to be a few words. */
export const HOME_MAX = 600;
/** How many sessions' "answer back this way" are kept. */
const REPLY_VIA_MAX = 50;
/** How many of the person's texts are remembered, so one heard twice is taken once. */
const HEARD_MAX = 200;
/** At most this many text_person texts from one session (or the Home agent) in AGENT_TEXT_MS, and from all of them together. */
export const AGENT_TEXT_MAX = 3;
export const AGENT_TEXTS_MAX = 10;
export const AGENT_TEXT_MS = 10 * 60_000;
/** The status a session's text_person text shows in the picker. */
export const TEXTED_YOU = "texted you";

/** The rate caps on agents' own texts. */
export class AgentTextCaps {
  private sent: { from: string; at: number }[] = [];
  constructor(private now: () => number = Date.now) {}

  /** Why `from` can't text now, or undefined (and it's counted). */
  take(from: string): string | undefined {
    const at = this.now();
    this.sent = this.sent.filter((s) => at - s.at < AGENT_TEXT_MS);
    const mins = AGENT_TEXT_MS / 60_000;
    if (this.sent.filter((s) => s.from === from).length >= AGENT_TEXT_MAX) return `You've texted the person ${AGENT_TEXT_MAX} times in the last ${mins} minutes (at most ${AGENT_TEXT_MAX}). Nothing was sent: put it in your reply instead.`;
    if (this.sent.length >= AGENT_TEXTS_MAX) return `Agents have texted the person ${AGENT_TEXTS_MAX} times in the last ${mins} minutes. Nothing was sent: put it in your reply instead.`;
    this.sent.push({ from, at });
    return undefined;
  }

  /** Gives back `from`'s last one (it didn't go). */
  undo(from: string) {
    const i = this.sent.map((s) => s.from).lastIndexOf(from);
    if (i >= 0) this.sent.splice(i, 1);
  }
}

/** A session's link goes in a text at most this often. */
export const LINK_EVERY_MS = 5 * 60_000;

export class Texter {
  readonly router: Router;
  /** one per connector, in CONNECTORS' order */
  readonly channels: Channel[];
  private inbox = Promise.resolve();
  private failed?: string;
  /** each session's last words from the agent this turn (to tell whether it ended asking something) */
  private lastSaid = new Map<string, string>();
  /** sessions the person texted: the agent's answer goes back by text */
  private talking = new Set<string>();
  /** files that came with the text the router holds for the picker, which hold that is, and where they came from */
  private held?: { files: InboundFile[]; hold: { text: string; at: number }; back?: Back };
  private heldTimer?: ReturnType<typeof setTimeout>;
  /** when each session's link last went out */
  private linked = new Map<string, number>();
  /** the ids of the person's texts already taken, newest last */
  private heardIds: string[] = [];
  readonly caps: AgentTextCaps;

  constructor(
    private ctx: Ctx,
    readonly store: TextingStore,
    open: OpenLink = openSpectrum,
    private now: () => number = Date.now,
    deps: { connectors?: ConnectorDeps; list?: Connector[] } = {},
  ) {
    this.router = new Router(store.router, now);
    this.caps = new AgentTextCaps(now);
    const list = deps.list ?? connectors(store, { ...deps.connectors, [IMESSAGE]: open });
    this.channels = list.map((c) => new Channel(c, (m) => void this.heard(m), ctx.log));
  }

  // ── the links ──

  /** Connects every connector that's on and set; each reconnects after a drop, backing off. */
  async start() {
    await Promise.all(this.channels.map((c) => c.start()));
  }

  async stop() {
    await Promise.all(this.channels.map((c) => c.stop()));
  }

  /** Settings changed: new links with them (or none); `id`: just that connector's. */
  async restart(id?: string) {
    await Promise.all(this.channels.filter((c) => !id || c.id === id).map((c) => c.restart()));
  }

  channel(id: string | undefined): Channel | undefined {
    return id ? this.channels.find((c) => c.id === id) : undefined;
  }

  /** Some connector is connected. */
  get connected(): boolean {
    return this.channels.some((c) => c.connected);
  }

  /** Why the last text didn't go, or why the link to the person is down. */
  get lastError(): string | undefined {
    return this.failed ?? this.target()?.lastError ?? this.channels.find((c) => c.lastError)?.lastError;
  }

  /** Where Tether's texts go: the connector picked in settings (when it's on), else the one the person last wrote on, else the first one connected. */
  target(): Channel | undefined {
    for (const id of [this.store.prefer, this.store.lastVia]) {
      const c = this.channel(id);
      if (c?.connected && c.connector.enabled()) return c;
    }
    return this.channels.find((c) => c.connected && c.connector.enabled());
  }

  /** Where an answer to session `id` (or the Home agent, HOME) goes: the way the person last wrote it. */
  backTo(id: string): Back | undefined {
    return this.store.replyVia[id];
  }

  private async say(text: string, back?: Back): Promise<string | undefined> {
    return (await this.send(text, back)).id;
  }

  /** Texts the person (an answer: back the way it came, `back`, when that's connected); `sent`: it went (Photon may give no id). */
  private async send(text: string, back?: Back, images?: string[]): Promise<{ sent: boolean; id?: string; ids?: string[] }> {
    const there = back && this.channel(back.via);
    const ch = (there?.connected ? there : undefined) ?? this.target();
    if (!ch) return { sent: false };
    try {
      const ids = await ch.send({ text, ...(images?.length ? { images } : {}), ...(back?.place && ch === there ? { place: back.place } : {}) });
      this.failed = undefined;
      this.router.noteOut();
      return { sent: true, ...(ids[0] ? { id: ids[0], ids } : {}) };
    } catch (e: any) {
      this.failed = ch.lastError;
      return { sent: false };
    }
  }

  /** Notes each part of a text that went (a split one has several): a threaded reply to any of them names it. */
  private noteSent(r: { ids?: string[] }, sessionId: string, requestId?: string) {
    for (const id of r.ids ?? []) this.router.noteSent(id, sessionId, requestId);
  }

  /**
   * The Home agent texts the person ("[home] ok, on it"): whether it went. A threaded reply to it goes
   * back to the Home agent. `reply`: it answers what the person wrote it, so it goes back the way that
   * came; its own text (text_person) goes where Tether's texts go.
   */
  async homeText(body: string, o: { reply?: boolean } = {}): Promise<boolean> {
    const words = clip(body, HOME_MAX);
    if (!this.target() || !words) return false;
    const r = await this.send(this.router.stampHome(words), o.reply === false ? undefined : this.backTo(HOME));
    this.noteSent(r, HOME);
    this.store.save();
    return r.sent;
  }

  /** A test text on one connector (iMessage when unnamed). */
  async test(id: string = IMESSAGE) {
    const ch = this.channel(id);
    if (!ch) throw new Error("There's no such connector.");
    const c = ch.connector;
    if (!c.enabled() || !c.configured()) throw new Error(c.notReady);
    await ch.start();
    if (!ch.connected) throw new Error(ch.lastError ?? `Not connected to ${c.service ?? c.label} yet.`);
    await ch.send({ text: TEXTS.test });
  }

  /** Settings: every connector, never a secret. */
  messaging(): MessagingStatus {
    return {
      connectors: this.channels.map((ch) => {
        const c = ch.connector;
        return { id: c.id, label: c.label, enabled: c.enabled(), configured: c.configured(), connected: ch.connected, ...(ch.lastError ? { lastError: ch.lastError } : {}), about: c.about, forms: c.forms() };
      }),
      ...(this.store.prefer ? { prefer: this.store.prefer } : {}),
      ...(this.store.lastVia ? { lastUsed: this.store.lastVia } : {}),
    };
  }

  /** Changes one connector's settings, and reconnects it. */
  async setConnector(a: { id?: unknown; enabled?: unknown; values?: unknown }): Promise<MessagingStatus> {
    const ch = this.channel(typeof a.id === "string" ? a.id : undefined);
    if (!ch) throw new Error("There's no such connector.");
    const values: Record<string, string> = {};
    if (a.values !== undefined) {
      if (!a.values || typeof a.values !== "object" || Array.isArray(a.values)) throw new Error("Bad settings.");
      for (const [k, v] of Object.entries(a.values)) {
        if (typeof v !== "string" || v.length > 500) throw new Error("That value is too long.");
        values[k] = v;
      }
    }
    ch.connector.update({ ...(typeof a.enabled === "boolean" ? { enabled: a.enabled } : {}), values });
    await ch.restart();
    return this.messaging();
  }

  /** Where Tether's texts go: a connector, or (null) wherever the person last wrote. */
  prefer(id: unknown): MessagingStatus {
    if (id === null || id === undefined || id === "") this.store.prefer = undefined;
    else if (typeof id === "string" && this.channel(id)?.connector.enabled()) this.store.prefer = id;
    else if (typeof id === "string" && this.channel(id)) throw new Error("Turn it on first.");
    else throw new Error("There's no such connector.");
    this.store.save();
    return this.messaging();
  }

  /**
   * The person's files, stored for `sessionId` under the runner's attachments folder (as the
   * composer's uploads are, core/attachments.ts): what a message to it carries. One that's too big or
   * won't come is skipped, and the person is told.
   */
  private async stash(sessionId: string, files: InboundFile[] | undefined, via?: Back): Promise<Attachment[]> {
    const dir = this.ctx.attachmentsDir;
    if (!files?.length) return [];
    if (!dir) {
      await this.say(TEXTS.filesNotSent, via);
      return [];
    }
    const into = join(dir, sessionKey(sessionId));
    const out: Attachment[] = [];
    for (const f of files.slice(0, ATTACH_MAX)) {
      const max = isImageType(f.mimeType) ? ATTACH_IMAGE_MAX : ATTACH_FILE_MAX;
      try {
        if (f.size !== undefined && f.size > max) throw new Error("it's too big");
        const data = await f.read(max);
        if (data.byteLength > max) throw new Error("it's too big");
        mkdirSync(into, { recursive: true, mode: 0o700 });
        const name = safeName(f.name);
        const path = join(into, `${randomBytes(4).toString("hex")}-${name}`);
        writeFileSync(path, data, { mode: 0o400 });
        out.push({ path, name, mimeType: f.mimeType, size: data.byteLength });
      } catch (e: any) {
        this.ctx.log(`texting: couldn't take ${safeName(f.name)}: ${e?.message ?? e}`);
        await this.say(TEXTS.fileSkipped(safeName(f.name)), via);
      }
    }
    return out;
  }

  // ── out: what happened ──

  /** The session in Tether. */
  url(sessionId: string): string {
    const short = this.ctx.links?.url(this.ctx.appUrl, sessionId);
    if (short) return short;
    return `${this.ctx.appUrl.replace(/\/+$/, "")}/#/s/${encodeURIComponent(this.ctx.runnerId)}/${encodeURIComponent(sessionId)}`;
  }

  /**
   * An agent's own text (its text_person tool): at most PERSON_TEXT_MAX characters, stamped with its
   * session's number (or [home]) so a reply goes back to it. Sent even while the session is open in
   * Tether: the agent was asked to text. What the tool answers the agent.
   */
  async personText(from: string, body: string): Promise<{ text: string; isError?: boolean }> {
    const words = clip(body, PERSON_TEXT_MAX);
    if (!words) return { text: "The message is empty.", isError: true };
    if (!this.target()) return { text: "Texting isn't set up or connected in Tether, so nothing was sent. Say it in your reply instead.", isError: true };
    const why = this.caps.take(from);
    if (why) return { text: why, isError: true };
    const sent = from === HOME ? await this.homeText(words, { reply: false }) : (await this.tell(from, TEXTED_YOU, words, { always: true })).sent;
    if (!sent) {
      this.caps.undo(from);
      return { text: `The text didn't go (${this.lastError ?? "not connected"}). Say it in your reply instead.`, isError: true };
    }
    const cut = words.length < body.trim().length ? ` It was cut to ${PERSON_TEXT_MAX} characters.` : "";
    return { text: `Texted the person.${cut} If they reply, their reply comes to you as a message.` };
  }

  /** Texts about a session, unless someone is looking at it (or at `also`) in Tether right now (`always`: even then). Whether it went. */
  async tell(sessionId: string, status: string, body: string, o: { also?: string[]; quick?: boolean; requestId?: string; always?: boolean; link?: boolean; via?: Back } = {}): Promise<{ sent: boolean }> {
    const { also = [], quick = false, requestId, always = false } = o;
    if (!this.target()) return { sent: false };
    if (!always && [sessionId, ...also].some((id) => this.ctx.viewersOf(id).length)) return { sent: false };
    // The link only now and then, and never on a quick back-and-forth.
    const at = this.now();
    // A request's text always has it: the full command is there, not in the text.
    const link = !!o.link || (!quick && at - (this.linked.get(sessionId) ?? -Infinity) >= LINK_EVERY_MS);
    if (link) this.linked.set(sessionId, at);
    const { text } = this.router.stamp(sessionId, status, link ? `${body}\n${this.url(sessionId)}` : body, requestId);
    const r = await this.send(text, o.via);
    this.noteSent(r, sessionId, requestId);
    this.store.save();
    return { sent: r.sent };
  }

  async request(r: Request) {
    const look = this.ctx.session(r.sessionId);
    if (!look || !requestStillOpen(look, r.id)) return;
    const root = look.summary.parentSessionId;
    const { status, body } = requestText(r, agentOf(r.sessionId));
    await this.tell(r.sessionId, status, body, { also: root ? [root] : [], requestId: r.id, link: true });
  }

  async attention(sessionId: string) {
    await this.tell(sessionId, "needs you in the terminal", TEXTS.attention(agentOf(sessionId)));
  }

  /** The agent said something: kept until its turn ends (only the last message counts). */
  said(sessionId: string, msg: Msg) {
    if (msg.role !== "assistant") return;
    const text = msg.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n").trim();
    // A check-in's answer line is Tether's to read, not the person's (shared/checkIn.ts).
    if (text) this.lastSaid.set(sessionId, replyForPeople(text));
  }

  turnStarted(sessionId: string) {
    this.lastSaid.delete(sessionId);
    this.settled(sessionId);
  }

  /** The person answered the session (a request, a new turn): it's out of the picker until it texts again. */
  settled(sessionId: string) {
    this.router.settle(sessionId);
    this.store.save();
  }

  /**
   * A failed turn texts. A finished one texts the agent's last message when the person texted it
   * this turn (its answer) or when it ends by asking them something; otherwise nothing.
   */
  async turnEnded(sessionId: string, error?: string) {
    const last = this.lastSaid.get(sessionId);
    this.lastSaid.delete(sessionId);
    // The Home agent's Texts chat answers by its own texts (homeText).
    if (this.ctx.homeLine?.home?.isTextsChat(sessionId)) return void this.talking.delete(sessionId);
    if (!endWorthTelling(this.ctx.session(sessionId))) return;
    const talking = this.talking.delete(sessionId);
    // An answer to what the person wrote goes back the way it came.
    const via = talking ? this.backTo(sessionId) : undefined;
    if (error) await this.tell(sessionId, `failed: ${failureKind(error)}`, TEXTS.failed(agentOf(sessionId), failureKind(error)), { via });
    // An answer to something the person texted is the back-and-forth: no link.
    else if (last && (talking || asksQuestion(last))) await this.tell(sessionId, asksQuestion(last) ? "asked you something" : "answered", clip(last, SAID_MAX), { quick: talking, via });
  }

  // ── in: the person's replies, one at a time ──

  heard(m: Inbound): Promise<void> {
    // The same text heard twice (a reconnect's replay) is taken once.
    if (m.id) {
      const key = m.via ? `${m.via}:${m.id}` : m.id;
      if (this.heardIds.includes(key)) return this.inbox;
      this.heardIds = [...this.heardIds, key].slice(-HEARD_MAX);
    }
    // Tether's texts follow the person to the connector they wrote on.
    if (m.via && this.channel(m.via)) this.store.lastVia = m.via;
    // NUL marks a message with only files while it's routed: never theirs.
    m = { ...m, text: m.text.replaceAll("\u0000", "") };
    this.inbox = this.inbox.then(() => this.answer(m)).catch((e) => this.ctx.log(`texting: ${e?.message ?? e}`));
    return this.inbox;
  }

  /** Held files the person sent are going nowhere now (the hold moved on, or expired): they're told. */
  private async dropHeld() {
    const h = this.held;
    this.held = undefined;
    clearTimeout(this.heldTimer);
    if (h) await this.say(TEXTS.filesNotSent, h.back);
  }

  /** The picker's hold expired with files on it: the person hears they didn't go. */
  checkHeld(): Promise<void> {
    const h = this.held;
    if (!h || this.now() - h.hold.at < HELD_MS) return Promise.resolve();
    // The router forgets an expired hold on its next look; the files go now.
    this.inbox = this.inbox.then(() => (this.held === h ? this.dropHeld() : undefined));
    return this.inbox;
  }

  private async answer(m: Inbound) {
    const home = this.ctx.homeLine?.home;
    const via = m.via;
    const back: Back | undefined = via ? { via, ...(m.place ? { place: m.place } : {}) } : undefined;
    const mine = m.files ?? [];
    const before = this.router.state.held;
    const d = this.router.route(!m.text.trim() && mine.length ? NO_WORDS : m.text, m.replyTo, !!home, mine.length ? { filesOnly: NO_WORDS } : undefined);
    this.store.save();
    // Files wait with the text the picker holds, and go wherever it goes.
    let files = mine;
    const hold = this.router.state.held;
    const tookHeld = !!before && !hold && (d.kind === "deliver" || d.kind === "home") && d.text === before.text;
    if (tookHeld && this.held?.hold === before) {
      files = [...this.held.files, ...mine];
      this.held = undefined;
      clearTimeout(this.heldTimer);
    }
    // The hold moved on (a new one, picked another way, expired) with files on it: they didn't go.
    if (this.held && this.held.hold !== hold) await this.dropHeld();
    const heldThis = !!hold && hold !== before;
    if (heldThis && mine.length) {
      this.held = { files: mine, hold, ...(back ? { back } : {}) };
      clearTimeout(this.heldTimer);
      this.heldTimer = setTimeout(() => void this.checkHeld(), HELD_MS + 1_000);
      this.heldTimer.unref?.();
    }
    if (d.kind === "none") return;
    // Only files, no words: the agent reads that it was sent a file; it never answers a request.
    const onlyFiles = d.text === NO_WORDS;
    const words = onlyFiles ? FILES_ONLY : d.text;
    if (d.kind === "reply") {
      await this.say(d.text, back);
      if (mine.length && !heldThis) await this.say(TEXTS.filesNotSent, back);
      return;
    }
    if (back) {
      this.store.replyVia = Object.fromEntries([...Object.entries(this.store.replyVia).filter(([k]) => k !== (d.kind === "home" ? HOME : d.sessionId)), [d.kind === "home" ? HOME : d.sessionId, back]].slice(-REPLY_VIA_MAX));
      this.store.save();
    }
    if (d.kind === "home") {
      try {
        const mark = this.channel(via)?.connector.mark;
        await home!.take(words, { ...(mark ? { mark } : {}), ...(files.length ? { files: (chat) => this.stash(chat, files, back) } : {}) });
        await m.react?.(READ).catch((e) => this.ctx.log(`texting: couldn't react: ${e?.message ?? e}`));
      } catch (e: any) {
        await this.say(TEXTS.couldNotSend("the Home agent", String(e?.message ?? e)), back);
      }
      return;
    }
    const tag = `[${d.n}]`;
    try {
      const look = this.ctx.session(d.sessionId);
      const pending = look?.state?.requests?.filter((r) => look.requests.includes(r.id)) ?? [];
      // A reply to a request's text answers that request only. Once it's closed (answered in
      // Tether, by a rule, or by an earlier text) the reply goes nowhere: a "y" sent on to the
      // agent as words starts a turn with no context, and it mustn't answer a newer request the
      // person hasn't seen yet either.
      const open = d.requestId ? pending.find((r) => r.id === d.requestId) : pending[0];
      if (d.requestId && !open) {
        this.router.closedRequest(d.sessionId, d.requestId);
        this.store.save();
        await this.say(TEXTS.alreadyAnswered(d.n), back);
        if (files.length) await this.say(TEXTS.filesNotSent, back);
        return;
      }
      // Only files: they go to the agent, never as an answer to its request.
      if (open && !onlyFiles) {
        const r = readReply(open, d.text);
        if ("problem" in r) {
          await this.say(`${tag} ${r.problem}`, back);
          if (files.length) await this.say(TEXTS.filesNotSent, back);
          return;
        }
        // Talking: the agent reads it as the reason and carries on (a plan stays a plan).
        const answer: RequestAnswer = "answer" in r ? r.answer : { allow: false, reason: r.talk };
        await this.ctx.sessions.answer(d.sessionId, open.id, answer);
        this.talking.add(d.sessionId);
        if (files.length) await this.say(TEXTS.filesWithAnswer(d.n), back);
      } else {
        const stored = await this.stash(d.sessionId, files, back);
        if (stored.length) await this.ctx.sessions.tell(d.sessionId, words, stored);
        else await this.ctx.sessions.tell(d.sessionId, words);
        this.talking.add(d.sessionId);
      }
      // No "sent" or "allowed" back (texts.ts): the session answers for itself. A ✅ on the
      // person's text says Tether read it and passed it on.
      await m.react?.(READ).catch((e) => this.ctx.log(`texting: couldn't react: ${e?.message ?? e}`));
    } catch (e: any) {
      await this.say(TEXTS.couldNotSend(tag, String(e?.message ?? e)), back);
    }
  }
}

export const textingModule: Module = {
  name: "texting",
  start(ctx) {
    const store = new TextingStore(join(ctx.dataDir, "texting.json"));
    const t = new Texter(ctx, store);
    if (ctx.homeLine) ctx.homeLine.phone = { send: (text) => t.homeText(text, { reply: true }), text: (from, body) => t.personText(from, body) };
    const later = (ms: number, f: () => Promise<void>) => setTimeout(() => void f().catch((e) => ctx.log(`texting failed: ${e?.message ?? e}`)), ms);
    const offs = [
      ctx.bus.on("requestOpened", ({ request }) => void later(REQUEST_DELAY_MS, () => t.request(request))),
      ctx.bus.on("attention", ({ sessionId }) => void later(0, () => t.attention(sessionId))),
      ctx.bus.on("message", ({ sessionId, msg }) => t.said(sessionId, msg)),
      ctx.bus.on("turnStarted", ({ sessionId }) => t.turnStarted(sessionId)),
      ctx.bus.on("requestClosed", ({ sessionId }) => t.settled(sessionId)),
      ctx.bus.on("turnEnded", ({ sessionId, error, stopped, recovering }) => void (!stopped && !recovering && later(FINISH_DELAY_MS, () => t.turnEnded(sessionId, error)))),
    ];
    // iMessage's own ops, for a web from before connectors.
    const imessage = t.channel(IMESSAGE)!;
    const status = () => store.status(imessage);
    ctx.ops.register("textingStatus", () => status());
    ctx.ops.register("setTexting", async (a) => {
      store.update(a);
      await t.restart(IMESSAGE);
      return status();
    });
    ctx.ops.register("textingTest", async () => (await t.test(IMESSAGE), null));
    ctx.ops.register("messagingStatus", () => t.messaging());
    ctx.ops.register("setConnector", (a) => t.setConnector(a));
    ctx.ops.register("setMessagingPrefer", (a) => t.prefer(a.prefer));
    ctx.ops.register("testConnector", async (a) => (await t.test(String(a.id)), null));
    void t.start();
    return () => {
      offs.forEach((f) => f());
      if (ctx.homeLine) ctx.homeLine.phone = undefined;
      void t.stop();
    };
  },
};
