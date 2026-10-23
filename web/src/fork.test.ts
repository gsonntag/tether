import { describe, expect, test } from "bun:test";
import { canFork, forkExcerpt, forkTarget } from "./fork";
import type { Msg } from "./shared/protocol";

const msg = (m: Partial<Msg>): Msg => ({ id: "m", role: "user", parts: [], ts: 1, ...m }) as Msg;

describe("Fork from here", () => {
  test("offered on your messages and finished replies only", () => {
    expect(canFork(msg({ parts: [{ type: "text", text: "Fix it" }] }))).toBe(true);
    expect(canFork(msg({ role: "assistant", parts: [{ type: "text", text: "Done" }] }))).toBe(true);
    expect(canFork(msg({ role: "assistant", streaming: true, parts: [{ type: "text", text: "Wor" }] }))).toBe(false);
    expect(canFork(msg({ role: "notice", parts: [{ type: "text", text: "Goal set." }] }))).toBe(false);
    expect(canFork(msg({ parts: [{ type: "text", text: "You are taking over an in-progress coding session from another agent" }] }))).toBe(false);
    expect(canFork(msg({ parts: [{ type: "tool", id: "t", name: "Bash", input: {}, status: "done" }] }))).toBe(false);
  });

  test("the dialog's target", () => {
    const m = msg({ id: "u1", parts: [{ type: "text", text: "Fix   the\nlogin bug" }] });
    expect(forkTarget("claude-code:1", m, "claude-code", "opus")).toEqual({ sessionId: "claude-code:1", msgId: "u1", harness: "claude-code", model: "opus", atUser: true, excerpt: "Fix the login bug" });
    expect(forkTarget("codex:1", m, "codex", "gpt-6-luna", "azure:east").model).toBe("gpt-6-luna#azure:east");
    expect(forkTarget("codex:1", m, "codex", undefined, "azure:east").model).toBeUndefined();
    expect(forkExcerpt(msg({ parts: [{ type: "text", text: "x".repeat(100) }] }), 10)).toBe("xxxxxxxxxx…");
  });
});
