import { expect, test } from "bun:test";
import { checksOf, cleanMessage, outputTail, parsePr, splitTitleBody } from "./gitActions";

test("checks: any failure fails, else unfinished is pending, else passing; none when empty", () => {
  expect(checksOf(undefined)).toBe("none");
  expect(checksOf([])).toBe("none");
  const run = (status: string, conclusion = "") => ({ __typename: "CheckRun", status, conclusion });
  const ctx = (state: string) => ({ __typename: "StatusContext", state });
  expect(checksOf([run("COMPLETED", "SUCCESS"), run("COMPLETED", "SKIPPED"), ctx("SUCCESS")])).toBe("passing");
  expect(checksOf([run("COMPLETED", "SUCCESS"), run("IN_PROGRESS")])).toBe("pending");
  expect(checksOf([run("QUEUED"), ctx("PENDING")])).toBe("pending");
  expect(checksOf([run("IN_PROGRESS"), run("COMPLETED", "FAILURE")])).toBe("failing");
  expect(checksOf([ctx("ERROR"), run("COMPLETED", "SUCCESS")])).toBe("failing");
  expect(checksOf([run("COMPLETED", "TIMED_OUT")])).toBe("failing");
});

test("parsePr: state from state and isDraft; not a PR is undefined", () => {
  const base = { number: 7, url: "https://github.com/o/r/pull/7", title: "T", headRefName: "f", statusCheckRollup: [] };
  expect(parsePr({ ...base, state: "OPEN", isDraft: false })).toEqual({ number: 7, url: base.url, title: "T", state: "open", checks: "none", branch: "f" });
  expect(parsePr({ ...base, state: "OPEN", isDraft: true })?.state).toBe("draft");
  expect(parsePr({ ...base, state: "MERGED", isDraft: true })?.state).toBe("merged");
  expect(parsePr({ ...base, state: "CLOSED" })?.state).toBe("closed");
  expect(parsePr({ message: "no" })).toBeUndefined();
  expect(parsePr(null)).toBeUndefined();
});

test("generated text: fences and quotes dropped, PR title and body split", () => {
  expect(cleanMessage("```\nFix the thing\n\nBecause.\n```")).toBe("Fix the thing\n\nBecause.");
  expect(cleanMessage('"Add tests"')).toBe("Add tests");
  expect(cleanMessage("A  \n\n\n\nB")).toBe("A\n\nB");
  expect(splitTitleBody("Title: Add git actions\n\nBody: Commit, push and PRs.")).toEqual({ title: "Add git actions", body: "Commit, push and PRs." });
  expect(splitTitleBody("# One line")).toEqual({ title: "One line", body: "" });
});

test("output tail: color dropped, the end kept", () => {
  expect(outputTail("\x1b[31mred\x1b[0m\n")).toBe("red");
  expect(outputTail("abcdefghij", 5)).toBe("…ghij");
});
