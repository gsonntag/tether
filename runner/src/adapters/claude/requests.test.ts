import { expect, test } from "bun:test";
import { claudeAsk, claudeResult } from "./requests";

// Inputs and options as canUseTool received them from Claude Code 2.1.312 (probed 2026-10-29).

test("a tool approval carries what its card shows and why Claude Code asks", () => {
  const input = { command: "cd /tmp && ls", description: "List tmp" };
  const ask = claudeAsk("Bash", input, { toolUseID: "toolu_1", displayName: "Bash", description: "List tmp", decisionReason: "Multiple directory changes in one command require approval for clarity" });
  expect(ask).toEqual({ kind: "approval", tool: "Bash", input, toolId: "toolu_1", toolKind: "shell", command: "cd /tmp && ls", reason: "Multiple directory changes in one command require approval for clarity" });
  expect(claudeResult(ask, input, { allow: true })).toEqual({ behavior: "allow", updatedInput: input });
  expect(claudeResult(ask, input, { allow: false, reason: "no", interrupt: true })).toEqual({ behavior: "deny", message: "no", interrupt: true });
  expect(claudeResult(ask, input, { allow: false, reason: "no" })).toEqual({ behavior: "deny", message: "no" });
  const w = claudeAsk("Write", { file_path: "/p/notes.txt", content: "hello\n" }, { toolUseID: "t", blockedPath: "/etc" });
  expect(w).toMatchObject({ toolKind: "write", path: "/p/notes.txt", reason: "It touches /etc, outside the folders Claude may use." });
});

test("AskUserQuestion is a question; the answers go back keyed by question text", () => {
  const input = {
    questions: [
      { question: "Which color do you prefer?", header: "Color", options: [{ label: "Red", description: "Save Red" }, { label: "Blue", description: "Save Blue" }], multiSelect: false },
      { question: "Which sizes?", header: "Size", options: [{ label: "S" }, { label: "M" }], multiSelect: true },
    ],
  };
  const ask = claudeAsk("AskUserQuestion", input, { toolUseID: "t" });
  expect(ask).toMatchObject({ kind: "question", question: "Which color do you prefer?", options: ["Red", "Blue"] });
  expect(ask.questions![0]).toEqual({ question: "Which color do you prefer?", header: "Color", options: [{ label: "Red", description: "Save Red" }, { label: "Blue", description: "Save Blue" }] });
  expect(ask.questions![1]!.multiSelect).toBe(true);
  expect(claudeResult(ask, input, { allow: true, answers: ["Blue", "S, M"] })).toEqual({
    behavior: "allow",
    updatedInput: { ...input, answers: { "Which color do you prefer?": "Blue", "Which sizes?": "S, M" } },
  });
});

test("ExitPlanMode is a plan to approve; approving may switch the mode", () => {
  const input = { plan: "# Plan\n1. Add subtract", planFilePath: "/home/u/.claude/plans/x.md" };
  const ask = claudeAsk("ExitPlanMode", input, { toolUseID: "t" });
  expect(ask).toMatchObject({ kind: "approval", plan: "# Plan\n1. Add subtract", approveAs: [{ id: "acceptEdits" }] });
  expect(claudeResult(ask, input, { allow: true })).toEqual({ behavior: "allow", updatedInput: input });
  expect(claudeResult(ask, input, { allow: true, mode: "acceptEdits" })).toEqual({
    behavior: "allow",
    updatedInput: input,
    updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
  });
});
