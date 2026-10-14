import { describe, expect, test } from "bun:test";
import { byListOrder, groupSessions, hasUnreadNotice, isBusy, mergeEntries, needCount, nestSubagents, projectIsQuiet, sessionState, showInSidebar, sidebarDaysLabel, touched, type Entry, type RecentContext } from "./recentSessions";
import { listPath, type AgentNotice, type SessionSummary } from "./shared/protocol";

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
  test("a review session only while it's open, working or asking you something; not for its notices", () => {
    const r = session("r", 0, { reviewOf: "a" });
    expect(showInSidebar(r, ctx())).toBe(false);
    expect(showInSidebar(r, ctx({ selected: "r" }))).toBe(true);
    expect(showInSidebar({ ...r, live: true, status: "running" }, ctx())).toBe(true);
    expect(showInSidebar({ ...r, live: true, needsInput: true }, ctx())).toBe(true);
    expect(showInSidebar(r, ctx({ notices: [notice("r", NOW)] }))).toBe(false);
    const g = groupSessions([{ session: { ...r, live: true, needsInput: true } }, { session: r }], ctx({ notices: [notice("r", NOW)] }));
    expect(g.needs.map((e) => e.session.id)).toEqual(["r"]);
    expect(groupSessions([{ session: r }], ctx({ notices: [notice("r", NOW)] })).needs).toEqual([]);
  });

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
    // Only an armed wakeup or cron job: not working, but listed whatever its age (it will work again).
    expect(showInSidebar(session("a", old, { activeCount: 1, workingCount: 0, live: true }), ctx())).toBe(true);
    expect(isBusy(session("a", old, { activeCount: 1, workingCount: 0, live: true }))).toBe(false);
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

describe("viewed: opening a session reads its notices, on every device", () => {
  test("a notice counts until the session is opened after it", () => {
    const s = session("a", 10 * DAY);
    const n = notice("a", NOW - DAY);
    expect(hasUnreadNotice(s, ctx({ notices: [n] }))).toBe(true);
    // Opened (here or elsewhere) after it came: read.
    expect(hasUnreadNotice(s, ctx({ notices: [n], viewed: { a: NOW - DAY + 1 } }))).toBe(false);
    expect(hasUnreadNotice({ ...s, viewedAt: NOW - DAY + 1 }, ctx({ notices: [n] }))).toBe(false);
    // Opened before it came: still unread.
    expect(hasUnreadNotice(s, ctx({ notices: [n], viewed: { a: NOW - 2 * DAY } }))).toBe(true);
    // Memory notices are the conflicts' business.
    expect(hasUnreadNotice(s, ctx({ notices: [notice("a", NOW, "memory")] }))).toBe(false);
  });

  test("the window goes by last touched: opening an old session makes it recent", () => {
    const old = session("a", 10 * DAY);
    expect(showInSidebar(old, ctx())).toBe(false);
    expect(showInSidebar(old, ctx({ viewed: { a: NOW - DAY } }))).toBe(true);
    expect(showInSidebar({ ...old, viewedAt: NOW - DAY }, ctx())).toBe(true);
  });
});

describe("the three states", () => {
  const st = (s: SessionSummary, c: Partial<RecentContext> = {}) => sessionState(s, ctx(c));

  test("working: the main turn, a wait, or background work; a wakeup alone isn't", () => {
    expect(st(session("a", 0, { live: true, status: "running" }))).toBe("working");
    expect(st(session("a", 0, { live: true, status: "waiting" }))).toBe("working");
    expect(st(session("a", 0, { live: true, activeCount: 1, workingCount: 1, runningKinds: { shell: 1 } }))).toBe("working");
    expect(st(session("a", 0, { live: true, activeCount: 1, workingCount: 0, runningKinds: {} }))).toBe("recent");
    // An older runner without runningKinds: workingCount says.
    expect(st(session("a", 0, { live: true, activeCount: 1, workingCount: 0 }))).toBe("recent");
    // Idle with its process still up looks like any other recent session.
    expect(st(session("a", 0, { live: true }))).toBe("recent");
  });

  test("needs you: a question waiting, or a notice you haven't opened", () => {
    expect(st(session("a", 0, { live: true, status: "running", needsInput: true }))).toBe("needs");
    // A closed process can't be asking.
    expect(st(session("a", 0, { live: false, needsInput: true }))).toBe("recent");
    const n = notice("a", NOW - 1000);
    expect(st(session("a", 0), { notices: [n] })).toBe("needs");
    expect(st(session("a", 0), { notices: [n], viewed: { a: NOW } })).toBe("recent");
    expect(st(session("a", 0), { notices: [notice("a", NOW - 1000, "blocked")] })).toBe("needs");
    // Working again: past whatever the notice said.
    expect(st(session("a", 0, { live: true, status: "running" }), { notices: [n] })).toBe("working");
  });

  test("a finished turn beats background work, unless a later message started more", () => {
    const bg = { live: true, activeCount: 1, workingCount: 1, runningKinds: { shell: 1 } };
    expect(st(session("a", 2000, bg), { notices: [notice("a", NOW - 1000)] })).toBe("needs");
    expect(st(session("a", 0, bg), { notices: [notice("a", NOW - 1000)] })).toBe("working");
    expect(st(session("a", 2000, bg), { notices: [notice("a", NOW - 1000)], viewed: { a: NOW } })).toBe("working");
  });
});

