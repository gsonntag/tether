import { expect, test } from "bun:test";
import { SIDE_READ_ONLY } from "../../../../shared/sideChat";
import { readOnlyGate, readOnlyOptions, readOnlyRefusal } from "./readOnly";

const signal = { signal: new AbortController().signal };
const gate = async (input: unknown): Promise<unknown> => readOnlyGate(input as any, "t", signal);
const denied: unknown = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: SIDE_READ_ONLY } };

test("only the listed reading tools pass", () => {
  for (const t of ["Read", "Grep", "Glob", "WebSearch", "AskUserQuestion"]) expect(readOnlyRefusal(t)).toBeUndefined();
  // No shell at all, however harmless the command; no MCP tool (Tether's included); no subagents.
  for (const t of ["WebFetch", "Bash", "BashOutput", "Write", "Edit", "MultiEdit", "NotebookEdit", "Agent", "Task", "ExitPlanMode", "Skill", "mcp__tether__tether_sessions", "mcp__tether__tether_send", "mcp__other__anything", "SomethingNew", "", undefined, 3]) expect(readOnlyRefusal(t)).toBe(SIDE_READ_ONLY);
});

test("the hook denies with the reason the model reads, and fails closed", async () => {
  expect(await gate({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } })).toEqual(denied);
  expect(await gate({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: {} })).toEqual({});
  expect(await gate({ hook_event_name: "PreToolUse" })).toEqual(denied);
  // Something it can't read at all.
  expect(await gate(null)).toEqual(denied);
  const trap = { hook_event_name: "PreToolUse", get tool_name() { throw new Error("x"); } };
  expect(await gate(trap)).toEqual(denied);
});

test("a read-only start: the gate, none of the person's hooks, the prompt; nothing otherwise", () => {
  const ro = readOnlyOptions(true);
  expect(ro.preToolUse[0]!.hooks[0]).toBe(readOnlyGate);
  expect(ro.settings).toEqual({ disableAllHooks: true });
  expect(ro.append).toContain("read-only side chat");
  expect(readOnlyOptions(undefined)).toEqual({ preToolUse: [], settings: {}, append: undefined });
});
