import { describe, expect, test } from "bun:test";
import { describeCall, relTo } from "./approvalCall";

const root = "/home/u/proj";

describe("the approval card's header", () => {
  test("shell: wants to run, with the command", () => {
    expect(describeCall("Bash", { command: "git push" }, root)).toEqual({ verb: "wants to run", command: "git push" });
    expect(describeCall("shell", { command: ["ls", "-la"] }, root)).toEqual({ verb: "wants to run", command: "ls -la" });
    expect(describeCall("run_command", { CommandLine: "make" }, root).command).toBe("make");
  });
  test("edit and write, relative to the project", () => {
    expect(describeCall("Edit", { file_path: `${root}/src/a.ts`, old_string: "a", new_string: "b" }, root, true).verb).toBe("wants to edit src/a.ts");
    expect(describeCall("Write", { file_path: `${root}/b.ts`, content: "x" }, root).verb).toBe("wants to write b.ts");
    expect(describeCall("write_to_file", { TargetFile: `${root}/c.ts`, CodeContent: "x" }, root, true).verb).toBe("wants to edit c.ts");
  });
  test("read, MCP, url, anything else", () => {
    expect(describeCall("Read", { file_path: "/home/u/notes.md" }, root).verb).toBe("wants to read ~/notes.md");
    expect(describeCall("mcp__github__create_issue", { title: "x" }, root)).toEqual({ verb: "wants to call github", server: "create_issue" });
    expect(describeCall("WebFetch", { url: "https://example.com" }, root).verb).toBe("wants to fetch https://example.com");
    expect(describeCall("TodoWrite", { todos: [] }, root).verb).toBe("wants to use TodoWrite");
  });
  test("relTo: inside the project, under home, elsewhere", () => {
    expect(relTo(`${root}/a/b`, root + "/")).toBe("a/b");
    expect(relTo("/home/u/other/x", root)).toBe("~/other/x");
    expect(relTo("/etc/hosts", root)).toBe("/etc/hosts");
  });
});
