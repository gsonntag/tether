import type { AgentNotice, SessionSummary } from "./shared/protocol";

const DAY = 24 * 60 * 60 * 1000;

/** What a project's session list needs to know besides the session itself. */
export interface RecentContext {
  now: number;
  /** Settings → "Show sessions from the last": days, 0 = all */
  days: number;
  notices: AgentNotice[];
  noticesSeen: number;
  noticesRead: string[];
  /** the session open on screen */
  selected?: string;
}

/** Whether the session's latest notice (finished, needs input, …) is one you haven't opened yet. */
export function hasUnreadNotice(s: Pick<SessionSummary, "id">, c: Pick<RecentContext, "notices" | "noticesSeen" | "noticesRead">): boolean {
  const n = c.notices.find((x) => x.sessionId === s.id);
  return !!n && n.ts > c.noticesSeen && !c.noticesRead.includes(n.id);
}

/**
 * A session that's doing something or waiting on you: listed whatever its age. Background work
 * counts only while it works: a session whose only activity is an armed wakeup or cron job is
 * listed by its age like any other (an older runner sends no workingCount: then all of it counts).
 */
export function isBusy(s: SessionSummary): boolean {
  const working = s.activeCount ? (s.workingCount ?? s.activeCount) : 0;
  return s.status !== "idle" || !!s.needsInput || working > 0;
}

/**
 * Whether a session belongs in its project's sidebar list: its latest message is inside the window,
 * or it's busy (running, background work, waiting on a limit or retry, a question for you), has an
 * unread notice, or is the one open. Done (archived) sessions never do; search still finds them.
 */
export function showInSidebar(s: SessionSummary, c: RecentContext): boolean {
  if (s.archived) return false;
  if (!c.days || s.id === c.selected || isBusy(s) || hasUnreadNotice(s, c)) return true;
  return s.updatedAt >= c.now - c.days * DAY;
}

/** Settings labels for SIDEBAR_DAYS. */
export const sidebarDaysLabel = (days: number) => (days ? `${days} ${days === 1 ? "day" : "days"}` : "All");
