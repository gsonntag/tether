import { expect, test } from "bun:test";
import { watchingChip, watchingLine, watchingTitle } from "./watching";

const now = new Date(2026, 10, 20, 23, 10).getTime();
const later = new Date(2026, 10, 20, 23, 40).getTime();

test("the row chip says watching, with the next wake when it's ahead", () => {
  expect(watchingChip({ n: 1, label: "x" }, now)).toBe("Watching");
  expect(watchingChip({ n: 1, label: "x", at: later }, now, "en-US")).toBe("Watching · wakes at 11:40 PM");
  expect(watchingChip({ n: 1, label: "x", at: now - 1 }, now)).toBe("Watching");
  expect(watchingTitle({ n: 2, label: "tail log" })).toBe("Waiting on 2 things, first: tail log. Its turn ended; this will wake it.");
});

test("the session view's line names the first watcher, who started it, and the next wake", () => {
  expect(watchingLine([{ kind: "monitor", label: "progress.log events", by: "Step 1" }], now)).toBe("Watching a monitor: “progress.log events” (subagent “Step 1”). It wakes when that reports.");
  expect(watchingLine([{ kind: "shell", label: "wait" }, { kind: "wakeup", label: "Autonomous loop", at: later }], now, "en-US")).toBe("Watching a background command: “wait” and 1 more · next wake at 11:40 PM. It wakes when that reports.");
});
