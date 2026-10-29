import { expect, test } from "bun:test";
import type { RunnerInfo } from "../../shared/protocol";
import { ago, mergeRunners, reconnected, type KnownRunner } from "./runners";

const info = (id: string, connectedAt = 1): RunnerInfo => ({ id, name: id, hostname: id, version: "0", protocol: 1, harnesses: [], connectedAt });

test("runners that drop off the server's list stay, as disconnected", () => {
  const first = mergeRunners([], [info("b"), info("a")], 100);
  expect(first.map((r) => [r.id, r.online, r.lastSeen])).toEqual([["a", true, 100], ["b", true, 100]]);
  const second = mergeRunners(first, [info("b")], 200);
  expect(second.map((r) => [r.id, r.online, r.lastSeen])).toEqual([["b", true, 200], ["a", false, 100]]);
});

test("a runner that reconnected, or came online, needs fresh subscriptions", () => {
  const before: KnownRunner[] = mergeRunners([], [info("a", 1), info("b", 1)], 0);
  const after = mergeRunners(before, [info("a", 1), info("b", 2), info("c", 3)], 0);
  expect(reconnected(before, after).sort()).toEqual(["b", "c"]);
  const offline = mergeRunners(after, [], 0);
  expect(reconnected(after, offline)).toEqual([]);
  expect(reconnected(offline, mergeRunners(offline, [info("a", 1)], 0))).toEqual(["a"]);
});

test("relative times", () => {
  const now = 10_000_000;
  expect(ago(now - 5_000, now)).toBe("just now");
  expect(ago(now - 5 * 60_000, now)).toBe("5 min ago");
  expect(ago(now - 3 * 3600_000, now)).toBe("3 h ago");
  expect(ago(now - 72 * 3600_000, now)).toBe("3 days ago");
});
