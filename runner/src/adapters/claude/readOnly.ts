// A side chat's read-only gate on Claude Code (SPEC §16a). Claude Code's plan mode doesn't stop a
// shell command that writes (checked on 2.1.327: in plan mode, with "auto" as the person's default,
// `echo hello > f` ran without asking), so a read-only session gets a PreToolUse hook that denies
// every tool but the ones that only read. A hook's deny stands over modes, allow rules and the
// auto classifier, and it covers subagents' calls too. The core also refuses its approvals.

import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { SIDE_READ_ONLY } from "../../../../shared/sideChat";

/** Tools that only read (or ask the person). Anything else is denied. */
const READ_TOOLS = new Set(["Read", "Grep", "Glob", "LS", "NotebookRead", "WebFetch", "WebSearch", "TodoWrite", "ToolSearch", "ListMcpResourcesTool", "ReadMcpResourceTool", "AskUserQuestion", "BashOutput", "mcp__tether__tether_sessions"]);

/** Commands that only read, and the arguments that would make them write or run something. */
const READ_COMMANDS: Record<string, RegExp | undefined> = {
  ls: undefined,
  cat: undefined,
  head: undefined,
  tail: undefined,
  wc: undefined,
  pwd: undefined,
  grep: undefined,
  rg: /^--pre/,
  find: /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/,
  git: /^(-o|--output|--ext-diff|-c$)/,
};
const GIT_READS = new Set(["log", "show", "diff", "status", "blame", "rev-parse", "ls-files", "grep"]);

/** A shell command that only reads: one plain command, nothing redirected, piped or substituted. */
export function readOnlyBash(command: string): boolean {
  if (/[;&|<>`$(){}\\\n\r]/.test(command)) return false;
  const words = command.trim().split(/\s+/);
  const [name, ...args] = words;
  if (!name || !(name in READ_COMMANDS)) return false;
  const bad = READ_COMMANDS[name];
  if (bad && args.some((a) => bad.test(a))) return false;
  if (name === "git") return GIT_READS.has(args.find((a) => !a.startsWith("-")) ?? "") && !args.some((a) => a.startsWith("--output"));
  return true;
}

/** Why a tool call is refused in a read-only session; undefined when it only reads. */
export function readOnlyRefusal(tool: string, input: unknown): string | undefined {
  if (READ_TOOLS.has(tool)) return undefined;
  if (tool === "Bash" && readOnlyBash(String((input as { command?: unknown })?.command ?? ""))) return undefined;
  return SIDE_READ_ONLY;
}

/** The PreToolUse hook that keeps a session read-only. */
export const readOnlyGate: HookCallback = async (input) => {
  if (input.hook_event_name !== "PreToolUse") return {};
  const why = readOnlyRefusal(input.tool_name, input.tool_input);
  return why ? { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: why } } : {};
};

/** What the model is told, appended to its system prompt. */
export const READ_ONLY_PROMPT = "You are in a read-only side chat beside the person's main session. Answer their questions by reading: you can't edit files, run commands that change anything, or start subagents. Don't plan work or ask to leave this mode; if something needs changing, say what, for the main session to do.";
