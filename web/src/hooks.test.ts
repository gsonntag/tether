import { describe, expect, test } from "bun:test";
import { hookJson, hookLabel } from "./hooks";

describe("hook labels", () => {
  test("tool events name the matcher", () => {
    expect(hookLabel({ event: "PreToolUse", matcher: "Bash" })).toBe("Before Bash");
    expect(hookLabel({ event: "PostToolUse", matcher: "Edit|Write" })).toBe("After Edit, Write");
    expect(hookLabel({ event: "PreToolUse", matcher: "" })).toBe("Before every tool");
  });
  test("other events ignore the matcher", () => {
    expect(hookLabel({ event: "Stop", matcher: "Bash" })).toBe("When a turn ends");
    expect(hookLabel({ event: "UserPromptSubmit", matcher: "" })).toBe("Before your message goes out");
  });
  test("JSON round-trips the Claude shape", () => {
    const j = JSON.parse(hookJson({ event: "PreToolUse", matcher: "Bash", hooks: [{ type: "command", command: "x", timeout: 5 }] }));
    expect(j).toEqual({ event: "PreToolUse", matcher: "Bash", hooks: [{ type: "command", command: "x", timeout: 5 }] });
    expect(JSON.parse(hookJson({ event: "Stop", matcher: "", hooks: [] })).matcher).toBeUndefined();
  });
});
