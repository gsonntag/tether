// The sidebar's lists, derived from every runner's summaries.

import type { SummaryState } from "../../shared/summary";
import type { ProjectInfo, RunStatus, SessionSummary } from "../../shared/transcript";

export { activeRunnerFilter, aggregateProjects, filterRowsByRunner } from "./runnerFilter";

export interface Row extends SessionSummary {
  runnerId: string;
  /** under the open session: one its agent started (tether_start, SPEC §6a), not a subagent (subagents.ts) */
  spawned?: boolean;
}

/** Background subagents still running: the session is working, whatever its main agent does. */
export const shownStatus = <S extends { status: RunStatus; backgroundSubagents?: number }>(s: S): RunStatus => (s.backgroundSubagents && s.status === "idle" ? "running" : s.status);

/**
 * An older runner's Home agent folder (RunnerInfo.homeFolder): its live chats stay out of the lists,
 * as they did. Remove once no runner sends it (the Home agent is gone).
 */
const homeFolders = new Map<string, string>();
export function setHomeFolders(runners: { id: string; homeFolder?: string }[]) {
  homeFolders.clear();
  for (const r of runners) if (r.homeFolder) homeFolders.set(r.id, r.homeFolder);
}
export const isHomeChat = (runnerId: string, projectPath: string) => homeFolders.get(runnerId) === projectPath;

const rows = (summaries: Record<string, SummaryState>, runnerId?: string): Row[] =>
  Object.entries(summaries)
    .filter(([id]) => !runnerId || id === runnerId)
    .flatMap(([rId, s]) =>
      Object.values(s.sessions)
        .filter((x) => !isHomeChat(rId, x.projectPath))
        .map((x) => ({ ...x, status: shownStatus(x), runnerId: rId })),
    );

/** A row the main sidebar lists show: not a subagent, not a side chat, and not an unpinned session started by another session's agent (SPEC §6a). */
export const listed = (r: Pick<SessionSummary, "parentSessionId" | "sideOf" | "startedBy" | "pinned">) =>
  !r.parentSessionId && !r.sideOf && (!r.startedBy || !!r.pinned);

const newestFirst = (a: Row, b: Row) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id);

/** Recent sessions across runners and projects, newest first; subagents are left out (they sit under their parent). */
export function recentSessions(summaries: Record<string, SummaryState>, query = "", runnerId?: string): Row[] {
  const q = query.trim().toLowerCase();
  return rows(summaries, runnerId)
    .filter((r) => listed(r) && (!r.archived || !!q) && (!q || r.title.toLowerCase().includes(q)))
    .sort(newestFirst);
}

/**
 * The Sidebar's Pinned group and the rest (Recent): pinned main sessions in the order they were
 * pinned, across runners. An archived one is never pinned (archiving unpins).
 */
export function splitPinned(list: Row[]): { pinned: Row[]; rest: Row[] } {
  // Each runner stamps its own pins: across runners the order is as good as their clocks.
  const isPinned = (r: Row) => !!r.pinned && !r.archived && listed(r);
  const pinned = list.filter(isPinned).sort((a, b) => a.pinned! - b.pinned! || a.runnerId.localeCompare(b.runnerId) || a.id.localeCompare(b.id));
  return { pinned, rest: list.filter((r) => !isPinned(r)) };
}

export interface ProjectGroup {
  /** the folder (one group per path, across runners) */
  path: string;
  /** its short name: the folder's, with as many parent folders as it takes to tell it from the others */
  label: string;
  rows: Row[];
}

const trimmed = (path: string) => path.replace(/(.)\/+$/, "$1");

/** The project a session is listed under: its folder, or for one in a worktree (SPEC §4) the repo's main checkout. */
export const projectOf = (r: Pick<SessionSummary, "projectPath" | "worktreeOf">) => trimmed(r.worktreeOf ?? r.projectPath);

/** Whether the session belongs in the project list of `folder`: its own, or the main checkout of its worktree. */
export const inProject = (r: Pick<SessionSummary, "projectPath" | "worktreeOf">, folder: string) => trimmed(r.projectPath) === trimmed(folder) || projectOf(r) === trimmed(folder);

