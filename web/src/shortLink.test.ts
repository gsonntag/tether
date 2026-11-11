import { expect, test } from "bun:test";
import { formatRoute, parseRoute, presenceFor } from "./route";
import { askRunner, linkLook, OFFLINE_MS, SETTLE_MS } from "./shortLink";

test("#/l/<code> is a short link; old #/s/ links are unchanged", () => {
  expect(parseRoute("#/l/Ab3dE6gH")).toEqual({ page: "link", code: "Ab3dE6gH" });
  expect(parseRoute("#/l/Ab3dE6gH/")).toEqual({ page: "link", code: "Ab3dE6gH" });
  expect(parseRoute("#l/Ab3dE6gH")).toEqual({ page: "link", code: "Ab3dE6gH" });
  expect(formatRoute({ page: "link", code: "Ab3dE6gH" })).toBe("#/l/Ab3dE6gH");
  expect(parseRoute("#/l/")).toEqual({ page: "home" });
  expect(parseRoute("#/s/box%201/claude%3Aa")).toEqual({ page: "session", runnerId: "box 1", sessionId: "claude:a" });
  expect(presenceFor("#/l/Ab3dE6gH", true)).toEqual({});
});

test("what the page shows while it resolves", () => {
  const base = { code: "Ab3dE6gH", elapsedMs: 0, linkOpen: true, online: ["r1", "r2"], answered: new Set<string>() };
  expect(linkLook(base)).toBe("looking");
  // Every runner said no, but too soon: another may be about to connect.
  expect(linkLook({ ...base, answered: new Set(["r1", "r2"]) })).toBe("looking");
  expect(linkLook({ ...base, elapsedMs: SETTLE_MS, answered: new Set(["r1", "r2"]) })).toBe("missing");
  expect(linkLook({ ...base, elapsedMs: SETTLE_MS, answered: new Set(["r1"]) })).toBe("looking");
  expect(linkLook({ ...base, elapsedMs: SETTLE_MS, linkOpen: false, answered: new Set(["r1", "r2"]) })).toBe("looking");
  // No runner yet: wait, then say so (never "doesn't exist").
  expect(linkLook({ ...base, online: [], elapsedMs: SETTLE_MS })).toBe("looking");
  expect(linkLook({ ...base, online: [], elapsedMs: OFFLINE_MS })).toBe("offline");
  // A code that can't be one is missing at once.
  expect(linkLook({ ...base, code: "../x" })).toBe("missing");
});

test("asking a runner: a hit, a miss, and an error is a miss", async () => {
  expect(await askRunner(async () => ({ runnerId: "r1", sessionId: "claude:a" }), "r1", "Ab3dE6gH")).toEqual({ runnerId: "r1", sessionId: "claude:a" });
  expect(await askRunner(async () => null, "r1", "Ab3dE6gH")).toBeUndefined();
  expect(await askRunner(async () => Promise.reject(new Error("This runner doesn't know")), "r1", "Ab3dE6gH")).toBeUndefined();
});
