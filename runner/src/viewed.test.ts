import { expect, test } from "bun:test";
import type { ProjectInfo, SessionSummary } from "../../web/src/shared/protocol";
import { config } from "./config";
import { markViewed, pickRecent, recentProjects, VIEWED_KEEP, viewedAt, viewedMap } from "./viewed";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 13, 12);

test("a view is kept by session, never moves back, and the oldest go past the cap", () => {
  delete config().viewed;
  expect(markViewed("a", "/p", NOW)).toBe(NOW);
  // A slower device's later write doesn't move it back.
  expect(markViewed("a", undefined, NOW - 5)).toBe(NOW);
  expect(config().viewed!.a).toEqual({ at: NOW, project: "/p" });
  expect(viewedAt("a")).toBe(NOW);
  expect(viewedMap()).toEqual({ a: NOW });
  for (let i = 0; i < VIEWED_KEEP + 5; i++) markViewed(`s${i}`, "/p", NOW + i + 1);
  expect(Object.keys(config().viewed!)).toHaveLength(VIEWED_KEEP);
  expect(viewedAt("a")).toBeUndefined();
  expect(viewedAt(`s${VIEWED_KEEP + 4}`)).toBe(NOW + VIEWED_KEEP + 5);
  delete config().viewed;
});

const project = (path: string, ageMs: number, extra: Partial<ProjectInfo> = {}): ProjectInfo => ({ path, name: path, sessionCount: 1, updatedAt: NOW - ageMs, pinned: false, live: [], ...extra });
const session = (id: string, ageMs: number, extra: Partial<SessionSummary> = {}): SessionSummary => ({
  id,
  harness: "claude-code",
  nativeId: id,
  projectPath: "/p",
  title: id,
  createdAt: 0,
  updatedAt: NOW - ageMs,
  live: false,
  status: "idle",
  ...extra,
});

test("recentProjects: live, active in the window, or holding a session opened in it", () => {
  const ps = [project("/new", DAY), project("/old", 10 * DAY), project("/live", 10 * DAY, { live: [session("x", 10 * DAY, { live: true })] }), project("/seen", 10 * DAY), project("/gone", 0, { archived: true })];
  const got = recentProjects(ps, [{ at: NOW - DAY, project: "/seen" }, { at: NOW - 9 * DAY, project: "/old" }], 3, NOW).map((p) => p.path);
  expect(got.sort()).toEqual(["/live", "/new", "/seen"]);
  // All: the most recently touched 20, plus any live one.
  const many = Array.from({ length: 30 }, (_, i) => project(`/p${i}`, i * DAY));
  const all = recentProjects([...many, project("/live", 400 * DAY, { live: [session("x", 0)] })], [], 0, NOW).map((p) => p.path);
  expect(all).toHaveLength(21);
  expect(all).toContain("/live");
  expect(all).toContain("/p19");
  expect(all).not.toContain("/p20");
});

test("pickRecent: by last touched, live ones whatever their age, done ones never", () => {
  const got = pickRecent(
    [session("old", 10 * DAY), session("opened", 10 * DAY, { viewedAt: NOW - 1000 }), session("msg", DAY), session("live", 20 * DAY, { live: true }), session("done", 0, { archived: true })],
    3,
    NOW,
  ).map((s) => s.id);
  expect(got).toEqual(["opened", "msg", "live"]);
  expect(pickRecent([session("a", 400 * DAY), session("b", DAY)], 0, NOW).map((s) => s.id)).toEqual(["b", "a"]);
  expect(pickRecent([session("a", 0), session("b", 1)], 3, NOW, 1).map((s) => s.id)).toEqual(["a"]);
});
