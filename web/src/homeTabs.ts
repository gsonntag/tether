// The Home agent's tabs (HomeChat.tsx): the runner keeps which chats are open (HomeChatUpdate.chats);
// which one this device shows is kept here, per runner. NEW is a tab with no chat yet: its first
// message starts one.

import type { HomeChatUpdate } from "../../shared/protocol";
import type { SessionSummary } from "../../shared/transcript";
import { fromTether, fromTexted } from "../../shared/fromTether";

export const NEW = "new";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const local = (): Store | undefined => (typeof localStorage === "undefined" ? undefined : localStorage);
const key = (runnerId: string) => `tether.homeTab.${runnerId}`;

export function loadTab(runnerId: string, s: Store | undefined = local()): string | undefined {
  try {
    return s?.getItem(key(runnerId)) ?? undefined;
  } catch {
    return undefined;
  }
}

export function saveTab(runnerId: string, tab: string, s: Store | undefined = local()) {
  try {
    s?.setItem(key(runnerId), tab);
  } catch {}
}

/** The open chats: the runner's tabs, or (a runner from before tabs) its one current chat. */
export const tabsOf = (u: { sessionId?: string; chats?: string[] } | undefined): string[] => u?.chats ?? (u?.sessionId ? [u.sessionId] : []);

/**
 * The tab this device shows: the one it picked, while that's open; else the runner's current one
 * (where the person last wrote); else the newest; else a new one.
 */
export function pickTab(chats: string[], picked: string | undefined, current: string | undefined): string {
  if (picked === NEW) return NEW;
  if (picked && chats.includes(picked)) return picked;
  if (current && chats.includes(current)) return current;
  return chats.at(-1) ?? NEW;
}

/** The tab shown after closing `closed`: the one to its right, else to its left, else a new one. */
export function afterClose(chats: string[], closed: string): string {
  const i = chats.indexOf(closed);
  const left = chats.filter((c) => c !== closed);
  if (i < 0) return left.at(-1) ?? NEW;
  return left[i] ?? left[i - 1] ?? NEW;
}

/** A tab's name: its chat's title (the first message, or as renamed), on one line. */
export function tabLabel(title: string | undefined): string {
  const t = (title ? (fromTether(title) ?? fromTexted(title)?.text ?? title) : "").replace(/\s+/g, " ").trim();
  // A session's name before its first message gives it one.
  return t && t !== "Untitled" && t !== "New session" ? t : "New chat";
}

/** What a tab's marker shows: working (a turn runs, or it waits for the person), or a reply nobody has read. */
export function tabMark(s: Pick<SessionSummary, "status" | "requests" | "unread"> | undefined, shown: boolean): "running" | "waiting" | "unread" | "failed" | undefined {
  if (!s) return undefined;
  if ((s.requests ?? 0) > 0 || s.status === "waiting") return "waiting";
  if (s.status === "running") return "running";
  if (!shown && s.unread) return s.unread === "failed" ? "failed" : "unread";
  return undefined;
}

/**
 * A tab's home name, matching the texts (runner/src/modules/homeLine.ts homeLabel): its place, "h"
 * for the first tab, "h1", "h2", … for the next; undefined from a runner from before homes.
 */
export function homeTag(labels: Record<string, number> | undefined, id: string): string | undefined {
  const n = labels?.[id];
  if (n === undefined) return undefined;
  return n === 0 ? "h" : `h${n}`;
}

/**
 * The home numbers after a tab change made here, before the runner's broadcast says: the tabs
 * renumbered by place (the first h). Undefined (the runner's to say) unless the labels were by place
 * already: a runner from before renumbering kept each tab's number.
 */
export function renumber(labels: Record<string, number> | undefined, before: string[], after: string[]): Record<string, number> | undefined {
  if (!labels || !before.every((c, i) => labels[c] === i)) return undefined;
  return Object.fromEntries(after.map((c, i) => [c, i]));
}

/** At most this many Home tabs besides h (runner/src/modules/homeLine.ts MAX_EXTRA_HOMES). */
export const MAX_EXTRA_HOMES = 9;

/** Whether there's room for another Home tab. */
export const homesFull = (labels: Record<string, number> | undefined) => Object.values(labels ?? {}).filter((n) => n !== 0).length >= MAX_EXTRA_HOMES;

/** The name the next new Home tab will get: the lowest number no open tab has (after the last; h with none). */
export function nextHomeTag(labels: Record<string, number> | undefined): string {
  const used = new Set(Object.values(labels ?? {}));
  let n = 0;
  while (used.has(n)) n++;
  return n === 0 ? "h" : `h${n}`;
}

/**
 * What a runner's Home tabs become with update `u`, or undefined to keep them: a newer rev replaces
 * them; the same rev only fills in what's missing (the tabs, asked for after a broadcast that came
 * without them; the home labels, which a tab change made here doesn't know). Labels a newer update
 * leaves out are kept for the tabs still open.
 */
export function mergeHomeChat(cur: HomeChatUpdate | undefined, u: HomeChatUpdate): HomeChatUpdate | undefined {
  if (cur && cur.rev > u.rev) return undefined;
  if (cur && cur.rev === u.rev) {
    const chats = cur.chats ?? u.chats;
    const labels = u.labels ?? cur.labels;
    if (chats === cur.chats && labels === cur.labels) return undefined;
    return { ...cur, ...(chats ? { chats } : {}), ...(labels ? { labels } : {}) };
  }
  const kept = u.labels ?? (cur?.labels && u.chats ? Object.fromEntries(Object.entries(cur.labels).filter(([c]) => u.chats!.includes(c))) : cur?.labels);
  return { rev: u.rev, ...(u.sessionId ? { sessionId: u.sessionId } : {}), ...(u.chats ? { chats: u.chats } : {}), ...(kept ? { labels: kept } : {}) };
}
