// Texting (SPEC §11 Texting): a request, "needs you" in the terminal, a failed turn, a turn that ended
// with the agent asking you something, and the agent's answer to anything you texted it go to the
// person's phone as iMessages through Photon Spectrum, with a link to the session in Tether now and
// then (LINK_EVERY_MS; never on the back-and-forth of a texted conversation). A
// turn that just finishes doesn't text. Replies go back to the session: y or n (or a letter) answers
// a request, anything else is the person's words to the agent (describe.ts). Each text starts with
// its session's number; a reply that isn't clear gets a numbered picker (router.ts). The runner sends
// them, not the app: a Foliation app has no internet egress (server/src/push.ts).
//
// The thread is shared with the `textme` CLI (the text-me skill), which texts from the same Photon
// number and hears the same replies: each says what it last sent in a shared folder (thread.ts), and
// a reply that's answering a textme's text is left to it, with no picker.
//
// Texts carry what the agent wants and says (the person asked for that over push's lock-screen
// wording); known secrets are redacted. Tether's own words read like a human's: "[6] ok", one
// casual sentence at most, never that something works, and no acknowledgment after a reply is
// passed on (texts.ts has the whole rule).

import { join } from "node:path";
import type { Msg, Request, RequestAnswer } from "../../../../shared/transcript";
import type { Module, ModuleContext } from "..";
import { agentOf, endWorthTelling, failureKind, FINISH_DELAY_MS, REQUEST_DELAY_MS, requestStillOpen } from "../push";
import { clip, readReply, requestText } from "./describe";
import { openSpectrum, type Inbound, type OpenLink, type TextLink } from "./link";
import { Router } from "./router";
import { TextingStore } from "./store";
import { FileThread, type Thread } from "./thread";
import { TEXTS } from "./texts";

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

type Ctx = Pick<ModuleContext, "session" | "viewersOf" | "log" | "runnerId" | "appUrl"> & { sessions: Pick<ModuleContext["sessions"], "tell" | "answer"> };

