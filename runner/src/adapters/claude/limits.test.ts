import { expect, test } from "bun:test";
import { ClaudeStream } from "./stream";

/** Frames of a failed turn, in the shape Claude Code really writes them (its stores, and SDKRateLimitInfo). */
const failure = (code: string | undefined, text: string, extra: any = {}) => [
  { type: "assistant", uuid: "a1", ...(code ? { error: code } : {}), message: { id: "m1", model: "<synthetic>", role: "assistant", content: [{ type: "text", text }] } },
  { type: "result", subtype: "success", is_error: true, result: text, uuid: "r1", ...extra },
];
const REJECTED = { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1793901600, rateLimitType: "five_hour", overageStatus: "rejected" } };
const ALLOWED = { type: "rate_limit_event", rate_limit_info: { status: "allowed", resetsAt: 1793901600, rateLimitType: "five_hour" } };

function run(frames: any[], host: any = {}) {
  const hits: any[] = [];
  const sink: any = { state() {}, event() {}, message() {}, plan() {}, limitReached: (h: any) => hits.push(h) };
  const s = new ClaudeStream(sink, { nativeId: "n", ...host });
  s.mainStarts();
  for (const f of frames) s.handle(f);
  return hits;
}

test("the real limit results, with no event: Claude Code's own text under its rate_limit code", () => {
  expect(run(failure("rate_limit", "You've hit your session limit · resets 8:40am (UTC)", { api_error_status: 429 }))).toEqual([{}]);
  expect(run(failure("rate_limit", "You've hit your weekly limit · resets 6pm (UTC)"))).toEqual([{}]);
});

test("a rejected rate_limit_event, with its reset", () => {
  expect(run([REJECTED, ...failure("rate_limit", "Any words")])).toEqual([{ resetsAt: 1793901600_000 }]);
});

test("no code on the frames: the result's own text decides", () => {
  expect(run([{ type: "result", subtype: "success", is_error: true, result: "You've hit your session limit · resets 8:40am (UTC)" }])).toEqual([{}]);
});

const NOT_SIGNALS: [string, any[]][] = [
  ["a short 429: the same code, no rejection", failure("rate_limit", "Server is temporarily limiting requests (not your usage limit)", { api_error_status: 429 })],
  ["a 429 with API text", failure("rate_limit", "API Error: 429 rate_limit_error")],
  ["overloaded", failure("overloaded", "Repeated 529 Overloaded errors", { api_error_status: 529 })],
  ["a 5xx", failure("server_error", "API Error: 500", { api_error_status: 500 })],
  ["auth", failure("authentication_failed", "Not logged in · Please run /login", { api_error_status: 401 })],
  ["a network failure", [{ type: "result", subtype: "success", is_error: true, result: "API Error: Connection error." }]],
  ["a limit's words under another code", failure("overloaded", "You've hit your session limit")],
  ["a rejection, then another failure", [REJECTED, ...failure("overloaded", "Repeated 529 Overloaded errors")]],
  ["a rejection cleared by a later report", [REJECTED, ALLOWED, ...failure("server_error", "API Error: 500")]],
  ["a rejection the turn got past", [REJECTED, ALLOWED, { type: "result", subtype: "success", is_error: false, result: "Done." }]],
  ["a rejection on a turn that finished", [REJECTED, { type: "result", subtype: "success", is_error: false, result: "You've hit your session limit, it says here." }]],
  ["the agent writing the words", [{ type: "result", subtype: "success", is_error: false, result: "You've hit your session limit" }]],
  ["a stopped turn", [REJECTED, { type: "result", subtype: "error_during_execution", is_error: true, terminal_reason: "aborted_streaming" }]],
];
for (const [name, frames] of NOT_SIGNALS) test(`not exhausted: ${name}`, () => expect(run(frames)).toEqual([]));

test("not exhausted: you pressed Stop", () => {
  expect(run([REJECTED, ...failure("rate_limit", "You've hit your session limit")], { interrupted: () => true })).toEqual([]);
});

test("a rejection stays with its turn", () => {
  const hits: any[] = [];
  const s = new ClaudeStream({ state() {}, event() {}, message() {}, plan() {}, limitReached: (h: any) => hits.push(h) } as any, { nativeId: "n" });
  s.mainStarts();
  s.handle(REJECTED);
  s.handle({ type: "result", subtype: "success", is_error: false, result: "Done." });
  s.mainStarts();
  for (const f of failure("rate_limit", "Server is temporarily limiting requests (not your usage limit)")) s.handle(f);
  expect(hits).toEqual([]);
});

test("a key's process says nothing of the plan", () => {
  const seen: any[] = [];
  const s = new ClaudeStream({ plan: (p: any) => seen.push(p), state() {} } as any, { nativeId: "n", keyed: () => true });
  s.handle({ type: "rate_limit_event", rate_limit_info: { status: "allowed", unifiedWindows: { five_hour: { utilization: 0.5 } } } });
  expect(seen).toEqual([]);
});
