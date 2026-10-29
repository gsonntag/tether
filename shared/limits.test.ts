import { expect, test } from "bun:test";
import { capEvent, capInput, capMessage, capPart, capRequest, capToolPatch, cutBytes, fetchFullPart, utf8Length, FRAME_BYTES_MAX, guardFrame, IMAGE_DATA_MAX, INPUT_JSON_MAX, INPUT_STRING_MAX, MESSAGE_BYTES_MAX, newestPage, PAGE_BYTES_MAX, partChunk, PART_CHUNK_MAX, PART_TEXT_MAX } from "./limits";
import type { Msg, Part, ToolPart } from "./transcript";

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

// ---------- round 4: every path stays under the frame limit ----------


const MB = 1024 * 1024;
const bytes = (v: unknown) => JSON.stringify(v).length;
const tool = (over: Partial<ToolPart> = {}): ToolPart => ({ type: "tool", id: "t", name: "Write", kind: "write", input: {}, status: "done", ...over });

test("tool input: long strings trimmed, shape kept, marked", () => {
  const content = "c".repeat(5 * MB);
  const p = capPart(tool({ input: { file_path: "/a.ts", content } })) as ToolPart;
  expect(p.inputTruncated).toBe(true);
  expect((p.input as any).file_path).toBe("/a.ts");
  expect((p.input as any).content.length).toBe(INPUT_STRING_MAX + 1);
  // Many medium strings that are each under the string cap still end up as a bounded preview.
  const wide = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, "x".repeat(INPUT_STRING_MAX)]));
  const c = capInput(wide);
  expect(c.truncated).toBe(true);
  expect(bytes(c.value)).toBeLessThan(INPUT_JSON_MAX + 100);
  // Small inputs are returned as is.
  const small = { command: "ls" };
  expect(capInput(small)).toEqual({ value: small, truncated: false });
});

test("request inputs are capped too", () => {
  const r = capRequest({ id: "r", sessionId: "s", kind: "approval", tool: "Edit", input: { old_string: "o".repeat(3 * MB), new_string: "n" }, openedAt: 0 });
  expect(r.inputTruncated).toBe(true);
  expect(bytes(r)).toBeLessThan(INPUT_JSON_MAX);
  const state = capEvent({ type: "state", state: { requests: [{ id: "r", sessionId: "s", kind: "approval", input: "z".repeat(3 * MB), openedAt: 0 }] } });
  expect(bytes(state)).toBeLessThan(INPUT_JSON_MAX);
});

test("tool patch events are capped", () => {
  const e = capEvent({ type: "tool", msgId: "m", toolId: "t", patch: { output: "o".repeat(20 * MB), input: { content: "i".repeat(20 * MB) } } });
  expect(bytes(e)).toBeLessThan(200 * 1024);
  expect(e).toMatchObject({ patch: { truncated: 20 * MB, inputTruncated: true } });
});

test("a message with very many parts keeps the first ones up to the budget and marks the rest", () => {
  const parts: Part[] = Array.from({ length: 400 }, (_, i) => ({ type: "text", text: `${i}`.padEnd(60 * 1024, "-") }));
  const msg = capMessage({ id: "m", role: "assistant", ts: 0, parts });
  expect(bytes(msg)).toBeLessThan(MESSAGE_BYTES_MAX + 70 * 1024);
  expect(msg.parts.length + msg.partsOmitted!).toBe(400);
  expect((msg.parts[0] as any).text.startsWith("0-")).toBe(true);
  // A page of such messages stays within the page budget.
  const page = newestPage(Array.from({ length: 10 }, (_, i) => ({ id: `m${i}`, role: "assistant" as const, ts: 0, parts })), 50);
  expect(bytes(page.messages)).toBeLessThan(PAGE_BYTES_MAX + MESSAGE_BYTES_MAX);
});

