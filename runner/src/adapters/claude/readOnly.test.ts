import { expect, test } from "bun:test";
import { SIDE_READ_ONLY } from "../../../../shared/sideChat";
import { readOnlyBash, readOnlyGate, readOnlyRefusal } from "./readOnly";

test("only reading tools pass", () => {
  for (const t of ["Read", "Grep", "Glob", "WebFetch", "AskUserQuestion", "mcp__tether__tether_sessions"]) expect(readOnlyRefusal(t, {})).toBeUndefined();
  for (const t of ["Write", "Edit", "MultiEdit", "NotebookEdit", "Agent", "Task", "ExitPlanMode", "Skill", "mcp__tether__tether_send", "mcp__other__anything"]) expect(readOnlyRefusal(t, {})).toBe(SIDE_READ_ONLY);
});

test("a shell command passes only when it plainly reads", () => {
  for (const c of ["ls -la", "cat src/a.ts", "git log --oneline -5", "git diff HEAD~1", "git status", "rg -n foo src", "find . -name '*.ts'", "head -n 20 README.md"]) expect(readOnlyBash(c)).toBe(true);
  for (const c of [
    "echo hello > f",
    "cat a >> b",
    "ls; rm -rf x",
    "ls && touch x",
    "cat a | tee b",
    "ls $(touch x)",
    "ls `touch x`",
    "touch x",
    "rm x",
    "sed -i s/a/b/ f",
    "find . -delete",
    "find . -exec rm {} +",
    "git commit -m x",
    "git -c core.pager=x log",
    "git diff --output=f",
    "git checkout .",
    "rg --pre=sh foo",
    "python -c 1",
    "",
  ])
    expect(readOnlyBash(c)).toBe(false);
  expect(readOnlyRefusal("Bash", { command: "git log" })).toBeUndefined();
  expect(readOnlyRefusal("Bash", { command: "echo hi > x" })).toBe(SIDE_READ_ONLY);
});

test("the hook denies with the reason the model reads", async () => {
  const deny = await readOnlyGate({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: "x" } } as any, "t", { signal: new AbortController().signal });
  expect(deny).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: SIDE_READ_ONLY } });
  expect(await readOnlyGate({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: {} } as any, "t", { signal: new AbortController().signal })).toEqual({});
});
