import { expect, test } from "bun:test";
import { formatRoute, parseRoute, presenceFor } from "./route";
import { NO_ANSWER } from "./link";
import { ASK_TIMEOUT_MS, askRunner, Lookup, OFFLINE_MS, RETRY_MS, SETTLE_MS, SLOW_MS, TIMEOUT_BACKOFF_MAX_MS } from "./shortLink";

test("#/l/<code> is a short link; old #/s/ links are unchanged", () => {
  expect(parseRoute("#/l/Ab3dE6gH")).toEqual({ page: "link", code: "Ab3dE6gH" });
  expect(parseRoute("#/l/Ab3dE6gH/")).toEqual({ page: "link", code: "Ab3dE6gH" });
  expect(parseRoute("#l/Ab3dE6gH")).toEqual({ page: "link", code: "Ab3dE6gH" });
  expect(formatRoute({ page: "link", code: "Ab3dE6gH" })).toBe("#/l/Ab3dE6gH");
  expect(parseRoute("#/l/")).toEqual({ page: "home" });
  expect(parseRoute("#/s/box%201/claude%3Aa")).toEqual({ page: "session", runnerId: "box 1", sessionId: "claude:a" });
  expect(presenceFor("#/l/Ab3dE6gH", true)).toEqual({});
});

const CODE = "Ab3dE6gH";
const miss = { kind: "miss" } as const;
const timeout = { kind: "timeout" } as const;
const error = { kind: "error" } as const;

function opened(at = 0) {
  const l = new Lookup(CODE);
  l.linkOpen(true, at);
  return l;
}

test("asking a runner: a hit, a miss, an old runner's miss, an empty session, a timeout and other errors", async () => {
  const fail = (m: string) => async () => Promise.reject(new Error(m));
  expect(await askRunner(async () => ({ sessionId: "claude:a" }), "r1", CODE)).toEqual({ kind: "hit", sessionId: "claude:a" });
  expect(await askRunner(async () => null, "r1", CODE)).toEqual(miss);
  expect(await askRunner(async () => ({ sessionId: "" }), "r1", CODE)).toEqual(miss);
  expect(await askRunner(async () => ({ sessionId: 5 }) as any, "r1", CODE)).toEqual(miss);
  expect(await askRunner(fail('This runner doesn\'t know "resolveLink". Update and restart it.'), "r1", CODE)).toEqual(miss);
  expect(await askRunner(fail(NO_ANSWER), "r1", CODE)).toEqual(timeout);
  for (const m of ["Disconnected.", "Not connected.", "That runner is offline."]) expect(await askRunner(fail(m), "r1", CODE)).toEqual(error);
});

test("connecting until the link opens; nothing asked; the waits count from when it opens", () => {
  const l = new Lookup(CODE);
  expect(l.toAsk(["r1"], 0)).toEqual([]);
  expect(l.look(["r1"], [], 60_000)).toBe("connecting");
  expect(l.look([], [], 60_000)).toBe("connecting");
  // A slow cold load: the link opens late.
  l.linkOpen(true, 5_000);
  expect(l.toAsk(["r1"], 5_000)).toEqual(["r1"]);
  expect(l.toAsk(["r1"], 5_000)).toEqual([]);
  l.answered("r1", miss, 5_100);
  expect(l.look(["r1"], [], 5_100)).toBe("looking");
  expect(l.look(["r1"], [], 5_000 + SETTLE_MS)).toBe("missing");
  // A second runner connects: it's asked, and the page waits for it.
  expect(l.look(["r1", "r2"], [], 7_500)).toBe("looking");
  expect(l.toAsk(["r1", "r2"], 7_500)).toEqual(["r2"]);
});

test("a hit is the asked runner's session", () => {
  const l = opened();
  l.toAsk(["r1", "r2"], 0);
  expect(l.answered("r1", miss, 10)).toEqual({});
  expect(l.answered("r2", { kind: "hit", sessionId: "claude:a" }, 10)).toEqual({ sessionId: "claude:a" });
});

