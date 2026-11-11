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
// number like any other, whose reply comes back to that session (rate-capped: AgentTextCaps), and
// optionally an image after it (images.ts checks the file: a real image, not too big).
//
// Images the person texts go along with their words to whoever the text goes to, stored as that
// session's attachments (the agent sees them as images, and their paths); other files are left out.
//
// A reply right after one of Tether's texts about a session is about that session (router.ts
// REPLY_MS): to the Home agent it goes with a line saying which (homeLine.ts replyContext).
//
// Texts carry what the agent wants and says (the person asked for that over push's lock-screen
// wording), a request as one "Can I …? y/n" question with no raw command (describe.ts, summary.ts); known secrets
// are redacted. Tether's own words read like a human's: "[6] ok", one
// casual sentence at most, never that something works, and no acknowledgment after a reply is
// passed on (texts.ts has the whole rule).

import { join } from "node:path";
import type { Msg, Request, RequestAnswer } from "../../../../shared/transcript";
import type { Module, ModuleContext } from "..";
import { agentOf, endWorthTelling, failureKind, FINISH_DELAY_MS, REQUEST_DELAY_MS, requestStillOpen } from "../push";
import { clip, readReply, requestText } from "./describe";
import { openSpectrum, type Inbound, type OpenLink, type TextLink } from "./link";
import { HELD_MS, HOME, Router, type About } from "./router";
import { homeLabel, homeList, PERSON_TEXT_MAX, replyContext, type TextedFile } from "../homeLine";
import { download, imagemagick, incomingImage, pickIncoming, readOutgoingImage, type Convert, type InboundFile, type OutImage } from "./images";
import { TextingStore } from "./store";
import { TEXTS } from "./texts";
import { replyForPeople } from "../../../../shared/checkIn";

/** The reaction on a text Tether read and passed on to its session. */
export const READ = "✅";

const RETRY_MIN_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;

