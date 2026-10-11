// Notifications: when an agent has a question, finishes, or is blocked, the runner pushes it to
// every device that turned notifications on (Web Push), so they arrive with no tab open. The
// runner, not the app, sends them: it is always on and sees every session, and the app stays a
// stateless relay. Each runner has its own VAPID key; browsers subscribe to each runner
// separately (one service-worker scope per runner). Recent notifications are kept for the bell.

import webpush from "web-push";
import { basename } from "node:path";
import { NOTIFY_KINDS, type AgentNotice, type MemoryConflict, type NotifyKind } from "../../web/src/shared/protocol";
import { config, saveConfig, saveConfigSoon } from "./config";

export interface PushSub {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  kinds: NotifyKind[];
  /** kinds this device has been asked about (absent: subscribed before kinds were recorded) */
  offered?: NotifyKind[];
  /** device description, for the settings list */
  label?: string;
  addedAt: number;
}

const RECENT_MAX = 100;
/** The same notice (session, kind, heading) again within this window is dropped. */
const THROTTLE_MS: Record<NotifyKind, number> = { question: 0, finished: 0, blocked: 2 * 60_000, memory: 0 };

const ALL_KINDS: NotifyKind[] = NOTIFY_KINDS.map((k) => k.id);
/** What every device was offered before `offered` was recorded. */
const LEGACY_KINDS: NotifyKind[] = ["question", "finished", "blocked"];
/** Kinds added later that devices subscribed before them get switched on for (once). */
const DEFAULT_ON: NotifyKind[] = ["memory"];

/**
 * Devices subscribed before a kind existed get the default-on ones added, once: `offered` records
 * that they have seen it, so turning it off afterwards sticks. True when anything changed.
 */
export function migrateSubs(subs: PushSub[]): boolean {
  let changed = false;
  for (const s of subs) {
    const offered = s.offered ?? LEGACY_KINDS;
    const fresh = ALL_KINDS.filter((k) => !offered.includes(k));
    if (s.offered && !fresh.length) continue;
    // A device with every kind switched off stays that way.
    if (s.kinds.length) for (const k of fresh) if (DEFAULT_ON.includes(k) && !s.kinds.includes(k)) s.kinds.push(k);
    s.offered = [...ALL_KINDS];
    changed = true;
  }
  return changed;
}

let migrated = false;

function store() {
  const c = config();
  c.push ??= { subs: [], recent: [] };
  if (!c.push.vapid) {
    c.push.vapid = webpush.generateVAPIDKeys();
    saveConfig();
  }
  if (!migrated) {
    migrated = true;
    if (migrateSubs(c.push.subs)) saveConfig();
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
  st.subs.push({ ...sub, offered: [...ALL_KINDS], addedAt: Date.now() });
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

/** Drops a removed session's notices, so it doesn't come back as needing you. */
export function forgetSession(sessionId: string) {
  const st = store();
  st.recent = st.recent.filter((n) => n.sessionId !== sessionId);
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
      vapidDetails: { subject: pushSubject(), publicKey: st.vapid.publicKey, privateKey: st.vapid.privateKey },
      TTL: 24 * 3600,
      urgency: n.kind === "finished" || n.kind === "memory" ? "normal" : "high",
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

/**
 * The VAPID `sub` claim. Apple's push service rejects a `localhost` address (403 BadJwtToken)
 * where others don't, so use the app's own https URL; TETHER_PUSH_SUBJECT overrides it.
 */
export function pushSubject(env: Record<string, string | undefined> = process.env): string {
  if (env.TETHER_PUSH_SUBJECT) return env.TETHER_PUSH_SUBJECT;
  try {
    const u = new URL(env.TETHER_URL ?? "");
    if (u.protocol === "https:" && u.hostname !== "localhost") return u.origin;
  } catch {}
  return "mailto:tether@example.com";
}

/** Push services replace an undelivered message with the same topic (≤32 url-safe chars). */
function topicOf(key: string) {
  let h = 0;
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) | 0;
  return `s${(h >>> 0).toString(36)}`;
}

// ---- memory conflicts (runner/src/context: the merge pass kept the newest of two claims) ----

/** One line of at most `max` chars, ending in "." or "…". */
const sentence = (s: string, max: number) => {
  const t = s.replace(/\s+/g, " ").trim().replace(/[.\s]+$/, "");
  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t + ".";
};

/** Title and body for the conflicts one merge pass (or one throttle window) raised. */
export function conflictNotice(list: MemoryConflict[]): Pick<AgentNotice, "title" | "body" | "conflictId"> {
  const sorted = [...list].sort((a, b) => b.ts - a.ts);
  const newest = sorted[0]!;
  if (sorted.length === 1) {
    const claim = newest.newClaim?.trim() || newest.newBody.split("\n").find((l) => l.trim()) || newest.newBody;
    return {
      title: `Memory conflict · ${newest.name}`.slice(0, 120),
      body: `Kept the newest: ${sentence(claim, 100)} Tap to review.`,
      conflictId: newest.id,
    };
  }
  const names = [...new Set(sorted.map((c) => c.name))];
  const shown = names.length > 3 ? `${names.slice(0, 3).join(", ")} and ${names.length - 3} more` : names.join(", ");
  return {
    title: `${sorted.length} memory conflicts`,
    body: `${sentence(`Kept the newest each time: ${shown}`, 200)} Tap to review.`,
    conflictId: newest.id,
  };
}

/**
 * Batches memory-conflict notifications: what one merge pass raised goes out as one, and for
 * `windowMs` after a notification, new conflicts wait and go out together when the window ends.
 * Conflicts resolved by then (or already resolved when they arrive) are left out.
 */
export class ConflictNotifier {
  private pending = new Map<string, MemoryConflict>();
  private lastAt = -Infinity;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    private o: {
      windowMs: number;
      isOpen: (id: string) => boolean;
      send: (list: MemoryConflict[]) => void;
      now?: () => number;
    },
  ) {}

  private now() {
    return this.o.now?.() ?? Date.now();
  }

  /** One merge pass's conflicts. */
  add(list: MemoryConflict[]) {
    for (const c of list) if (c.status === "open") this.pending.set(c.id, c);
    if (!this.pending.size || this.timer) return;
    const wait = this.lastAt + this.o.windowMs - this.now();
    if (wait <= 0) this.flush();
    else this.timer = setTimeout(() => this.flush(), wait);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    const list = [...this.pending.values()].filter((c) => this.o.isOpen(c.id));
    this.pending.clear();
    if (!list.length) return;
    this.lastAt = this.now();
    this.o.send(list);
  }
}

/** Pushes a batch of memory conflicts. No session: it links to the Memory page instead. */
export function notifyConflicts(list: MemoryConflict[]) {
  return notify({ kind: "memory", ...conflictNotice(list), sessionId: "", projectPath: "" });
}