test("timeouts never read as 'doesn't exist': the first wakes the link, retries back off to 30s, then 'not answering'", () => {
  const l = opened();
  l.toAsk(["r1", "r2"], 0);
  l.answered("r1", miss, 50);
  expect(l.answered("r2", timeout, ASK_TIMEOUT_MS)).toEqual({ wake: true });
  expect(l.look(["r1", "r2"], [], ASK_TIMEOUT_MS)).toBe("looking");
  // Asked again after 8s, then 16s, then at most 30s; only the first timeout wakes the link.
  expect(l.toAsk(["r1", "r2"], 2 * ASK_TIMEOUT_MS - 1)).toEqual([]);
  expect(l.toAsk(["r1", "r2"], 2 * ASK_TIMEOUT_MS)).toEqual(["r2"]);
  expect(l.answered("r2", timeout, 24_000)).toEqual({});
  expect(l.toAsk(["r2"], 24_000 + 16_000 - 1)).toEqual([]);
  expect(l.toAsk(["r2"], 40_000)).toEqual(["r2"]);
  expect(l.look(["r1", "r2"], [], 40_000)).toBe("unanswered");
  l.answered("r2", timeout, 48_000);
  l.answered("r2", timeout, 48_000 + 1); // a fourth, as if asked again
  expect(l.toAsk(["r2"], 48_001 + TIMEOUT_BACKOFF_MAX_MS - 1)).toEqual([]);
  expect(l.toAsk(["r2"], 48_001 + TIMEOUT_BACKOFF_MAX_MS)).toEqual(["r2"]);
  // A late hit still opens it.
  expect(l.answered("r2", { kind: "hit", sessionId: "claude:a" }, 90_000)).toEqual({ sessionId: "claude:a" });
});

test("a runner that only errors: retried every couple of seconds, 'not answering' after 30s, never 'doesn't exist'", () => {
  const l = opened();
  for (let t = 0; t < SLOW_MS; t += RETRY_MS) {
    expect(l.toAsk(["r1"], t)).toEqual(["r1"]);
    l.answered("r1", error, t);
    expect(l.look(["r1"], [], t)).toBe("looking");
  }
  expect(l.look(["r1"], [], SLOW_MS)).toBe("unanswered");
});

test("a dropped link starts every wait over, and timeouts and errors before it don't count", () => {
  const l = opened();
  l.toAsk(["r1"], 0);
  l.answered("r1", timeout, ASK_TIMEOUT_MS);
  // The tab went to the background: the socket dropped.
  l.linkOpen(false, 9_000);
  expect(l.look(["r1"], [], 40_000)).toBe("connecting");
  expect(l.toAsk(["r1"], 40_000)).toEqual([]);
  // Back: asked at once (no backoff left over), and 30s counts from now.
  l.linkOpen(true, 40_000);
  expect(l.toAsk(["r1"], 40_000)).toEqual(["r1"]);
  expect(l.answered("r1", timeout, 48_000)).toEqual({ wake: true });
  expect(l.look(["r1"], [], 69_999)).toBe("looking");
  expect(l.look(["r1"], [], 70_000)).toBe("unanswered");
});

test("every connected runner said no but one is offline: maybe it has it; it's asked once it's back", () => {
  const l = opened();
  l.toAsk(["r1"], 0);
  l.answered("r1", miss, 10);
  expect(l.look(["r1"], ["r2"], SETTLE_MS)).toBe("maybeOffline");
  expect(l.toAsk(["r1", "r2"], 5_000)).toEqual(["r2"]);
  expect(l.answered("r2", { kind: "hit", sessionId: "claude:b" }, 5_100)).toEqual({ sessionId: "claude:b" });
});

test("no runner yet: wait, then say so (never 'doesn't exist'), timed from when the link opened; a code that can't be one is missing at once", () => {
  const l = opened(1_000);
  expect(l.look([], [], 1_000 + SETTLE_MS)).toBe("looking");
  expect(l.look([], [], 1_000 + OFFLINE_MS - 1)).toBe("looking");
  expect(l.look([], [], 1_000 + OFFLINE_MS)).toBe("offline");
  const bad = new Lookup("../x");
  expect(bad.look(["r1"], [], 0)).toBe("missing");
  bad.linkOpen(true, 0);
  expect(bad.toAsk(["r1"], 0)).toEqual([]);
});
