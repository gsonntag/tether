import { afterEach, describe, expect, test } from "bun:test";
import { getUsage, parseKiroUsage, simulateUsage } from "./usage";
import { simulatedUsage } from "./faults";

afterEach(() => {
  simulateUsage("claude");
  simulateUsage("codex");
  simulateUsage("kiro");
});

describe("parseKiroUsage", () => {
  const reset = Math.floor(Date.parse("2026-11-01T00:00:00Z") / 1000); // epoch seconds, as the API sends

  test("a credit pool becomes one window, with the plan and reset", () => {
    const u = parseKiroUsage({
      subscriptionInfo: { subscriptionTitle: "KIRO STUDENT", overageCapability: "OVERAGE_CAPABLE" },
      nextDateReset: reset,
      usageBreakdownList: [{ resourceType: "CREDIT", displayName: "Credits", currentUsageWithPrecision: 106.36, usageLimitWithPrecision: 1000 }],
    });
    expect(u.provider).toBe("kiro");
    expect(u.label).toBe("Kiro");
    expect(u.plan).toBe("KIRO STUDENT");
    expect(u.limited).toBeUndefined();
    expect(u.windows).toEqual([{ label: "Credits", percent: 11, resetsAt: reset * 1000, used: 106.36, limit: 1000 }]);
  });

  test("breakdowns without a limit are skipped; a full one reads as limited", () => {
    const u = parseKiroUsage({
      nextDateReset: "2026-11-01T00:00:00Z", // also accepts an ISO string
      usageBreakdownList: [
        { resourceType: "CREDIT", currentUsage: 1000, usageLimit: 1000 },
        { resourceType: "UNLIMITED", currentUsage: 42, usageLimit: 0 },
      ],
    });
    expect(u.windows).toEqual([{ label: "CREDIT", percent: 100, resetsAt: reset * 1000, used: 1000, limit: 1000 }]);
    expect(u.limited).toBe(true);
  });

  test("an \"Unknown\" plan and an empty response are tolerated", () => {
    expect(parseKiroUsage({ subscriptionInfo: { subscriptionTitle: "Unknown" }, usageBreakdownList: [] })).toEqual({
      provider: "kiro",
      label: "Kiro",
      plan: undefined,
      windows: [],
    });
    expect(parseKiroUsage({})).toEqual({ provider: "kiro", label: "Kiro", plan: undefined, windows: [] });
  });
});

describe("Kiro usage on the page", () => {
  test("simulated Kiro usage shows up in the report as its own provider", async () => {
    // All three simulated so getUsage reads no real login (and spawns no Claude process).
    simulateUsage("claude", simulatedUsage("claude", 10));
    simulateUsage("codex", simulatedUsage("codex", 20));
    simulateUsage("kiro", simulatedUsage("kiro", 50));
    const report = await getUsage(true);
    const kiro = report.providers.find((p) => p.provider === "kiro");
    expect(kiro?.label).toBe("Kiro (simulated)");
    expect(kiro?.windows[0]).toMatchObject({ label: "Credits", percent: 50, used: 500, limit: 1000 });
  });
});
