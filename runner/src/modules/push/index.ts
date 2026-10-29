// Web Push notifications (SPEC §11 P5): when a session needs you (a request, or Claude's TUI asking
// in the terminal), finishes, or fails, every device that turned notifications on hears, with no
// tab open. A device that is looking at that session right now (presence) is skipped.
//
// The runner sends them: it is always on, sees every session, and keeps each device's subscription
// in its own config dir (push.json). The app's server keeps the VAPID key pair and hands it over on
// connect (server/src/push.ts), so one subscription per device works for every runner.

import { join } from "node:path";
import type { PushPayload } from "../../../../shared/protocol";
import { AGENT_NAMES, type Request } from "../../../../shared/transcript";
import { parseSessionId } from "../../../../shared/ids";
import type { Module, ModuleContext } from "..";
import { PushSender, type Sender } from "./sender";
import { SubscriptionStore } from "./store";

/** A request that closes this fast (answered elsewhere, a policy step) never notifies. */
const REQUEST_DELAY_MS = 800;
/** A turn end is told only if the session is still idle by then (the queue may send the next message). */
const FINISH_DELAY_MS = 1500;

const agentOf = (sessionId: string) => AGENT_NAMES[parseSessionId(sessionId)?.harness ?? "claude"] ?? "The agent";
const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** What a request asks, as a notification's body. */
export function requestBody(r: Request, agent: string): string {
  if (r.kind === "question") return `${agent} asks: ${short(r.questions?.[0]?.question ?? r.question ?? "a question", 160)}`;
  if (r.plan !== undefined) return `${agent} has a plan for you to approve.`;
  const input = (r.input ?? {}) as Record<string, unknown>;
  const cmd = r.command ?? (typeof input.command === "string" ? input.command : undefined);
  if (cmd) return `${agent} wants to run ${short(cmd, 120)}`;
  const path = r.path ?? (typeof input.file_path === "string" ? input.file_path : typeof input.path === "string" ? input.path : undefined);
  if (path) return `${agent} wants to ${r.toolKind === "edit" || r.toolKind === "write" ? "change" : "use"} ${short(path.split("/").pop() ?? path, 80)}`;
  return `${agent} wants to use ${r.tool ?? "a tool"}.`;
}

export class Notifier {
  constructor(
    private ctx: Pick<ModuleContext, "session" | "viewersOf" | "runnerId" | "log">,
    private store: SubscriptionStore,
    private sender: Sender,
  ) {}

  /** Sends to every device but those looking at the session (or at `also`). */
  async notify(p: Omit<PushPayload, "runnerId" | "ts">, also: string[] = []) {
    if (!this.sender.ready()) return;
    const skip = new Set(p.sessionId ? [p.sessionId, ...also].flatMap((id) => this.ctx.viewersOf(id)) : []);
    const payload: PushPayload = { ...p, runnerId: this.ctx.runnerId, ts: Date.now() };
    await Promise.all(
      this.store
        .list()
        .filter((s) => !skip.has(s.deviceId))
        .map((s) => this.sender.send(s, payload).then((gone) => gone && this.store.remove(s.endpoint))),
    );
  }

  /** A session's title, with its main session's for a subagent. */
  title(id: string): string {
    const s = this.ctx.session(id)?.summary;
    if (!s) return "Tether";
    const parent = s.parentSessionId ? this.ctx.session(s.parentSessionId)?.summary : undefined;
    return parent ? `${parent.title || "Untitled"} · ${s.title}` : s.title || "Untitled";
  }

  async request(r: Request) {
    const look = this.ctx.session(r.sessionId);
    if (!look?.requests.includes(r.id)) return;
    const root = look.summary.parentSessionId;
    await this.notify({ kind: "request", sessionId: r.sessionId, title: this.title(r.sessionId), body: requestBody(r, agentOf(r.sessionId)), tag: `req-${r.id}` }, root ? [root] : []);
  }

