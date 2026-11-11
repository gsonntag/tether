import { expect, test } from "bun:test";
import { formatRoute, parseRoute, presenceFor } from "./route";
import { NO_ANSWER } from "./link";
import { askRunner, Lookup, OFFLINE_MS, RETRY_MS, SETTLE_MS } from "./shortLink";

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

test("asking a runner: a hit, a miss, an old runner's miss, a timeout and other errors", async () => {
  const fail = (m: string) => async () => Promise.reject(new Error(m));
  expect(await askRunner(async () => ({ sessionId: "claude:a" }), "r1", CODE)).toEqual({ kind: "hit", sessionId: "claude:a" });
  expect(await askRunner(async () => null, "r1", CODE)).toEqual(miss);
  expect(await askRunner(fail('This runner doesn\'t know "resolveLink". Update and restart it.'), "r1", CODE)).toEqual(miss);
  expect(await askRunner(fail(NO_ANSWER), "r1", CODE)).toEqual({ kind: "timeout" });
  for (const m of ["Disconnected.", "Not connected.", "That runner is offline."]) expect(await askRunner(fail(m), "r1", CODE)).toEqual({ kind: "error" });
});

test("nothing is asked, and nothing is missing, until the link opens; the settle wait counts from then", () => {
  const l = new Lookup(CODE, 0);
  expect(l.toAsk(["r1"], 0)).toEqual([]);
  // A slow cold load: the link opens late.
  l.linkOpen(true, 5_000);
  expect(l.toAsk(["r1"], 5_000)).toEqual(["r1"]);
  expect(l.toAsk(["r1"], 5_000)).toEqual([]);
  l.answered("r1", miss, 5_100);
  expect(l.look(["r1"], 5_100)).toBe("looking");
  expect(l.look(["r1"], 5_000 + SETTLE_MS)).toBe("missing");
  // A second runner connects: it's asked, and the page waits for it.
  expect(l.look(["r1", "r2"], 7_500)).toBe("looking");
  expect(l.toAsk(["r1", "r2"], 7_500)).toEqual(["r2"]);
});

test("a hit is the asked runner's session", () => {
  const l = new Lookup(CODE, 0);
  l.linkOpen(true, 0);
  l.toAsk(["r1", "r2"], 0);
  expect(l.answered("r1", miss, 10)).toBeUndefined();
  expect(l.answered("r2", { kind: "hit", sessionId: "claude:a" }, 10)).toBe("claude:a");
});

test("a dropped link or a restarting runner never reads as 'doesn't exist': it's asked again", () => {
  const l = new Lookup(CODE, 0);
  l.linkOpen(true, 0);
  l.toAsk(["r1"], 0);
  // The tab went to the background: the socket dropped mid-lookup.
  l.linkOpen(false, 100);
  l.answered("r1", { kind: "error" }, 100);
  expect(l.look(["r1"], 10_000)).toBe("looking");
  expect(l.toAsk(["r1"], 10_000)).toEqual([]);
  // Back: asked again, and the settle wait starts over.
  l.linkOpen(true, 10_000);
  expect(l.toAsk(["r1"], 10_000)).toEqual(["r1"]);
  l.answered("r1", { kind: "error" }, 10_100);
  expect(l.toAsk(["r1"], 10_200)).toEqual([]);
  expect(l.toAsk(["r1"], 10_100 + RETRY_MS)).toEqual(["r1"]);
  expect(l.answered("r1", { kind: "hit", sessionId: "claude:a" }, 12_200)).toBe("claude:a");
});

test("a wedged runner doesn't hold the page: once everyone answered or timed out, missing; it's still asked again", () => {
  const l = new Lookup(CODE, 0);
  l.linkOpen(true, 0);
  l.toAsk(["r1", "r2"], 0);
  l.answered("r1", miss, 50);
  expect(l.look(["r1", "r2"], 5_000)).toBe("looking");
  l.answered("r2", { kind: "timeout" }, 8_000);
  expect(l.look(["r1", "r2"], 8_000)).toBe("missing");
  expect(l.toAsk(["r1", "r2"], 8_000)).toEqual(["r2"]);
});

test("no runner yet: wait, then say so (never 'doesn't exist'); a code that can't be one is missing at once", () => {
  const l = new Lookup(CODE, 0);
  l.linkOpen(true, 0);
  expect(l.look([], SETTLE_MS)).toBe("looking");
  expect(l.look([], OFFLINE_MS)).toBe("offline");
  const bad = new Lookup("../x", 0);
  bad.linkOpen(true, 0);
  expect(bad.look(["r1"], 0)).toBe("missing");
  expect(bad.toAsk(["r1"], 0)).toEqual([]);
});
