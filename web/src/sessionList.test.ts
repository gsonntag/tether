import { expect, test } from "bun:test";
import type { SessionSummary } from "../../shared/transcript";
import { childrenOf, folderName, mergeRows, recentSessions } from "./sessionList";

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
