// Session lists sort by the time of the most recent user or agent message: resuming a session after
// a runner restart (history replay, state, activity) must not bump it to the top, and a reply being
// written keeps it there.

import { expect, test } from "bun:test";
import type { Msg } from "../../web/src/shared/protocol";
const { movedAt } = await import("./session");

const msg = (ts: number, extra: Partial<Msg> = {}): Msg => ({ id: `m${ts}`, role: "user", parts: [], ts, ...extra });
const NOW = 1_000_000;

test("a history replay takes the last message's time, not now, and never moves it back", () => {
  expect(movedAt({ type: "reset", messages: [msg(100), msg(300), msg(200)] }, 50, [], NOW)).toBe(300);
  expect(movedAt({ type: "reset", messages: [] }, 42, [], NOW)).toBe(42);
  // resumed at its stored last-message time, later than the replay's (a Codex turn's start)
  expect(movedAt({ type: "reset", messages: [msg(100), msg(300)] }, 400, [], NOW)).toBe(400);
});

test("a replay ignores notices and messages without a known time", () => {
  const messages = [msg(100), msg(900, { role: "notice" }), msg(0, { id: "x", role: "assistant" })];
  expect(movedAt({ type: "reset", messages }, 50, [], NOW)).toBe(100);
});

test("state, activity, toasts and notices don't move it", () => {
  expect(movedAt({ type: "state", state: { status: "idle" } }, 42, [], NOW)).toBe(42);
  expect(movedAt({ type: "activity", items: [] }, 42, [], NOW)).toBe(42);
  expect(movedAt({ type: "toast", level: "info", text: "hi" }, 42, [], NOW)).toBe(42);
  expect(movedAt({ type: "msg", msg: msg(500, { role: "notice" }) }, 42, [], NOW)).toBe(42);
});

test("a new message moves it to its own time, never back", () => {
  expect(movedAt({ type: "msg", msg: msg(500) }, 42, [], NOW)).toBe(500);
  expect(movedAt({ type: "msg", msg: msg(10) }, 42, [], NOW)).toBe(42);
  expect(movedAt({ type: "msg", msg: msg(500, { role: "assistant" }) }, 42, [], NOW)).toBe(500);
});

test("a reply being written counts as the most recent message", () => {
  const writing = msg(100, { id: "a", role: "assistant", streaming: true });
  expect(movedAt({ type: "delta", msgId: "a", part: 0, kind: "text", text: "x" }, 100, [writing], NOW)).toBe(NOW);
  expect(movedAt({ type: "delta", msgId: "a", part: 0, kind: "thinking", text: "x" }, 100, [writing], NOW)).toBe(NOW);
  // a tool call added to it, or the message finishing
  expect(movedAt({ type: "msg", msg: { ...writing, parts: [{ type: "text", text: "x" }] } }, 100, [writing], NOW)).toBe(NOW);
  expect(movedAt({ type: "msg", msg: { ...writing, streaming: false } }, 100, [writing], NOW)).toBe(NOW);
});

test("text into a finished or replayed message doesn't move it", () => {
  const done = msg(100, { id: "a", role: "assistant" });
  expect(movedAt({ type: "delta", msgId: "a", part: 0, kind: "text", text: "x" }, 100, [done], NOW)).toBe(100);
  expect(movedAt({ type: "delta", msgId: "missing", part: 0, kind: "text", text: "x" }, 100, [done], NOW)).toBe(100);
  // a finished message patched later (a tool result, a plan outcome) keeps its time
  expect(movedAt({ type: "msg", msg: { ...done, parts: [] } }, 100, [done], NOW)).toBe(100);
});