/**
 * The Projects list with each worktree folder a session is known to be in (its worktreeOf) folded
 * into its main checkout's entry, so a worktree isn't a project of its own.
 */
export function foldWorktrees<P extends ProjectInfo & { runnerIds: string[] }>(projects: P[], rows: Pick<SessionSummary, "projectPath" | "worktreeOf">[]): P[] {
  const mainOf = new Map(rows.filter((r) => r.worktreeOf).map((r) => [trimmed(r.projectPath), trimmed(r.worktreeOf!)]));
  if (!mainOf.size) return projects;
  const by = new Map<string, P>();
  for (const p of projects) {
    const path = mainOf.get(trimmed(p.path)) ?? trimmed(p.path);
    const had = by.get(path);
    const own = path === trimmed(p.path);
    by.set(
      path,
      !had
        ? own ? p : { ...p, path, name: folderName(path) }
        : { ...had, ...(own ? { name: p.name } : {}), sessions: had.sessions + p.sessions, updatedAt: Math.max(had.updatedAt, p.updatedAt), harnesses: [...new Set([...had.harnesses, ...p.harnesses])], runnerIds: [...new Set([...had.runnerIds, ...p.runnerIds])] },
    );
  }
  return [...by.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Recent, by project: one group per folder (a worktree session's under its main checkout), in the order of each group's newest session (`list`
 * comes newest first, so a page of it groups the same way), sessions newest first within.
 */
export function groupByProject(list: Row[]): ProjectGroup[] {
  const by = new Map<string, Row[]>();
  for (const r of [...list].sort(newestFirst)) {
    const key = projectOf(r);
    const g = by.get(key);
    if (g) g.push(r);
    else by.set(key, [r]);
  }
  const groups = [...by].map(([path, rows]) => ({ path, parts: path.split("/").filter(Boolean), depth: 1, label: "", rows }));
  const tail = (g: (typeof groups)[number]) => g.parts.slice(-g.depth).join("/") || g.path;
  // Same-named folders take one more parent each round, until every label differs (or a path runs out).
  for (;;) {
    for (const g of groups) g.label = tail(g);
    const count = new Map<string, number>();
    for (const g of groups) count.set(g.label, (count.get(g.label) ?? 0) + 1);
    const clash = groups.filter((g) => count.get(g.label)! > 1 && g.depth < g.parts.length);
    if (!clash.length) break;
    for (const g of clash) g.depth++;
  }
  return groups.map(({ path, label, rows }) => ({ path, label, rows }));
}

/** Recent's groups, or none where the list stays flat: search results and a project's list. */
export const recentGroups = (list: Row[], o: { query?: string; filter?: string }): ProjectGroup[] | undefined => (o.query?.trim() || o.filter ? undefined : groupByProject(list));

/**
 * The session menu's pin item: "Pin" or "Unpin", or none where pinning isn't offered (a runner from
 * before pinSession, a subagent, a side chat). Pinning a started session promotes it into Pinned.
 */
export function pinMenuLabel(s: SessionSummary, canPin: boolean): "Pin" | "Unpin" | undefined {
  if (!canPin || s.parentSessionId || s.sideOf) return undefined;
  return s.pinned ? "Unpin" : "Pin";
}

/** A session's subagents that the summaries know (live ones, mostly), newest first. */
export function childrenOf(summaries: Record<string, SummaryState>, runnerId: string, sessionId: string): Row[] {
  return rows(summaries)
    .filter((r) => r.runnerId === runnerId && r.parentSessionId === sessionId)
    .sort(newestFirst);
}

/** Unarchived sessions started by `sessionId` (tether_start) from the broadcast summaries, newest first. */
export function startedChildrenOf(summaries: Record<string, SummaryState>, runnerId: string, sessionId: string): Row[] {
  return rows(summaries, runnerId)
    .filter((r) => r.startedBy === sessionId && !r.archived && !r.pinned)
    .map((r) => ({ ...r, spawned: true }))
    .sort(newestFirst);
}

/**
 * Walks up `parentSessionId` / `startedBy` from `sessionId` to its top-level ancestor in the main
 * list, returning `[root, ..., sessionId]`. Stops at pinned sessions or cycles.
 */
export function ancestorChain(
  summaries: Record<string, SummaryState>,
  views: Record<string, { session?: Pick<SessionSummary, "parentSessionId" | "startedBy" | "pinned"> }>,
  runnerId: string,
  sessionId: string,
): string[] {
  const chain = [sessionId];
  const seen = new Set<string>([sessionId]);
  let cur = sessionId;
  while (true) {
    const s = summaries[runnerId]?.sessions[cur] ?? views[`${runnerId}\u0000${cur}`]?.session;
    const parent = s?.parentSessionId ?? (!s?.pinned ? s?.startedBy : undefined);
    if (!parent || seen.has(parent)) break;
    seen.add(parent);
    chain.unshift(parent);
    cur = parent;
  }
  return chain;
}

/**
 * Sessions on a runner waiting for a person: open requests (a subagent's count in its
 * parent's), or a TUI in terminal mode asking (SPEC §8). Includes agent-started sessions since their
 * requests don't roll up into their starter. Oldest waiting first.
 */
export function waitingOn(summaries: Record<string, SummaryState>, runnerId: string): Row[] {
  return rows(summaries)
    .filter((r) => r.runnerId === runnerId && !r.parentSessionId && !r.sideOf && ((r.requests ?? 0) > 0 || (r.mode === "terminal" && r.status === "waiting")))
    .sort((a, b) => a.updatedAt - b.updatedAt);
}

/** A session's side chats that the summaries know (SPEC §16a), newest first. */
export function sideChatsOf(summaries: Record<string, SummaryState>, runnerId: string, sessionId: string): Row[] {
  return rows(summaries)
    .filter((r) => r.runnerId === runnerId && r.sideOf === sessionId)
    .sort(newestFirst);
}

/** Merges two lists by session (the later one wins), newest first. */
export function mergeRows(a: Row[], b: Row[]): Row[] {
  const by = new Map<string, Row>();
  for (const r of [...a, ...b]) by.set(`${r.runnerId}\u0000${r.id}`, r);
  return [...by.values()].sort(newestFirst);
}

/** The last part of a path: "/home/me/web" -> "web". */
export const folderName = (path: string) => path.replace(/\/+$/, "").split("/").pop() || path;

export type InboxKind = "needs" | "failed" | "finished" | "working" | "watching" | "scheduled";
export interface InboxRow extends Row {
  inbox: InboxKind;
}

/**
 * Home's inbox (SPEC §10), across runners: what needs you (open requests, a TUI asking), then
 * failed and finished turns nobody has looked at, then what is working, then sessions with a
 * message scheduled (SPEC §9; never needing you for that). Main sessions only (a subagent's
 * request counts in its parent's).
 */
export function inbox(summaries: Record<string, SummaryState>): InboxRow[] {
  const out: InboxRow[] = [];
  for (const r of rows(summaries)) {
    // A pinned session its runner can't find is only a saved row: never on Home.
    if (r.parentSessionId || r.sideOf || r.missing) continue;
    const kind: InboxKind | undefined =
      (r.requests ?? 0) > 0 || r.status === "waiting" || (r.queuePaused && r.status === "idle") ? "needs" : r.unread === "failed" ? "failed" : r.unread === "finished" && !r.backgroundSubagents && !r.watching ? "finished" : r.status === "running" ? "working" : r.watching && !r.archived ? "watching" : r.scheduledAt !== undefined && !r.archived ? "scheduled" : undefined;
    // Nested agent-started sessions only surface on Home when they directly need a person's input.
    if (r.startedBy && !r.pinned && kind !== "needs") continue;
    if (kind) out.push({ ...r, inbox: kind });
  }
  const rank: Record<InboxKind, number> = { needs: 0, failed: 1, finished: 2, working: 3, watching: 4, scheduled: 5 };
  // Waiting longest first; scheduled soonest first; the rest newest first.
  return out.sort((a, b) => rank[a.inbox] - rank[b.inbox] || (a.inbox === "needs" ? a.updatedAt - b.updatedAt : a.inbox === "scheduled" ? a.scheduledAt! - b.scheduledAt! : b.updatedAt - a.updatedAt) || a.id.localeCompare(b.id));
}
