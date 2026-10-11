import { describe, expect, test } from "bun:test";
import type { Msg } from "./shared/protocol";
import { BRIEF_PREFIX, formatMsgTime, fullMsgTime, timedMessages } from "./msgTime";

// Local times, so the tests hold in any time zone. "Now" is Sunday, Oct 11, 2026, 4:00 PM.
const at = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime();
const NOW = at(2026, 10, 11, 16, 0);
// Intl may put a narrow no-break space before AM/PM.
const fmt = (ts: number, now = NOW) => formatMsgTime(ts, now, "en-US").replace(/\s/g, " ");

describe("formatMsgTime", () => {
  test("today: the time", () => {
    expect(fmt(at(2026, 10, 11, 15, 42))).toBe("3:42 PM");
    expect(fmt(at(2026, 10, 11, 0, 5))).toBe("12:05 AM");
  });

  test("yesterday: Yesterday and the time", () => {
    expect(fmt(at(2026, 10, 10, 15, 42))).toBe("Yesterday 3:42 PM");
    expect(fmt(at(2026, 10, 10, 23, 59))).toBe("Yesterday 11:59 PM");
  });

  test("earlier this year: date and time", () => {
    expect(fmt(at(2026, 10, 9, 15, 42))).toBe("Oct 9, 3:42 PM");
    expect(fmt(at(2026, 1, 1, 9, 0))).toBe("Jan 1, 9:00 AM");
  });

  test("an earlier year: the date", () => {
    expect(fmt(at(2025, 10, 9, 15, 42))).toBe("Oct 9, 2025");
  });

  test("yesterday across a month and a year boundary", () => {
    expect(fmt(at(2026, 9, 30, 8, 0), at(2026, 10, 1, 9, 0))).toBe("Yesterday 8:00 AM");
    expect(fmt(at(2025, 12, 31, 22, 0), at(2026, 1, 1, 9, 0))).toBe("Yesterday 10:00 PM");
  });

  test("other locales use their own words and order", () => {
    expect(formatMsgTime(at(2026, 10, 10, 15, 42), NOW, "de-DE")).toBe("Gestern 15:42");
    expect(formatMsgTime(at(2026, 10, 11, 15, 42), NOW, "en-GB")).toBe("15:42");
  });

  test("the tooltip has the full date and time to the second", () => {
    expect(fullMsgTime(at(2026, 10, 9, 15, 42, 5), "en-US").replace(/\s/g, " ")).toBe("Friday, October 9, 2026 at 3:42:05 PM");
  });
});

describe("timedMessages", () => {
  const m = (id: string, role: Msg["role"], ts: number, text = "hi", extra: Partial<Msg> = {}): Msg => ({ id, role, ts, parts: [{ type: "text", text }], ...extra });
  const t0 = at(2026, 10, 11, 15, 0);

  test("the first of each run from the same side shows its time", () => {
    const list = [m("u1", "user", t0), m("a1", "assistant", t0 + 5_000), m("a2", "assistant", t0 + 20_000), m("u2", "user", t0 + 30_000)];
    expect([...timedMessages(list)]).toEqual(["u1", "a1", "u2"]);
  });

  test("a run shows the time again once a minute has passed since it last did", () => {
    const list = [m("a1", "assistant", t0), m("a2", "assistant", t0 + 40_000), m("a3", "assistant", t0 + 70_000), m("a4", "assistant", t0 + 100_000), m("a5", "assistant", t0 + 130_000)];
    expect([...timedMessages(list)]).toEqual(["a1", "a3", "a5"]);
  });

  test("tool results, handoff briefs and messages without a known time are skipped", () => {
    const toolOnly: Msg = { id: "tr", role: "user", ts: t0 + 10_000, parts: [{ type: "tool", id: "t", name: "Bash", input: {}, status: "done" }] };
    const list = [
      m("brief", "user", t0, `${BRIEF_PREFIX} …`),
      m("a1", "assistant", t0 + 1_000),
      toolOnly,
      m("a2", "assistant", t0 + 20_000),
      m("u0", "user", 0),
      m("n1", "notice", t0 + 30_000),
    ];
    expect([...timedMessages(list)]).toEqual(["a1", "n1"]);
  });

  test("a new day always shows the time", () => {
    const late = at(2026, 10, 10, 23, 59, 50);
    expect([...timedMessages([m("a1", "assistant", late), m("a2", "assistant", late + 20_000)])]).toEqual(["a1", "a2"]);
  });
});