describe("groupSessions", () => {
  const e = (s: SessionSummary, extra: Partial<Entry> = {}): Entry => ({ session: s, ...extra });

  test("each session in one group, most recently touched first; recent only inside the window; done never", () => {
    const g = groupSessions(
      [
        e(session("old", 10 * DAY)),
        e(session("msg", 2 * DAY)),
        e(session("opened", 5 * DAY), {}),
        e(session("run", 9 * DAY, { live: true, status: "running" })),
        e(session("ask", 8 * DAY, { live: true, needsInput: true })),
        e(session("done", 0, { archived: true })),
      ],
      ctx({ viewed: { opened: NOW - DAY } }),
    );
    expect(g.needs.map((x) => x.session.id)).toEqual(["ask"]);
    expect(g.working.map((x) => x.session.id)).toEqual(["run"]);
    expect(g.recent.map((x) => x.session.id)).toEqual(["opened", "msg"]);
  });

  test("an opened needs-you session stays put while open, then tops Recent", () => {
    const n = notice("a", NOW - 2 * DAY);
    const list = [e(session("a", 2 * DAY)), e(session("b", DAY))];
    const before = groupSessions(list, ctx({ notices: [n] }));
    expect(before.needs.map((x) => x.session.id)).toEqual(["a"]);
    const was = new Set(before.needs.map((x) => x.session.id));
    // Opened: viewed now, and selected.
    const open = groupSessions(list, ctx({ notices: [n], viewed: { a: NOW }, selected: "a", wasNeeds: was } as RecentContext));
    expect(open.needs.map((x) => x.session.id)).toEqual(["a"]);
    const left = groupSessions(list, ctx({ notices: [n], viewed: { a: NOW }, wasNeeds: was } as RecentContext));
    expect(left.needs).toEqual([]);
    expect(left.recent.map((x) => x.session.id)).toEqual(["a", "b"]);
    // Opening a recent one doesn't put it in Needs you.
    expect(groupSessions(list, ctx({ selected: "b", wasNeeds: was } as RecentContext)).needs).toEqual([]);
  });

  test("pulses: a waiting request needs you, background activity works; summaries win, other runners stay apart", () => {
    const perm = { id: "q1", kind: "permission" as const, title: "Allow?" };
    const pulses = {
      r1: { a: { session: session("a", 0, { live: true, title: "stale" }), pendingUi: [perm] }, bg: { session: session("bg", 0, { live: true }), activity: { subagent: 1 } } },
      r2: { a: { session: session("a", 0, { live: true, status: "running" as const }) } },
    };
    const entries = mergeEntries("r1", [session("a", 0, { live: true, title: "fresh" })], pulses);
    expect(entries).toHaveLength(3);
    const g = groupSessions(entries, ctx());
    expect(g.needs.map((x) => [x.runnerId, x.session.title])).toEqual([["r1", "fresh"]]);
    expect(g.working.map((x) => `${x.runnerId}:${x.session.id}`).sort()).toEqual(["r1:bg", "r2:a"]);
    // No runner: pulses only.
    expect(mergeEntries(undefined, [session("z", 0)], pulses)).toHaveLength(3);
  });
});

