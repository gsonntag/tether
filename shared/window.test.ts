import { expect, test } from "bun:test";
import type { Msg } from "./transcript";
import { applyToWindow, prependPage, type TranscriptWindow } from "./window";

const msg = (id: string, text = id): Msg => ({ id, role: "assistant", ts: 0, parts: [{ type: "text", text }, { type: "tool", id: `t-${id}`, name: "Bash", kind: "shell", input: {}, status: "running" }] });
const win = (...ids: string[]): TranscriptWindow => ({ messages: ids.map((i) => msg(i)), hasOlder: true });
const ids = (w: TranscriptWindow) => w.messages.map((m) => m.id);

test("a new message is appended; a replacement of a loaded one stays in place", () => {
  let w = applyToWindow(win("m5", "m6"), { type: "msg", msg: msg("m7"), isNew: true });
  expect(ids(w)).toEqual(["m5", "m6", "m7"]);
  w = applyToWindow(w, { type: "msg", msg: msg("m5", "edited") });
  expect(ids(w)).toEqual(["m5", "m6", "m7"]);
  expect(w.messages[0]!.parts[0]).toEqual({ type: "text", text: "edited" });
});

test("a late update to a message outside the window is ignored, not appended", () => {
  const w = win("m5", "m6");
  expect(applyToWindow(w, { type: "msg", msg: msg("m1", "late tool result") })).toBe(w);
  expect(applyToWindow(w, { type: "tool", msgId: "m1", toolId: "t-m1", patch: { status: "done" } })).toBe(w);
  expect(applyToWindow(w, { type: "delta", msgId: "m1", part: 0, text: "x" })).toBe(w);
  // Paging up later brings m1 once, with its current content.
  const paged = prependPage(w, { messages: [msg("m1", "late tool result"), msg("m5", "stale")], hasOlder: false });
  expect(ids(paged)).toEqual(["m1", "m5", "m6"]);
  expect(paged.messages[1]!.parts[0]).toEqual({ type: "text", text: "m5" });
  expect(paged.hasOlder).toBe(false);
});

test("deltas, tool patches and resets", () => {
  let w = applyToWindow(win("m1"), { type: "delta", msgId: "m1", part: 0, text: "!" });
  expect(w.messages[0]!.parts[0]).toEqual({ type: "text", text: "m1!" });
  expect(applyToWindow(w, { type: "delta", msgId: "m1", part: 1, text: "x" })).toEqual(w);
  w = applyToWindow(w, { type: "tool", msgId: "m1", toolId: "t-m1", patch: { status: "done", output: "ok" } });
  expect(w.messages[0]!.parts[1]).toMatchObject({ type: "tool", id: "t-m1", status: "done", output: "ok" });
  w = applyToWindow(w, { type: "reset", messages: [msg("c1")], hasOlder: false });
  expect(w).toEqual({ messages: [msg("c1")], hasOlder: false });
});
