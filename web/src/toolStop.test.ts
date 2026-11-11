import { expect, test } from "bun:test";
import type { ToolPart } from "../../shared/transcript";
import { stoppable } from "./toolStop";

const shell = (over: Partial<ToolPart> = {}): ToolPart => ({ type: "tool", id: "t1", name: "Bash", kind: "shell", status: "running", command: "sleep 300", ...over }) as ToolPart;
const live = { mode: "live" as const, status: "running" as const };

test("a running command in a live turn can be stopped", () => {
  expect(stoppable(shell(), live)).toBe(true);
});

test("no Stop once the command finished, or for tools that aren't commands", () => {
  expect(stoppable(shell({ status: "done" }), live)).toBe(false);
  expect(stoppable(shell({ status: "error" }), live)).toBe(false);
  expect(stoppable(shell({ kind: "read" }), live)).toBe(false);
});

test("no Stop on a stale running card: the session isn't running, or the TUI drives it", () => {
  expect(stoppable(shell(), { mode: "live", status: "idle" } as any)).toBe(false);
  expect(stoppable(shell(), { mode: "stored", status: "running" } as any)).toBe(false);
  expect(stoppable(shell(), undefined)).toBe(false);
});

test("no Stop while the command waits on your answer", () => {
  expect(stoppable(shell(), live, true)).toBe(false);
});
