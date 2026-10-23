import { describe, expect, test } from "bun:test";
import { countIn, findMatches, findMessageIndices, latestUnmounted, messageText, nearestIndex } from "./find";
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

  test("messageText is built once per message object", () => {
    let serialised = 0;
    const input = { toJSON: () => (serialised++, { command: "ls" }) };
    const m: Msg = { id: "t", role: "assistant", ts: 1, parts: [{ type: "tool", id: "x", name: "Bash", input, status: "done" }] };
    expect(messageText(m)).toContain('"command":"ls"');
    messageText(m);
    findMessageIndices([m], "ls");
    expect(serialised).toBe(1);
    // A changed message is a new object (the store copies it), so it is read again.
    findMessageIndices([{ ...m }], "ls");
    expect(serialised).toBe(2);
  });
});

describe("findMatches", () => {
  test("counts every occurrence, not just messages", () => {
    expect(countIn("the theme of the day", "the")).toBe(3);
    expect(countIn("aaaa", "aa")).toBe(2);
    expect(findMatches(msgs, "the")).toEqual({ indices: [0, 1, 3], total: 3 });
    expect(findMatches(msgs, "")).toEqual({ indices: [], total: 0 });
  });
});

describe("latestUnmounted", () => {
  const indices = [2, 10, 40, 55];
  test("the latest match before the first mounted message", () => {
    expect(latestUnmounted(indices, 50)).toBe(40);
    expect(latestUnmounted(indices, 41)).toBe(40);
    expect(latestUnmounted(indices, 40)).toBe(10);
  });
  test("nothing once every match is mounted", () => {
    expect(latestUnmounted(indices, 2)).toBeUndefined();
    expect(latestUnmounted(indices, 0)).toBeUndefined();
    expect(latestUnmounted([], 100)).toBeUndefined();
  });
  test("walking back steps one matching message at a time", () => {
    let start = 100;
    const steps: number[] = [];
    for (let i = latestUnmounted(indices, start); i !== undefined; i = latestUnmounted(indices, start)) {
      steps.push(i);
      start = i;
    }
    expect(steps).toEqual([55, 40, 10, 2]);
  });
});

describe("nearestIndex", () => {
  test("the last match above the bottom edge of the view", () => {
    expect(nearestIndex([-500, -20, 100, 300, 900, 1400], 800)).toBe(3);
    expect(nearestIndex([-500, -20], 800)).toBe(1);
  });
  test("the first match below when none is above", () => {
    expect(nearestIndex([900, 1400], 800)).toBe(0);
  });
  test("none", () => {
    expect(nearestIndex([], 800)).toBe(-1);
  });
});
