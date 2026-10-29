import { expect, test } from "bun:test";
import type { SessionSummary } from "../../shared/transcript";
import { childrenOf, folderName, mergeRows, recentSessions, waitingOn } from "./sessionList";

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
