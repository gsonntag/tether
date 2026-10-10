import { describe, expect, test } from "bun:test";
import { rules } from "../guard";
import { configOption, OPENCODE_ENV, permissionCall, selectValues, sessionModes, toolName } from "./acp";

// Shapes below are what opencode 1.18 sends over `opencode acp`.
const OPTIONS = [
  { id: "model", category: "model", type: "select", currentValue: "opencode/big-pickle", options: [{ value: "opencode/big-pickle", name: "Big Pickle" }] },
  { id: "effort", category: "thought_level", type: "select", currentValue: "default", options: [{ value: "high", name: "High" }, { value: "default", name: "Default" }] },
  { id: "mode", category: "mode", type: "select", currentValue: "build", options: [{ value: "build", name: "build" }, { value: "plan", name: "plan" }] },
];

describe("config options", () => {
  test("by category", () => {
    expect(configOption(OPTIONS, "model").id).toBe("model");
    expect(selectValues(configOption(OPTIONS, "thought")).map((v) => v.value)).toEqual(["high", "default"]);
  });
  test("modes from a mode option (opencode)", () => expect(sessionModes({ configOptions: OPTIONS })).toEqual({ ids: ["build", "plan"], current: "build" }));
  test("modes from the modes field", () =>
    expect(sessionModes({ modes: { currentModeId: "a", availableModes: [{ id: "a" }, { id: "b" }] } })).toEqual({ ids: ["a", "b"], current: "a" }));
  test("no modes", () => expect(sessionModes({ configOptions: OPTIONS.slice(0, 1) })).toBeUndefined());
});

describe("toolName", () => {
  test("opencode tool id in the first title", () => {
    expect(toolName({ title: "write", kind: "edit", rawInput: {} })).toBe("write");
    expect(toolName({ title: "glob", kind: "search" })).toBe("glob");
  });
  test("shell titles are commands", () => {
    expect(toolName({ title: "ls", kind: "execute" })).toBe("bash");
    expect(toolName({ title: "bash", kind: "execute" })).toBe("bash");
  });
  test("replayed calls have path titles", () => {
    expect(toolName({ title: "tmp/p/a.txt", kind: "edit", rawInput: { filePath: "/tmp/p/a.txt", content: "x" } })).toBe("write");
    expect(toolName({ title: "tmp/p/a.txt", kind: "edit", rawInput: { filePath: "/tmp/p/a.txt", oldString: "a", newString: "b" } })).toBe("edit");
    expect(toolName({ title: "tmp/p/a.txt", kind: "read" })).toBe("read");
  });
  test("explicit name wins", () => expect(toolName({ name: "Foo", title: "bar", kind: "read" })).toBe("Foo"));
});

describe("permissionCall", () => {
  test("uses the card's full input when the request has none", () => {
    const tc = { toolCallId: "c", kind: "read", title: "read", rawInput: {} };
    const r = permissionCall(tc, { name: "read", input: { filePath: "/home/u/.ssh/id_rsa" } });
    expect(r).toEqual({ name: "read", input: { filePath: "/home/u/.ssh/id_rsa" } });
    expect(rules({ tool: r.name, input: r.input, cwd: "/home/u/p" })?.decision).toBe("deny");
  });
  test("shell: card name, not the command title", () => {
    const tc = { toolCallId: "c", kind: "execute", title: "sudo ls", rawInput: { command: "sudo ls" } };
    expect(permissionCall(tc, { name: "bash", input: { cwd: "/p" } })).toEqual({ name: "bash", input: { cwd: "/p", command: "sudo ls" } });
    expect(permissionCall(tc).name).toBe("bash");
  });
  test("edit request without a card: filepath and locations", () => {
    const tc = { kind: "edit", title: "/p/.env", locations: [{ path: "/p/.env" }], rawInput: { filepath: "/p/.env", diff: "…" } };
    expect(permissionCall(tc).input.filePath).toBe("/p/.env");
    expect(permissionCall({ kind: "read", title: "read", locations: [{ path: "/p/x" }], rawInput: {} }).input.path).toBe("/p/x");
  });
});

describe("opencode env", () => {
  test("asks for everything, plan mode keeps its edit ban", () => {
    expect(JSON.parse(OPENCODE_ENV.OPENCODE_PERMISSION!)).toEqual({ "*": "ask" });
    if (OPENCODE_ENV.OPENCODE_CONFIG_CONTENT) expect(JSON.parse(OPENCODE_ENV.OPENCODE_CONFIG_CONTENT).agent.plan.permission.edit["*"]).toBe("deny");
  });
});
