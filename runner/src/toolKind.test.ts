import { describe, expect, test } from "bun:test";
import type { Msg, ToolKind } from "../../web/src/shared/protocol";
import { classifyTool, tagToolParts, tagToolPatch } from "./toolKind";

const kind = (name: string, input: unknown = {}, hint?: { kind?: ToolKind }) => classifyTool(name, input, hint).kind;

describe("classifyTool", () => {
  // Real names each harness emits (adapters, fixtures, guard.ts's list).
  const cases: [string, ToolKind, string[]][] = [
    ["claude-code", "shell", ["Bash", "Monitor"]],
    ["claude-code", "edit", ["Edit", "MultiEdit", "NotebookEdit"]],
    ["claude-code", "write", ["Write"]],
    ["claude-code", "read", ["Read", "LS"]],
    ["claude-code", "search", ["Glob", "Grep"]],
    ["claude-code", "fetch", ["WebFetch", "WebSearch"]],
    ["claude-code", "todo", ["TodoWrite"]],
    ["claude-code", "task", ["Task", "Agent"]],
    ["claude-code", "other", ["ExitPlanMode", "Skill", "ToolSearch", "BashOutput", "KillShell", "CronCreate", "AskUserQuestion", "mcp__fs__read_file"]],
    ["codex", "shell", ["bash"]],
    ["codex", "edit", ["apply_patch"]],
    ["codex", "read", ["view_image"]],
    ["codex", "fetch", ["web_search"]],
    ["codex", "task", ["Agent"]],
    ["codex", "todo", ["TodoWrite"]],
    ["pi", "shell", ["bash"]],
    ["pi", "read", ["read", "ls"]],
    ["pi", "write", ["write"]],
    ["pi", "edit", ["edit"]],
    ["pi", "search", ["grep", "find"]],
    ["opencode", "read", ["read", "list"]],
    ["opencode", "search", ["glob", "grep", "search"]],
    ["opencode", "edit", ["edit", "patch"]],
    ["opencode", "fetch", ["webfetch", "websearch", "codesearch", "fetch"]],
    ["opencode", "todo", ["todowrite"]],
    ["opencode", "task", ["task"]],
    ["antigravity", "shell", ["run_command"]],
    ["antigravity", "read", ["view_file", "view_file_outline", "view_code_item", "list_dir"]],
    ["antigravity", "edit", ["replace_file_content", "multi_replace_file_content"]],
    ["antigravity", "write", ["write_to_file"]],
    ["antigravity", "search", ["grep_search", "find_by_name", "codebase_search"]],
    ["antigravity", "fetch", ["read_url_content", "search_web"]],
    ["antigravity", "task", ["invoke_subagent"]],
    ["antigravity", "other", ["command_status", "send_command_input", "browser_click", "ask_question"]],
  ];
  for (const [harness, k, names] of cases) test(`${harness}: ${names.join(", ")} → ${k}`, () => expect(names.map((n) => kind(n))).toEqual(names.map(() => k)));

  test("unknown names go by their input", () => {
    expect(kind("str_replace_editor", { path: "a", old_string: "x", new_string: "y" })).toBe("edit");
    expect(kind("fancy_patch", { edits: [] })).toBe("edit");
    expect(kind("run_shell_thing", { command: "ls" })).toBe("shell");
    expect(kind("lookup", { command: "ls" })).toBe("other");
    expect(kind("todo_update", { todos: [] })).toBe("todo");
    expect(kind("mcp__x__edit", { old_string: "a" })).toBe("other");
  });

  test("an adapter's kind counts when the name says nothing", () => {
    expect(kind("Foo", {}, { kind: "read" })).toBe("read");
    expect(kind("write", {}, { kind: "edit" })).toBe("write"); // the name says more
    expect(kind("think", {}, { kind: "other" })).toBe("other");
  });

  test("display fields: a shell call's command, a file tool's path", () => {
    expect(classifyTool("Bash", { command: "ls -la", description: "list" })).toEqual({ kind: "shell", command: "ls -la" });
    expect(classifyTool("run_command", { CommandLine: "make", Cwd: "/p" })).toEqual({ kind: "shell", command: "make" });
    expect(classifyTool("exec_command", { cmd: ["git", "status"] })).toEqual({ kind: "shell", command: "git status" });
    // ACP: no command in the input, the title was it
    expect(classifyTool("bash", { description: "sudo ls" }, { kind: "shell", command: "sudo ls" })).toEqual({ kind: "shell", command: "sudo ls" });
    expect(classifyTool("Read", { file_path: "/p/a.ts", offset: 3 })).toEqual({ kind: "read", path: "/p/a.ts" });
    expect(classifyTool("edit", { filePath: "/p/a.ts" })).toEqual({ kind: "edit", path: "/p/a.ts" });
    expect(classifyTool("write_to_file", { TargetFile: "/p/b.ts", CodeContent: "x" })).toEqual({ kind: "write", path: "/p/b.ts" });
    expect(classifyTool("list_dir", { DirectoryPath: "/p" })).toEqual({ kind: "read", path: "/p" });
    // a search's folder isn't a file to open
    expect(classifyTool("Grep", { pattern: "x", path: "/p" })).toEqual({ kind: "search" });
  });
});

describe("tagging", () => {
  test("tool parts in messages", () => {
    const msgs: Msg[] = [{ id: "m", role: "assistant", ts: 0, parts: [{ type: "text", text: "hi" }, { type: "tool", id: "t", name: "Bash", input: { command: "ls" }, status: "running" }] }];
    tagToolParts(msgs);
    expect(msgs[0]!.parts[1]).toMatchObject({ kind: "shell", command: "ls" });
  });

  test("a patch that fills in the input (pi streams a call's arguments after its name)", () => {
    const part = { type: "tool" as const, id: "t", name: "edit", input: {}, status: "running" as const, kind: "edit" as const };
    const patch: any = { input: { path: "/p/a.ts", edits: [] } };
    tagToolPatch(() => part, patch);
    expect(patch).toMatchObject({ kind: "edit", path: "/p/a.ts" });
    // Output alone doesn't look the part up.
    tagToolPatch(() => {
      throw new Error("looked up");
    }, { output: "x" });
  });
});
