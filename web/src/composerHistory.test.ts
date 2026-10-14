import { describe, expect, test } from "bun:test";
import { composerHistory, isInjected } from "./composerHistory";
import type { Msg } from "./shared/protocol";

const user = (text: string): Msg => ({ id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text }], ts: 0 });

describe("composer history", () => {
  test("Tether's own user messages are left out", () => {
    for (const t of [
      "[Tether goal] Continue working toward the goal: ship it",
      "I approve the plan as it stands. Implement it now.",
      "Implement the plan.",
      "Implement the plan.\n\nNotes for the work:\n\nkeep it small",
      "Your blocked command was run by the user instead, so don't run it again:\n<bash-input>ls</bash-input>",
      "PostToolUse hook feedback for Bash:\nlint failed",
      "Stop hook feedback:\nrun the tests",
    ])
      expect(isInjected(t)).toBe(true);
    expect(isInjected("Implement the plan, but skip step 2")).toBe(false);
    expect(composerHistory([user("fix the bug"), user("Stop hook feedback:\ntests"), user("  "), user("now add a test")])).toEqual(["fix the bug", "now add a test"]);
  });
});
