// Runners as the browser shows them. The server lists only connected runners; the browser
// remembers the ones it has seen so a runner that drops off shows as disconnected, not gone.

import type { RunnerInfo } from "../../shared/protocol";

export interface KnownRunner extends RunnerInfo {
  online: boolean;
  /** when this browser last saw it connected */
  lastSeen: number;
}

/** Folds the server's current list into what we knew: listed runners are online, the rest offline. */
export function mergeRunners(known: KnownRunner[], online: RunnerInfo[], now: number): KnownRunner[] {
  const byId = new Map(known.map((r) => [r.id, { ...r, online: false }]));
  for (const r of online) byId.set(r.id, { ...r, online: true, lastSeen: now });
  return sortRunners([...byId.values()]);
}

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

const STORE_KEY = "tether.runners";

export function loadKnown(): KnownRunner[] {
  try {
    const list = JSON.parse(localStorage.getItem(STORE_KEY) ?? "[]");
    return Array.isArray(list) ? sortRunners(list.map((r: KnownRunner) => ({ ...r, online: false }))) : [];
  } catch {
    return [];
  }
}

export function saveKnown(list: KnownRunner[]) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(list));
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
