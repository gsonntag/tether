// search_sessions' reading of store files: Claude Code's and Codex's entries, a line at a time.

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { entryPieces, SEARCH, searchFile, searchMsgs, snippetOf } from "./search";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const fileOf = (lines: unknown[]) => {
  const d = mkdtempSync(join(tmpdir(), "tether-search-"));
  dirs.push(d);
  const f = join(d, "s.jsonl");
  writeFileSync(f, lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
  return f;
};

test("snippetOf: the text around the first match, any case, on one line", () => {
  expect(snippetOf("Hello\nWorld", "world")).toBe("Hello World");
  expect(snippetOf("nothing here", "x y")).toBeUndefined();
  const long = `${"a".repeat(500)} NEEDLE ${"b".repeat(500)}`;
  const s = snippetOf(long, "needle")!;
  expect(s.startsWith("…")).toBe(true);
  expect(s.endsWith("…")).toBe(true);
  expect(s).toContain("NEEDLE");
  expect(s.length).toBeLessThanOrEqual(SEARCH.snippet + 4);
});

test("entryPieces: Claude Code prompts, replies, tool calls and results; Codex items; not bookkeeping", () => {
  expect(entryPieces({ type: "user", message: { content: "hi" } })).toEqual([{ where: "prompt", text: "hi" }]);
  expect(entryPieces({ type: "assistant", message: { content: [{ type: "thinking", thinking: "x" }, { type: "text", text: "done" }, { type: "tool_use", name: "Bash", input: { command: "ls" } }] } })).toEqual([
    { where: "reply", text: "done" },
    { where: "tool call (Bash)", text: '{"command":"ls"}' },
  ]);
  expect(entryPieces({ type: "user", message: { content: [{ type: "tool_result", content: [{ type: "text", text: "out" }] }] } })).toEqual([{ where: "tool result", text: "out" }]);
  expect(entryPieces({ type: "api-request-blob", message: [{ type: "text", text: "x" }] })).toEqual([]);
  expect(entryPieces({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] } })).toEqual([{ where: "reply", text: "ok" }]);
  expect(entryPieces({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>cwd</environment_context>" }] } })).toEqual([]);
  expect(entryPieces({ type: "response_item", payload: { type: "function_call", name: "shell", arguments: '{"cmd":"x"}' } })).toEqual([{ where: "tool call (shell)", text: '{"cmd":"x"}' }]);
  expect(entryPieces({ type: "response_item", payload: { type: "function_call_output", output: "result" } })).toEqual([{ where: "tool result", text: "result" }]);
  expect(entryPieces({ type: "event_msg", payload: { type: "agent_message", message: "dup" } })).toEqual([]);
});

test("searchFile: matches with where and when, stops after the cap, skips bad lines, reads huge lines raw", async () => {
  const at = "2026-01-02T03:04:05.000Z";
  const f = fileOf([
    "not json SERVERLESS",
    { type: "user", message: { content: "is the serverless runner up?" }, timestamp: at },
    { type: "assistant", message: { content: [{ type: "text", text: "Serverless says \"no\"" }] }, timestamp: at },
    { type: "user", message: { content: [{ type: "tool_result", content: "serverless: failed" }] } },
    { type: "assistant", message: { content: [{ type: "text", text: "serverless again" }] } },
    { type: "assistant", message: { content: [{ type: "text", text: "never read" }] } },
  ]);
  const r = await searchFile(f, "SERVERLESS");
  expect(r.hits).toEqual([
    { where: "prompt", at: Date.parse(at), snippet: "is the serverless runner up?" },
    { where: "reply", at: Date.parse(at), snippet: 'Serverless says "no"' },
    { where: "tool result", snippet: "serverless: failed" },
  ]);
  expect(r.more).toBe(true);
  // A quote in the query matches through JSON's escaping.
  expect((await searchFile(f, 'says "no')).hits).toHaveLength(1);
  expect(await searchFile(f, "absent")).toEqual({ hits: [], more: false });
  const max = SEARCH.maxLine;
  SEARCH.maxLine = 100;
  try {
    const big = fileOf([{ type: "assistant", message: { content: [{ type: "text", text: `${"x".repeat(200)} needle ${"y".repeat(200)}` }] } }]);
    const h = (await searchFile(big, "needle")).hits;
    expect(h).toHaveLength(1);
    expect(h[0]!.where).toBe("a very large entry");
  } finally {
    SEARCH.maxLine = max;
  }
  // stop() ends the read.
  expect((await searchFile(f, "serverless", { stop: () => true })).hits).toEqual([]);
});

test("searchMsgs: the runner's messages, for a session with no store file", () => {
  const r = searchMsgs(
    [
      { id: "1", role: "user", ts: 5, parts: [{ type: "text", text: "Deploy it" }] },
      { id: "2", role: "assistant", ts: 6, parts: [{ type: "tool", id: "t", name: "Bash", kind: "shell", input: { command: "deploy.sh" }, status: "done", output: "ok" } as any] },
    ],
    "DEPLOY",
  );
  expect(r).toEqual({ hits: [{ where: "prompt", at: 5, snippet: "Deploy it" }, { where: "tool", at: 6, snippet: '{"command":"deploy.sh"} ok' }], more: false });
});
