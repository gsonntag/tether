// Runners as the browser shows them. The server lists only connected runners, and only those the
// signed-in person may see. The browser remembers the ones they own, so one that drops off shows as
// disconnected, not gone. A runner shared with them isn't remembered: the server can't say whether
// one that left the list went offline or was unshared, so it just goes (it can't be used offline).

import type { RunnerInfo } from "../../shared/protocol";

export interface KnownRunner extends RunnerInfo {
  online: boolean;
  /** when this browser last saw it connected */
  lastSeen: number;
}

/** Folds the server's current list into what we knew: listed runners are online, owned ones that aren't offline, shared ones that aren't gone. */
export function mergeRunners(known: KnownRunner[], online: RunnerInfo[], now: number): KnownRunner[] {
  const byId = new Map(known.filter((r) => accessOf(r) === "manage").map((r) => [r.id, { ...r, online: false }]));
  for (const r of online) byId.set(r.id, { ...r, online: true, lastSeen: now });
  return sortRunners([...byId.values()]);
}

/** Whether the runner takes `pinSession` (RunnerInfo.pinning): pin buttons show only then. */
export const canPin = (runners: RunnerInfo[], runnerId: string) => !!runners.find((r) => r.id === runnerId)?.pinning;

/** Whether the runner takes `listWorktrees` and `existingWorktreeSession` (RunnerInfo.existingWorktrees): New session's "Existing worktree" shows only then. */
export const canJoinWorktree = (runners: RunnerInfo[], runnerId: string) => !!runners.find((r) => r.id === runnerId)?.existingWorktrees;

/** Connected first, then by name. */
export function sortRunners(list: KnownRunner[]): KnownRunner[] {
  const label = (r: KnownRunner) => r.name || r.id;
  return [...list].sort((a, b) => Number(b.online) - Number(a.online) || label(a).localeCompare(label(b)) || a.id.localeCompare(b.id));
}

/** Runners whose connection is new since `before`: they need fresh subscriptions. */
export function reconnected(before: KnownRunner[], after: KnownRunner[]): string[] {
  const prev = new Map(before.map((r) => [r.id, r]));
  return after.filter((r) => r.online && (!prev.get(r.id)?.online || prev.get(r.id)?.connectedAt !== r.connectedAt)).map((r) => r.id);
}

/**
 * Why texting is down, when one of your runners is the texting hub (SPEC §11 Texting) and none can
 * text now: the hub is offline (as last seen), or can't reach its messaging app. Undefined when a
 * hub can text, or none was ever seen.
 */
export function textingDown(runners: KnownRunner[]): string | undefined {
  const hubs = runners.filter((r) => r.textingHub && accessOf(r) === "manage");
  if (!hubs.length || hubs.some((r) => r.online && r.textingHub!.up)) return undefined;
  const h = hubs.find((r) => r.online) ?? [...hubs].sort((a, b) => b.lastSeen - a.lastSeen)[0]!;
  const name = h.name || h.id;
  return h.online ? `Texting is unavailable: ${name} can't reach its messaging app.` : `Texting is unavailable: ${name} is offline.`;
}

/** What you may do on a runner (shared/access.ts): absent from the server means you own it. */
export const accessOf = (r: Pick<RunnerInfo, "access"> | undefined): "manage" | "drive" | "view" => r?.access ?? "manage";

/** This browser's runners, kept with whose they are (SPEC §3, Sharing runners). The old unkeyed list goes. */
const STORE_KEY = "tether.runners.v2";
const OLD_KEY = "tether.runners";

/**
 * The runners remembered for `email`, offline until the server lists them; none for anyone else, so
 * a browser one person used shows another nothing of theirs.
 */
export function loadKnown(email: string | undefined): KnownRunner[] {
  try {
    localStorage.removeItem(OLD_KEY);
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) ?? "null");
    if (!email || !saved || saved.email !== email || !Array.isArray(saved.runners)) return [];
    return sortRunners(saved.runners.filter((r: KnownRunner) => accessOf(r) === "manage").map((r: KnownRunner) => ({ ...r, online: false })));
  } catch {
    return [];
  }
}

/** Keeps the owned runners for `email`; shared ones aren't kept. */
export function saveKnown(list: KnownRunner[], email: string | undefined) {
  if (!email) return;
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ email, runners: list.filter((r) => accessOf(r) === "manage") }));
  } catch {
    // private mode or full storage: we just won't remember offline runners across reloads
  }
}

/** "just now", "5 min ago", "3 h ago", "2 days ago" */
export function ago(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} days ago`;
}