describe("review fixes", () => {
  const e = (s: SessionSummary, extra: Partial<Entry> = {}): Entry => ({ session: s, ...extra });
  const ids = (l: Entry[]) => l.map((x) => x.session.id);

  test("the open session sorts where it was before you opened it, and moves up once you leave", () => {
    const list = [e(session("a", DAY)), e(session("b", 2 * DAY)), e(session("c", 3 * DAY))];
    // Opened c: viewed now, but held at its old place.
    const open = ctx({ viewedHere: { c: NOW }, viewed: { c: NOW }, selected: "c", hold: { id: "c", at: 0 } });
    expect(ids(groupSessions(list, open).recent)).toEqual(["a", "b", "c"]);
    expect([session("c", 3 * DAY), session("a", DAY)].sort(byListOrder(open)).map((s) => s.id)).toEqual(["a", "c"]);
    // Left it: by when you opened it.
    expect(ids(groupSessions(list, ctx({ viewedHere: { c: NOW }, viewed: { c: NOW } })).recent)).toEqual(["c", "a", "b"]);
  });

  test("this device's own clock orders, but only the runner's view reads a notice", () => {
    const n = notice("a", NOW - 1000);
    expect(touched(session("a", DAY), ctx({ viewedHere: { a: NOW } }))).toBe(NOW);
    expect(sessionState(session("a", DAY), ctx({ notices: [n], viewedHere: { a: NOW } }))).toBe("needs");
    expect(sessionState(session("a", DAY), ctx({ notices: [n], viewed: { a: NOW } }))).toBe("recent");
  });

  test("another runner's session goes by its pulse: its notice, its viewedAt; never this runner's views", () => {
    const fin = { ...notice("a", NOW - 1000), id: "other" };
    const theirs = e(session("a", DAY), { runnerId: "r2", pulse: { session: session("a", DAY), notice: fin } });
    const c = ctx({ runnerId: "r1", viewed: { a: NOW } });
    expect(groupSessions([theirs], c).needs).toHaveLength(1);
    const seen = e(session("a", DAY, { viewedAt: NOW }), { runnerId: "r2", pulse: { session: session("a", DAY), notice: fin } });
    expect(groupSessions([seen], c).needs).toHaveLength(0);
    // This runner's own notices don't leak onto it either.
    const plain = e(session("a", DAY), { runnerId: "r2", pulse: { session: session("a", DAY) } });
    expect(groupSessions([plain], ctx({ runnerId: "r1", notices: [notice("a", NOW)] })).needs).toHaveLength(0);
  });

  test("a live session with only a wakeup armed stays in Recent whatever its age", () => {
    const sched = e(session("s", 30 * DAY, { live: true, activeCount: 1, workingCount: 0, runningKinds: {} }));
    expect(ids(groupSessions([sched, e(session("old", 30 * DAY))], ctx()).recent)).toEqual(["s"]);
  });

  test("needCount: one per waiting request, else one", () => {
    const perm = (id: string) => ({ id, kind: "permission" as const, title: "?" });
    expect(needCount(e(session("a", 0, { live: true }), { pulse: { session: session("a", 0), pendingUi: [perm("1"), perm("2")] } }))).toBe(2);
    expect(needCount(e(session("a", 0)))).toBe(1);
  });
});

describe("nestSubagents", () => {
  test("subagents follow the session that started them; ones whose parent isn't listed stay put", () => {
    const by = (sessionId: string, name: string) => ({ startedBy: { sessionId, name } });
    const list = [session("a", 1), session("x", 2, by("gone", "x")), session("b", 3), session("a1", 4, by("a", "one")), session("a1a", 5, by("a1", "deep")), session("b1", 6, by("b", "two"))];
    expect(nestSubagents(list).map((r) => `${r.session.id}:${r.depth}`)).toEqual(["a:0", "a1:1", "a1a:2", "x:0", "b:0", "b1:1"]);
  });
});

test("listPath: a subagent in its own worktree is listed in its parent's project", () => {
  expect(listPath(session("a", 1))).toBe("/p");
  expect(listPath(session("a", 1, { projectPath: "/home/u/.tether/worktrees/p-1/x", listedUnder: "/p" }))).toBe("/p");
});
