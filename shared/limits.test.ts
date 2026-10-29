import { expect, test } from "bun:test";
import { capMessage, capPart, IMAGE_DATA_MAX, newestPage, PART_TEXT_MAX } from "./limits";
import type { Msg } from "./transcript";

test("big text, tool output and images are cut short and marked with their full length", () => {
  const big = "x".repeat(PART_TEXT_MAX + 10);
  expect(capPart({ type: "text", text: big })).toEqual({ type: "text", text: big.slice(0, PART_TEXT_MAX), truncated: big.length });
  const tool = capPart({ type: "tool", id: "t", name: "Bash", kind: "shell", input: {}, status: "done", output: big });
  expect(tool).toMatchObject({ output: big.slice(0, PART_TEXT_MAX), truncated: big.length });
  const img = "a".repeat(IMAGE_DATA_MAX + 1);
  expect(capPart({ type: "image", mimeType: "image/png", data: img })).toEqual({ type: "image", mimeType: "image/png", data: "", truncated: img.length });
  const small = { type: "text" as const, text: "hi" };
  expect(capPart(small)).toBe(small);
});

const m = (id: string, size = 10): Msg => ({ id, role: "assistant", ts: 0, parts: [{ type: "text", text: "y".repeat(size) }] });

test("a page is cut by count and by bytes, newest kept, never empty", () => {
  const all = ["a", "b", "c", "d"].map((id) => m(id));
  expect(newestPage(all, 2)).toEqual({ messages: [m("c"), m("d")], hasOlder: true });
  expect(newestPage(all, 10)).toEqual({ messages: all, hasOlder: false });
  const sized = [m("a", 1000), m("b", 1000), m("c", 1000)];
  const one = JSON.stringify(sized[0]).length;
  expect(newestPage(sized, 50, one * 2 + 10).messages.map((x) => x.id)).toEqual(["b", "c"]);
  // A single message over the byte budget still comes (capped), so a page is never empty.
  const huge = [m("a"), m("z", PART_TEXT_MAX * 3)];
  const page = newestPage(huge, 50, 100);
  expect(page.messages.map((x) => x.id)).toEqual(["z"]);
  expect(page.messages[0]!.parts[0]).toMatchObject({ truncated: PART_TEXT_MAX * 3 });
  expect(page.hasOlder).toBe(true);
  expect(newestPage([], 50)).toEqual({ messages: [], hasOlder: false });
});

test("capMessage keeps a small message as is", () => {
  const x = m("a");
  expect(capMessage(x)).toBe(x);
});
