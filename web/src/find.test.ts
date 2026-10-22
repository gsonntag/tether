import { describe, expect, test } from "bun:test";
import { findMessageIndices, messageText } from "./find";
import type { Msg } from "./shared/protocol";

const msgs: Msg[] = [
  { id: "u1", role: "user", ts: 1, parts: [{ type: "text", text: "Please fix the Sidebar layout" }] },
  { id: "a1", role: "assistant", ts: 2, parts: [{ type: "thinking", text: "The sidebar uses a VStack" }, { type: "text", text: "Looking now." }] },
  {
    id: "a2",
    role: "assistant",
    ts: 3,
    parts: [
      { type: "tool", id: "t1", name: "Bash", input: { command: "bun test" }, status: "done", kind: "shell", command: "bun test", output: "12 pass\n0 fail" },
      { type: "tool", id: "t2", name: "Read", input: {}, status: "done", kind: "read", path: "web/src/components/Sidebar.tsx" },
    ],
  },
  { id: "a3", role: "assistant", ts: 4, parts: [{ type: "plan", id: "p1", text: "1. Move the toggle\n2. Ship it" }] },
  { id: "n1", role: "notice", ts: 5, title: "Compaction finished", parts: [] },
  { id: "a4", role: "assistant", ts: 6, parts: [{ type: "image", mimeType: "image/png", data: "" }] },
];

describe("findMessageIndices", () => {
  test("matches text and thinking, case-insensitively", () => {
    expect(findMessageIndices(msgs, "sidebar")).toEqual([0, 1, 2]);
    expect(findMessageIndices(msgs, "SIDEBAR LAYOUT")).toEqual([0]);
  });

  test("matches a tool's name, command, path and output", () => {
    expect(findMessageIndices(msgs, "bash")).toEqual([2]);
    expect(findMessageIndices(msgs, "bun test")).toEqual([2]);
    expect(findMessageIndices(msgs, "Sidebar.tsx")).toEqual([2]);
    expect(findMessageIndices(msgs, "0 fail")).toEqual([2]);
  });

  test("matches plan text and notice titles", () => {
    expect(findMessageIndices(msgs, "ship it")).toEqual([3]);
    expect(findMessageIndices(msgs, "compaction")).toEqual([4]);
  });

  test("an empty term or no match finds nothing", () => {
    expect(findMessageIndices(msgs, "")).toEqual([]);
    expect(findMessageIndices(msgs, "zebra")).toEqual([]);
  });

  test("messageText leaves images out and keeps an error", () => {
    expect(messageText(msgs[5]!)).toBe("");
    expect(messageText({ id: "e", role: "assistant", ts: 7, parts: [], error: "rate limited" })).toBe("rate limited");
    expect(messageText({ id: "e", role: "assistant", ts: 7, parts: [], error: "aborted" })).toBe("");
  });
});
