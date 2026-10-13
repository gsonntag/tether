// What a session has going on (subagents, shells, …): the strip above the message box and the history panel read it.

import type { ActivityItem, LiveState } from "./shared/protocol";

/** The session's activity; older runners only send a flat list of background tasks. */
export function activityOf(state: LiveState | undefined): ActivityItem[] {
  if (!state) return [];
  if (state.activity) return state.activity;
  return (state.background ?? []).map((b) => ({
    id: b.id,
    // `type` was the task type, or a subagent's agent type ("general-purpose")
    kind: b.type === "local_bash" ? "shell" : b.type && (b.type === "local_agent" || !b.type.startsWith("local_")) ? "subagent" : "other",
    title: b.description,
    status: "running",
    startedAt: Date.now(),
  }));
}

// ---------- the live strip above the message box, and the history panel ----------

/** Rows the strip shows before "N more". */
export const STRIP_ROWS = 4;

/** What it's doing right now, in one line: a shell's last output line, else the latest action. */
export function nowLine(a: ActivityItem): string | undefined {
  const out = a.output
    ?.split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1);
  if ((a.kind === "shell" || a.kind === "monitor") && out) return out;
  return a.latest ?? a.steps?.at(-1)?.label ?? out ?? a.command ?? a.watching;
}

/**
 * Where a workflow is: the phase it's on (the first one going; else the first not done yet) and
 * its place, or undefined when the harness sent no phases or every phase is over.
 */
export function currentPhase(a: ActivityItem): { index: number; total: number; title: string; detail?: string } | undefined {
  const ph = a.phases;
  if (!ph?.length) return undefined;
  let i = ph.findIndex((p) => p.status === "running");
  if (i < 0) i = ph.findIndex((p) => p.status === "pending");
  if (i < 0) return undefined;
  return { index: i, total: ph.length, title: ph[i]!.title, detail: ph[i]!.detail };
}

/** "Step 2 of 4 · Review" */
export function phaseLabel(a: ActivityItem): string | undefined {
  const c = currentPhase(a);
  return c ? `Step ${c.index + 1} of ${c.total} · ${c.title}` : undefined;
}

export interface StripRow {
  item: ActivityItem;
  /** 0: on its own; 1+: started by the row above (a workflow's or subagent's own work) */
  depth: number;
}

/**
 * The strip: everything running (a long main-thread tool call excepted, the transcript shows it),
 * children right under their parent; armed wakeups and cron jobs apart, for one quiet line.
 */
export function stripModel(items: ActivityItem[]): { rows: StripRow[]; waiting: ActivityItem[] } {
  const live = items.filter((a) => a.status === "running" && a.kind !== "tool");
  const ids = new Set(live.map((a) => a.id));
  const rows: StripRow[] = [];
  const add = (a: ActivityItem, depth: number) => {
    rows.push({ item: a, depth });
    for (const c of live) if (c.parentId === a.id && c.id !== a.id) add(c, Math.min(depth + 1, 2));
  };
  for (const a of live) if (!a.parentId || !ids.has(a.parentId)) add(a, 0);
  return { rows, waiting: items.filter((a) => a.status === "waiting").sort((a, b) => (a.nextAt ?? Infinity) - (b.nextAt ?? Infinity)) };
}

/** The history panel: finished items, newest first; a workflow's or subagent's own work stays inside it. */
export function historyItems(items: ActivityItem[]): ActivityItem[] {
  const ids = new Set(items.map((a) => a.id));
  return items
    .filter((a) => (a.status === "done" || a.status === "failed" || a.status === "stopped") && !(a.parentId && ids.has(a.parentId)))
    .sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt));
}

/** An item's own children (a workflow's agents, a subagent's shells), by phase when it has phases. */
export function childrenOf(items: ActivityItem[], id: string): ActivityItem[] {
  return items.filter((a) => a.parentId === id && a.id !== id);
}
