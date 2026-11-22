// The rows under the open session in the Sidebar (SPEC §6a): its subagents and the sessions its
// agent started with tether_start (the peers module's spawnedFamily op), behind one toggle row that
// remembers, per device, whether it's open.

import type { SpawnedFamily } from "../../shared/protocol";
import { mergeRows, shownStatus, type Row } from "./sessionList";
import type { SummaryState } from "../../shared/summary";

const KEY = "tether.subagentsOpen";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const local = (): Store | undefined => (typeof localStorage === "undefined" ? undefined : localStorage);

/** Whether the section is open on this device: closed unless opened here. */
export function loadChildrenOpen(s: Store | undefined = local()): boolean {
  try {
    return s?.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function saveChildrenOpen(on: boolean, s: Store | undefined = local()) {
  try {
    if (on) s?.setItem(KEY, "1");
    else s?.removeItem(KEY);
  } catch {}
}

/**
 * The sessions a session's agent started, as rows (marked `spawned`): the broadcast summary where
 * there's one (fresher), else what the op said. One the summary says is archived (its starter done
 * with it, tether_archive) is left out before the op is asked again.
 */
export function spawnedRows(family: SpawnedFamily | undefined, summaries: Record<string, SummaryState>, runnerId: string): Row[] {
  const live = summaries[runnerId]?.sessions ?? {};
  return (family?.children ?? []).flatMap((c) => {
    const s = live[c.id] ?? c;
    return s.archived ? [] : [{ ...s, status: shownStatus(s), runnerId, spawned: true }];
  });
}

/** Subagents and started sessions together, newest first, one row each. */
export const withSpawned = (subagents: Row[], spawned: Row[]): Row[] => mergeRows(subagents, spawned);

/** Running first, then the most recent. */
export const byChildOrder = (children: Row[]) => [...children].sort((a, b) => Number(b.status !== "idle") - Number(a.status !== "idle") || b.updatedAt - a.updatedAt);

/** The rows shown before "N more": the first `limit` (running first), and the open one always; the rest. */
export function fewChildren(children: Row[], selectedId: string | undefined, limit: number): { few: Row[]; rest: Row[] } {
  const sorted = byChildOrder(children);
  const few = sorted.slice(0, limit);
  const open = selectedId !== undefined ? sorted.find((c) => c.id === selectedId) : undefined;
  if (open && !few.includes(open)) few.push(open);
  return { few, rest: sorted.filter((c) => !few.includes(c)) };
}

/** Each kind counted: "2 subagents · 3 started", "3 subagents", "3 started". */
function kinds(rows: Row[]): { subagents: string; started: string } {
  const started = rows.filter((c) => c.spawned).length;
  const subagents = rows.length - started;
  return { subagents: subagents ? `${subagents} subagent${subagents === 1 ? "" : "s"}` : "", started: started ? `${started} started` : "" };
}
export function kindCount(rows: Row[]): string {
  const k = kinds(rows);
  return [k.subagents, k.started].filter(Boolean).join(" · ");
}

/** The "N more" button: "5 more subagents", "2 more started", "4 more: 2 subagents · 2 started". */
export function moreLabel(rest: Row[]): string {
  const k = kinds(rest);
  if (k.subagents && k.started) return `${rest.length} more: ${k.subagents} · ${k.started}`;
  return `${rest.length} more ${k.subagents ? k.subagents.replace(/^\d+ /, "") : "started"}`;
}

/**
 * What a cached spawnedFamily answer was for: the session's status, and each of its family's
 * status and archived mark from the summaries ("-": not in them, as an archived one leaves). A
 * change to any of them asks again.
 */
export function familyKey(summaries: Record<string, SummaryState>, runnerId: string, sessionId: string, f: SpawnedFamily | undefined): string {
  const live = summaries[runnerId]?.sessions ?? {};
  const one = (id: string) => {
    const s = live[id];
    return `${id}:${s ? `${s.status}${s.archived ? ":a" : ""}` : "-"}`;
  };
  return [one(sessionId), ...(f?.parent ? [one(f.parent.id)] : []), ...(f?.children ?? []).map((c) => one(c.id))].join(",");
}

/** The runner's main sessions (where a started one shows up first): one not seen at the last answer asks again. */
export function mainIds(summaries: Record<string, SummaryState>, runnerId: string): string[] {
  return Object.values(summaries[runnerId]?.sessions ?? {})
    .filter((s) => !s.parentSessionId && !s.sideOf)
    .map((s) => s.id);
}

/**
 * Whether the section shows its rows: as toggled for this session (`toggled`), else as this device
 * keeps it, and always when the open session is one of them (its row stays in view).
 */
export function childrenOpen(saved: boolean, children: Row[], selectedId: string | undefined, toggled?: boolean): boolean {
  if (toggled !== undefined) return toggled;
  return saved || (selectedId !== undefined && children.some((c) => c.id === selectedId));
}

/** The toggle row: its words ("2 subagents · 1 started"), how many run (a dot and the count beside them), and all of it said. */
export function childrenToggle(children: Row[]): { label: string; running: number; said: string } {
  const running = children.filter((c) => c.status !== "idle").length;
  const label = kindCount(children);
  return { label, running, said: `${label}${running ? ` · ${running} running` : ""}` };
}
