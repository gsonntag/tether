import { expect, test } from "bun:test";
import type { SessionSummary } from "../../shared/transcript";
import type { Row } from "./sessionList";
import { byChildOrder, childrenOpen, childrenToggle, familyKey, fewChildren, kindCount, loadChildrenOpen, mainIds, moreLabel, saveChildrenOpen, spawnedRows, withSpawned } from "./subagents";

const s = (id: string, updatedAt: number, extra: Partial<SessionSummary> = {}): SessionSummary => ({ id, harness: "claude", nativeId: id, projectPath: "/p/web", title: `T ${id}`, mode: "stored", status: "idle", updatedAt, ...extra });
const r = (id: string, updatedAt: number, extra: Partial<Row> = {}): Row => ({ ...s(id, updatedAt), runnerId: "a", ...extra });
const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
};

test("started sessions are marked, take the live summary where there is one, and merge with subagents", () => {
  const family = { parent: { id: "boss", title: "Boss" }, children: [s("k1", 5, { harness: "codex", title: "old title" }), s("k2", 2, { harness: "antigravity" })] };
  const summaries = { a: { epoch: "e", seq: 1, sessions: { k1: s("k1", 9, { harness: "codex", title: "Fix it", status: "running" }) } } };
  const spawned = spawnedRows(family, summaries, "a");
  expect(spawned.map((x) => [x.id, x.title, x.status, x.spawned, x.runnerId])).toEqual([
    ["k1", "Fix it", "running", true, "a"],
    ["k2", "T k2", "idle", true, "a"],
  ]);
  // Never a subagent: no parentSessionId.
  expect(spawned.every((x) => !x.parentSessionId)).toBe(true);
  expect(spawnedRows(undefined, summaries, "a")).toEqual([]);
  // Background subagents running count as working, as elsewhere.
  expect(spawnedRows({ children: [s("k3", 1, { backgroundSubagents: 1 })] }, {}, "a")[0]!.status).toBe("running");
  const native = [r("sub1", 7, { parentSessionId: "boss", agentType: "Explore" })];
  expect(withSpawned(native, spawned).map((x) => `${x.id}${x.spawned ? "*" : ""}`)).toEqual(["k1*", "sub1", "k2*"]);
});

test("a few rows, running first, the open one always; the rest counted", () => {
  const kids = [r("a", 1), r("b", 5), r("c", 3, { status: "running" }), r("d", 4), r("e", 2)];
  expect(byChildOrder(kids).map((x) => x.id)).toEqual(["c", "b", "d", "e", "a"]);
  expect(fewChildren(kids, undefined, 2).rest.map((x) => x.id)).toEqual(["d", "e", "a"]);
  expect(fewChildren(kids, undefined, 2).few.map((x) => x.id)).toEqual(["c", "b"]);
  const withOpen = fewChildren(kids, "a", 2);
  expect(withOpen.few.map((x) => x.id)).toEqual(["c", "b", "a"]);
  expect(withOpen.rest.map((x) => x.id)).toEqual(["d", "e"]);
  expect(fewChildren([], "a", 5)).toEqual({ few: [], rest: [] });
});

test("the section: closed by default, as this device keeps it, open while one of its rows is open, toggled per session", () => {
  const kids = [r("a", 1), r("b", 2)];
  expect(childrenOpen(false, kids, undefined)).toBe(false);
  expect(childrenOpen(true, kids, undefined)).toBe(true);
  // The parent itself is open: not one of its rows.
  expect(childrenOpen(false, kids, "parent")).toBe(false);
  // A subagent (or started session) is open: its row stays in view.
  expect(childrenOpen(false, kids, "b")).toBe(true);
  // Toggled here wins either way.
  expect(childrenOpen(false, kids, "b", false)).toBe(false);
  expect(childrenOpen(false, kids, undefined, true)).toBe(true);
});

test("the toggle row, the more button and the list count each kind", () => {
  expect(childrenToggle([r("a", 1)])).toEqual({ label: "1 subagent", running: 0, said: "1 subagent" });
  expect(childrenToggle([r("a", 1, { status: "running" }), r("b", 1, { status: "waiting" }), r("c", 1)])).toEqual({ label: "3 subagents", running: 2, said: "3 subagents · 2 running" });
  const sp = (id: string) => r(id, 1, { spawned: true });
  expect(childrenToggle([r("a", 1), r("b", 1), sp("x"), sp("y"), sp("z")]).label).toBe("2 subagents · 3 started");
  expect(childrenToggle([sp("x"), { ...sp("y"), status: "running" }]).said).toBe("2 started · 1 running");
  expect(kindCount([sp("x")])).toBe("1 started");
  expect(moreLabel([r("a", 1), r("b", 1)])).toBe("2 more subagents");
  expect(moreLabel([r("a", 1)])).toBe("1 more subagent");
  expect(moreLabel([sp("x"), sp("y")])).toBe("2 more started");
  expect(moreLabel([r("a", 1), sp("x"), sp("y")])).toBe("3 more: 1 subagent · 2 started");
});

test("a cached family is asked again when its session's or members' status or archived mark changes, or a main session appears", () => {
  const f = { parent: { id: "p", title: "P" }, children: [s("k1", 1), s("k2", 1)] };
  const sums = (over: Record<string, Partial<SessionSummary> | null> = {}) => {
    const base: Record<string, SessionSummary> = { me: s("me", 1), p: s("p", 1), k1: s("k1", 1), sub: s("sub", 1, { parentSessionId: "me" }), other: s("other", 1) };
    for (const [id, o] of Object.entries(over)) if (o === null) delete base[id]; else base[id] = { ...(base[id] ?? s(id, 1)), ...o };
    return { a: { epoch: "e", seq: 1, sessions: base } };
  };
  const key = familyKey(sums(), "a", "me", f);
  expect(key).toBe("me:idle,p:idle,k1:idle,k2:-");
  // Unrelated sessions don't change it.
  expect(familyKey(sums({ other: { status: "running" }, sub: { status: "running" } }), "a", "me", f)).toBe(key);
  expect(familyKey(sums({ me: { status: "running" } }), "a", "me", f)).not.toBe(key);
  expect(familyKey(sums({ k1: { status: "running" } }), "a", "me", f)).not.toBe(key);
  // Archived: marked while listed, "-" once it leaves the summaries.
  expect(familyKey(sums({ k1: { archived: true } }), "a", "me", f)).not.toBe(key);
  expect(familyKey(sums({ k1: null }), "a", "me", f)).toBe("me:idle,p:idle,k1:-,k2:-");
  // Main sessions only (where a started one appears): no subagents or side chats.
  expect(mainIds(sums({ side: { sideOf: "me" } }), "a").sort()).toEqual(["k1", "me", "other", "p"]);
});

test("open or closed is kept per device; closed is the default", () => {
  const m = memory();
  expect(loadChildrenOpen(m)).toBe(false);
  saveChildrenOpen(true, m);
  expect(loadChildrenOpen(m)).toBe(true);
  saveChildrenOpen(false, m);
  expect(loadChildrenOpen(m)).toBe(false);
  const broken = { getItem: () => { throw new Error("no"); }, setItem: () => { throw new Error("no"); }, removeItem: () => { throw new Error("no"); } };
  expect(loadChildrenOpen(broken)).toBe(false);
  expect(() => saveChildrenOpen(true, broken)).not.toThrow();
  expect(loadChildrenOpen(undefined)).toBe(false);
});
