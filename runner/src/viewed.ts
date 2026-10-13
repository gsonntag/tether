// When you last opened each session, on any device: kept in the runner's config so a session read
// on the phone counts as read on the laptop. The web app orders its lists by it ("last touched").

import { lastTouched, type ProjectInfo, type SessionSummary } from "../../web/src/shared/protocol";
import { config, saveConfigSoon } from "./config";

const DAY = 24 * 60 * 60 * 1000;
/** sessions remembered; the oldest views go first */
export const VIEWED_KEEP = 2000;

export interface Viewed {
  at: number;
  /** its project, so listRecent knows where to look for a session opened long after its last message */
  project?: string;
}

const all = (): Record<string, Viewed> => (config().viewed ??= {});

export function viewedAt(sessionId: string): number | undefined {
  return all()[sessionId]?.at;
}

export function viewedMap(): Record<string, number> {
  return Object.fromEntries(Object.entries(all()).map(([id, v]) => [id, v.at]));
}

/** Records a view now (never earlier than one already recorded). */
export function markViewed(sessionId: string, projectPath?: string, now = Date.now()): number {
  const map = all();
  const prev = map[sessionId];
  const at = Math.max(now, prev?.at ?? 0);
  map[sessionId] = { at, project: projectPath ?? prev?.project };
  const ids = Object.keys(map);
  if (ids.length > VIEWED_KEEP)
    for (const id of ids.sort((a, b) => map[a]!.at - map[b]!.at).slice(0, ids.length - VIEWED_KEEP)) delete map[id];
  saveConfigSoon();
  return at;
}

/**
 * The projects listRecent reads: live ones, ones with a message in the window, and ones holding a
 * session opened in it. With no window, the 20 most recently touched (reading every project's
 * sessions takes too long).
 */
export function recentProjects(projects: ProjectInfo[], viewed: Viewed[], days: number, now = Date.now()): ProjectInfo[] {
  const touched = new Map<string, number>();
  for (const v of viewed) if (v.project) touched.set(v.project, Math.max(touched.get(v.project) ?? 0, v.at));
  const at = (p: ProjectInfo) => Math.max(p.updatedAt, touched.get(p.path) ?? 0);
  const open = projects.filter((p) => !p.archived);
  if (!days) return [...open.filter((p) => p.live.length), ...open.filter((p) => !p.live.length).sort((a, b) => at(b) - at(a)).slice(0, 20)];
  const cutoff = now - days * DAY;
  return open.filter((p) => p.live.length || at(p) >= cutoff);
}

/** Of those projects' sessions: the ones touched in the window, and live ones; most recent first, at most `limit`. */
export function pickRecent(sessions: SessionSummary[], days: number, now = Date.now(), limit = 100): SessionSummary[] {
  const cutoff = days ? now - days * DAY : 0;
  return sessions
    .filter((s) => !s.archived && (s.live || lastTouched(s) >= cutoff))
    .sort((a, b) => lastTouched(b) - lastTouched(a) || (a.id < b.id ? -1 : 1))
    .slice(0, limit);
}

export const allViewed = (): Viewed[] => Object.values(all());
