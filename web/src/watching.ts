// How a session's watchers show (shared/watchers.ts): its turn ended, but something it left running
// will wake it, so it reads as watching rather than finished.

import type { Watcher, WatchingSummary } from "../../shared/watchers";
import { watcherText } from "../../shared/watchers";
import { whenLabel } from "./schedule";

/** The row's chip: "Watching", "Watching · wakes at 11:40 PM". */
export function watchingChip(w: WatchingSummary, now: number, locale?: string): string {
  return w.at !== undefined && w.at > now ? `Watching · wakes ${whenLabel(w.at, now, locale)}` : "Watching";
}

/** The chip's tooltip: what it waits on. */
export function watchingTitle(w: WatchingSummary): string {
  return `Waiting on ${w.n === 1 ? "" : `${w.n} things, first: `}${w.label}. Its turn ended; this will wake it.`;
}

/** The session view's line: "Watching 2 background tasks: “replication progress.log” and 1 more · next wake at 11:40 PM". */
export function watchingLine(list: Watcher[], now: number, locale?: string): string {
  const first = list[0]!;
  const what = first.kind === "wakeup" ? "a scheduled wakeup" : first.kind === "monitor" ? "a monitor" : first.kind === "workflow" ? "a workflow" : first.kind === "shell" ? "a background command" : "a background task";
  const label = first.label && first.kind !== "wakeup" ? `: “${first.label.length > 90 ? `${first.label.slice(0, 89)}…` : first.label}”` : "";
  const by = first.by ? ` (subagent “${first.by}”)` : "";
  const more = list.length > 1 ? ` and ${list.length - 1} more` : "";
  const at = list.map((w) => w.at).filter((t): t is number => t !== undefined && t > now).sort((a, b) => a - b)[0];
  return `Watching ${what}${label}${by}${more}${at !== undefined ? ` · next wake ${whenLabel(at, now, locale)}` : ""}. It wakes when that reports.`;
}

/** Every watcher in words, one per line (the line's tooltip). */
export const watchingDetail = (list: Watcher[]) => list.map(watcherText).join("\n");
