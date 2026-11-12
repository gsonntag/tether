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
// nothing else claims them go to its Texts chat, and its short replies come back as "[h] ..."
// texts (homeAgent/index.ts decides which replies).
//
// An agent can text the person itself with its text_person tool (personText): a short text stamped with its session's
// number like any other, whose reply comes back to that session (rate-capped: AgentTextCaps), and
// optionally an image after it, where the connector takes images (images.ts checks the file: a real
// image, not too big; the bytes checked are the bytes sent).
//
// The Home agent has several homes (homeLine.ts: h, h1, h2, …; router.ts parses "hn", "h1 …",
// "hd1"); a home's texts start "[h]" or "[h1]", and a reply goes back to the home that texted. A
// reply right after one of a home's texts about a session is about that session (router.ts
// REPLY_MS): it goes with a line saying which (homeLine.ts replyContext).
//
// Texts go over messaging connectors (connector.ts, connectors.ts): iMessage through Photon, a Discord
// bot, … Everything above is the same on each: one router, one set of session numbers. Tether's texts
// go to the connector the person picked in settings, else the one they last wrote on, else the first
// one connected. An answer goes back the way the person's message came: the reply to a picker, and a
// session's (or the Home agent's) answer to what they wrote it, by the connector they last wrote
// it on (replyVia), whatever "Send to" says. Files they send come along to the session or the Home
// agent (stash), held with their words while the picker asks which session (and with whatever text
// takes the held one over, or replaces it: a photo, then its caption); none is dropped without
// saying so. Images among them are checked by their bytes, HEIC is made JPEG and an image too big to
// see is scaled down (images.ts). Every call to a connector in the queue is bounded (PHOTON.ms): a
// stalled service is logged and passed by.
//
// Texts carry what the agent wants and says (the person asked for that over push's lock-screen
// wording), a request as one "Can I …? y/n" question with no raw command (describe.ts, summary.ts); known secrets
// are redacted. Tether's own words read like a human's: "[6] ok", one
// casual sentence at most, never that something works, and no acknowledgment after a reply is
// passed on (texts.ts has the whole rule).

import { join } from "node:path";
import type { Msg, Request, RequestAnswer, RunStatus } from "../../../../shared/transcript";
import { isImageType, safeName, splitAttachments, type Attachment } from "../../../../shared/attachments";
import { fromTexted } from "../../../../shared/fromTether";
import { ATTACH_FILE_MAX, ATTACH_IMAGE_MAX, ATTACH_MAX } from "../../../../shared/limits";
import type { MessagingStatus } from "../../../../shared/protocol";
import type { Module, ModuleContext } from "..";
import { storeFile } from "../../core/attachments";
import { agentOf, endWorthTelling, failureKind, FINISH_DELAY_MS, REQUEST_DELAY_MS, requestStillOpen } from "../push";
import { Channel, timedOut, withTimeout, type Connector, type Inbound, type InboundFile } from "./connector";
import { connectors, type ConnectorDeps } from "./connectors";
import { clip, readReply, requestText } from "./describe";
import { IMESSAGE } from "./imessage";
import { openSpectrum, PHOTON, type OpenLink } from "./link";
import { HELD_MS, HOME, Router, type About } from "./router";
import { heicNote, homeLabel, homeList, PERSON_TEXT_MAX, replyContext } from "../homeLine";
import { DOWNLOAD, IMAGE_REFUSED, ImageFailures, imagemagick, incomingImage, readOutgoingImage, sniffImage, sweepMagickTemp, type Convert, type OutImage } from "./images";
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

type Ctx = Pick<ModuleContext, "session" | "viewersOf" | "log" | "runnerId" | "appUrl" | "homeLine" | "links" | "attachmentsDir"> & {
  sessions: Pick<ModuleContext["sessions"], "tell" | "answer"> & Partial<Pick<ModuleContext["sessions"], "queue">>;
};

/** A user message's words as the transcript shows them, for telling the channel's own message apart: no defang mark, no texted marker, no attachments block. */
const shown = (text: string) => {
  const t = text.replaceAll("\u200b", "");
  return splitAttachments(fromTexted(t)?.text ?? t).text.trim();
};

/** What a turn's end texts (Texter.endOf), taken as it ends. */
export interface TurnEnd {
  /** the agent's last words in the turn */
  last?: string;
  /** the turn answers a message the person sent */
  talking: boolean;
  /** the channel message that started it, where its answer may go */
  claim?: Back;
  /** which of the session's turns it was (Texter counts them) */
  turn: number;
}

/** What the agent reads for a message with only files in it. */
export const FILES_ONLY = "(sent a file)";
/** What files the person sent with an answer to a request say, when they follow it (after its turn). */
export const TEXTED_WITH_ANSWER = "(files the person sent with their answer)";
/** A message with only files, while it's routed (no one can type it: NUL is taken out of what they send). */
const NO_WORDS = "\u0000";

