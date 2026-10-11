import { describe, expect, test } from "bun:test";
import type { ReviewFinding } from "./shared/protocol";
import { bySeverity, findingWhere, reviewAnchors } from "./shared/review";
import { canFork } from "./fork";
import { showInSidebar } from "./recentSessions";

const f = (file: string, severity: ReviewFinding["severity"], line?: number): ReviewFinding => ({ file, severity, issue: "x", fix: "", ...(line ? { line } : {}) });

describe("review card", () => {
  test("findings: most severe first, the reviewer's order within one; file and line", () => {
    const list = [f("a.ts", "low"), f("b.ts", "high", 3), f("c.ts", "critical"), f("d.ts", "high")].map((x, i) => ({ f: x, i }));
    expect(bySeverity(list).map((x) => x.i)).toEqual([2, 1, 3, 0]);
    expect(findingWhere(f("b.ts", "high", 3))).toBe("b.ts:3");
    expect(findingWhere(f("a.ts", "low"))).toBe("a.ts");
  });

  test("a card goes after the message it followed, else after the last one", () => {
    const msgs = [{ id: "u1" }, { id: "a1" }, { id: "u2" }];
    expect(reviewAnchors(msgs, [{ id: "r1", afterMsgId: "a1" }, { id: "r2", afterMsgId: "gone" }, { id: "r3" }])).toEqual([
      ["r1", "a1"],
      ["r2", "u2"],
      ["r3", "u2"],
    ]);
    expect(reviewAnchors([], [{ id: "r1" }])).toEqual([]);
  });

  test("a reviewer's prompt can't be forked from", () => {
    expect(canFork({ id: "u", role: "user", ts: 1, parts: [{ type: "text", text: "You are reviewing the changes another agent made" }] })).toBe(false);
  });

  test("review sessions stay out of the sidebar", () => {
    const s = { id: "codex:r", harness: "codex" as const, nativeId: "r", projectPath: "/p", title: "Review of x", createdAt: 0, updatedAt: Date.now(), live: true, status: "idle" as const, reviewOf: "claude-code:x" };
    expect(showInSidebar(s, { now: Date.now(), days: 3, notices: [], noticesSeen: 0, noticesRead: [] })).toBe(false);
  });
});
