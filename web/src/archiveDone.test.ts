import { expect, test } from "bun:test";
import { archiveDoneLabel, resultHeadline, resultRows } from "./archiveDone";

const row = (id: string, reason?: string) => ({ id, title: id, project: "/p", ...(reason ? { reason } : {}) });
const result = (archived: string[], kept: string[], skipped: string[]) => ({ id: "c1", at: 1, archived: archived.map((x) => row(x, "merged")), kept: kept.map((x) => row(x, "not done")), skipped: skipped.map((x) => row(x, "running")) });

test("the button says what's running", () => {
  expect(archiveDoneLabel(undefined, false)).toBe("Archive done sessions");
  expect(archiveDoneLabel({}, true)).toBe("Checking sessions…");
  expect(archiveDoneLabel({ running: { id: "c", at: 0, deadline: 1, asked: 8, answered: 2 } }, false)).toBe("Checking 8 sessions…");
  expect(archiveDoneLabel({ running: { id: "c", at: 0, deadline: 1, asked: 1, answered: 0 } }, false)).toBe("Checking 1 session…");
});

test("the headline covers nothing to check, nobody asked, nothing archived, and some archived", () => {
  expect(resultHeadline(result([], [], []))).toBe("No recent sessions to check.");
  expect(resultHeadline(result([], [], ["a", "b"]))).toBe("None of 2 sessions could be asked right now.");
  expect(resultHeadline(result([], ["a"], []))).toBe("Asked 1 session; none were done, so nothing was archived.");
  expect(resultHeadline(result(["a"], ["b", "c"], ["d"]))).toBe("Archived 1 of 3 sessions asked.");
});

test("rows list archived first, then kept, then not asked, each with its reason", () => {
  expect(resultRows(result(["a"], ["b"], ["c"])).map((r) => [r.kind, r.id, r.reason])).toEqual([
    ["archived", "a", "merged"],
    ["kept", "b", "not done"],
    ["skipped", "c", "running"],
  ]);
});
