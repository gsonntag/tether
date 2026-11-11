// Texting (SPEC §11 Texting): the same moments as push notifications (a request, "needs you" in the
// terminal, a turn finished or failed) go to the person's phone as iMessages through Photon
// Spectrum, and their replies go back to the session. Each text starts with its session's number;
// a reply that isn't clear gets a numbered picker (router.ts). The runner sends them, not the app:
// a Foliation app has no internet egress (server/src/push.ts).
//
// What a text says is what a push says (pushTitle, requestBody, failureKind): the folder, the agent
// and what kind of thing happened, never a title, a command or the agent's words.

import { join } from "node:path";
import type { Request } from "../../../../shared/transcript";
import type { Module, ModuleContext } from "..";
import { agentOf, endWorthTelling, failureKind, FINISH_DELAY_MS, pushTitle, REQUEST_DELAY_MS, requestBody, requestStillOpen } from "../push";
import { openSpectrum, type Inbound, type OpenLink, type TextLink } from "./link";
import { Router } from "./router";
import { TextingStore } from "./store";

const RETRY_MIN_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;

type Ctx = Pick<ModuleContext, "session" | "viewersOf" | "log"> & { sessions: Pick<ModuleContext["sessions"], "tell" | "deny"> };

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

  constructor(
    private ctx: Ctx,
    readonly store: TextingStore,
    private open: OpenLink = openSpectrum,
    now: () => number = Date.now,
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
    if (!this.link) return undefined;
    try {
      return await this.link.send(text);
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
    await this.link.send("Tether texting works. Replies here go to your sessions.");
  }

  // ── out: what happened ──

  /** "my-app · Claude", or "… · a subagent" (pushTitle: never the session's own title). */
  label(id: string): string {
    const s = this.ctx.session(id)?.summary;
    if (!s) return "Tether";
    const title = pushTitle(s.projectPath, agentOf(id));
    return s.parentSessionId ? `${title} · a subagent` : title;
  }

  /** Texts about a session, unless someone is looking at it (or at `also`) in Tether right now. */
  async tell(sessionId: string, status: string, body: string, also: string[] = []) {
    if (!this.link) return;
    if ([sessionId, ...also].some((id) => this.ctx.viewersOf(id).length)) return;
    const { text } = this.router.stamp(sessionId, this.label(sessionId), status, body);
    const id = await this.say(text);
    if (id) this.router.noteSent(id, sessionId);
    this.store.save();
  }

  async request(r: Request) {
    const look = this.ctx.session(r.sessionId);
    if (!look || !requestStillOpen(look, r.id)) return;
    const root = look.summary.parentSessionId;
    const agent = agentOf(r.sessionId);
    const what = requestBody(r, agent);
    const status = what.slice(what.startsWith(`${agent} `) ? agent.length + 1 : 0).replace(/\.$/, "");
    await this.tell(r.sessionId, status, `${what} Open Tether to approve, or reply to deny with a note.`, root ? [root] : []);
  }

  async attention(sessionId: string) {
    await this.tell(sessionId, "needs you in the terminal", `${agentOf(sessionId)} needs you in the terminal. A reply is typed into it.`);
  }

  async turnEnded(sessionId: string, error?: string) {
    if (!endWorthTelling(this.ctx.session(sessionId))) return;
    if (error) await this.tell(sessionId, `failed: ${failureKind(error)}`, `Failed: ${failureKind(error)}.`);
    else await this.tell(sessionId, "finished", "Finished.");
  }

  // ── in: the person's replies, one at a time ──

  heard(m: Inbound): Promise<void> {
    this.inbox = this.inbox.then(() => this.answer(m)).catch((e) => this.ctx.log(`texting: ${e?.message ?? e}`));
    return this.inbox;
  }

  private async answer(m: Inbound) {
    const d = this.router.route(m.text, m.replyTo);
    this.store.save();
    if (d.kind === "none") return;
    if (d.kind === "reply") return void (await this.say(d.text));
    const tag = `[${d.n}] ${d.label}`;
    try {
      const open = this.ctx.session(d.sessionId)?.requests ?? [];
      if (open.length) {
        await this.ctx.sessions.deny(d.sessionId, open[0]!, d.text);
        await this.say(`→ ${tag}: denied, with your note.`);
      } else {
        await this.ctx.sessions.tell(d.sessionId, d.text);
        await this.say(`→ ${tag}`);
      }
    } catch (e: any) {
      await this.say(`Couldn't send to ${tag}: ${e?.message ?? e}`);
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