/** Whether an agent's message ends by asking the person something: its last paragraph (code left out) has a question. */
export function asksQuestion(text: string): boolean {
  const prose = text.replace(/```[\s\S]*?(```|$)/g, "").replace(/`[^`\n]*`/g, "").trim();
  const last = prose.split(/\n\s*\n/).pop() ?? "";
  return /\?(?=["')\]*_]*(\s|$))/.test(last);
}

type Ctx = Pick<ModuleContext, "session" | "viewersOf" | "log" | "runnerId" | "appUrl" | "homeLine" | "links"> & {
  sessions: Pick<ModuleContext["sessions"], "tell" | "answer"> & Partial<Pick<ModuleContext["sessions"], "queue">>;
};

/** How long an agent's answer may be in a text. */
const SAID_MAX = 1500;
/** How long a Home agent text may be: it's meant to be a few words. */
export const HOME_MAX = 600;
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

/** What the person's images came to: the ones that go (`heic`: kept as HEIC, by path only), and how many didn't. */
interface Got {
  files: (TextedFile & { heic?: boolean })[];
  notImages: number;
  failed: number;
}
const NO_FILES: Got = { files: [], notImages: 0, failed: 0 };

/** Said to the agent with a HEIC photo that couldn't be made a JPEG. */
export const HEIC_NOTE = "(The photo is HEIC and couldn't be converted, so it's attached by its path only.)";

/** What an image the person texted with no words says to the agent. */
export const IMAGE_ONLY = "(image)";
/** What the images the person texted with an answer to a request say, when they follow it. */
export const TEXTED_WITH_ANSWER = "(images the person texted with their answer)";

/** A session's link goes in a text at most this often. */
export const LINK_EVERY_MS = 5 * 60_000;

export class Texter {
  readonly router: Router;
  private link?: TextLink;
  private connecting?: Promise<void>;
  private retry?: ReturnType<typeof setTimeout>;
  private delay = RETRY_MIN_MS;
  private stopped = false;
  private inbox = Promise.resolve();
  connected = false;
  lastError?: string;
  /** each session's last words from the agent this turn (to tell whether it ended asking something) */
  private lastSaid = new Map<string, string>();
  /** sessions the person texted: the agent's answer goes back by text */
  private talking = new Set<string>();
  /** when each session's link last went out */
  private linked = new Map<string, number>();
  /** the ids of the person's texts already taken, newest last */
  private heardIds: string[] = [];
  /** images that came with the text the router holds (its id), waiting for the person to pick a session */
  private heldFiles?: { id: number; files: TextedFile[]; at: number };
  /** turns HEIC into JPEG (tests replace it) */
  convert: Convert = imagemagick;
  readonly caps: AgentTextCaps;

  constructor(
    private ctx: Ctx,
    readonly store: TextingStore,
    private open: OpenLink = openSpectrum,
    private now: () => number = Date.now,
  ) {
    this.router = new Router(store.router, now);
    this.caps = new AgentTextCaps(now);
  }

  // ── the link ──

  /** Connects when texting is on and set; reconnects after a drop, backing off. */
  start() {
    this.stopped = false;
    if (this.link || this.connecting) return this.connecting ?? Promise.resolve();
    const cfg = this.store.config();
    if (!cfg) return Promise.resolve();
    this.connecting = (async () => {
      try {
        const link = await this.open(cfg, (m) => this.heard(m), this.ctx.log);
        if (this.stopped) return void (await link.stop());
        this.link = link;
        this.connected = true;
        this.lastError = undefined;
        this.delay = RETRY_MIN_MS;
        void link.closed.then(() => this.dropped(link));
      } catch (e: any) {
        this.lastError = `Couldn't connect to Photon: ${e?.message ?? e}`;
        this.ctx.log(`texting: ${this.lastError}`);
        this.later();
      } finally {
        this.connecting = undefined;
      }
    })();
    return this.connecting;
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.retry);
    await this.connecting;
    const link = this.link;
    this.link = undefined;
    this.connected = false;
    await link?.stop();
  }

  /** Settings changed: a new link with them (or none). */
  async restart() {
    await this.stop();
    this.lastError = undefined;
    this.delay = RETRY_MIN_MS;
    await this.start();
  }

  private dropped(link: TextLink) {
    if (this.link !== link) return;
    this.link = undefined;
    this.connected = false;
    if (!this.stopped) this.later();
  }

  private later() {
    if (this.stopped) return;
    clearTimeout(this.retry);
    this.retry = setTimeout(() => void this.start(), this.delay);
    this.delay = Math.min(this.delay * 2, RETRY_MAX_MS);
  }

  private async say(text: string): Promise<string | undefined> {
    return (await this.send(text)).id;
  }

  /** Texts the person; `sent`: it went (Photon may give no id). */
  private async send(text: string): Promise<{ sent: boolean; id?: string }> {
    if (!this.link) return { sent: false };
    try {
      const id = await this.link.send(text);
      this.router.noteOut();
        return { sent: true, ...(id ? { id } : {}) };
    } catch (e: any) {
      this.lastError = `Couldn't send a text: ${e?.message ?? e}`;
      this.ctx.log(`texting: ${this.lastError}`);
      return { sent: false };
    }
  }

  /**
   * The Home agent texts the person ("[home] ok, on it"): whether it went. A threaded reply to it
   * goes back to the Home agent; `about`: the session it's about, which a reply goes with.
   */
  async homeText(body: string, about?: string, chat?: string): Promise<boolean> {
    return (await this.homeSend(body, about, undefined, chat)).sent;
  }

  /** The home a chat is (none, or the primary one's: undefined), for stamping its texts "[h1] …". */
  private homeOf(chat?: string): { n: number; chat: string } | undefined {
    if (!chat) return undefined;
    const h = this.ctx.homeLine?.home?.homes().find((x) => x.chat === chat);
    return h && h.n !== 0 ? { n: h.n, chat } : undefined;
  }

  private async homeSend(body: string, about?: string, image?: OutImage, chat?: string): Promise<{ sent: boolean; imageSent?: boolean }> {
    const words = clip(body, HOME_MAX);
    if (!this.link || !words) return { sent: false };
    const home = this.homeOf(chat);
    const { sent, id } = await this.send(this.router.stampHome(words, about, home));
    if (id) this.router.noteSent(id, HOME, undefined, about, home?.chat);
    const imageSent = sent && image ? await this.sendImage(image, HOME, about, undefined, home?.chat) : undefined;
    this.store.save();
    return { sent, ...(imageSent !== undefined ? { imageSent } : {}) };
  }

  /** An image after a text, threaded like it (a reply to the image goes where a reply to the text would). */
  private async sendImage(image: OutImage, sessionId: string, about?: string, requestId?: string, home?: string): Promise<boolean> {
    if (!this.link?.sendFile) return false;
    try {
      const id = await this.link.sendFile(image);
      if (id) this.router.noteSent(id, sessionId, requestId, about, home);
      return true;
    } catch (e: any) {
      this.lastError = `Couldn't send an image: ${e?.message ?? e}`;
      this.ctx.log(`texting: ${this.lastError}`);
      return false;
    }
  }

  async test() {
    if (!this.store.config()) throw new Error("Set the phone and the Photon project's id and secret first, and turn texting on.");
    await this.start();
    if (!this.link) throw new Error(this.lastError ?? "Not connected to Photon yet.");
    await this.link.send(TEXTS.test);
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
  async personText(from: string, body: string, o: { image?: string; about?: string; chat?: string } = {}): Promise<{ text: string; isError?: boolean }> {
    const words = clip(body, PERSON_TEXT_MAX);
    if (!words) return { text: "The message is empty.", isError: true };
    if (!this.link) return { text: "Texting isn't set up or connected in Tether, so nothing was sent. Say it in your reply instead.", isError: true };
    if (o.image && !this.link.sendFile) return { text: "Images can't be texted on this connection. Nothing was sent.", isError: true };
    // Taken before an image is checked: a refused image counts as a try (no free probing of paths).
    const why = this.caps.take(from);
    if (why) return { text: why, isError: true };
    let image: OutImage | undefined;
    if (o.image) {
      const r = readOutgoingImage(o.image);
      if ("problem" in r) return { text: `${r.problem} Nothing was sent.`, isError: true };
      image = r;
    }
    const { sent, imageSent } = from === HOME ? await this.homeSend(words, o.about, image, o.chat) : await this.tell(from, TEXTED_YOU, words, { always: true, image });
    if (!sent) {
      this.caps.undo(from);
      return { text: `The text didn't go (${this.lastError ?? "not connected"}). Say it in your reply instead.`, isError: true };
    }
    const cut = words.length < body.trim().length ? ` It was cut to ${PERSON_TEXT_MAX} characters.` : "";
    const pic = image ? (imageSent ? " The image went with it." : ` The image didn't go (${this.lastError ?? "not connected"}).`) : "";
    return { text: `Texted the person.${cut}${pic} If they reply, their reply comes to you as a message.` };
  }

  /** Texts about a session, unless someone is looking at it (or at `also`) in Tether right now (`always`: even then). Whether it went. */
  async tell(sessionId: string, status: string, body: string, o: { also?: string[]; quick?: boolean; requestId?: string; always?: boolean; link?: boolean; image?: OutImage } = {}): Promise<{ sent: boolean; imageSent?: boolean }> {
    const { also = [], quick = false, requestId, always = false } = o;
    if (!this.link) return { sent: false };
    if (!always && [sessionId, ...also].some((id) => this.ctx.viewersOf(id).length)) return { sent: false };
    // The link only now and then, and never on a quick back-and-forth.
    const at = this.now();
    // A request's text always has it: the full command is there, not in the text.
    const link = !!o.link || (!quick && at - (this.linked.get(sessionId) ?? -Infinity) >= LINK_EVERY_MS);
    if (link) this.linked.set(sessionId, at);
    const { text } = this.router.stamp(sessionId, status, link ? `${body}\n${this.url(sessionId)}` : body, requestId);
    const { sent, id } = await this.send(text);
    if (id) this.router.noteSent(id, sessionId, requestId);
    const imageSent = sent && o.image ? await this.sendImage(o.image, sessionId, undefined, requestId) : undefined;
    this.store.save();
    return { sent, ...(imageSent !== undefined ? { imageSent } : {}) };
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
    if (error) await this.tell(sessionId, `failed: ${failureKind(error)}`, TEXTS.failed(agentOf(sessionId), failureKind(error)));
    // An answer to something the person texted is the back-and-forth: no link.
    else if (last && (talking || asksQuestion(last))) await this.tell(sessionId, asksQuestion(last) ? "asked you something" : "answered", clip(last, SAID_MAX), { quick: talking });
  }

  // ── in: the person's replies, one at a time ──

  heard(m: Inbound): Promise<void> {
    // The same text heard twice (a reconnect's replay) is taken once.
    if (m.id) {
      if (this.heardIds.includes(m.id)) return this.inbox;
      this.heardIds = [...this.heardIds, m.id].slice(-HEARD_MAX);
    }
    // Its images download now, beside the texts before it (each within DOWNLOAD.ms): the queue
    // waits for them, never longer.
    const got = m.files?.length ? this.download(m.files) : Promise.resolve(NO_FILES);
    this.inbox = this.inbox.then(async () => this.answer(m, await got)).catch((e) => this.ctx.log(`texting: ${e?.message ?? e}`));
    return this.inbox;
  }

  /** The images among what the person texted, downloaded and checked; how many files were left out (not images) and how many failed. */
  private async download(list: InboundFile[]): Promise<Got> {
    const { take, left } = pickIncoming(list);
    const files: Got["files"] = [];
    let failed = 0;
    let notImages = left;
    await Promise.all(
      take.map(async (f) => {
        try {
          const img = await incomingImage(f, await download(f), this.convert);
          if (img) files.push(img);
          else notImages++;
        } catch (e: any) {
          this.ctx.log(`texting: couldn't download an image: ${e?.message ?? e}`);
          failed++;
        }
      }),
    );
    return { files, notImages, failed };
  }

  /** What a reply to the Home agent is about, with the session's title and folder. */
  private aboutText(a: About): string {
    const look = this.ctx.session(a.sessionId);
    return replyContext({ sessionId: a.sessionId, ...(look?.summary.title ? { title: look.summary.title } : {}), ...(look ? { project: look.summary.projectPath } : {}) });
  }

  /** The images held with the held text `id`, taken (and those of other held texts dropped). */
  private takeHeld(id: number | undefined): TextedFile[] {
    const h = this.heldFiles;
    this.heldFiles = undefined;
    if (!h) return [];
    if (h.id === id && this.now() - h.at < HELD_MS) return h.files;
    return [];
  }

  private async answer(m: Inbound, got: Got) {
    const home = this.ctx.homeLine?.home;
    if (got.notImages) await this.say(TEXTS.onlyImages);
    else if (got.failed) await this.say(TEXTS.imagesNotSent);
    const words = m.text.trim();
    const heic = got.files.some((f) => f.heic);
    const own: TextedFile[] = got.files.map(({ heic: _, ...f }) => f);
    const text = words || (own.length ? IMAGE_ONLY : "");
    const heldBefore = this.router.state.held?.id;
    const d = this.router.route(text, m.replyTo, home ? home.homes() : false);
    this.store.save();
    // Images go with their words: now, or (held while the person picks a session) when the held
    // text goes. A text that replaces a held one takes its images along (a photo, then its caption).
    let files = own;
    const heldNow = this.router.state.held;
    if (d.kind === "deliver" || d.kind === "home" || d.kind === "newHome") {
      files = [...this.takeHeld(d.held), ...own];
    } else if (heldNow && heldNow.id !== heldBefore) {
      const carried = this.heldFiles && this.now() - this.heldFiles.at < HELD_MS ? this.heldFiles.files : [];
      this.heldFiles = carried.length || own.length ? { id: heldNow.id!, files: [...carried, ...own], at: this.now() } : undefined;
      own.length = 0;
      files = [];
    }
    // Anything below that doesn't pass the images on says so (never lost without a word).
    let passed = files.length === 0;
    const withNote = (t: string) => (heic ? `${t}\n\n${HEIC_NOTE}` : t);
    try {
      if (d.kind === "none") return;
      if (d.kind === "reply") return void (await this.say(d.text));
      if (d.kind === "newHome") {
        try {
          const n = await home!.newHome(withNote(d.text), files.length ? files : undefined);
          passed = true;
          if (d.text) await m.react?.(READ).catch(() => {});
          else await this.say(TEXTS.homeStarted(homeLabel(n)));
        } catch (e: any) {
          await this.say(TEXTS.couldNotSend("a new home", String(e?.message ?? e)));
        }
        return;
      }
      if (d.kind === "deleteHome") {
        try {
          const left = await home!.deleteHome(d.n);
          await this.say(TEXTS.homeDeleted(homeLabel(d.n), homeList(left)));
        } catch (e: any) {
          await this.say(TEXTS.couldNotSend(homeLabel(d.n), String(e?.message ?? e)));
        }
        return;
      }
      if (d.kind === "home") {
        const label = homeLabel(d.home ?? 0);
        try {
          await home!.take(withNote((d.about ? this.aboutText(d.about) : "") + d.text), files.length ? files : undefined, { n: d.home ?? 0 });
          passed = true;
          await m.react?.(READ).catch((e) => this.ctx.log(`texting: couldn't react: ${e?.message ?? e}`));
        } catch (e: any) {
          await this.say(TEXTS.couldNotSend(d.home ? label : "the Home agent", String(e?.message ?? e)));
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
          return void (await this.say(TEXTS.alreadyAnswered(d.n)));
        }
        if (open && d.text === IMAGE_ONLY && files.length) {
          // Just an image while a request waits: it isn't a y or an n, so it goes after the turn,
          // and the request still waits on the person.
          if (!this.ctx.sessions.queue) throw new Error("this session can't take images now");
          await this.ctx.sessions.queue(d.sessionId, withNote(d.text), files);
          passed = true;
          this.router.unsettle(d.sessionId);
          this.store.save();
        } else if (open) {
          const r = readReply(open, d.text);
          if ("problem" in r) return void (await this.say(`${tag} ${r.problem}`));
          // Talking: the agent reads it as the reason and carries on (a plan stays a plan).
          const answer: RequestAnswer = "answer" in r ? r.answer : { allow: false, reason: r.talk };
          await this.ctx.sessions.answer(d.sessionId, open.id, answer);
          // Images with the answer: the agent gets them after its turn.
          if (files.length && this.ctx.sessions.queue) {
            await this.ctx.sessions.queue(d.sessionId, withNote(TEXTED_WITH_ANSWER), files);
            passed = true;
          }
          this.talking.add(d.sessionId);
        } else {
          await this.ctx.sessions.tell(d.sessionId, withNote(d.text), files.length ? files : undefined);
          passed = true;
          this.talking.add(d.sessionId);
        }
        // No "sent" or "allowed" back (texts.ts): the session answers for itself. A ✅ on the
        // person's text says Tether read it and passed it on.
        await m.react?.(READ).catch((e) => this.ctx.log(`texting: couldn't react: ${e?.message ?? e}`));
      } catch (e: any) {
        await this.say(TEXTS.couldNotSend(tag, String(e?.message ?? e)));
      }
    } finally {
      if (!passed) await this.say(TEXTS.imagesNotSent);
    }
  }
}

