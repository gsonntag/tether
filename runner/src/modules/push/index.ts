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
import { endpointProblem } from "./endpoint";
import { SubscriptionStore } from "./store";

const DEV = process.env.TETHER_DEV === "1";

/** A request that closes this fast (answered elsewhere, a policy step) never notifies. */
const REQUEST_DELAY_MS = 800;
/** A turn end is told only if the session is still idle by then (the queue may send the next message). */
const FINISH_DELAY_MS = 1500;

const agentOf = (sessionId: string) => AGENT_NAMES[parseSessionId(sessionId)?.harness ?? "claude"] ?? "The agent";
const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** Looks like a path, URL, key, token, secret or an assignment: never in a notification. */
const UNSAFE =
  /[\\/=:@$`|<>{}[\]~]|https?|\bsk-|token|secret|passw|api.?key|bearer|credential|[A-Za-z0-9+_-]{20,}|[0-9a-f]{12,}|[\p{L}\p{N}_-]\.[\p{L}\p{N}_-]|(^|[\s"'(])\.[\p{L}\p{N}_]/iu;

/**
 * A session's title as a push shows it: the project folder and the agent ("web-coder · Claude").
 * Never the session's own title: Codex titles are your first message verbatim, Claude's are written
 * by the model from it, `!` sessions hold the command, and a denylist can't tell "my pin is 4821"
 * from a harmless title. `renamed`: a name you gave the session yourself in Tether (none yet), shown
 * only when short and free of anything path-, host-, key- or command-like.
 */
export function pushTitle(projectPath: string, agent: string, renamed?: string): string {
  const t = (renamed ?? "").trim().replace(/\s+/g, " ");
  if (t && t.length <= 60 && !UNSAFE.test(t) && !/[;&*#%^]|\bsudo\b|\brm\b|--?\w|\d{4,}/.test(t)) return t;
  // The folder's name too only when it doesn't look like a host, key or secret.
  const folder = projectPath.replace(/\/+$/, "").split("/").pop() || "";
  const safe = folder && folder.length <= 40 && !UNSAFE.test(folder) && !/\d{4,}/.test(folder);
  return `${safe ? folder : "a project"} · ${agent}`;
}

/**
 * What a request needs, as a notification says it: only what kind of thing the agent wants. Never
 * any text the agent or the model wrote (a step's description, Codex's reason), a command, a path,
 * a host, a tool's name or the question itself: a phone may show it on its lock screen.
 */
export function requestBody(r: Request, agent: string, _harness: string = "claude"): string {
  if (r.kind === "question") return `${agent} has a question for you.`;
  if (r.plan !== undefined) return `${agent} has a plan for you to approve.`;
  if (r.network) return `${agent} wants network access.`;
  const input = (r.input ?? {}) as Record<string, unknown>;
  const files = Array.isArray(input.files) ? input.files.length : 0;
  const kind = r.toolKind ?? (r.command || typeof input.command === "string" ? "shell" : undefined);
  switch (kind) {
    case "shell":
      return `${agent} wants to run a command.`;
    case "edit":
    case "write":
      return files > 1 ? `${agent} wants to edit ${files} files.` : `${agent} wants to edit a file.`;
    case "read":
    case "search":
      return `${agent} wants to read files.`;
    case "fetch":
      return `${agent} wants to fetch from the web.`;
  }
  return `${agent} wants to use a tool.`;
}

/** A failed turn's error as a short category, never the raw message. */
export function failureKind(error: string): string {
  const e = error.toLowerCase();
  if (/rate.?limit|429|usage limit|quota/.test(e)) return "rate limited";
  if (/overload|529|capacity/.test(e)) return "the service is overloaded";
  if (/not logged in|\/login|sign(ed)? in|api key|auth|401|403/.test(e)) return "not signed in";
  if (/model/.test(e) && /(not exist|not found|issue with|unknown|access|invalid)/.test(e)) return "model unavailable";
  if (/context|too long|prompt is too long|token/.test(e)) return "the conversation is too long";
  if (/network|econn|timed? ?out|socket|connection/.test(e)) return "connection problem";
  if (/stopped|exited|killed|crash/.test(e)) return "the agent stopped unexpectedly";
  return "an error";
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

  /**
   * A session's title as a push says it (pushTitle: the folder and the agent). A subagent is
   * "<folder> · <agent> · a subagent": its own title is model-written from its task.
   */
  title(id: string): string {
    const s = this.ctx.session(id)?.summary;
    if (!s) return "Tether";
    const title = pushTitle(s.projectPath, agentOf(id));
    return s.parentSessionId ? `${title} · a subagent` : title;
  }

  async request(r: Request) {
    const look = this.ctx.session(r.sessionId);
    if (!look?.requests.includes(r.id)) return;
    const root = look.summary.parentSessionId;
    await this.notify({ kind: "request", sessionId: r.sessionId, title: this.title(r.sessionId), body: requestBody(r, agentOf(r.sessionId), parseSessionId(r.sessionId)?.harness), tag: `req-${r.id}` }, root ? [root] : []);
  }

  async attention(sessionId: string, _message?: string) {
    await this.notify({ kind: "request", sessionId, title: this.title(sessionId), body: `${agentOf(sessionId)} needs you in the terminal.`, tag: `att-${sessionId}` });
  }

  async turnEnded(sessionId: string, error?: string) {
    const look = this.ctx.session(sessionId);
    if (!look || look.summary.parentSessionId) return;
    // The queue sent the next message, or the session waits on a request (that notifies itself).
    if (look.status !== "idle" || look.requests.length) return;
    // Why it needs you, not what the agent said (lock screens show notifications).
    if (error) await this.notify({ kind: "failed", sessionId, title: this.title(sessionId), body: `Failed: ${failureKind(error)}.`, tag: `end-${sessionId}` });
    else await this.notify({ kind: "finished", sessionId, title: this.title(sessionId), body: `Finished.`, tag: `end-${sessionId}` });
  }
}

export const pushModule: Module = {
  name: "push",
  start(ctx) {
    const store = new SubscriptionStore(join(ctx.dataDir, "push.json"));
    const sender = new PushSender(ctx.appUrl, ctx.log, (e) => endpointProblem(e, DEV), DEV);
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
    ctx.ops.register("pushSubscribe", async (a) => {
      const sub = a.subscription as any;
      const endpoint = str(sub?.endpoint, "subscription.endpoint");
      const problem = await endpointProblem(endpoint, DEV);
      if (problem) throw new Error(problem);
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