test("msg and reset events are capped", () => {
  const huge: Part = { type: "text", text: "h".repeat(20 * MB) };
  expect(bytes(capEvent({ type: "msg", msg: { id: "m", role: "user", ts: 0, parts: [huge] } }))).toBeLessThan(100 * 1024);
  const reset = capEvent({ type: "reset", hasOlder: false, messages: Array.from({ length: 100 }, (_, i) => ({ id: `m${i}`, role: "user" as const, ts: 0, parts: [huge] })) });
  expect(bytes(reset)).toBeLessThan(PAGE_BYTES_MAX + 100 * 1024);
  expect(reset).toMatchObject({ hasOlder: true });
});

test("fullPart comes back whole in bounded slices", async () => {
  const part = tool({ input: { content: "é".repeat(3 * MB) }, output: "o".repeat(2 * MB) });
  let calls = 0;
  const got = await fetchFullPart(async (offset) => {
    calls++;
    const c = partChunk(part, offset);
    expect(c.chunk.length).toBeLessThanOrEqual(PART_CHUNK_MAX);
    return c;
  });
  expect(got).toEqual(part);
  expect(calls).toBeGreaterThan(4);
  await expect(fetchFullPart(async () => ({ chunk: "", offset: 5, total: 10, version: "v", done: false }))).rejects.toThrow();
});

test("the frame guard turns oversized results into errors and events into resync", () => {
  const big = "x".repeat(FRAME_BYTES_MAX + 1);
  expect(JSON.parse(guardFrame({ t: "result", id: "s1", ok: true, data: big }).frame!)).toEqual({ t: "result", id: "s1", ok: false, error: "The answer was too large to send." });
  expect(JSON.parse(guardFrame({ t: "event", sessionId: "c:1", seq: 9, event: { type: "msg", msg: { id: "m", role: "user", ts: 0, parts: [{ type: "text", text: big }] } } }).frame!)).toEqual({
    t: "event",
    sessionId: "c:1",
    seq: 9,
    event: { type: "resync" },
  });
  expect(guardFrame({ t: "summary", summary: { kind: "all", epoch: "e", seq: 1, sessions: [{ title: big } as any] } })).toEqual({ frame: null, replaced: true });
  // Multi-byte text counts in bytes: 3 MB of 3-byte characters is 9 MB.
  expect(JSON.parse(guardFrame({ t: "result", id: "s2", ok: true, data: "€".repeat(3 * MB) }).frame!).ok).toBe(false);
  expect(guardFrame({ t: "ping" })).toEqual({ frame: '{"t":"ping"}', replaced: false });
});

// ---------- P1 carry-over fixes ----------

test("caps measure UTF-8 bytes, not characters", () => {
  // 30 K three-byte characters: 90 KB, over the 64 KB cap though only 30 K characters long.
  const euros = "€".repeat(30 * 1024);
  const p = capPart({ type: "text", text: euros }) as { text: string; truncated?: number };
  expect(p.truncated).toBe(euros.length);
  expect(new TextEncoder().encode(p.text).length).toBeLessThanOrEqual(PART_TEXT_MAX);
  expect(utf8Length("a€😀")).toBe(new TextEncoder().encode("a€😀").length);
  // A cut never splits a surrogate pair.
  expect(cutBytes("😀😀", 5)).toBe("😀");
});

test("a tool patch always says whether its output and input are cut", () => {
  expect(capToolPatch({ output: "small" })).toEqual({ output: "small", truncated: 0 });
  expect(capToolPatch({ input: { command: "ls" } })).toEqual({ input: { command: "ls" }, inputTruncated: false });
  expect(capToolPatch({ status: "done" })).toEqual({ status: "done" });
  // On the wire too: 0 and false survive JSON, undefined wouldn't.
  const e = capEvent({ type: "tool", msgId: "m", toolId: "t", patch: { output: "x" } });
  expect(JSON.parse(JSON.stringify(e)).patch.truncated).toBe(0);
});

test("fullPart notices a part that changed between slices even at the same length", async () => {
  const a = tool({ output: "a".repeat(3 * MB) });
  const b = tool({ output: "b".repeat(3 * MB) });
  let n = 0;
  await expect(fetchFullPart(async (offset) => partChunk(n++ === 0 ? a : b, offset))).rejects.toThrow("changed");
});

test("the frame limit leaves room under the relay's send buffer", () => {
  expect(FRAME_BYTES_MAX * 3).toBeLessThanOrEqual(12 * MB);
});
