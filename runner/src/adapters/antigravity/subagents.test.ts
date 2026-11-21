import { expect, test } from "bun:test";
import { matchCalls, parentMessage } from "./subagents";

const step = (s: string) => new Uint8Array(Buffer.from(`\x12\x0a..$abc\x1a${s}\x0a\x12more`, "latin1"));

test("a subagent's first step names its parent and prompt", () => {
  const p = parentMessage(step("[Message] timestamp=2026-11-21T00:37:56Z sender=4afd15cc-2c80-4b26-adbc-60918bcdeee5 priority=MESSAGE_PRIORITY_HIGH content=Please run 'ls' here."));
  expect(p).toEqual({ parent: "4afd15cc-2c80-4b26-adbc-60918bcdeee5", prompt: "Please run 'ls' here." });
  expect(parentMessage(step("Run the shell command: echo hi"))).toBeUndefined();
  expect(parentMessage(step("[Message] sender=not-a-uuid content=x"))).toBeUndefined();
});

test("subagents pair with the calls that started them by prompt, one to one, in order", () => {
  const kid = (id: string, prompt: string) => ({ nativeId: id, parent: "p", prompt, at: 0 });
  const calls = [{ toolId: "c1", prompt: "List the files.\nThen report." }, { toolId: "c2", prompt: "Read notes.txt" }, { toolId: "c3", prompt: "Read notes.txt" }];
  const m = matchCalls([kid("a", "Read notes.txt"), kid("b", "List the files."), kid("c", "Read notes.txt"), kid("d", "Something else")], calls);
  expect([...m].map(([k, c]) => [k, c.toolId])).toEqual([["a", "c2"], ["b", "c1"], ["c", "c3"]]);
});