/** Where an answer goes back: the connector, and the place on it (a Discord DM, or a channel others read: `shared`). */
export interface Back {
  via: string;
  place?: string;
  shared?: boolean;
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
  /**
   * Sessions the person texted, with how many of their messages still wait for an answer: each
   * turn's end answers one (two quick texts, the second queued: two turns, two answers).
   */
  private talking = new Map<string, number>();
  /** each session's turns so far (turnStarted counts them): a turn's end can tell whether another started since */
  private turns = new Map<string, number>();
  /** files that came with the text the router holds for the picker (by its id), since when, and where they came from */
  private held?: { files: InboundFile[]; id: number; at: number; back?: Back };
  private heldTimer?: ReturnType<typeof setTimeout>;
  /** where the text the picker holds came from (files or not): picked from elsewhere, it's no channel's answer */
  private heldFrom?: { id?: number; place?: string };
  /** the last send / image send timed out (it may still have gone): the agent isn't told to resend */
  private unsure = false;
  private imageFails = new ImageFailures(() => this.now());
  private imageUnsure = false;
  /** turns HEIC into JPEG and scales big images down (tests replace it) */
  convert: Convert = imagemagick;
  /**
   * A message from a shared place (a server channel) that started a turn, by session (or HOME). The
   * one rule: only that turn's answer may go back there. It's set only when the session was idle
   * with nothing queued as the message came ("armed"), becomes "active" when the turn it starts
   * starts and its message has been seen ("starting" in between), and goes on any other input (a DM, Tether's web, a report, another turn) and once used.
   * Kept in memory only: after a restart everything goes to the DM.
   */
  private channelTurns = new Map<string, { via: string; place: string; expect: string; msgId?: string; phase: "armed" | "starting" | "active" }>();

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
    // A hold with files from before a restart keeps its words (its files are gone with that process:
    // the person is told when it's picked, answer()).
    this.router = new Router(store.router, now);
    this.caps = new AgentTextCaps(now);
    const list = deps.list ?? connectors(store, { ...deps.connectors, [IMESSAGE]: open });
    this.channels = list.map((c) => new Channel(c, (m) => void this.heard(m), ctx.log));
  }

  // ── the links ──

  /** Connects every connector that's on and set; each reconnects after a drop, backing off. */
  async start() {
    this.rearmHeld();
    await Promise.all(this.channels.map((c) => c.start()));
  }

  /** The held files' timer again, for what's left of HELD_MS (after a restart, or a stop that cleared it). */
  private rearmHeld() {
    if (this.held) this.holdFiles(this.held.files, this.held.id, this.held.at, this.held.back);
  }

  async stop() {
    clearTimeout(this.heldTimer);
    this.heldTimer = undefined;
    await Promise.all(this.channels.map((c) => c.stop()));
  }

  /** Settings changed: new links with them (or none); `id`: just that connector's. */
  async restart(id?: string) {
    this.rearmHeld();
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

  /**
   * Where a text about session `id` (or the Home agent, HOME) goes: the connector the person last
   * wrote it on. The place they wrote it (a server channel others read) only for `answer`, the
   * direct answer to what they wrote there, and only once: anything later goes to their own DM.
   */
  backTo(id: string, answer = false, claim = id): Back | undefined {
    const ct = this.channelTurns.get(claim);
    if (answer && ct?.phase === "active") {
      this.channelTurns.delete(claim);
      return { via: ct.via, place: ct.place, shared: true };
    }
    const b = this.store.replyVia[id];
    // A private place (the DM it came from) only: a shared one is never kept here.
    return b ? { via: b.via, ...(b.place ? { place: b.place } : {}) } : undefined;
  }

  /** Session `id` (or a home's claim key, homeKey) is idle with nothing queued, so a message now starts its next turn. */
  private idle(id: string): boolean {
    if (id === HOME || id.startsWith(`${HOME}:`)) {
      const home = this.ctx.homeLine?.home;
      if (!home?.textsBusy) return false;
      const chat = id.slice(HOME.length + 1);
      return !home.textsBusy(chat || undefined);
    }
    const look = this.ctx.session(id);
    // Not driven from its terminal, its queue not held, not waiting out a restart: a message now runs as the next turn.
    const st = look?.state;
    return !!look && look.status === "idle" && !look.busy && !(st?.queue?.length ?? 0) && st?.mode !== "terminal" && !st?.queueHeld && !st?.restartWait;
  }

  /** Which channelTurns key a session's events are for: each home's own (homeKey), so one home's turn never takes another's claim. */
  private turnKey(sessionId: string): string {
    return this.ctx.homeLine?.home?.isTextsChat(sessionId) ? this.homeKey(sessionId) : sessionId;
  }

  /**
   * A home's channel-claim key: "home:<its chat>" (`chat` none: the primary home's). A channel message
   * to one home may answer in that channel only from that home's turn. (Where its private answers go,
   * replyVia, is the Home agent's as a whole: HOME.)
   */
  private homeKey(chat?: string): string {
    const c = chat ?? this.ctx.homeLine?.home?.homes().find((h) => h.n === 0)?.chat;
    return c ? `${HOME}:${c}` : HOME;
  }

  private async say(text: string, back?: Back): Promise<string | undefined> {
    return (await this.send(text, back)).id;
  }

  /** The channel a text goes on: back the way it came (`back`, when that's connected), else Tether's target. */
  private channelFor(back?: Back): { ch?: Channel; there?: Channel } {
    const there = back && this.channel(back.via);
    return { ch: (there?.connected ? there : undefined) ?? this.target(), ...(there ? { there } : {}) };
  }

  /**
   * Texts the person (an answer: back the way it came, `back`, when that's connected); `sent`: it went
   * (Photon may give no id). `image`: one image, its own message after the words (where the connector
   * takes images). At most PHOTON.ms each: a send that times out may still have gone (`unsure`).
   */
  private async send(text: string, back?: Back, image?: OutImage): Promise<{ sent: boolean; id?: string; ids?: string[] }> {
    this.unsure = false;
    const { ch, there } = this.channelFor(back);
    if (!ch) return { sent: false };
    const place = back?.place && ch === there ? { place: back.place, ...(back.shared ? { shared: true } : {}) } : {};
    try {
      const ids = await withTimeout(ch.send({ text, ...place }), "a send", PHOTON.ms, ch.connector.service ?? ch.connector.label);
      this.failed = undefined;
      this.router.noteOut();
      return { sent: true, ...(ids[0] ? { id: ids[0], ids } : {}) };
    } catch (e: any) {
      // Only the send itself timing out leaves it unknown whether it went (not opening the chat).
      this.unsure = timedOut(e, "a send");
      this.failed = ch.lastError ?? `Couldn't send a text: ${e?.message ?? e}`;
      if (timedOut(e, "a send")) this.ctx.log(`texting: ${this.failed}`);
      return { sent: false };
    }
  }

  /** An image after a text, on the same channel, threaded like it (a reply to the image goes where a reply to the text would). Whether it went. */
  private async sendImage(image: OutImage, back: Back | undefined, note: (ids: string[]) => void): Promise<boolean> {
    this.imageUnsure = false;
    const { ch, there } = this.channelFor(back);
    if (!ch?.connector.images) {
      this.failed = "This messaging app can't take images.";
      return false;
    }
    const place = back?.place && ch === there ? { place: back.place, ...(back.shared ? { shared: true } : {}) } : {};
    try {
      const ids = await withTimeout(ch.send({ text: "", files: [{ name: image.name, mimeType: image.mimeType, data: image.data }], ...place }), "an image", PHOTON.ms, ch.connector.service ?? ch.connector.label);
      note(ids);
      return true;
    } catch (e: any) {
      this.imageUnsure = timedOut(e, "an image");
      this.failed = `Couldn't send an image: ${e?.message ?? e}`;
      this.ctx.log(`texting: ${this.failed}`);
      return false;
    }
  }

  /** Notes each part of a text that went (a split one has several): a threaded reply to any of them names it. */
  private noteSent(r: { ids?: string[] }, sessionId: string, requestId?: string, about?: string, home?: string) {
    for (const id of r.ids ?? []) this.router.noteSent(id, sessionId, requestId, about, home);
  }

  /** A Home chat went on in another (a move): replies to its texts follow it. */
  homeMoved(from: string, to: string) {
    this.router.movedHome(from, to);
    this.store.save();
  }

  /** The home a chat is (none, or the primary one's: undefined), for stamping its texts "[h1] …". */
  private homeOf(chat?: string): { n: number; chat: string } | undefined {
    if (!chat) return undefined;
    const h = this.ctx.homeLine?.home?.homes().find((x) => x.chat === chat);
    return h && h.n !== 0 ? { n: h.n, chat } : undefined;
  }

  /**
   * One of the Home agent's homes texts the person ("[h] ok, on it", "[h1] …"): whether it went. A
   * threaded reply to it goes back to that home. `reply`: it answers what the person wrote it, so it
   * goes back the way that came; its own text (text_person) goes where Tether's texts go. `about`:
   * the session it's about, which a reply goes with. `chat`: the home's chat (none: the primary one).
   */
  async homeText(body: string, o: { reply?: boolean; answer?: boolean; about?: string; chat?: string } = {}): Promise<boolean> {
    return (await this.homeSend(body, o)).sent;
  }

  private async homeSend(body: string, o: { reply?: boolean; answer?: boolean; about?: string; chat?: string }, image?: OutImage): Promise<{ sent: boolean; imageSent?: boolean }> {
    const words = clip(body, HOME_MAX);
    if (!this.target() || !words) return { sent: false };
    const home = this.homeOf(o.chat);
    const back = o.reply === false ? undefined : this.backTo(HOME, !!o.answer, this.homeKey(o.chat));
    const r = await this.send(this.router.stampHome(words, o.about, home), back);
    this.noteSent(r, HOME, undefined, o.about, home?.chat);
    const imageSent = r.sent && image ? await this.sendImage(image, back, (ids) => this.noteSent({ ids }, HOME, undefined, o.about, home?.chat)) : undefined;
    this.store.save();
    return { sent: r.sent, ...(imageSent !== undefined ? { imageSent } : {}) };
  }

  /** A test text on one connector (iMessage when unnamed). */
  async test(id: string = IMESSAGE) {
    const ch = this.channel(id);
    if (!ch) throw new Error("There's no such connector.");
    const c = ch.connector;
    if (!c.enabled() || !c.configured()) throw new Error(c.notReady);
    await ch.start();
    if (!ch.connected) throw new Error(ch.lastError ?? `Not connected to ${c.service ?? c.label} yet.`);
    // A test that didn't go says so to whoever pressed it; it leaves no error on the connector's status.
    const was = ch.lastError;
    try {
      await ch.send({ text: TEXTS.test });
    } catch (e) {
      ch.lastError = was;
      throw e;
    }
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
    const out: Attachment[] = [];
    for (const f of files.slice(0, ATTACH_MAX)) {
      const max = isImageType(f.mimeType) ? ATTACH_IMAGE_MAX : ATTACH_FILE_MAX;
      try {
        if (f.size !== undefined && f.size > max) throw new Error("it's too big");
        // Bounded, whatever the connector does: a stuck download mustn't hold up the texts queue.
        let data: Uint8Array = await withTimeout(f.read(max), "a download", DOWNLOAD.ms, "The download");
        if (data.byteLength > max) throw new Error("it's too big");
        let name = f.name;
        let mimeType = f.mimeType;
        // An image is what its bytes say: HEIC made JPEG, one too big to see scaled down; one that
        // isn't an image after all is kept as a plain file.
        if (isImageType(mimeType) || sniffImage(data)) {
          const img = await incomingImage({ name }, Buffer.from(data), this.convert);
          if (img) ({ name, mimeType, data } = img);
          else if (isImageType(mimeType)) mimeType = "application/octet-stream";
        }
        // As an upload is stored: a safe name, the session's 2 GB, read-only, never over another file.
        out.push(storeFile(dir, sessionId, { name, mimeType, data }));
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
   * session's number (or [h]) so a reply goes back to it. Sent even while the session is open in
   * Tether: the agent was asked to text. What the tool answers the agent.
   */
  async personText(from: string, body: string, o: { image?: string; about?: string; chat?: string } = {}): Promise<{ text: string; isError?: boolean }> {
    const words = clip(body, PERSON_TEXT_MAX);
    if (!words) return { text: "The message is empty.", isError: true };
    const target = this.target();
    if (!target) return { text: "Texting isn't set up or connected in Tether, so nothing was sent. Say it in your reply instead.", isError: true };
    if (o.image && !target.connector.images) return { text: `${target.connector.label} can't take images from Tether. Nothing was sent.`, isError: true };
    // Taken before an image is checked, and given back if it's refused (below).
    const why = this.caps.take(from);
    if (why) return { text: why, isError: true };
    let image: OutImage | undefined;
    if (o.image) {
      // A refused image isn't a text: it gives the cap back, and refusals are limited on their own
      // (past ImageFailures.MAX in its window every image is refused unread: no probing paths).
      const r = this.imageFails.allowed(from) ? readOutgoingImage(o.image) : { problem: IMAGE_REFUSED };
      if ("problem" in r) {
        this.imageFails.failed(from);
        this.caps.undo(from);
        return { text: `${r.problem} Nothing was sent.`, isError: true };
      }
      image = r;
    }
    this.unsure = this.imageUnsure = false;
    const { sent, imageSent } = from === HOME ? await this.homeSend(words, { reply: false, ...(o.about ? { about: o.about } : {}), ...(o.chat ? { chat: o.chat } : {}) }, image) : await this.tell(from, TEXTED_YOU, words, { always: true, image });
    if (!sent) {
      this.caps.undo(from);
      return {
        text: this.unsure
          ? `The text may or may not have gone (${this.lastError}). Don't send it again; mention it in your reply if it matters.`
          : `The text didn't go (${this.lastError ?? "not connected"}). Say it in your reply instead.`,
        isError: true,
      };
    }
    const cut = words.length < body.trim().length ? ` It was cut to ${PERSON_TEXT_MAX} characters.` : "";
    const pic = image ? (imageSent ? " The image went with it." : this.imageUnsure ? " The image may or may not have gone; don't send it again." : ` The image didn't go (${this.lastError ?? "not connected"}).`) : "";
    return { text: `Texted the person.${cut}${pic} If they reply, their reply comes to you as a message.` };
  }

  /** Texts about a session, unless someone is looking at it (or at `also`) in Tether right now (`always`: even then). Whether it went. */
  async tell(sessionId: string, status: string, body: string, o: { also?: string[]; quick?: boolean; requestId?: string; always?: boolean; link?: boolean; via?: Back; image?: OutImage } = {}): Promise<{ sent: boolean; imageSent?: boolean }> {
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
    const imageSent = r.sent && o.image ? await this.sendImage(o.image, o.via, (ids) => this.noteSent({ ids }, sessionId, requestId)) : undefined;
    this.store.save();
    return { sent: r.sent, ...(imageSent !== undefined ? { imageSent } : {}) };
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
    if (msg.role === "user") {
      // The channel message itself, seen once: its id is the claim's. Any other user message (typed in
      // Tether, another session's, a report, send_to_session) ends the claim, whatever it says.
      const key = this.turnKey(sessionId);
      const ct = this.channelTurns.get(key);
      if (!ct) return;
      if (ct.msgId !== undefined) {
        if (msg.id !== ct.msgId) this.channelTurns.delete(key);
        return;
      }
      if (shown(msg.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n")) !== ct.expect) return void this.channelTurns.delete(key);
      ct.msgId = msg.id;
      // Its turn started before the message showed: now it's that turn's.
      if (ct.phase === "starting") ct.phase = "active";
      return;
    }
    if (msg.role !== "assistant") return;
    const text = msg.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n").trim();
    // A check-in's answer line is Tether's to read, not the person's (shared/checkIn.ts).
    if (text) this.lastSaid.set(sessionId, replyForPeople(text));
  }

  /**
   * A turn started (running after idle), or a turn went on after waiting on the person (`from`
   * "waiting": a permission answered; the same turn, which keeps its claim and its count).
   */
  turnStarted(sessionId: string, from?: RunStatus) {
    if (from !== "waiting") {
      // Subagents' turns are never told: not counted.
      if (!this.ctx.session(sessionId)?.summary.parentSessionId) this.turns.set(sessionId, (this.turns.get(sessionId) ?? 0) + 1);
      // The turn a channel message started (active once its message has been seen), or any other one
      // (which ends the channel's claim).
      const key = this.turnKey(sessionId);
      const ct = this.channelTurns.get(key);
      if (ct?.phase === "armed") ct.phase = ct.msgId !== undefined ? "active" : "starting";
      else this.channelTurns.delete(key);
    }
    this.lastSaid.delete(sessionId);
    this.settled(sessionId);
  }

  /** The person answered the session (a request, a new turn): it's out of the picker until it texts again. */
  settled(sessionId: string) {
    this.router.settle(sessionId);
    this.store.save();
  }

  /**
   * What a turn's end texts, taken the moment it ends: its last words, whether it answers the
   * person's message, and its channel claim. The text goes out FINISH_DELAY_MS later, maybe after the
   * next turn started; it reads none of that turn's state and leaves its claim and talking alone.
   */
  endOf(sessionId: string): TurnEnd {
    const last = this.lastSaid.get(sessionId);
    this.lastSaid.delete(sessionId);
    const ct = this.channelTurns.get(sessionId);
    let claim: Back | undefined;
    if (ct?.phase === "active") {
      this.channelTurns.delete(sessionId);
      claim = { via: ct.via, place: ct.place, shared: true };
    }
    const waiting = this.talking.get(sessionId) ?? 0;
    // One message answered; the rest wait for the turns still to come (queued ones). Nothing queued
    // or running: none (several sent into one turn got one answer).
    const look = this.ctx.session(sessionId);
    const more = !!look && (look.status !== "idle" || ((look.state?.queue?.length ?? 0) > 0 && !look.state?.queueHeld));
    const left = more ? waiting - 1 : 0;
    if (left > 0) this.talking.set(sessionId, left);
    else this.talking.delete(sessionId);
    return { ...(last !== undefined ? { last } : {}), talking: waiting > 0, ...(claim ? { claim } : {}), turn: this.turns.get(sessionId) ?? 0 };
  }

  /**
   * A failed turn texts. A finished one texts the agent's last message when the person texted it
   * this turn (its answer) or when it ends by asking them something; otherwise nothing. `end`: the
   * turn's snapshot, taken when it ended (endOf; now, when not given).
   */
  async turnEnded(sessionId: string, error?: string, end: TurnEnd = this.endOf(sessionId)) {
    const movedOn = (this.turns.get(sessionId) ?? 0) !== end.turn;
    try {
      await this.tellEnd(sessionId, error, end, movedOn);
    } finally {
      // Told or not, a turn with nothing newer leaves no count behind.
      if (!movedOn) this.turns.delete(sessionId);
    }
  }

  /**
   * A turn stopped by the person (or failing on the way to a retry, `recovering`): nothing is told.
   * Stopped, its claim and the messages it owed answers to go; recovering, only its claim (the retry
   * still owes the answer).
   */
  turnStopped(sessionId: string, recovering = false) {
    this.channelTurns.delete(this.turnKey(sessionId));
    if (recovering) return;
    void this.endOf(sessionId);
    this.turns.delete(sessionId);
  }

  private async tellEnd(sessionId: string, error: string | undefined, end: TurnEnd, movedOn: boolean) {
    const { talking, claim } = end;
    // The Home agent's Texts chat answers by its own texts (homeText).
    if (this.ctx.homeLine?.home?.isTextsChat(sessionId)) return;
    const look = this.ctx.session(sessionId);
    let last = end.last;
    if (movedOn) {
      // A next turn started (a queued message): this one is over all the same. Only what's owed goes:
      // the answer to the person's message, or a failure; never a question alone.
      if (!look || look.summary.parentSessionId || (!talking && !error)) return;
    } else {
      // Still this turn's: still idle and not waiting on a request (else it tells itself). Its words
      // as they are now: a terminal session's file watcher can lag behind the turn's end.
      if (!endWorthTelling(look)) return;
      last = this.lastSaid.get(sessionId) ?? last;
      this.lastSaid.delete(sessionId);
    }
    // What follows the person's message goes back the way it came; only the answer of the turn a
    // channel message started may go to that channel (its claim), a failure goes to their DM.
    if (error) await this.tell(sessionId, `failed: ${failureKind(error)}`, TEXTS.failed(agentOf(sessionId), failureKind(error)), { via: talking ? this.backTo(sessionId) : undefined });
    // An answer to something the person texted is the back-and-forth: no link.
    else if (last && (talking || asksQuestion(last))) await this.tell(sessionId, asksQuestion(last) ? "asked you something" : "answered", clip(last, SAID_MAX), { quick: talking, via: talking ? (claim ?? this.backTo(sessionId)) : undefined });
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
    this.heldTimer = undefined;
    // Not an answer to anything just written: privately.
    if (h) await this.say(TEXTS.filesNotSent, h.back ? { via: h.back.via } : undefined);
  }

  /** The picker's hold expired with files on it: the person hears they didn't go. */
  checkHeld(): Promise<void> {
    const h = this.held;
    if (!h || this.now() - h.at < HELD_MS) return Promise.resolve();
    // The router forgets an expired hold on its next look; the files go now.
    this.inbox = this.inbox.then(() => (this.held === h ? this.dropHeld() : undefined)).catch((e) => this.ctx.log(`texting: ${e?.message ?? e}`));
    return this.inbox;
  }

  /** Keeps files with the held text `id`: until it goes, or HELD_MS after `at` (then they're dropped and the person is told, checkHeld). */
  private holdFiles(files: InboundFile[], id: number, at: number, back?: Back) {
    clearTimeout(this.heldTimer);
    this.held = { files, id, at, ...(back ? { back } : {}) };
    this.heldTimer = setTimeout(() => void this.checkHeld(), Math.max(0, at + HELD_MS - this.now()) + 1_000);
    this.heldTimer.unref?.();
  }

  /** The ✅ on the person's text (at most PHOTON.ms: a stalled service is logged and passed by). */
  private async read(m: Inbound) {
    if (!m.react) return;
    const svc = this.channel(m.via)?.connector;
    await withTimeout(m.react(READ), "a reaction", PHOTON.ms, svc?.service ?? svc?.label ?? "The messaging app").catch((e) => this.ctx.log(`texting: couldn't react: ${e?.message ?? e}`));
  }

  /** What a reply to the Home agent is about, with the session's title and folder. */
  private aboutText(a: About): string {
    const look = this.ctx.session(a.sessionId);
    return replyContext({ sessionId: a.sessionId, ...(look?.summary.title ? { title: look.summary.title } : {}), ...(look ? { project: look.summary.projectPath } : {}) });
  }

  private async answer(m: Inbound) {
    const home = this.ctx.homeLine?.home;
    const via = m.via;
    // Tether's own replies (the picker, a problem, a file notice) go privately: a shared place (a
    // channel) only ever gets the answer of the turn its message claimed (arm, below).
    let back: Back | undefined = via ? { via, ...(m.place && !m.shared ? { place: m.place } : {}) } : undefined;
    // What can't come through (a voice note, a contact card, a poll): said once, for this message.
    if (m.unsupported) await this.say(TEXTS.onlyTextAndFiles, back);
    const mine = m.files ?? [];
    const was = this.router.heldNow();
    const before = was ? { ...was } : undefined;
    const d = this.router.route(!m.text.trim() && mine.length ? NO_WORDS : m.text, m.replyTo, home ? home.homes() : false, mine.length ? { filesOnly: NO_WORDS } : undefined);
    this.store.save();
    // Files wait with the text the picker holds, and go wherever its turn goes: its own words, or
    // the words that take it over ("2 what's wrong here", "h1 …", "hn …").
    let files = mine;
    const hold = this.router.state.held;
    const targeted = d.kind === "deliver" || d.kind === "home" || d.kind === "newHome";
    const tookHeld = targeted && !!before && d.held !== undefined && d.held === before.id;
    const h0 = this.held;
    if (tookHeld && h0 && h0.id === before!.id) {
      files = [...h0.files, ...mine];
      this.held = undefined;
      clearTimeout(this.heldTimer);
    } else if (tookHeld && (before!.images || before!.text === NO_WORDS)) {
      // Its files are gone (kept in memory only: a restart): the person hears so, and a hold of
      // only files has nothing left to pass on.
      await this.say(TEXTS.filesNotSent, back);
      if (d.text === NO_WORDS && !mine.length) {
        if (d.kind === "deliver") this.router.unsettle(d.sessionId);
        this.store.save();
        return;
      }
    }
    const heldThis = !!hold && hold.id !== before?.id;
    // A new hold replacing one with files (a photo, then its caption): they move to it.
    const carried = heldThis && this.held && this.now() - this.held.at < HELD_MS ? this.held.files : [];
    if (carried.length) this.held = undefined;
    // The hold moved on any other way (expired, dropped) with files on it: they didn't go.
    if (this.held && this.held.id !== hold?.id) await this.dropHeld();
    // A held text picked from another place than it was written: no channel's answer.
    const elsewhere = tookHeld && d.text === before!.text && (this.heldFrom?.id !== before!.id || this.heldFrom?.place !== m.place);
    if (heldThis) this.heldFrom = { id: hold.id, ...(m.place ? { place: m.place } : {}) };
    else if (!hold) this.heldFrom = undefined;
    if (heldThis && (mine.length || carried.length)) {
      this.holdFiles([...carried, ...mine], hold.id!, this.now(), back);
      hold.images = carried.length + mine.length;
      this.store.save();
    }
    if (d.kind === "none") return;
    // Only files, no words: the agent reads that it was sent a file; it never answers a request.
    const onlyFiles = "text" in d && d.text === NO_WORDS;
    const words = onlyFiles ? FILES_ONLY : "text" in d ? d.text : "";
    if (d.kind === "reply") {
      await this.say(d.text, back);
      if (mine.length && !heldThis) await this.say(TEXTS.filesNotSent, back);
      return;
    }
    if (d.kind === "deleteHome") {
      try {
        const left = await home!.deleteHome(d.n);
        await this.say(TEXTS.homeDeleted(homeLabel(d.n), homeList(left)), back);
      } catch (e: any) {
        await this.say(TEXTS.couldNotSend(homeLabel(d.n), String(e?.message ?? e)), back);
      }
      if (files.length) await this.say(TEXTS.filesNotSent, back);
      return;
    }
    // Every home answers back the way the person wrote (one replyVia for all of them, HOME); each home
    // has its own channel claim (homeKey: its chat, resolved, and made for h if it's gone).
    const key = d.kind === "deliver" ? d.sessionId : HOME;
    let claim = key;
    if (d.kind === "home") {
      const to = d.chat ? { chat: d.chat } : { n: 0 };
      const chat = home!.chatOf ? await home!.chatOf(to).catch(() => undefined) : home!.homes().find((h) => (d.chat ? h.chat === d.chat : h.n === 0))?.chat;
      // A home that's gone (chat unknown) gets a key no turn has: never h's live claim.
      claim = chat || !d.chat ? this.homeKey(chat) : `${HOME}:gone`;
    }
    // Any input ends a channel turn's claim; this one may start a new one (below).
    this.channelTurns.delete(claim);
    if (back) {
      // The way back: the connector, and the place only when it's private (a DM).
      // A channel message keeps the DM this session was last written from (the place private answers go).
      const was = this.store.replyVia[key];
      const dm = m.shared ? (was?.via === back.via ? was.place : undefined) : back.place;
      const keep = { via: back.via, ...(dm ? { place: dm } : {}) };
      this.store.replyVia = Object.fromEntries([...Object.entries(this.store.replyVia).filter(([k]) => k !== key), [key, keep]].slice(-REPLY_VIA_MAX));
      this.store.save();
      // From here on, Tether's own replies go to the DM this session is answered in.
      back = keep;
    }
    /** A channel message to an idle session (or Home): the turn it starts may answer in the channel. */
    const arm = () => {
      if (via && m.shared && m.place && !elsewhere && this.idle(claim)) this.channelTurns.set(claim, { via, place: m.place, expect: shown(words), phase: "armed" });
    };
    /** One more message the session owes an answer to: queued, it's its own turn's; else (a steer, a request answer) the current turn answers it. */
    const owe = (queued: boolean) => this.talking.set(key, queued ? (this.talking.get(key) ?? 0) + 1 : Math.max(1, this.talking.get(key) ?? 0));
    const mark = this.channel(via)?.connector.mark;
    // What failed says so once, with the files if they didn't go either.
    const failed = async (tag: string, e: any) => this.say(files.length ? TEXTS.couldNotSendWithFile(tag, String(e?.message ?? e)) : TEXTS.couldNotSend(tag, String(e?.message ?? e)), back);
    const take = { ...(mark ? { mark } : {}), ...(files.length ? { files: (chat: string) => this.stash(chat, files, back) } : {}) };
    if (d.kind === "newHome") {
      try {
        const n = await home!.newHome(d.text ? words : "", take);
        if (d.text) await this.read(m);
        else await this.say(TEXTS.homeStarted(homeLabel(n)), back);
      } catch (e: any) {
        await failed("a new home", e);
      }
      return;
    }
    if (d.kind === "home") {
      try {
        arm();
        // By its chat: the number may belong to another tab by now.
        await home!.take((d.about ? this.aboutText(d.about) : "") + words, take, d.chat ? { chat: d.chat } : { n: 0 });
        await this.read(m);
        if (d.gone) await this.say(TEXTS.homeGoneSentToH, back);
      } catch (e: any) {
        this.channelTurns.delete(claim);
        await failed(d.home ? homeLabel(d.home) : "the Home agent", e);
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
        owe(false);
        if (files.length) {
          // The files follow the answer, after the turn (where the session can queue them).
          const stored = this.ctx.sessions.queue ? await this.stash(d.sessionId, files, back) : [];
          if (stored.length) await this.ctx.sessions.queue!(d.sessionId, TEXTED_WITH_ANSWER + heicNote(stored), stored);
          else await this.say(TEXTS.filesWithAnswer(d.n), back);
        }
      } else {
        const stored = await this.stash(d.sessionId, files, back);
        arm();
        const queued = () => this.ctx.session(d.sessionId)?.state?.queue?.length ?? 0;
        const before = queued();
        if (stored.length) await this.ctx.sessions.tell(d.sessionId, words + heicNote(stored), stored);
        else await this.ctx.sessions.tell(d.sessionId, words);
        // Into the queue: a turn of its own to come. Else it started a turn or went into the running one.
        owe(queued() > before);
        // Only files while a request waits: it's still waiting on the person.
        if (open && onlyFiles) {
          this.router.unsettle(d.sessionId);
          this.store.save();
        }
      }
      // No "sent" or "allowed" back (texts.ts): the session answers for itself. A ✅ on the
      // person's text says Tether read it and passed it on.
      await this.read(m);
    } catch (e: any) {
      this.channelTurns.delete(key);
      await failed(tag, e);
    }
  }
}

export const textingModule: Module = {
  name: "texting",
  start(ctx) {
    // ImageMagick's folders an earlier runner left behind (a crash mid-conversion).
    sweepMagickTemp();
    const store = new TextingStore(join(ctx.dataDir, "texting.json"));
    const t = new Texter(ctx, store);
    if (ctx.homeLine)
      ctx.homeLine.phone = {
        send: (text, o) => t.homeText(text, { reply: true, answer: !!o?.answer, ...(o?.about ? { about: o.about } : {}), ...(o?.chat ? { chat: o.chat } : {}) }),
        text: (from, body, o) => t.personText(from, body, o),
        moved: (from, to) => t.homeMoved(from, to),
      };
    const later = (ms: number, f: () => Promise<void>) => setTimeout(() => void f().catch((e) => ctx.log(`texting failed: ${e?.message ?? e}`)), ms);
    const offs = [
      ctx.bus.on("requestOpened", ({ request }) => void later(REQUEST_DELAY_MS, () => t.request(request))),
      ctx.bus.on("attention", ({ sessionId }) => void later(0, () => t.attention(sessionId))),
      ctx.bus.on("message", ({ sessionId, msg }) => t.said(sessionId, msg)),
      ctx.bus.on("turnStarted", ({ sessionId, from }) => t.turnStarted(sessionId, from)),
      ctx.bus.on("requestClosed", ({ sessionId }) => t.settled(sessionId)),
      ctx.bus.on("turnEnded", ({ sessionId, error, stopped, recovering }) =>
        stopped || recovering ? t.turnStopped(sessionId, !stopped) : void later(FINISH_DELAY_MS, ((end) => () => t.turnEnded(sessionId, error, end))(t.endOf(sessionId))),
      ),
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
