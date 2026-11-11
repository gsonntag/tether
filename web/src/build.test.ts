import { expect, test } from "bun:test";
import { checkBuild } from "./build";

test("another build's id marks the page stale; the same id, junk or a failure doesn't; at most once a minute", async () => {
  let stale = 0;
  const mark = () => void stale++;
  await checkBuild(mark, 1_000_000, async () => ({ build: "a" }), "a");
  expect(stale).toBe(0);
  // Within the minute: not asked again.
  await checkBuild(mark, 1_030_000, async () => ({ build: "b" }), "a");
  expect(stale).toBe(0);
  await checkBuild(mark, 1_070_000, async () => "<!doctype html>", "a");
  await checkBuild(mark, 1_140_000, async () => Promise.reject(new Error("offline")), "a");
  expect(stale).toBe(0);
  await checkBuild(mark, 1_210_000, async () => ({ build: "b" }), "a");
  expect(stale).toBe(1);
  // Dev never checks.
  await checkBuild(mark, 2_000_000, async () => ({ build: "b" }), "dev");
  expect(stale).toBe(1);
});
