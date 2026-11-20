import { expect, test } from "bun:test";
import { nextCronFire, soonest, watcherText, watchingSummary } from "./watchers";

const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi).getTime();

test("nextCronFire: one-shot, recurring, steps, ranges and day fields", () => {
  const now = at(2026, 11, 20, 23, 10);
  expect(nextCronFire("40 23 20 11 *", now)).toBe(at(2026, 11, 20, 23, 40));
  // A one-shot at a minute already past: next year.
  expect(nextCronFire("5 23 20 11 *", now)).toBe(at(2027, 11, 20, 23, 5));
  expect(nextCronFire("*/15 * * * *", now)).toBe(at(2026, 11, 20, 23, 15));
  expect(nextCronFire("0 9 * * 1-5", now)).toBe(at(2026, 11, 23, 9, 0)); // Nov 20 2026 is a Friday
  expect(nextCronFire("0 0 1 * *", now)).toBe(at(2026, 12, 1, 0, 0));
  expect(nextCronFire("* * * * *", now)).toBe(at(2026, 11, 20, 23, 11));
  expect(nextCronFire("0 9 * * 7", now)).toBe(at(2026, 11, 22, 9, 0)); // 7 is Sunday
});

test("nextCronFire: unreadable or impossible expressions", () => {
  const now = at(2026, 11, 20, 23, 10);
  expect(nextCronFire("nonsense", now)).toBeUndefined();
  expect(nextCronFire("61 * * * *", now)).toBeUndefined();
  expect(nextCronFire("0 0 31 2 *", now)).toBeUndefined();
});

test("watchingSummary and watcherText", () => {
  expect(watchingSummary(undefined)).toBeUndefined();
  expect(watchingSummary([])).toBeUndefined();
  const list = [
    { kind: "monitor" as const, label: "progress.log  events", by: "Step 1" },
    { kind: "wakeup" as const, label: "check again", at: 2000 },
    { kind: "wakeup" as const, label: "later", at: 3000, recurring: true },
  ];
  expect(watchingSummary(list)).toEqual({ n: 3, label: "progress.log events", at: 2000 });
  expect(soonest(list)).toBe(2000);
  expect(watcherText(list[0]!)).toBe("monitor “progress.log events” (started by subagent “Step 1”)");
  expect(watcherText(list[2]!)).toBe(`scheduled wakeup “later”, next fires at ${new Date(3000).toISOString()}`);
});
