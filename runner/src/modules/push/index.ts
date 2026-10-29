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
 * A harness's own short description of a shell step, when it is safe to show on a lock screen:
 * at most 60 characters, nothing that looks like a path, URL, key or secret, and nothing from the
 * command itself (no word of 5+ characters it shares with the command). Undefined otherwise.
 */
export function safeDescription(desc: unknown, command: unknown): string | undefined {
  if (typeof desc !== "string") return undefined;
  const d = desc.trim().replace(/\s+/g, " ");
  if (!d || d.length > 60 || UNSAFE.test(d)) return undefined;
  const cmd = typeof command === "string" ? command.toLowerCase() : "";
  const words = cmd.split(/[^\p{L}\p{N}_.-]+/u).filter((w) => w.length >= 5);
  const low = d.toLowerCase();
  if (cmd && (low.includes(cmd.trim()) || words.some((w) => low.includes(w)))) return undefined;
  return d;
}

/**
 * A session's title as a notification may show it: the title when it is short and safe (no path,
 * URL, host, dotfile, key, secret or command-like text), else the project folder's name and the agent
 * ("web-coder · Claude"). Codex titles are your first message verbatim; Claude's are written by the
 * model from it; `!` sessions start "[Shell command run from Tether] … $ cmd".
 */
export function safeTitle(title: string | undefined, projectPath: string, agent: string): string {
  const t = (title ?? "").trim().replace(/\s+/g, " ");
  if (t && t.length <= 60 && !UNSAFE.test(t) && !/[;&*#%^]|\bsudo\b|\brm\b|--?\w/.test(t)) return t;
  const folder = projectPath.replace(/\/+$/, "").split("/").pop() || "Tether";
  return `${folder} · ${agent}`;
}

/**
 * What a request needs, as a notification says it: never the command, a path, the file's contents
 * or the question itself (a phone may show it on its lock screen). For a shell step, the harness's
 * own short description when it is safe (Claude's Bash `description`; Codex's approval reason),
 * else a summary from what kind of request it is. Other tools (MCP among them) only by kind.
 */
export function requestBody(r: Request, agent: string, harness: string = "claude"): string {
  if (r.kind === "question") return `${agent} has a question for you.`;
  if (r.plan !== undefined) return `${agent} has a plan for you to approve.`;
  const input = (r.input ?? {}) as Record<string, unknown>;
  const shell = r.toolKind === "shell" || (!r.toolKind && (!!r.command || typeof input.command === "string"));
  if (shell) {
    const command = r.command ?? input.command;
    // Claude's `reason` is its own rule's wording ("Path is outside…"), not a step description.
    const theirs = [input.description, harness === "codex" ? r.reason : undefined].filter((x): x is string => typeof x === "string");
    const own = theirs.map((x) => safeDescription(x, command)).find(Boolean);
    if (own) return `${agent} asks to: ${own}`;
    // Not shown as is (a host, a file, …): what kind of step it is, from its words.
    // (Codex's approval reasons say what kind: "Network access to <host>", "Read the .env file".)
    const said = harness === "codex" && typeof r.reason === "string" ? r.reason : "";
    if (/network|internet|download|\bonline\b/i.test(said)) return `${agent} wants network access.`;
    if (/^\s*(read|look at|open|view|cat)\b/i.test(said)) return `${agent} wants to read a file.`;
    return `${agent} wants to run a command.`;
  }
  const files = Array.isArray(input.files) ? input.files.length : 0;
  switch (r.toolKind) {
    case "edit":
    case "write":
      return files > 1 ? `${agent} wants to edit ${files} files.` : `${agent} wants to edit a file.`;
    case "read":
    case "search":
      return `${agent} wants to read files.`;
    case "fetch":
      return `${agent} wants to fetch from the web.`;
  }
  return r.tool ? `${agent} wants to use ${short(r.tool, 40)}.` : `${agent} needs your permission.`;
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
   * A session's title as a push says it (safeTitle). A subagent is "a subagent" under its main
   * session's title: its own title is model-written from its task.
   */
  title(id: string): string {
    const s = this.ctx.session(id)?.summary;
    if (!s) return "Tether";
    const agent = agentOf(id);
    const main = s.parentSessionId ? this.ctx.session(s.parentSessionId)?.summary : undefined;
    if (s.parentSessionId) return `${main ? safeTitle(main.title, main.projectPath, agent) : safeTitle(undefined, s.projectPath, agent)} · a subagent`;
    return safeTitle(s.title, s.projectPath, agent);
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
