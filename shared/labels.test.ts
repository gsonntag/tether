import { expect, test } from "bun:test";
import { contextDetail, contextPercent, planChip, usageChip, effortLabel, modelLabel, permissionModeLabel, prettyModel } from "./labels";

test("model ids read as people say them", () => {
  expect(prettyModel("claude-opus-5-5")).toBe("Opus 5.5");
  expect(prettyModel("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
  expect(prettyModel("claude-sonnet-5")).toBe("Sonnet 5");
  expect(prettyModel("opus")).toBe("Opus");
  expect(prettyModel("claude-sonnet-5[1m]")).toBe("Sonnet 5 (1M)");
  expect(prettyModel("gpt-6")).toBe("gpt-6");
});

test("labels prefer the harness's own names, and default says what it runs", () => {
  const models = [
    { id: "default", label: "Default (recommended)", resolved: "claude-opus-5-5" },
    { id: "opus", label: "Opus 5.5", resolved: "claude-opus-5-5" },
    { id: "haiku", label: "Haiku 5.5", resolved: "claude-haiku-5-5" },
  ];
  expect(modelLabel("haiku", models)).toBe("Haiku 5.5");
  expect(modelLabel("claude-haiku-5-5", models)).toBe("Haiku 5.5");
  expect(modelLabel("default", models)).toBe("Default (Opus 5.5)");
  expect(modelLabel("default")).toBe("Default");
  expect(modelLabel("claude-fable-5-1")).toBe("Fable 5.1");
  expect(effortLabel("xhigh")).toBe("Extra high");
  expect(effortLabel("high")).toBe("High");
  expect(permissionModeLabel("acceptEdits")).toBe("Accept edits");
  expect(permissionModeLabel("bypassPermissions")).toBe("Bypass permissions");
});

test("the context chip and its tooltip", () => {
  expect(contextPercent({ used: 84_000, total: 200_000 })).toBe("42%");
  expect(contextDetail({ used: 84_000, total: 200_000 })).toBe("84k of 200k context");
  expect(contextDetail({ used: 29_557, total: 1_000_000 })).toBe("30k of 1M context");
  expect(contextDetail({ used: 1_250_000, total: 2_000_000 })).toBe("1.3M of 2M context");
  expect(contextDetail({ used: 800, total: 258_400 })).toBe("800 of 258k context");
});

test("the plan chip: the fuller window, both in the tooltip, a window past its reset gone", () => {
  const at = Date.UTC(2026, 10, 1);
  const fiveHour = { percent: 5, resetsAt: at + 3_600_000 };
  const week = { percent: 63, resetsAt: at + 86_400_000 };
  expect(planChip({ fiveHour, week }, at)?.text).toBe("Week 63%");
  expect(planChip({ fiveHour, week }, at)?.detail).toMatch(/^5-hour 5%, resets .+ · Weekly 63%, resets .+$/);
  expect(planChip({ fiveHour: { ...fiveHour, percent: 90 }, week }, at)?.text).toBe("5h 90%");
  expect(planChip({ week }, at + 2 * 86_400_000)).toBeUndefined();
  expect(planChip({ fiveHour: { ...fiveHour, resetsAt: at - 1 }, week }, at)?.detail).toMatch(/^Weekly 63%/);
  expect(planChip({ week: { percent: 7 } }, at)).toEqual({ text: "Week 7%", detail: "Weekly 7%" });
  expect(planChip(undefined)).toBeUndefined();
  expect(planChip({})).toBeUndefined();
});

test("the usage chip says what the session draws from; limits only on a plan", () => {
  const plan = { week: { percent: 63 } };
  expect(usageChip({ kind: "plan", label: "Claude plan" }, plan).text).toBe("Claude plan · Week 63%");
  expect(usageChip({ kind: "plan", label: "Claude plan" }, undefined).text).toBe("Claude plan");
  expect(usageChip({ kind: "apiKey", label: "Anthropic API key" }, plan).text).toBe("Anthropic API key");
  expect(usageChip({ kind: "provider", label: "Azure" }, plan).text).toBe("Azure");
  expect(usageChip({ kind: "unknown", label: "Unknown" }, plan).text).toBe("Unknown");
});
