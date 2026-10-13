// Every session is in exactly one of three states, the same in the sidebar and on Home:
//   working: its main agent or background work is running, or it waits on a limit or retry;
//   needs you: a question, approval or plan waits, or a notice (finished, blocked) arrived after
//     you last opened it;
//   recent: everything else, by "last touched" (the latest message, or when you last opened it).
// Pure, so it's unit tested (recentSessions.test.ts).

import { byTouched, lastTouched, type AgentNotice, type ProjectInfo, type SessionPulse, type SessionSummary } from "./shared/protocol";
import { pulseWork, summaryWork, workState, type WorkInput } from "./workState";

const DAY = 24 * 60 * 60 * 1000;

/** What you've looked at: notices read on this device, and when each session was last opened (any device). */
export interface Seen {
  notices: AgentNotice[];
  noticesSeen: number;
  noticesRead: string[];
  /** sessionId -> when you last opened it (the runner's list, plus this device's latest) */
  viewed?: Record<string, number>;
}

/** What a project's session list needs to know besides the session itself. */
export interface RecentContext extends Seen {
  now: number;
  /** Settings → "Show sessions from the last": days, 0 = all */
  days: number;
  /** the session open on screen */
  selected?: string;
}

export const touched = (s: Pick<SessionSummary, "id" | "updatedAt" | "viewedAt">, c: Pick<Seen, "viewed">) => lastTouched(s, c.viewed?.[s.id]);

/** The session's latest notice (finished, blocked, a question), when it arrived after you last opened the session. */
export function unreadNotice(s: Pick<SessionSummary, "id" | "viewedAt">, c: Seen): AgentNotice | undefined {
  const n = c.notices.find((x) => x.sessionId === s.id);
  if (!n || n.kind === "memory" || n.ts <= c.noticesSeen || c.noticesRead.includes(n.id)) return undefined;
  return n.ts > Math.max(s.viewedAt ?? 0, c.viewed?.[s.id] ?? 0) ? n : undefined;
}

export const hasUnreadNotice = (s: Pick<SessionSummary, "id" | "viewedAt">, c: Seen) => !!unreadNotice(s, c);

/** A session as the lists see it: its summary, and its Home pulse when there is one. */
export interface Entry {
  session: SessionSummary;
  pulse?: SessionPulse;
  runnerId?: string;
}

const workOf = (e: Entry): WorkInput => (e.pulse ? pulseWork(e.pulse) : summaryWork(e.session));
/** A question, approval or plan waiting on you right now. */
const asking = (e: Entry) => e.session.live && (!!e.session.needsInput || !!e.pulse?.pendingUi?.length);

export type SessionState = "needs" | "working" | "recent";

/**
 * Asking you comes first, then the main agent working. A notice you haven't seen beats background
 * work (a dev server left running), unless it's a "Finished" from before the latest message: that
 * turn's work is what still runs. A wakeup or cron job alone isn't working.
 */
export function stateOf(e: Entry, c: Seen): SessionState {
  if (asking(e)) return "needs";
  const w = workState(workOf(e));
  if (w === "working" || w === "waiting") return "working";
  const n = unreadNotice(e.session, c);
  if (n && !(n.kind === "finished" && w === "background" && n.ts < e.session.updatedAt)) return "needs";
  return w === "background" ? "working" : "recent";
}

/** The sidebar's and Home's state of a bare summary. */
export const sessionState = (s: SessionSummary, c: Seen) => stateOf({ session: s }, c);

/** Busy: a session that's working or waiting on you, listed whatever its age. */
export const isBusy = (s: SessionSummary, c: Seen = { notices: [], noticesSeen: 0, noticesRead: [] }) => sessionState(s, c) !== "recent";

const inWindow = (s: SessionSummary, c: RecentContext) => !c.days || touched(s, c) >= c.now - c.days * DAY;

export interface Groups<T> {
  needs: T[];
  working: T[];
  recent: T[];
}

/**
 * Splits sessions into the three states, each most recently touched first; recent ones only
 * inside the window. Done (archived) sessions are left out. `hold`: the open session stays in
 * Needs you while you look at it if it was there before (`wasNeeds`), so the list doesn't jump
 * under you; it moves to the top of Recent once you leave.
 */
export function groupSessions<T extends Entry>(entries: T[], c: RecentContext & { wasNeeds?: Set<string> }): Groups<T> {
  const g: Groups<T> = { needs: [], working: [], recent: [] };
  for (const e of entries) {
    if (e.session.archived) continue;
    let st = stateOf(e, c);
    if (st === "recent" && e.session.id === c.selected && c.wasNeeds?.has(e.session.id)) st = "needs";
    if (st === "recent" && !inWindow(e.session, c)) continue;
    g[st].push(e);
  }
  const by = byTouched(c.viewed);
  for (const list of [g.needs, g.working, g.recent]) list.sort((a, b) => by(a.session, b.session));
  return g;
}

/**
 * One entry per session: summaries win (the runner pushes them as they change), pulses add Home's
 * detail. Pulses are by runner; summaries are the sidebar's runner's.
 */
export function mergeEntries(runnerId: string | undefined, summaries: Iterable<SessionSummary>, pulses: Record<string, Record<string, SessionPulse>>): Entry[] {
  const by = new Map<string, Entry>();
  for (const [rid, byId] of Object.entries(pulses)) for (const p of Object.values(byId)) by.set(`${rid}\n${p.session.id}`, { session: p.session, pulse: p, runnerId: rid });
  if (runnerId)
    for (const s of summaries) {
      const k = `${runnerId}\n${s.id}`;
      by.set(k, { ...by.get(k), session: s, runnerId });
    }
  return [...by.values()];
}

/**
 * Whether a session belongs in its project's sidebar list: touched inside the window, or working,
 * waiting on you, or the one open. Done (archived) sessions never do; search still finds them.
 */
export function showInSidebar(s: SessionSummary, c: RecentContext): boolean {
  if (s.archived) return false;
  if (!c.days || s.id === c.selected || isBusy(s, c)) return true;
  return inWindow(s, c);
}

/**
 * Whether a project has nothing to list (it's dimmed). An open project's list was just fetched, so
 * it decides. A closed one may know only some of its sessions (the live ones from listProjects, or
 * one that changed or was opened from search), so any of those that would show un-dims it, and
 * otherwise the project's latest activity (session file times: never earlier than the latest
 * message, so it errs towards not dimming) and its unread notices decide.
 */
export function projectIsQuiet(
  p: Pick<ProjectInfo, "path" | "updatedAt" | "sessionCount" | "live">,
  known: SessionSummary[] | undefined,
  open: boolean,
  c: RecentContext,
): boolean {
  if (open && known) return !known.some((s) => showInSidebar(s, c));
  if ([...(known ?? []), ...p.live].some((s) => showInSidebar(s, c))) return false;
  const recent = c.days ? p.updatedAt >= c.now - c.days * DAY : p.sessionCount > 0;
  return !recent && !c.notices.some((n) => n.projectPath === p.path && hasUnreadNotice({ id: n.sessionId }, c));
}

/** Settings labels for SIDEBAR_DAYS. */
export const sidebarDaysLabel = (days: number) => (days ? `${days} ${days === 1 ? "day" : "days"}` : "All");