export const textingModule: Module = {
  name: "texting",
  start(ctx) {
    const store = new TextingStore(join(ctx.dataDir, "texting.json"));
    const t = new Texter(ctx, store);
    if (ctx.homeLine) ctx.homeLine.phone = { send: (text, about, chat) => t.homeText(text, about, chat), text: (from, body, o) => t.personText(from, body, o) };
    const later = (ms: number, f: () => Promise<void>) => setTimeout(() => void f().catch((e) => ctx.log(`texting failed: ${e?.message ?? e}`)), ms);
    const offs = [
      ctx.bus.on("requestOpened", ({ request }) => void later(REQUEST_DELAY_MS, () => t.request(request))),
      ctx.bus.on("attention", ({ sessionId }) => void later(0, () => t.attention(sessionId))),
      ctx.bus.on("message", ({ sessionId, msg }) => t.said(sessionId, msg)),
      ctx.bus.on("turnStarted", ({ sessionId }) => t.turnStarted(sessionId)),
      ctx.bus.on("requestClosed", ({ sessionId }) => t.settled(sessionId)),
      ctx.bus.on("turnEnded", ({ sessionId, error, stopped, recovering }) => void (!stopped && !recovering && later(FINISH_DELAY_MS, () => t.turnEnded(sessionId, error)))),
    ];
    const status = () => store.status(t);
    ctx.ops.register("textingStatus", () => status());
    ctx.ops.register("setTexting", async (a) => {
      store.update(a);
      await t.restart();
      return status();
    });
    ctx.ops.register("textingTest", async () => (await t.test(), null));
    void t.start();
    return () => {
      offs.forEach((f) => f());
      if (ctx.homeLine) ctx.homeLine.phone = undefined;
      void t.stop();
    };
  },
};
