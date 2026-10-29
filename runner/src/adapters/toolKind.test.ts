import { expect, test } from "bun:test";
import { classifyTool } from "./toolKind";

test("tool calls are classified by what they do", () => {
  expect(classifyTool("Bash", { command: "ls -la" })).toEqual({ kind: "shell", command: "ls -la" });
  expect(classifyTool("Edit", { file_path: "/a.ts", old_string: "a", new_string: "b" })).toEqual({ kind: "edit", path: "/a.ts" });
  expect(classifyTool("Write", { file_path: "/b.ts", content: "x" })).toEqual({ kind: "write", path: "/b.ts" });
  expect(classifyTool("Read", { file_path: "/c.ts" })).toEqual({ kind: "read", path: "/c.ts" });
  expect(classifyTool("Grep", { pattern: "x" }).kind).toBe("search");
  expect(classifyTool("WebFetch", { url: "https://x" }).kind).toBe("fetch");
  expect(classifyTool("TodoWrite", { todos: [] }).kind).toBe("todo");
  expect(classifyTool("Agent", { prompt: "x" }).kind).toBe("task");
  expect(classifyTool("Task", { prompt: "x" }).kind).toBe("task");
  expect(classifyTool("mcp__github__edit", { old_string: "a" }).kind).toBe("other");
  expect(classifyTool("custom_shell_runner", { command: "make" })).toEqual({ kind: "shell", command: "make" });
});
