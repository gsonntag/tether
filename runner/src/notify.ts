// Notifications: when an agent has a question, finishes, or is blocked, the runner pushes it to
// every device that turned notifications on (Web Push), so they arrive with no tab open. The
// runner, not the app, sends them: it is always on and sees every session, and the app stays a
// stateless relay. Each runner has its own VAPID key; browsers subscribe to each runner
// separately (one service-worker scope per runner). Recent notifications are kept for the bell.

import webpush from "web-push";
import { basename } from "node:path";
import type { AgentNotice, NotifyKind } from "../../web/src/shared/protocol";
import { config, saveConfig, saveConfigSoon } from "./config";

export interface PushSub {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  kinds: NotifyKind[];
  /** device description, for the settings list */
  label?: string;
  addedAt: number;
}

const RECENT_MAX = 100;
/** The same notice (session, kind, heading) again within this window is dropped. */
const THROTTLE_MS: Record<NotifyKind, number> = { question: 0, finished: 0, blocked: 2 * 60_000 };

function store() {
  const c = config();
  c.push ??= { subs: [], recent: [] };
  if (!c.push.vapid) {
    c.push.vapid = webpush.generateVAPIDKeys();
    saveConfig();
  }
  return c.push as Required<NonNullable<typeof c.push>>;
}

export function vapidPublicKey(): string {
  return store().vapid.publicKey;
}

export function subscription(endpoint: string): PushSub | undefined {
  return store().subs.find((s) => s.endpoint === endpoint);
}

export function subscribe(sub: Omit<PushSub, "addedAt">) {
  const st = store();
  st.subs = st.subs.filter((s) => s.endpoint !== sub.endpoint);
  st.subs.push({ ...sub, addedAt: Date.now() });
  saveConfig();
}

export function unsubscribe(endpoint: string) {
  const st = store();
  st.subs = st.subs.filter((s) => s.endpoint !== endpoint);
  saveConfig();
}

export function recent(): AgentNotice[] {
  return store().recent;
}

const last = new Map<string, number>();

/** Records a notice and pushes it to the devices that want this kind. */
export function notify(n: Omit<AgentNotice, "id" | "ts" | "project">): AgentNotice | undefined {
  const key = `${n.sessionId}:${n.kind}:${n.title}`;
  const now = Date.now();
  if (now - (last.get(key) ?? 0) < THROTTLE_MS[n.kind]) return undefined;
  last.set(key, now);
  const st = store();
  const notice: AgentNotice = { ...n, id: crypto.randomUUID(), ts: now, project: basename(n.projectPath) };
  st.recent = [notice, ...st.recent].slice(0, RECENT_MAX);
  saveConfigSoon();
  for (const sub of st.subs) if (sub.kinds.includes(n.kind)) void send(sub, notice);
  return notice;
}

/** A test notification to one device. */
export async function sendTest(endpoint: string) {
  const sub = subscription(endpoint);
  if (!sub) throw new Error("This device isn't subscribed on this runner.");
  await send(sub, {
    id: crypto.randomUUID(),
    kind: "finished",
    title: "Tether notifications work",
    body: "You'll hear from your agents here.",
    sessionId: "",
    projectPath: "",
    project: "",
    ts: Date.now(),
  }, true);
}

async function send(sub: PushSub, n: AgentNotice, throwErrors = false) {
  const st = store();
  const payload = JSON.stringify({ ...n, runnerId: config().runnerId });
  try {
    await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, payload, {
      vapidDetails: { subject: "mailto:tether@localhost", publicKey: st.vapid.publicKey, privateKey: st.vapid.privateKey },
      TTL: 24 * 3600,
      urgency: n.kind === "finished" ? "normal" : "high",
      // A newer "finished"/"blocked" for a session replaces an undelivered one; questions all arrive.
      topic: n.sessionId && n.kind !== "question" ? topicOf(n.kind + n.sessionId) : undefined,
    });
  } catch (e: any) {
    // Gone: the browser dropped the subscription (unsubscribed, cleared data, uninstalled).
    if (e?.statusCode === 404 || e?.statusCode === 410) unsubscribe(sub.endpoint);
    else console.error(`push to ${new URL(sub.endpoint).host} failed: ${e?.statusCode ?? ""} ${e?.body ?? e?.message ?? e}`);
    if (throwErrors) throw new Error(`Push failed: ${e?.statusCode ?? ""} ${e?.body ?? e?.message ?? e}`.trim());
  }
}

/** Push services replace an undelivered message with the same topic (≤32 url-safe chars). */
function topicOf(key: string) {
  let h = 0;
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) | 0;
  return `s${(h >>> 0).toString(36)}`;
}
