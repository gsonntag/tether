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
 * there's one (fresher), else what the op said.
 */
export function spawnedRows(family: SpawnedFamily | undefined, summaries: Record<string, SummaryState>, runnerId: string): Row[] {
  const live = summaries[runnerId]?.sessions ?? {};
  return (family?.children ?? []).map((c) => {
    const s = live[c.id] ?? c;
    return { ...s, status: shownStatus(s), runnerId, spawned: true };
  });
}

/** Subagents and started sessions together, newest first, one row each. */
export const withSpawned = (subagents: Row[], spawned: Row[]): Row[] => mergeRows(subagents, spawned);

/** Running first, then the most recent. */
export const byChildOrder = (children: Row[]) => [...children].sort((a, b) => Number(b.status !== "idle") - Number(a.status !== "idle") || b.updatedAt - a.updatedAt);

/** The rows shown before "N more": the first `limit` (running first), and the open one always. */
export function fewChildren(children: Row[], selectedId: string | undefined, limit: number): { few: Row[]; rest: number } {
  const sorted = byChildOrder(children);
  const few = sorted.slice(0, limit);
  const open = selectedId !== undefined ? sorted.find((c) => c.id === selectedId) : undefined;
  if (open && !few.includes(open)) few.push(open);
  return { few, rest: children.length - few.length };
}

/**
 * Whether the section shows its rows: as toggled for this session (`toggled`), else as this device
 * keeps it, and always when the open session is one of them (its row stays in view).
 */
export function childrenOpen(saved: boolean, children: Row[], selectedId: string | undefined, toggled?: boolean): boolean {
  if (toggled !== undefined) return toggled;
  return saved || (selectedId !== undefined && children.some((c) => c.id === selectedId));
}

/** The toggle row's words: "3 subagents", with how many run. */
export function childrenToggle(children: Row[]): { label: string; running: number } {
  const n = children.length;
  const running = children.filter((c) => c.status !== "idle").length;
  return { label: `${n} subagent${n === 1 ? "" : "s"}${running ? ` · ${running} running` : ""}`, running };
}
