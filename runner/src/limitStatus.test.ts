import { describe, expect, test } from "bun:test";
import { LimitStatus } from "./limitStatus";

const T0 = 1_800_000_000_000;

describe("Claude rate-limit status", () => {
  test("a warning shows, a newer one updates it, and it clears when the window resets", () => {
    const l = new LimitStatus();
    expect(l.update({ status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.8, resetsAt: (T0 + 3_600_000) / 1000 }, T0)).toBe(true);
    expect(l.text()).toBe("80% of five_hour");
    expect(l.nextReset()).toBe(T0 + 3_600_000);
    l.update({ status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.93, resetsAt: (T0 + 3_600_000) / 1000 }, T0 + 1000);
    expect(l.text()).toBe("93% of five_hour");
    expect(l.expire(T0 + 3_599_999)).toBe(false);
    expect(l.expire(T0 + 3_600_000)).toBe(true);
    expect(l.text()).toBeUndefined();
    expect(l.nextReset()).toBeUndefined();
  });

  test("a later plain 'allowed' clears that window (no resetsAt needed)", () => {
    const l = new LimitStatus();
    l.update({ status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.75 }, T0);
    l.update({ status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.9 }, T0);
    expect(l.text()).toBe("90% of seven_day");
    expect(l.update({ status: "allowed", rateLimitType: "seven_day" }, T0)).toBe(true);
    expect(l.text()).toBe("75% of five_hour");
    expect(l.update({ status: "allowed" }, T0)).toBe(true); // untyped: everything is fine
    expect(l.text()).toBeUndefined();
    expect(l.update({ status: "allowed" }, T0)).toBe(false);
  });

  test("resetsAt in milliseconds; a warning already past its reset never shows; rejected is left to the quota path", () => {
    const l = new LimitStatus();
    l.update({ status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.5, resetsAt: T0 + 10 }, T0);
    expect(l.nextReset()).toBe(T0 + 10);
    l.update({ status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.6, resetsAt: T0 - 1 }, T0);
    expect(l.text()).toBe("50% of five_hour");
    expect(l.update({ status: "rejected", rateLimitType: "five_hour" }, T0)).toBe(false);
    expect(l.update(undefined)).toBe(false);
  });
});
