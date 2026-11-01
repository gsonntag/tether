import { expect, test } from "bun:test";
import { usageLimitHit } from "./items";
import { CodexStream } from "./stream";
import { TestSink } from "./testSink";

const REAL = "You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 3:56 AM.";
const turn = (error: any) => ({ id: "t1", status: "failed", items: [], error: { additionalDetails: null, ...error } });

function ends(t: any, thread = "main") {
  const sink = new TestSink() as TestSink & { limitReached: (h: any) => void };
  const hits: any[] = [];
  sink.limitReached = (h) => hits.push(h);
  const s = new CodexStream(sink, "/p", "main");
  s.handle("turn/started", { threadId: thread, turn: { id: "t1" } });
  s.handle("turn/completed", { threadId: thread, turn: t });
  return hits;
}

test("the real usage limit: its code, and its text when no code came", () => {
  expect(ends(turn({ message: REAL, codexErrorInfo: "usageLimitExceeded" }))).toEqual([{}]);
  expect(ends(turn({ message: REAL, codexErrorInfo: null }))).toEqual([{}]);
  expect(ends(turn({ message: REAL }))).toEqual([{}]);
  expect(usageLimitHit({ codexErrorInfo: "usage_limit_exceeded" })).toBe(true);
  expect(usageLimitHit({ codexErrorInfo: { usageLimitExceeded: {} } })).toBe(true);
});

const NOT_SIGNALS: [string, any][] = [
  ["a short rate limit", { message: "Rate limit reached for gpt-6. Please try again in 20s.", codexErrorInfo: "rateLimitExceeded" }],
  ["overloaded", { message: "Selected model is at capacity.", codexErrorInfo: "serverOverloaded" }],
  ["a 5xx", { message: "stream error", codexErrorInfo: "internalServerError" }],
  ["auth", { message: "401 Unauthorized", codexErrorInfo: "unauthorized" }],
  ["a dropped connection", { message: "stream disconnected", codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 502 } } }],
  ["failed attempts after a 429", { message: "exceeded retry limit, last status: 429", codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 429 } } }],
  ["no code, other text", { message: "exceeded retry limit, last status: 429 Too Many Requests", codexErrorInfo: null }],
  ["a limit's words under another code", { message: REAL, codexErrorInfo: "other" }],
];
for (const [name, error] of NOT_SIGNALS) test(`not exhausted: ${name}`, () => expect(ends(turn(error))).toEqual([]));

test("not exhausted: a turn that finished or was stopped, or a subagent's", () => {
  expect(ends({ id: "t1", status: "completed", items: [] })).toEqual([]);
  expect(ends({ id: "t1", status: "interrupted", items: [] })).toEqual([]);
  expect(ends(turn({ message: REAL, codexErrorInfo: "usageLimitExceeded" }), "unknown-child")).toEqual([]);
});
