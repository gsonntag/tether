import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { fromLocalInput, presets, toLocalInput, whenLabel } from "./schedule";

// The browser's time zone is the person's: these run in New York's (DST on 2026-03-08 and 2026-11-01).
let tz: string | undefined;
beforeAll(() => {
  tz = process.env.TZ;
  process.env.TZ = "America/New_York";
});
afterAll(() => {
  if (tz === undefined) delete process.env.TZ;
  else process.env.TZ = tz;
});

const iso = (t: number) => new Date(t).toISOString();

describe("presets", () => {
  test("an afternoon: in 1 hour, tonight 9 PM, tomorrow 9 AM, as absolute UTC times", () => {
    const now = new Date("2026-11-18T15:30:00-05:00");
    const p = presets(now, "en-US");
    expect(p.map((x) => x.label)).toEqual(["In 1 hour", "Tonight 9:00 PM", "Tomorrow 9:00 AM"]);
    expect(iso(p[0]!.at)).toBe("2026-11-18T21:30:00.000Z");
    expect(iso(p[1]!.at)).toBe("2026-11-19T02:00:00.000Z");
    expect(iso(p[2]!.at)).toBe("2026-11-19T14:00:00.000Z");
  });

  test("late evening: no 'tonight'; the small hours: this morning", () => {
    expect(presets(new Date("2026-11-18T20:55:00-05:00"), "en-US").map((x) => x.key)).toEqual(["hour", "tomorrow"]);
    const p = presets(new Date("2026-11-19T01:10:00-05:00"), "en-US");
    expect(p.map((x) => x.key)).toEqual(["hour", "tonight", "morning"]);
    expect(iso(p[2]!.at)).toBe("2026-11-19T14:00:00.000Z");
  });

  test("across the spring-forward night, tomorrow 9 AM is 9 AM on the wall (EDT), and 1 hour is 1 hour", () => {
    const now = new Date("2026-03-07T22:00:00-05:00");
    const p = presets(now, "en-US");
    expect(iso(p.find((x) => x.key === "tomorrow")!.at)).toBe("2026-03-08T13:00:00.000Z");
    const night = new Date("2026-03-08T01:30:00-05:00");
    const h = presets(night, "en-US")[0]!;
    expect(h.at - night.getTime()).toBe(60 * 60 * 1000);
    expect(new Date(h.at).getHours()).toBe(3); // 1:30 EST + 1h = 3:30 EDT
  });

  test("across the fall-back night, tomorrow 9 AM is 9 AM EST", () => {
    const p = presets(new Date("2026-10-31T18:00:00-04:00"), "en-US");
    expect(iso(p.find((x) => x.key === "tomorrow")!.at)).toBe("2026-11-01T14:00:00.000Z");
    expect(iso(p.find((x) => x.key === "tonight")!.at)).toBe("2026-11-01T01:00:00.000Z");
  });
});

describe("the custom time", () => {
  test("round-trips through the input, in local time", () => {
    const at = new Date("2026-11-18T21:05:00-05:00").getTime();
    expect(toLocalInput(at)).toBe("2026-11-18T21:05");
    expect(fromLocalInput("2026-11-18T21:05")).toBe(at);
    expect(fromLocalInput("")).toBeUndefined();
    expect(fromLocalInput("nonsense")).toBeUndefined();
  });

  test("a time the spring-forward skips still gives a time", () => {
    const t = fromLocalInput("2026-03-08T02:30");
    expect(t).toBeNumber();
    expect(Number.isFinite(t)).toBe(true);
  });
});

describe("how it reads", () => {
  const now = new Date("2026-11-18T15:30:00-05:00").getTime();
  test("today, tomorrow, this week, later, another year", () => {
    expect(whenLabel(new Date("2026-11-18T21:00:00-05:00").getTime(), now, "en-US")).toBe("at 9:00 PM");
    expect(whenLabel(new Date("2026-11-19T09:00:00-05:00").getTime(), now, "en-US")).toBe("tomorrow at 9:00 AM");
    expect(whenLabel(new Date("2026-11-21T09:00:00-05:00").getTime(), now, "en-US")).toBe("Sat at 9:00 AM");
    expect(whenLabel(new Date("2026-12-02T09:00:00-05:00").getTime(), now, "en-US")).toBe("Dec 2 at 9:00 AM");
    expect(whenLabel(new Date("2027-01-04T09:00:00-05:00").getTime(), now, "en-US")).toBe("Jan 4, 2027 at 9:00 AM");
    expect(whenLabel(new Date("2026-11-17T21:00:00-05:00").getTime(), now, "en-US")).toBe("yesterday at 9:00 PM");
  });
});