  async attention(sessionId: string, message?: string) {
    await this.notify({ kind: "request", sessionId, title: this.title(sessionId), body: message ? short(message, 200) : `${agentOf(sessionId)} needs you in the terminal.`, tag: `att-${sessionId}` });
  }

  async turnEnded(sessionId: string, error?: string) {
    const look = this.ctx.session(sessionId);
    if (!look || look.summary.parentSessionId) return;
    // The queue sent the next message, or the session waits on a request (that notifies itself).
    if (look.status !== "idle" || look.requests.length) return;
    const agent = agentOf(sessionId);
    if (error) await this.notify({ kind: "failed", sessionId, title: this.title(sessionId), body: `${agent}'s turn failed: ${short(error, 160)}`, tag: `end-${sessionId}` });
    else await this.notify({ kind: "finished", sessionId, title: this.title(sessionId), body: look.lastText ? short(look.lastText, 180) : `${agent} finished.`, tag: `end-${sessionId}` });
  }
}

export const pushModule: Module = {
  name: "push",
  start(ctx) {
    const store = new SubscriptionStore(join(ctx.dataDir, "push.json"));
    const sender = new PushSender(ctx.appUrl, ctx.log);
    const n = new Notifier(ctx, store, sender);
    const later = (ms: number, f: () => Promise<void>) => setTimeout(() => void f().catch((e) => ctx.log(`notify failed: ${e?.message ?? e}`)), ms);
    const offs = [
      ctx.bus.on("connected", ({ push }) => sender.setKeys(push)),
      ctx.bus.on("requestOpened", ({ request }) => void later(REQUEST_DELAY_MS, () => n.request(request))),
      ctx.bus.on("attention", ({ sessionId, message }) => void later(0, () => n.attention(sessionId, message))),
      ctx.bus.on("turnEnded", ({ sessionId, error, stopped }) => void (!stopped && later(FINISH_DELAY_MS, () => n.turnEnded(sessionId, error)))),
    ];
    const str = (v: unknown, what: string) => {
      if (typeof v !== "string" || !v || v.length > 2000) throw new Error(`${what} is required.`);
      return v;
    };
    ctx.ops.register("pushSubscribe", (a) => {
      const sub = a.subscription as any;
      const endpoint = str(sub?.endpoint, "subscription.endpoint");
      // A push service is https; a dev runner also takes plain http to this machine (a test push service).
      const local = process.env.TETHER_DEV === "1" && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(endpoint);
      if (!/^https:\/\//.test(endpoint) && !local) throw new Error("That isn't a push endpoint.");
      store.add({ deviceId: str(a.deviceId, "deviceId"), endpoint, keys: { p256dh: str(sub?.keys?.p256dh, "keys.p256dh"), auth: str(sub?.keys?.auth, "keys.auth") }, label: typeof a.label === "string" ? a.label.slice(0, 120) : undefined });
      return null;
    });
    ctx.ops.register("pushUnsubscribe", (a) => (store.remove(str(a.endpoint, "endpoint")), null));
    ctx.ops.register("pushStatus", (a) => ({ subscribed: !!store.get(str(a.endpoint, "endpoint")), ready: sender.ready() }));
    ctx.ops.register("pushTest", async (a) => {
      const sub = store.get(str(a.endpoint, "endpoint"));
      if (!sub) throw new Error("This device isn't subscribed on this runner.");
      if (!sender.ready()) throw new Error("The app has no push keys yet (TETHER_VAPID_PUBLIC_KEY, TETHER_VAPID_PRIVATE_KEY).");
      const gone = await sender.send(sub, { kind: "test", title: "Tether notifications work", body: "You'll hear from your agents here.", runnerId: ctx.runnerId, ts: Date.now(), tag: "test" }, true);
      if (gone) store.remove(sub.endpoint);
      return null;
    });
    return () => offs.forEach((f) => f());
  },
};
