// A side chat's read-only gate on Claude Code (SPEC §16a). Claude Code's plan mode doesn't stop a
// shell command that writes (checked on 2.1.327: in plan mode, with "auto" as the person's default,
// `echo hello > f` ran without asking), so a read-only session gets a PreToolUse hook that denies
// every tool but an explicit list of ones that only read. No shell at all (no list of "reading"
// commands survives quoting and options), no MCP tools, no subagents. A hook's deny stands over
// modes, allow rules and the auto classifier. The hook fails closed: anything it can't read is
// denied. The core also refuses its approvals, so a read the mode would ask about (a file outside
// the folder) is refused too.

import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { SIDE_READ_ONLY } from "../../../../shared/sideChat";

/** The only tools a read-only session runs: they read (or ask the person). Anything else is denied. */
export const READ_TOOLS: ReadonlySet<string> = new Set(["Read", "Grep", "Glob", "LS", "NotebookRead", "WebFetch", "WebSearch", "TodoWrite", "ToolSearch", "AskUserQuestion"]);

/** Why a tool call is refused in a read-only session; undefined when it only reads. */
export function readOnlyRefusal(tool: unknown): string | undefined {
  return typeof tool === "string" && READ_TOOLS.has(tool) ? undefined : SIDE_READ_ONLY;
}

const deny = (why: string) => ({ hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "deny" as const, permissionDecisionReason: why } });

/** The PreToolUse hook that keeps a session read-only. */
export const readOnlyGate: HookCallback = async (input) => {
  try {
    if (input.hook_event_name !== "PreToolUse") return {};
    const why = readOnlyRefusal(input.tool_name);
    return why ? deny(why) : {};
  } catch {
    return deny(SIDE_READ_ONLY);
  }
};

/** What the model is told, appended to its system prompt. */
export const READ_ONLY_PROMPT = "You are in a read-only side chat beside the person's main session. Answer their questions by reading files (Read, Grep, Glob): you have no shell, can't edit files, run commands or start subagents. Don't plan work or ask to leave this mode; if something needs changing, say what, for the main session to do.";
