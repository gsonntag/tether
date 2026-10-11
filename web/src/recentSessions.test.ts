import { describe, expect, test } from "bun:test";
import { hasUnreadNotice, isBusy, projectIsQuiet, showInSidebar, sidebarDaysLabel, type RecentContext } from "./recentSessions";
import type { AgentNotice, SessionSummary } from "./shared/protocol";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 11, 12);

const session = (id: string, ageMs: number, extra: Partial<SessionSummary> = {}): SessionSummary => ({
  id,
  harness: "claude-code",
  nativeId: id,
  projectPath: "/p",
  title: id,
  createdAt: NOW - ageMs,
  updatedAt: NOW - ageMs,
  live: false,
  status: "idle",
  ...extra,
});
const notice = (sessionId: string, ts: number, kind: AgentNotice["kind"] = "finished"): AgentNotice => ({
  id: `n-${sessionId}`,
  kind,
  title: "",
  body: "",
  sessionId,
  projectPath: "/p",
  project: "p",
  ts,
});
const ctx = (c: Partial<RecentContext> = {}): RecentContext => ({ now: NOW, days: 3, notices: [], noticesSeen: 0, noticesRead: [], ...c });

describe("showInSidebar", () => {
  test("by the time of the latest message, inside the window", () => {
    expect(showInSidebar(session("a", 2 * DAY), ctx())).toBe(true);
    expect(showInSidebar(session("a", 3 * DAY), ctx())).toBe(true); // the edge counts
    expect(showInSidebar(session("a", 3 * DAY + 1), ctx())).toBe(false);
    expect(showInSidebar(session("a", 2 * DAY), ctx({ days: 1 }))).toBe(false);
    expect(showInSidebar(session("a", 20 * DAY), ctx({ days: 30 }))).toBe(true);
  });

  test("All shows every session that isn't done", () => {
    expect(showInSidebar(session("a", 400 * DAY), ctx({ days: 0 }))).toBe(true);
    expect(showInSidebar(session("a", 400 * DAY, { archived: true }), ctx({ days: 0 }))).toBe(false);
  });

  test("done sessions never show, even when busy or open", () => {
    const done = session("a", 0, { archived: true, status: "running" });
    expect(showInSidebar(done, ctx({ selected: "a" }))).toBe(false);
  });

  test("old but busy: running, background work, waiting on a limit, or a question for you", () => {
    const old = 10 * DAY;
    expect(showInSidebar(session("a", old, { status: "running", live: true }), ctx())).toBe(true);
    expect(showInSidebar(session("a", old, { status: "waiting", live: true }), ctx())).toBe(true);
    expect(showInSidebar(session("a", old, { activeCount: 2, live: true }), ctx())).toBe(true);
    expect(showInSidebar(session("a", old, { needsInput: true, live: true }), ctx())).toBe(true);
    expect(showInSidebar(session("a", old, { activeCount: 0, live: true }), ctx())).toBe(false);
    // Only an armed wakeup or cron job: listed by age, like an idle session.
    expect(showInSidebar(session("a", old, { activeCount: 1, workingCount: 0, live: true }), ctx())).toBe(false);
    expect(showInSidebar(session("a", DAY, { activeCount: 1, workingCount: 0, live: true }), ctx())).toBe(true);
    expect(showInSidebar(session("a", old, { activeCount: 2, workingCount: 1, live: true }), ctx())).toBe(true);
    // An older runner doesn't say what's working: all of it counts.
    expect(showInSidebar(session("a", old, { activeCount: 1, live: true }), ctx())).toBe(true);
    expect(isBusy(session("a", old))).toBe(false);
  });

  test("old with an unread notice shows; once read it goes", () => {
    const s = session("a", 10 * DAY);
    const n = notice("a", NOW - DAY);
    expect(showInSidebar(s, ctx({ notices: [n] }))).toBe(true);
    expect(showInSidebar(s, ctx({ notices: [notice("a", NOW - DAY, "question")] }))).toBe(true);
    expect(showInSidebar(s, ctx({ notices: [n], noticesRead: [n.id] }))).toBe(false);
    expect(showInSidebar(s, ctx({ notices: [n], noticesSeen: NOW }))).toBe(false);
    // Someone else's notice doesn't count.
    expect(showInSidebar(s, ctx({ notices: [notice("b", NOW)] }))).toBe(false);
    expect(hasUnreadNotice({ id: "a" }, ctx({ notices: [n] }))).toBe(true);
  });

  test("the open session stays, however old", () => {
    expect(showInSidebar(session("a", 90 * DAY), ctx({ selected: "a" }))).toBe(true);
    expect(showInSidebar(session("a", 90 * DAY), ctx({ selected: "b" }))).toBe(false);
  });

  test("drops out as time passes", () => {
    const s = session("a", 2 * DAY);
    expect(showInSidebar(s, ctx())).toBe(true);
    expect(showInSidebar(s, ctx({ now: NOW + 1.5 * DAY }))).toBe(false);
  });
});

test("window labels", () => {
  expect([1, 3, 7, 30, 0].map(sidebarDaysLabel)).toEqual(["1 day", "3 days", "7 days", "30 days", "All"]);
});

describe("projectIsQuiet", () => {
  const project = (updatedAgo: number, extra: Partial<{ sessionCount: number; live: SessionSummary[] }> = {}) => ({
    path: "/p",
    updatedAt: NOW - updatedAgo,
    sessionCount: 3,
    live: [] as SessionSummary[],
    ...extra,
  });

  test("an open project goes by its fetched list", () => {
    expect(projectIsQuiet(project(0), [session("a", 10 * DAY)], true, ctx())).toBe(true);
    expect(projectIsQuiet(project(10 * DAY), [session("a", DAY)], true, ctx())).toBe(false);
  });

  test("a closed project with a running session is never dimmed", () => {
    const run = session("a", 30 * DAY, { status: "running", live: true });
    expect(projectIsQuiet(project(30 * DAY, { live: [run] }), undefined, false, ctx())).toBe(false);
    expect(projectIsQuiet(project(30 * DAY), [run], false, ctx())).toBe(false);
  });

  test("a closed project that knows only an old session still goes by its latest activity", () => {
    // e.g. an old session opened from search: the project's other sessions may be recent.
    expect(projectIsQuiet(project(DAY), [session("old", 30 * DAY)], false, ctx())).toBe(false);
    expect(projectIsQuiet(project(30 * DAY), [session("old", 30 * DAY)], false, ctx())).toBe(true);
  });

  test("closed: latest activity, unread notices, All", () => {
    expect(projectIsQuiet(project(10 * DAY), undefined, false, ctx())).toBe(true);
    expect(projectIsQuiet(project(10 * DAY), undefined, false, ctx({ notices: [notice("x", NOW)] }))).toBe(false);
    expect(projectIsQuiet(project(400 * DAY), undefined, false, ctx({ days: 0 }))).toBe(false);
    expect(projectIsQuiet(project(400 * DAY, { sessionCount: 0 }), undefined, false, ctx({ days: 0 }))).toBe(true);
  });
});
