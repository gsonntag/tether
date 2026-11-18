import { expect, test } from "bun:test";
import type { GitStatus, PrInfo } from "../../shared/gitActions";
import { actionsFor, branchLine, ghNote, prChip } from "./gitActions";

const pr = (p: Partial<PrInfo>): PrInfo => ({ number: 42, url: "https://github.com/o/r/pull/42", title: "Add git actions", state: "open", checks: "none", branch: "feature", ...p });

test("PR chip: number and state; checks while open, as a mark and a tone", () => {
  expect(prChip(pr({ checks: "passing" }))).toEqual({ text: "#42 · Open · ✓", tone: "ok", title: "Add git actions: open, checks passing. Opens on GitHub." });
  expect(prChip(pr({ checks: "failing" }))).toMatchObject({ text: "#42 · Open · ✗", tone: "bad" });
  expect(prChip(pr({ checks: "pending" }))).toMatchObject({ text: "#42 · Open · …", tone: "pending" });
  expect(prChip(pr({ checks: "none" }))).toMatchObject({ text: "#42 · Open", tone: "muted" });
  expect(prChip(pr({ state: "draft", checks: "pending" }))).toMatchObject({ text: "#42 · Draft · …", tone: "pending" });
  // done: checks no longer matter
  expect(prChip(pr({ state: "merged", checks: "failing" }))).toEqual({ text: "#42 · Merged", tone: "ok", title: "Add git actions: merged. Opens on GitHub." });
  expect(prChip(pr({ state: "closed", title: "" }))).toEqual({ text: "#42 · Closed", tone: "muted", title: "closed. Opens on GitHub." });
});

const st = (s: Partial<GitStatus>): GitStatus => ({ state: "ok", branch: "feature", head: "abc1234", ahead: 0, behind: 0, defaultBranch: "main", origin: true, changed: 0, ...s });

test("branch line: upstream, ahead and behind, not pushed, detached", () => {
  expect(branchLine(st({ upstream: "origin/feature", ahead: 2, behind: 1 }))).toBe("feature → origin/feature · 2 ahead · 1 behind");
  expect(branchLine(st({ upstream: "origin/feature" }))).toBe("feature → origin/feature · up to date");
  expect(branchLine(st({}))).toBe("feature · not pushed");
  expect(branchLine(st({ branch: undefined }))).toBe("detached at abc1234");
  expect(branchLine({ state: "notRepo", ahead: 0, behind: 0, origin: false, changed: 0 })).toBe("Not a git repository");
});

test("actions: what each can do now, and why not", () => {
  expect(actionsFor(st({ changed: 3 }), undefined)).toEqual({});
  expect(actionsFor(st({}), undefined).commit).toBe("Nothing to commit.");
  expect(actionsFor(st({ upstream: "origin/feature" }), undefined).push).toBe("Nothing to push.");
  expect(actionsFor(st({ origin: false }), undefined)).toMatchObject({ push: "No remote called origin.", pr: "No remote called origin." });
  expect(actionsFor(st({ branch: "main" }), undefined).pr).toBe("A PR needs a branch other than main.");
  expect(actionsFor(st({}), { gh: "missing", at: 0 }).pr).toBe("gh isn't installed on this computer.");
  expect(actionsFor(st({}), { gh: "ok", pr: pr({}), at: 0 }).pr).toBe("#42 is open for this branch.");
  expect(actionsFor(st({}), { gh: "ok", pr: pr({ state: "merged" }), at: 0 }).pr).toBeUndefined();
  expect(actionsFor(st({ branch: undefined, changed: 1 }), undefined).commit).toBe("HEAD is detached.");
});

test("gh notes: said plainly, nothing when fine", () => {
  expect(ghNote({ gh: "ok", at: 0 })).toBeUndefined();
  expect(ghNote({ gh: "unauthed", at: 0 })).toBe("gh isn't signed in on this computer. Run gh auth login there.");
  expect(ghNote({ gh: "noRemote", at: 0 })).toBeUndefined();
  expect(ghNote({ gh: "error", error: "HTTP 502", at: 0 })).toBe("gh: HTTP 502");
});
