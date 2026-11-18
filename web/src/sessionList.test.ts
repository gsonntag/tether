import { expect, test } from "bun:test";
import type { SessionSummary } from "../../shared/transcript";
import { childrenOf, folderName, mergeRows, pinMenuLabel, recentSessions, setHomeFolders, splitPinned, waitingOn , inbox } from "./sessionList";

const s = (id: string, updatedAt: number, extra: Partial<SessionSummary> = {}): SessionSummary => ({ id, harness: "claude", nativeId: id, projectPath: "/p/web", title: `T ${id}`, mode: "stored", status: "idle", updatedAt, ...extra });
const summaries = {
  a: { epoch: "e", seq: 1, sessions: { x: s("x", 3), y: s("y", 5), c: s("c", 9, { parentSessionId: "x" }) } },
  b: { epoch: "f", seq: 1, sessions: { z: s("z", 4, { title: "Fix login" }) } },
};

test("recent sessions merge runners, newest first, without subagents; search by title", () => {
  expect(recentSessions(summaries).map((r) => `${r.runnerId}:${r.id}`)).toEqual(["a:y", "b:z", "a:x"]);
  expect(recentSessions(summaries, "login").map((r) => r.id)).toEqual(["z"]);
  expect(childrenOf(summaries, "a", "x").map((r) => r.id)).toEqual(["c"]);
  expect(childrenOf(summaries, "b", "x")).toEqual([]);
});

test("merging keeps one row per session; folder names", () => {
  const a = [{ ...s("x", 1), runnerId: "a" }];
  const b = [{ ...s("x", 7), runnerId: "a" }, { ...s("y", 2), runnerId: "a" }];
  expect(mergeRows(a, b).map((r) => `${r.id}${r.updatedAt}`)).toEqual(["x7", "y2"]);
  expect(folderName("/home/me/web/")).toBe("web");
});

test("sessions waiting on you, per runner, without subagents (their parent counts them)", () => {
  const row = (id: string, over: object) => ({ id, harness: "claude", nativeId: id, projectPath: "/p", title: id, mode: "live", status: "waiting", updatedAt: 1, ...over });
  const summaries = {
    r1: { seq: 1, sessions: { a: row("a", { requests: 2, updatedAt: 5 }), b: row("b", {}), c: row("c", { requests: 1, updatedAt: 2 }), d: row("d", { requests: 1, parentSessionId: "a" }) } },
    r2: { seq: 1, sessions: { e: row("e", { requests: 1 }) } },
  };
  expect(waitingOn(summaries as any, "r1").map((r: any) => r.id)).toEqual(["c", "a"]);
});

test("background subagents running: the session reads as working, and not as finished until they end", () => {
  const row = (over: object) => ({ id: "a", harness: "codex", nativeId: "a", projectPath: "/p", title: "a", mode: "live", status: "idle", updatedAt: 1, ...over });
  const at = (over: object) => inbox({ r1: { seq: 1, sessions: { a: row(over) } } } as any)[0]?.inbox;
  expect(at({ backgroundSubagents: 2, unread: "finished" })).toBe("working");
  expect(at({ unread: "finished" })).toBe("finished");
  expect(at({ backgroundSubagents: 1, requests: 1 })).toBe("needs");
  expect(at({})).toBeUndefined();
  expect(recentSessions({ r1: { seq: 1, sessions: { a: row({ backgroundSubagents: 1 }) } } } as any)[0]!.status).toBe("running");
});

test("archived sessions: out of Recent unless searching, still on Home while they need you or work", () => {
  const sums = {
    a: { epoch: "e", seq: 1, sessions: { x: s("x", 3, { archived: true, title: "Old fix" }), y: s("y", 5), w: s("w", 6, { archived: true, requests: 1 }), r: s("r", 7, { archived: true, status: "running" }) } },
  };
  expect(recentSessions(sums).map((r) => r.id)).toEqual(["y"]);
  expect(recentSessions(sums, "old").map((r) => r.id)).toEqual(["x"]);
  expect(inbox(sums).map((r) => `${r.id}:${r.inbox}`)).toEqual(["w:needs", "r:working"]);
});

test("pinned sessions: their own group in pin order across runners, out of the rest; never an archived one", () => {
  const sums = {
    a: { epoch: "e", seq: 1, sessions: { x: s("x", 3, { pinned: 20 }), y: s("y", 5), w: s("w", 1, { pinned: 30, archived: true }) } },
    b: { epoch: "f", seq: 1, sessions: { z: s("z", 4, { pinned: 10 }), v: s("v", 9) } },
  };
  const { pinned, rest } = splitPinned(recentSessions(sums));
  expect(pinned.map((r) => `${r.runnerId}:${r.id}`)).toEqual(["b:z", "a:x"]);
  expect(rest.map((r) => r.id)).toEqual(["v", "y"]);
  // searching shows the archived one, still not as pinned
  expect(splitPinned(recentSessions(sums, "T w")).rest.map((r) => r.id)).toEqual(["w"]);
});

test("the session menu's pin item: only for a main, listed session on a runner that pins", () => {
  setHomeFolders([{ id: "a", homeFolder: "/home/agent" }]);
  expect(pinMenuLabel("a", s("x", 1), true)).toBe("Pin");
  expect(pinMenuLabel("a", s("x", 1, { pinned: 3 }), true)).toBe("Unpin");
  expect(pinMenuLabel("a", s("x", 1), false)).toBeUndefined();
  expect(pinMenuLabel("a", s("x", 1, { archived: true }), true)).toBeUndefined();
  expect(pinMenuLabel("a", s("x", 1, { parentSessionId: "y" }), true)).toBeUndefined();
  expect(pinMenuLabel("a", s("x", 1, { projectPath: "/home/agent" }), true)).toBeUndefined();
  setHomeFolders([]);
});