/** How long an agent's answer may be in a text. */
const SAID_MAX = 1500;
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

  constructor(
    private ctx: Ctx,
    readonly store: TextingStore,
    private open: OpenLink = openSpectrum,
    private now: () => number = Date.now,
    private thread: Thread = new FileThread(),
  ) {
    this.router = new Router(store.router, now);
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
        this.publish();
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
    this.thread.clear();
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

  /** Tells textme (thread.ts) what Tether last sent and which sessions are open. */
  private publish() {
    if (this.link) this.thread.publish(this.router.note());
  }

  private async say(text: string): Promise<string | undefined> {
    if (!this.link) return undefined;
    try {
      const id = await this.link.send(text);
      this.router.noteOut();
      this.publish();
      return id;
    } catch (e: any) {
      this.lastError = `Couldn't send a text: ${e?.message ?? e}`;
      this.ctx.log(`texting: ${this.lastError}`);
      return undefined;
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
    return `${this.ctx.appUrl.replace(/\/+$/, "")}/#/s/${encodeURIComponent(this.ctx.runnerId)}/${encodeURIComponent(sessionId)}`;
  }

  /** Texts about a session, unless someone is looking at it (or at `also`) in Tether right now. */
  async tell(sessionId: string, status: string, body: string, also: string[] = [], quick = false) {
    if (!this.link) return;
    if ([sessionId, ...also].some((id) => this.ctx.viewersOf(id).length)) return;
    // The link only now and then, and never on a quick back-and-forth.
    const at = this.now();
    const link = !quick && at - (this.linked.get(sessionId) ?? -Infinity) >= LINK_EVERY_MS;
    if (link) this.linked.set(sessionId, at);
    const { text } = this.router.stamp(sessionId, status, link ? `${body}\n\n${this.url(sessionId)}` : body);
    const id = await this.say(text);
    if (id) this.router.noteSent(id, sessionId);
    this.store.save();
    this.publish();
  }

  async request(r: Request) {
    const look = this.ctx.session(r.sessionId);
    if (!look || !requestStillOpen(look, r.id)) return;
    const root = look.summary.parentSessionId;
    const { status, body } = requestText(r, agentOf(r.sessionId));
    await this.tell(r.sessionId, status, body, root ? [root] : []);
  }

  async attention(sessionId: string) {
    await this.tell(sessionId, "needs you in the terminal", TEXTS.attention(agentOf(sessionId)));
  }

  /** The agent said something: kept until its turn ends (only the last message counts). */
  said(sessionId: string, msg: Msg) {
    if (msg.role !== "assistant") return;
    const text = msg.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n").trim();
    if (text) this.lastSaid.set(sessionId, text);
  }

  turnStarted(sessionId: string) {
    this.lastSaid.delete(sessionId);
    this.settled(sessionId);
  }

  /** The person answered the session (a request, a new turn): it's out of the picker until it texts again. */
  settled(sessionId: string) {
    this.router.settle(sessionId);
    this.store.save();
    this.publish();
  }

  /**
   * A failed turn texts. A finished one texts the agent's last message when the person texted it
   * this turn (its answer) or when it ends by asking them something; otherwise nothing.
   */
  async turnEnded(sessionId: string, error?: string) {
    const last = this.lastSaid.get(sessionId);
    this.lastSaid.delete(sessionId);
    if (!endWorthTelling(this.ctx.session(sessionId))) return;
    const talking = this.talking.delete(sessionId);
    if (error) await this.tell(sessionId, `failed: ${failureKind(error)}`, TEXTS.failed(agentOf(sessionId), failureKind(error)));
    // An answer to something the person texted is the back-and-forth: no link.
    else if (last && (talking || asksQuestion(last))) await this.tell(sessionId, asksQuestion(last) ? "asked you something" : "answered", clip(last, SAID_MAX), [], talking);
  }

  // ── in: the person's replies, one at a time ──

  heard(m: Inbound): Promise<void> {
    this.inbox = this.inbox.then(() => this.answer(m)).catch((e) => this.ctx.log(`texting: ${e?.message ?? e}`));
    return this.inbox;
  }

  private async answer(m: Inbound) {
    const d = this.router.route(m.text, m.replyTo, this.thread.waiters(this.now()));
    this.store.save();
    this.publish();
    if (d.kind === "none") return;
    if (d.kind === "reply") return void (await this.say(d.text));
    const tag = `[${d.n}]`;
    try {
      const look = this.ctx.session(d.sessionId);
      const open = look?.state?.requests?.find((r) => look.requests.includes(r.id));
      if (open) {
        const r = readReply(open, d.text);
        if ("problem" in r) return void (await this.say(`${tag} ${r.problem}`));
        // Talking: the agent reads it as the reason and carries on (a plan stays a plan).
        const answer: RequestAnswer = "answer" in r ? r.answer : { allow: false, reason: r.talk };
        await this.ctx.sessions.answer(d.sessionId, open.id, answer);
        this.talking.add(d.sessionId);
      } else {
        await this.ctx.sessions.tell(d.sessionId, d.text);
        this.talking.add(d.sessionId);
      }
      // No "sent" or "allowed" back (texts.ts): the session answers for itself. A ✅ on the
      // person's text says Tether read it and passed it on.
      await m.react?.(READ).catch((e) => this.ctx.log(`texting: couldn't react: ${e?.message ?? e}`));
    } catch (e: any) {
      await this.say(TEXTS.couldNotSend(tag, String(e?.message ?? e)));
    }
  }
}

export const textingModule: Module = {
  name: "texting",
  start(ctx) {
    const store = new TextingStore(join(ctx.dataDir, "texting.json"));
    const t = new Texter(ctx, store);
    const later = (ms: number, f: () => Promise<void>) => setTimeout(() => void f().catch((e) => ctx.log(`texting failed: ${e?.message ?? e}`)), ms);
    const offs = [
      ctx.bus.on("requestOpened", ({ request }) => void later(REQUEST_DELAY_MS, () => t.request(request))),
      ctx.bus.on("attention", ({ sessionId }) => void later(0, () => t.attention(sessionId))),
      ctx.bus.on("message", ({ sessionId, msg }) => t.said(sessionId, msg)),
      ctx.bus.on("turnStarted", ({ sessionId }) => t.turnStarted(sessionId)),
      ctx.bus.on("requestClosed", ({ sessionId }) => t.settled(sessionId)),
      ctx.bus.on("turnEnded", ({ sessionId, error, stopped }) => void (!stopped && later(FINISH_DELAY_MS, () => t.turnEnded(sessionId, error)))),
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
      void t.stop();
    };
  },
};
