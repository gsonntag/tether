// Session lists sort by when the conversation last moved: resuming a session after a runner
// restart (history replay, state, activity) must not bump it to the top.

import { expect, test } from "bun:test";
const { movedAt } = await import("./session");

const msg = (ts: number) => ({ id: `m${ts}`, role: "user" as const, parts: [], ts });

test("a history replay takes the last message's time, not now", () => {
  expect(movedAt({ type: "reset", messages: [msg(100), msg(300), msg(200)] }, Date.now())).toBe(300);
  expect(movedAt({ type: "reset", messages: [] }, 42)).toBe(42);
});

test("state, activity and toasts don't move it", () => {
  expect(movedAt({ type: "state", state: { status: "idle" } }, 42)).toBe(42);
  expect(movedAt({ type: "activity", items: [] }, 42)).toBe(42);
  expect(movedAt({ type: "toast", level: "info", text: "hi" }, 42)).toBe(42);
});

test("new messages and streamed text move it forward", () => {
  expect(movedAt({ type: "msg", msg: msg(500) }, 42)).toBe(500);
  expect(movedAt({ type: "msg", msg: msg(10) }, 42)).toBe(42);
  expect(movedAt({ type: "delta", msgId: "m", part: 0, kind: "text", text: "x" }, 42)).toBeGreaterThan(42);
});
