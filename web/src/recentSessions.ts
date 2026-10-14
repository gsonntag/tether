// Every session is in exactly one of three states, the same in the sidebar and on Home:
//   working: its main agent or background work is running, or it waits on a limit or retry;
//   needs you: a question, approval or plan waits, or a notice (finished, blocked) arrived after
//     you last opened it;
//   recent: everything else, by "last touched" (the latest message, or when you last opened it).
// Pure, so it's unit tested (recentSessions.test.ts).

import { lastTouched, type AgentNotice, type ProjectInfo, type SessionPulse, type SessionSummary } from "./shared/protocol";
import { pulseWork, summaryWork, workState, type WorkInput } from "./workState";

const DAY = 24 * 60 * 60 * 1000;

/** What you've looked at, on the sidebar's runner: notices read on this device, and when each session was last opened. */
export interface Seen {
  notices: AgentNotice[];
  noticesSeen: number;
  noticesRead: string[];
  /** sessionId -> when you last opened it (any device), by the runner's clock: notices compare with it */
  viewed?: Record<string, number>;
  /** sessionId -> when you opened it here, by this device's clock, until the runner confirms: for ordering only */
  viewedHere?: Record<string, number>;
  /** the runner these are for; another runner's sessions go by what their pulses say */
  runnerId?: string;
}

/** What a project's session list needs to know besides the session itself. */
export interface RecentContext extends Seen {
  now: number;
  /** Settings → "Show sessions from the last": days, 0 = all */
  days: number;
  /** the session open on screen */
  selected?: string;
  /**
   * The open session sorts by when it was last touched before you opened it: opening it (or coming
   * back to the tab) doesn't move it under your cursor. It moves up once you leave.
   */
  hold?: { id: string; at: number };
}

/** When it was last touched: the latest message, or when you last opened it (here or anywhere). */
export const touched = (s: Pick<SessionSummary, "id" | "updatedAt" | "viewedAt">, c: Pick<Seen, "viewed" | "viewedHere">) =>
  lastTouched(s, Math.max(c.viewed?.[s.id] ?? 0, c.viewedHere?.[s.id] ?? 0));

/** What the lists sort by: last touched, except for the open session (`hold`). */
export const sortTouched = (s: Pick<SessionSummary, "id" | "updatedAt" | "viewedAt">, c: Pick<RecentContext, "viewed" | "viewedHere" | "hold">) =>
  c.hold?.id === s.id ? Math.max(s.updatedAt, c.hold.at) : touched(s, c);

/** Sorts summaries like the lists do: most recently touched first, the open one where it was. */
export const byListOrder = (c: Pick<RecentContext, "viewed" | "viewedHere" | "hold">) => (a: SessionSummary, b: SessionSummary) =>
  sortTouched(b, c) - sortTouched(a, c) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The session's latest notice (finished, blocked, a question), when it arrived after you last opened the session. */
export function unreadNotice(s: Pick<SessionSummary, "id" | "viewedAt">, c: Seen): AgentNotice | undefined {
  const n = c.notices.find((x) => x.sessionId === s.id);
  if (!n || n.kind === "memory" || n.ts <= c.noticesSeen || c.noticesRead.includes(n.id)) return undefined;
  // Both by the runner's clock. A view here counts at once through noticesRead.
  return n.ts > Math.max(s.viewedAt ?? 0, c.viewed?.[s.id] ?? 0) ? n : undefined;
}

export const hasUnreadNotice = (s: Pick<SessionSummary, "id" | "viewedAt">, c: Seen) => !!unreadNotice(s, c);

/** A session as the lists see it: its summary, and its Home pulse when there is one. */
export interface Entry {
  session: SessionSummary;
  pulse?: SessionPulse;
  runnerId?: string;
}

/** Another runner's session: what you've seen of it is what its pulse says (its latest notice, when last opened). */
const foreign = (e: Entry, c: Pick<Seen, "runnerId">) => !!e.runnerId && !!c.runnerId && e.runnerId !== c.runnerId;
const seenFor = (e: Entry, c: Seen): Seen => (foreign(e, c) ? { notices: e.pulse?.notice ? [e.pulse.notice] : [], noticesSeen: 0, noticesRead: [] } : c);

const workOf = (e: Entry): WorkInput => (e.pulse ? pulseWork(e.pulse) : summaryWork(e.session));
/** A question, approval or plan waiting on you right now. */
const asking = (e: Entry) => e.session.live && (!!e.session.needsInput || !!e.pulse?.pendingUi?.length);

/** How many things it has waiting on you: each request (Home shows one row each), else one. */
export const needCount = (e: Entry) => Math.max(1, e.session.live ? (e.pulse?.pendingUi?.length ?? 0) : 0);

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
  const n = unreadNotice(e.session, seenFor(e, c));
  if (n && !(n.kind === "finished" && w === "background" && n.ts < e.session.updatedAt)) return "needs";
  return w === "background" ? "working" : "recent";
}

/** The sidebar's and Home's state of a bare summary. */
export const sessionState = (s: SessionSummary, c: Seen) => stateOf({ session: s }, c);

/** Busy: a session that's working or waiting on you, listed whatever its age. */
export const isBusy = (s: SessionSummary, c: Seen = { notices: [], noticesSeen: 0, noticesRead: [] }) => sessionState(s, c) !== "recent";

/**
 * Inside the window by last touched; the open one, and a live one with a wakeup or cron job armed
 * (it will work again), whatever their age.
 */
function inWindow(e: Entry, c: RecentContext): boolean {
  if (!c.days || e.session.id === c.selected || workState(workOf(e)) === "scheduled") return true;
  return touched(e.session, foreign(e, c) ? {} : c) >= c.now - c.days * DAY;
}

export interface Groups<T> {
  needs: T[];
  working: T[];
  recent: T[];
}

/**
 * Splits sessions into the three states, each most recently touched first; recent ones only
 * inside the window. Done (archived) sessions are left out. The open session stays in Needs you
 * while you look at it if it was there before (`wasNeeds`), and sorts where it was (`hold`), so the
 * lists don't jump under you; it moves to the top of Recent once you leave.
 */
export function groupSessions<T extends Entry>(entries: T[], c: RecentContext & { wasNeeds?: Set<string> }): Groups<T> {
  const g: Groups<T> = { needs: [], working: [], recent: [] };
  for (const e of entries) {
    if (e.session.archived) continue;
    // A review session (/review) is listed under the session it reviews, not on its own.
    if (e.session.reviewOf && e.session.id !== c.selected) continue;
    let st = stateOf(e, c);
    if (st === "recent" && !foreign(e, c) && e.session.id === c.selected && c.wasNeeds?.has(e.session.id)) st = "needs";
    if (st === "recent" && !inWindow(e, c)) continue;
    g[st].push(e);
  }
  const at = (e: Entry) => (foreign(e, c) ? lastTouched(e.session) : sortTouched(e.session, c));
  const by = (a: Entry, b: Entry) => at(b) - at(a) || (a.session.id < b.session.id ? -1 : a.session.id > b.session.id ? 1 : 0);
  for (const list of [g.needs, g.working, g.recent]) list.sort(by);
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
 * waiting on you, scheduled to work again, or the one open. Done (archived) sessions never do;
 * search still finds them. Review sessions only while open.
 */
export function showInSidebar(s: SessionSummary, c: RecentContext): boolean {
  if (s.archived) return false;
  // A review session (/review) is opened from its card in the session it reviews.
  if (s.reviewOf) return s.id === c.selected;
  return isBusy(s, c) || inWindow({ session: s }, c);
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
