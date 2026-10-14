// What a tool call is, whatever the harness calls it: the transcript picks its card from `kind`
// (web/src/components/Transcript.tsx) instead of guessing from names. Every tool part goes
// through tagToolParts / tagToolPatch on its way out of LiveSession.emit.

import type { Msg, Part, ToolKind } from "../../web/src/shared/protocol";

type ToolPart = Extract<Part, { type: "tool" }>;
export type ToolTags = Pick<ToolPart, "kind" | "command" | "path">;

// Lowercased names, by harness: Claude Code (Bash, Read, MultiEdit, Monitor…), Codex (bash,
// apply_patch, web_search, view_image, Agent, TodoWrite as runner/src/adapters/codex.ts names its
// items), pi (bash, read, write, edit, ls, grep, find), opencode and Kiro over ACP (their own names,
// or acp.ts's KIND_NAMES), Antigravity (run_command, view_file, replace_file_content…).
const NAMES: Record<string, ToolKind> = {};
const add = (kind: ToolKind, names: string) => names.split(" ").forEach((n) => (NAMES[n] = kind));
add("shell", "bash shell exec execute exec_command shell_command local_shell run_command run_terminal_cmd monitor");
add("edit", "edit multiedit notebookedit notebook_edit str_replace str_replace_based_edit_tool replace_file_content multi_replace_file_content apply_patch patch sed_file");
add("write", "write write_file write_to_file create_file");
add("read", "read read_file view_file view_file_outline view_code_item view_image notebookread ls list list_dir");
add("search", "glob grep find search grep_search find_by_name codebase_search");
add("fetch", "webfetch web_fetch fetch websearch web_search search_web read_url_content codesearch");
add("todo", "todowrite todo_write");
add("task", "task agent invoke_subagent");

/** Kinds ACP reports (ToolKind in the Agent Client Protocol), for names we don't know. */
export const ACP_KINDS: Record<string, ToolKind> = { execute: "shell", edit: "edit", read: "read", search: "search", fetch: "fetch" };

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

function commandOf(input: any): string | undefined {
  const c = input?.command ?? input?.CommandLine ?? input?.cmd;
  return Array.isArray(c) ? c.join(" ") : str(c);
}

function pathOf(input: any): string | undefined {
  return str(input?.file_path ?? input?.filePath ?? input?.filepath ?? input?.path ?? input?.notebook_path ?? input?.AbsolutePath ?? input?.TargetFile ?? input?.DirectoryPath);
}

/** For a name we don't know: what its input looks like. */
function kindFromInput(name: string, input: any): ToolKind | undefined {
  if (Array.isArray(input?.edits) || ["old_string", "oldText", "oldString", "TargetContent", "ReplacementChunks"].some((k) => input?.[k] !== undefined)) return "edit";
  if (commandOf(input) && /shell|bash|command|exec|terminal/i.test(name)) return "shell";
  if (Array.isArray(input?.todos) && /todo/i.test(name)) return "todo";
  return undefined;
}

/**
 * Classifies one call. `hint` is what the adapter already knows (ACP sends a kind; an ACP shell
 * call's title is its command): the name wins when it says more.
 */
export function classifyTool(name: string, input: unknown, hint: ToolTags = {}): ToolTags & { kind: ToolKind } {
  const lower = name.toLowerCase();
  const mcp = lower.startsWith("mcp__");
  const kind = (!mcp && (NAMES[lower] ?? kindFromInput(lower, input))) || (hint.kind && hint.kind !== "other" ? hint.kind : "other");
  const out: ToolTags & { kind: ToolKind } = { kind };
  const command = kind === "shell" ? (commandOf(input) ?? hint.command) : undefined;
  const path = kind === "read" || kind === "edit" || kind === "write" ? (pathOf(input) ?? hint.path) : undefined;
  if (command) out.command = command;
  if (path) out.path = path;
  return out;
}

/** Tags every tool part in place. */
export function tagToolParts(messages: Msg[]): void {
  for (const m of messages) for (const p of m.parts) if (p.type === "tool") Object.assign(p, classifyTool(p.name, p.input, p));
}

/** Tags a tool patch that changes the call's name, input or kind, against the part it patches (looked up only then). */
export function tagToolPatch(find: () => ToolPart | undefined, patch: Partial<ToolPart>): void {
  if (patch.name === undefined && patch.input === undefined && patch.kind === undefined) return;
  const part = find();
  const hint = { kind: patch.kind ?? part?.kind, command: patch.command ?? part?.command, path: patch.path ?? part?.path };
  Object.assign(patch, classifyTool(patch.name ?? part?.name ?? "", patch.input ?? part?.input, hint));
}
