// What a tool call is, whatever the harness calls it (ported from v1): the transcript picks its card
// from `kind` instead of guessing from names. Adapters tag every tool part with classifyTool.

import type { ToolKind, ToolPart } from "../../../shared/transcript";

export type ToolTags = Pick<ToolPart, "kind" | "command" | "path">;

// Lowercased names: Claude Code (Bash, Read, MultiEdit, Monitor…) and Codex (bash, apply_patch,
// web_search, view_image…).
const NAMES: Record<string, ToolKind> = {};
const add = (kind: ToolKind, names: string) => names.split(" ").forEach((n) => (NAMES[n] = kind));
add("shell", "bash shell exec execute exec_command shell_command local_shell run_command monitor");
add("edit", "edit multiedit notebookedit notebook_edit str_replace str_replace_based_edit_tool apply_patch patch");
add("write", "write write_file create_file");
add("read", "read read_file view_file view_image notebookread ls list list_dir");
add("search", "glob grep find search grep_search codebase_search toolsearch");
add("fetch", "webfetch web_fetch fetch websearch web_search");
add("todo", "todowrite todo_write");
add("task", "task agent");

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

function commandOf(input: any): string | undefined {
  const c = input?.command ?? input?.cmd;
  return Array.isArray(c) ? c.join(" ") : str(c);
}

function pathOf(input: any): string | undefined {
  return str(input?.file_path ?? input?.filePath ?? input?.path ?? input?.notebook_path);
}

/** For a name we don't know: what its input looks like. */
function kindFromInput(name: string, input: any): ToolKind | undefined {
  if (Array.isArray(input?.edits) || ["old_string", "oldText", "oldString"].some((k) => input?.[k] !== undefined)) return "edit";
  if (commandOf(input) && /shell|bash|command|exec|terminal/i.test(name)) return "shell";
  if (Array.isArray(input?.todos) && /todo/i.test(name)) return "todo";
  return undefined;
}

/** Classifies one call: its kind, and the command or path the card shows. */
export function classifyTool(name: string, input: unknown): ToolTags & { kind: ToolKind } {
  const lower = name.toLowerCase();
  const mcp = lower.startsWith("mcp__");
  const kind = (!mcp && (NAMES[lower] ?? kindFromInput(lower, input))) || "other";
  const out: ToolTags & { kind: ToolKind } = { kind };
  const command = kind === "shell" ? commandOf(input) : undefined;
  const path = kind === "read" || kind === "edit" || kind === "write" ? pathOf(input) : undefined;
  if (command) out.command = command;
  if (path) out.path = path;
  return out;
}

/** A tool part from a call's id, name and input, running. */
export function toolPart(id: string, name: string, input: unknown): ToolPart {
  return { type: "tool", id, name, input, status: "running", ...classifyTool(name, input) };
}
