import { expect, test } from "bun:test";
import { FROM_TETHER } from "../../../../shared/fromTether";
import { diffPairs, historyMsgs, itemPart, unwrapShell, userMsg } from "./items";
import { fixture } from "./testSink";

test("shell commands show as the script Codex runs", () => {
  expect(unwrapShell("/bin/bash -lc 'sleep 3 && echo done > out.txt'")).toBe("sleep 3 && echo done > out.txt");
  expect(unwrapShell(`bash -lc 'echo '\\''hi'\\'''`)).toBe("echo 'hi'");
  expect(unwrapShell('/bin/zsh -c "echo \\"x\\""')).toBe('echo "x"');
  expect(unwrapShell("/bin/bash -lc ls")).toBe("ls");
  expect(unwrapShell("git status")).toBe("git status");
});

test("a patch's unified diff becomes old/new pairs per hunk", () => {
  expect(diffPairs("@@ -1,2 +1,2 @@\n keep\n-old\n+new\n\\ No newline at end of file", "update")).toEqual([{ old_string: "keep\nold", new_string: "keep\nnew" }]);
  expect(diffPairs("brand new file", "add")).toEqual([{ old_string: "", new_string: "brand new file" }]);
  expect(diffPairs("gone", "delete")).toEqual([{ old_string: "gone", new_string: "" }]);
  const p = itemPart({ type: "fileChange", id: "f1", status: "completed", changes: [{ path: "a.ts", kind: { type: "update" }, diff: "@@\n-a\n+b" }, { path: "/abs/b.ts", kind: "add", diff: "x" }] }, "/proj");
  expect(p).toMatchObject({ type: "tool", kind: "edit", path: "/proj/a.ts", status: "done", input: { files: ["/proj/a.ts", "/abs/b.ts"], edits: [{ old_string: "a", new_string: "b" }, { old_string: "", new_string: "x" }] } });
});

test("items as parts: commands (a failing exit code is an error), MCP, search, unknown ones hidden", () => {
  expect(itemPart({ type: "commandExecution", id: "c", command: "false", status: "completed", exitCode: 1, aggregatedOutput: "" }, "/")).toMatchObject({ status: "error", kind: "shell" });
  expect(itemPart({ type: "mcpToolCall", id: "m", server: "gh", tool: "search", arguments: { q: 1 }, status: "completed", result: { content: [{ type: "text", text: "found" }] } }, "/")).toMatchObject({ name: "mcp__gh__search", kind: "other", output: "found" });
  expect(itemPart({ type: "webSearch", id: "w", query: "bun pty" }, "/")).toMatchObject({ kind: "fetch", input: { query: "bun pty" } });
  expect(itemPart({ type: "hookPrompt", id: "h" }, "/")).toBeUndefined();
  expect(itemPart({ type: "subAgentActivity", id: "s", kind: "completed" }, "/")).toBeUndefined();
});

test("Tether's own messages (an answer passed on, a denial's reason) read as Tether's", () => {
  expect(userMsg({ id: "x", content: [{ type: "text", text: `${FROM_TETHER}The user approved.` }] }, 1)).toMatchObject({ origin: { kind: "tether" }, parts: [{ text: "The user approved." }] });
  expect(userMsg({ id: "y", content: [{ type: "text", text: "hi" }, { type: "localImage", path: "/a.png" }] }, 1)!.parts).toEqual([{ type: "text", text: "hi\n[image]" }]);
});

test("a stored thread: a message per prompt, the steer between, compaction and failures", async () => {
  const msgs = historyMsgs(await fixture("approval-steer-turns.json"), "/home/ubuntu/scratch-p4/proj1", "gpt-6-luna");
  expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user", "assistant", "user", "assistant"]);
  expect(msgs[1]).toMatchObject({ model: "gpt-6-luna", ts: 1793279367000 });
  const more = historyMsgs(
    [
      { id: "t1", startedAt: 10, items: [{ type: "userMessage", id: "u", content: [{ type: "text", text: "go" }] }, { type: "contextCompaction", id: "k" }] },
      { id: "t2", startedAt: 20, status: "failed", error: { message: "Boom", additionalDetails: "quota" }, items: [] },
    ],
    "/",
  );
  expect(more).toEqual([
    { id: "u-u", role: "user", ts: 10000, parts: [{ type: "text", text: "go" }] },
    { id: "c-k", role: "notice", level: "info", ts: 10000, parts: [{ type: "text", text: "Context compacted." }] },
    { id: "e-t2", role: "assistant", ts: 20000, parts: [], error: "Boom: quota" },
  ]);
});

test("a thread whose first message is a command's output is titled by the command", async () => {
  const { titleOf } = await import("./discovery");
  const { shellMessage } = await import("../../../../shared/shellRun");
  expect(titleOf({ preview: shellMessage("npm test", "ok", { exitCode: 0 }) })).toBe("$ npm test");
  expect(titleOf({ preview: "[From Tether] go ahead" })).toBe("go ahead");
});
