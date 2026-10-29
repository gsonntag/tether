// The sidebar's lists, derived from every runner's summaries.

import type { SummaryState } from "../../shared/summary";
import type { SessionSummary } from "../../shared/transcript";

export interface Row extends SessionSummary {
  runnerId: string;
}

const rows = (summaries: Record<string, SummaryState>): Row[] =>
  Object.entries(summaries).flatMap(([runnerId, s]) => Object.values(s.sessions).map((x) => ({ ...x, runnerId })));

const newestFirst = (a: Row, b: Row) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id);

/** Recent sessions across runners and projects, newest first; subagents are left out (they sit under their parent). */
export function recentSessions(summaries: Record<string, SummaryState>, query = ""): Row[] {
  const q = query.trim().toLowerCase();
  return rows(summaries)
    .filter((r) => !r.parentSessionId && (!q || r.title.toLowerCase().includes(q)))
    .sort(newestFirst);
}

/** A session's subagents that the summaries know (live ones, mostly), newest first. */
export function childrenOf(summaries: Record<string, SummaryState>, runnerId: string, sessionId: string): Row[] {
  return rows(summaries)
    .filter((r) => r.runnerId === runnerId && r.parentSessionId === sessionId)
    .sort(newestFirst);
}

/**
 * Main sessions on a runner waiting for a person: open requests (a subagent's count in its
 * parent's), or a TUI in terminal mode asking (SPEC §8). Oldest waiting first.
 */
export function waitingOn(summaries: Record<string, SummaryState>, runnerId: string): Row[] {
  return rows(summaries)
    .filter((r) => r.runnerId === runnerId && !r.parentSessionId && ((r.requests ?? 0) > 0 || (r.mode === "terminal" && r.status === "waiting")))
    .sort((a, b) => a.updatedAt - b.updatedAt);
}

/** Merges two lists by session (the later one wins), newest first. */
export function mergeRows(a: Row[], b: Row[]): Row[] {
  const by = new Map<string, Row>();
  for (const r of [...a, ...b]) by.set(`${r.runnerId}\u0000${r.id}`, r);
  return [...by.values()].sort(newestFirst);
}

/** The last part of a path: "/home/me/web" -> "web". */
export const folderName = (path: string) => path.replace(/\/+$/, "").split("/").pop() || path;

export type InboxKind = "needs" | "failed" | "finished" | "working";
export interface InboxRow extends Row {
  inbox: InboxKind;
}

/**
 * Home's inbox (SPEC §10), across runners: what needs you (open requests, a TUI asking), then
 * failed and finished turns nobody has looked at, then what is working. Main sessions only (a
 * subagent's request counts in its parent's).
 */
export function inbox(summaries: Record<string, SummaryState>): InboxRow[] {
  const out: InboxRow[] = [];
  for (const r of rows(summaries)) {
    if (r.parentSessionId) continue;
    const kind: InboxKind | undefined =
      (r.requests ?? 0) > 0 || r.status === "waiting" || (r.queuePaused && r.status === "idle") ? "needs" : r.unread === "failed" ? "failed" : r.unread === "finished" ? "finished" : r.status === "running" ? "working" : undefined;
    if (kind) out.push({ ...r, inbox: kind });
  }
  const rank: Record<InboxKind, number> = { needs: 0, failed: 1, finished: 2, working: 3 };
  // Waiting longest first; the rest newest first.
  return out.sort((a, b) => rank[a.inbox] - rank[b.inbox] || (a.inbox === "needs" ? a.updatedAt - b.updatedAt : b.updatedAt - a.updatedAt) || a.id.localeCompare(b.id));
}
