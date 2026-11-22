// Pure helpers for filtering sidebar sessions and projects by runner (SPEC issue #142).

import type { ProjectInfo } from "../../shared/transcript";
import type { Row } from "./sessionList";

export const RUNNER_FILTER_KEY = "tether.runnerFilter";

export function loadRunnerFilter(store?: Storage): string | undefined {
  try {
    return (store ?? (typeof localStorage === "undefined" ? undefined : localStorage))?.getItem(RUNNER_FILTER_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function saveRunnerFilter(runnerId?: string, store?: Storage) {
  try {
    const s = store ?? (typeof localStorage === "undefined" ? undefined : localStorage);
    if (!runnerId) s?.removeItem(RUNNER_FILTER_KEY);
    else s?.setItem(RUNNER_FILTER_KEY, runnerId);
  } catch {}
}

/**
 * Returns the active runner filter id, or undefined for "All runners".
 * Falls back to undefined if only one runner is online, or if the chosen runner is gone or offline.
 */
export function activeRunnerFilter(chosen: string | undefined, online: { id: string }[]): string | undefined {
  if (online.length <= 1) return undefined;
  return chosen && online.some((r) => r.id === chosen) ? chosen : undefined;
}

/** Filters a row list by runner id (returns original list if runnerId is undefined). */
export function filterRowsByRunner(rows: Row[], runnerId?: string): Row[] {
  return runnerId ? rows.filter((r) => r.runnerId === runnerId) : rows;
}

/**
 * Aggregates projects across runners, or for a single filtered runner.
 * Sorts by updatedAt newest first.
 */
export function aggregateProjects(projectsBy: Record<string, ProjectInfo[]>, runnerFilter?: string): (ProjectInfo & { runnerIds: string[] })[] {
  const by = new Map<string, ProjectInfo & { runnerIds: string[] }>();
  for (const [runnerId, list] of Object.entries(projectsBy)) {
    if (runnerFilter && runnerId !== runnerFilter) continue;
    for (const p of list) {
      const had = by.get(p.path);
      by.set(p.path, had ? { ...had, sessions: had.sessions + p.sessions, updatedAt: Math.max(had.updatedAt, p.updatedAt), runnerIds: [...had.runnerIds, runnerId] } : { ...p, runnerIds: [runnerId] });
    }
  }
  return [...by.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}
