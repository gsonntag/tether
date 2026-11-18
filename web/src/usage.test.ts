import { expect, test } from "bun:test";
import { emptyTotals } from "../../shared/usage";
import { bars, dayLabel, fmtPart, fmtPrice, fmtTokens, modelName, niceMax, scanLine } from "./usage";

test("token counts read short", () => {
  expect([0, 950, 1000, 12_345, 999_499, 999_500, 3_449_999, 123_456_789, 8_722_131_942].map(fmtTokens)).toEqual(["0", "950", "1k", "12k", "999k", "1M", "3.4M", "123M", "8.7B"]);
});

test("a price says when it's partial, and when there is none", () => {
  const t = { ...emptyTotals(), requests: 3, usd: 12.345 };
  expect(fmtPrice(t)).toBe("$12.35");
  expect(fmtPrice({ ...t, unpriced: 1 })).toBe("$12.35+");
  expect(fmtPrice({ ...t, usd: 0, unpriced: 3 })).toBe("no price");
  expect(fmtPart(0, { requests: 3, unpriced: 3 })).toBe("—");
  expect(fmtPart(0.5, { requests: 3, unpriced: 1 })).toBe("$0.50");
  // An empty row is a priced zero, not "no price".
  expect(fmtPrice(emptyTotals())).toBe("$0.00");
});

test("axis tops are round", () => {
  expect([0, 0.3, 1, 1.2, 4, 7, 12, 8.7e9].map(niceMax)).toEqual([1, 0.5, 1, 2, 5, 10, 20, 1e10]);
});

test("bars stack from the bottom, scaled to the axis top", () => {
  const day = (d: string, input: number, output: number, cacheRead: number, cacheWrite: number, usd = 0) => ({ day: d, input, output, cacheRead, cacheWrite, usd });
  const { max, bars: list } = bars([day("2026-11-17", 100, 100, 600, 200, 3), day("2026-11-18", 0, 0, 0, 0)], "tokens", 100);
  expect(max).toBe(1000);
  expect(list[0]!.total).toBe(1000);
  expect(list[0]!.segments).toEqual([
    { key: "input", y: 90, h: 10 },
    { key: "output", y: 80, h: 10 },
    { key: "cacheWrite", y: 60, h: 20 },
    { key: "cacheRead", y: 0, h: 60 },
  ]);
  expect(list[1]!.segments).toEqual([]);
  const usd = bars([day("a", 1, 1, 1, 1, 3)], "usd", 100);
  expect([usd.max, usd.bars[0]!.segments]).toEqual([5, [{ key: "usd", y: 40, h: 60 }]]);
});

test("days are calendar days, whatever the browser's zone", () => {
  expect(dayLabel("2026-11-17", { month: "short", day: "numeric" })).toMatch(/Nov 17|17 Nov/);
  expect(dayLabel("nonsense")).toBe("nonsense");
});

test("names and the scan line", () => {
  expect(modelName("claude", "claude-opus-5-5")).toBe("Claude · Opus 5.5");
  expect(modelName("codex", "gpt-6-luna")).toBe("Codex · gpt-6-luna");
  expect(modelName("claude", "claude-haiku-4-5-20251001")).toBe("Claude · Haiku 4.5 (20251001)");
  const now = Date.parse("2026-11-18T12:00:00Z");
  expect(scanLine({ running: true, files: 3005, done: 120, errors: 0 }, now)).toBe("Reading session logs… 120 of 3,005 files");
  expect(scanLine({ running: false, files: 3005, done: 3005, at: now - 30_000, errors: 0 }, now)).toBe("Read just now");
  expect(scanLine({ running: false, files: 1, done: 1, at: now - 5 * 60_000, errors: 2 }, now)).toBe("Read 5 min ago · 2 files couldn't be read");
  expect(scanLine({ running: false, files: 0, done: 0, errors: 0 }, now)).toBe("");
});
