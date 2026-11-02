import { expect, test } from "bun:test";
import { modelIdProblem, MODEL_ID_MAX, planLines, reportedAt, isApiBilling, contextDetail, contextPercent, planChip, usageChip, effortLabel, findModel, modelLabel, permissionModeLabel, prettyModel } from "./labels";
import { keyTarget, keyTargets } from "./credentials";

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

test("the plan chip: 5-hour preferred, Week once it's out, both in the tooltip, a window past its reset gone", () => {
  const at = Date.UTC(2026, 10, 1);
  const fiveHour = { percent: 5, resetsAt: at + 3_600_000 };
  const week = { percent: 63, resetsAt: at + 86_400_000 };
  expect(planChip({ fiveHour, week }, at)?.text).toBe("5h 5%");
  expect(planChip({ fiveHour, week }, at)?.detail).toMatch(/^5-hour 5%, resets .+ · Weekly 63%, resets .+$/);
  expect(planChip({ fiveHour: { ...fiveHour, percent: 90 }, week }, at)?.text).toBe("5h 90%");
  expect(planChip({ week }, at + 2 * 86_400_000)).toBeUndefined();
  expect(planChip({ fiveHour: { ...fiveHour, resetsAt: at - 1 }, week }, at)?.detail).toMatch(/^Weekly 63%/);
  expect(planChip({ week: { percent: 7 } }, at)).toEqual({ text: "Week 7%", detail: "Weekly 7%" });
  expect(planChip(undefined)).toBeUndefined();
  expect(planChip({})).toBeUndefined();
  expect(planChip({ fiveHour: { percent: 0 }, week }, at)?.text).toBe("5h 0%");
  expect(planChip({ fiveHour: { ...fiveHour, resetsAt: at - 1 }, week }, at)?.text).toBe("Week 63%");
  // The week shows instead once it's the one that's out.
  expect(planChip({ fiveHour, week: { ...week, percent: 100 } }, at)?.text).toBe("Week 100%");
  expect(planChip({ fiveHour, week: { ...week, percent: 97, exhausted: true } }, at)?.text).toBe("Week 97%");
  expect(planChip({ fiveHour: { ...fiveHour, percent: 100 }, week: { ...week, percent: 99 } }, at)?.text).toBe("5h 100%");
});

test("the usage chip says what the session draws from; limits only on a plan", () => {
  const plan = { week: { percent: 63 } };
  expect(usageChip({ kind: "plan", label: "Claude plan" }, plan).text).toBe("Claude plan · Week 63%");
  for (const label of ["ChatGPT plan", "Claude plan"]) {
    expect(usageChip({ kind: "plan", label }, { ...plan, fiveHour: { percent: 10 } }).text).toBe(`${label} · 5h 10%`);
    expect(usageChip({ kind: "plan", label }, plan).text).toBe(`${label} · Week 63%`);
  }
  expect(usageChip({ kind: "plan", label: "Claude plan" }, undefined).text).toBe("Claude plan");
  expect(usageChip({ kind: "apiKey", label: "Anthropic API key" }, plan).text).toBe("Anthropic API key");
  expect(usageChip({ kind: "provider", label: "Azure" }, plan).text).toBe("Azure");
  expect(usageChip({ kind: "unknown", label: "Unknown" }, plan).text).toBe("Unknown");
});

test("findModel goes by id, then by what an alias resolves to, never by the default entry", () => {
  const list = [
    { id: "default", label: "Default", resolved: "claude-opus-5-5" },
    { id: "opus", label: "Opus 5.5", resolved: "claude-opus-5-5" },
  ];
  expect(findModel(list, "claude-opus-5-5")?.id).toBe("opus");
  expect(findModel(list, "default")?.id).toBe("default");
  expect(findModel(list, "haiku")).toBeUndefined();
  expect(findModel(list, undefined)).toBeUndefined();
});

test("metered indicators require confirmed API billing, never a plan or unknown", () => {
  for (const label of ["Anthropic API key", "OpenAI API key"]) expect(isApiBilling({ kind: "apiKey", label })).toBe(true);
  expect(isApiBilling({ kind: "provider", label: "Azure" })).toBe(true);
  expect(isApiBilling({ kind: "unknown", label: "Unknown" })).toBe(false);
  expect(isApiBilling({ kind: "plan", label: "Claude plan" })).toBe(false);
  expect(isApiBilling(undefined)).toBe(false);
});

test("the billing menu's plan lines: what's known, with its reset and, past an hour, its age", () => {
  const now = Date.UTC(2026, 10, 1, 12);
  const plan = { week: { percent: 64, resetsAt: now + 4 * 86_400_000, at: now - 60_000 }, fiveHour: { percent: 12.4, at: now - 3 * 3_600_000 } };
  const [week, five] = planLines(plan, now);
  expect(week).toMatch(/^Week 64% · resets .+$/);
  expect(week).not.toContain("ago");
  expect(five).toBe("5 hours 12% · 3h ago");
  expect(planLines({ week: { percent: 1, at: now - 3 * 86_400_000 } }, now)).toEqual(["Week 1% · 3d ago"]);
  expect(planLines({ week: { percent: 1, at: now - 3_600_000 } }, now)).toEqual(["Week 1%"]);
  // Past its reset, or never reported: no line, and no number made up.
  expect(planLines({ week: { percent: 90, resetsAt: now - 1 } }, now)).toEqual([]);
  expect(planLines(undefined, now)).toEqual([]);
  expect(planLines({}, now)).toEqual([]);
  expect(reportedAt({ week: { percent: 1 } }, 5)).toEqual({ week: { percent: 1, at: 5 } });
});

test("the key a plan session goes to: its last used, else the first set", () => {
  const plan = { source: "subscription" as const, billing: { kind: "plan" as const, label: "ChatGPT plan" } };
  const openai = { source: "openai" as const, billing: { kind: "apiKey" as const, label: "OpenAI API key" } };
  const azure = { source: "azure" as const, billing: { kind: "provider" as const, label: "Azure" } };
  expect(keyTarget([plan, openai, azure])).toBe(openai);
  expect(keyTarget([plan, openai, azure], "azure")).toBe(azure);
  expect(keyTarget([plan, openai], "azure")).toBe(openai);
  expect(keyTarget([plan, azure])).toBe(azure);
  expect(keyTarget([plan])).toBeUndefined();
  expect(keyTargets([plan, openai, azure], "openai", ["azure", "openai"])).toEqual([azure, openai]);
  expect(keyTarget([plan, openai, azure], "openai", ["azure"])).toBe(azure);
  expect(keyTarget([plan, openai], "openai", ["azure"])).toBeUndefined();
  expect(keyTarget([plan, openai, azure], "azure", [])).toBeUndefined();
  expect(keyTarget([plan, openai], undefined, ["azure", "openai"])).toBe(openai);

});

test("a typed model or deployment name: trimmed, short, a model id's characters, no control characters", () => {
  for (const ok of ["gpt-6-luna", "my-deploy_2", "claude-opus-5-5[1m]", "org/model:v1", "a"]) expect(modelIdProblem(ok)).toBeUndefined();
  for (const bad of ["", " gpt", "gpt ", "gpt 6", "gpt\u0000x", "gpt\nx", "-flag", "x;rm", "a\u202eb", "é", "x".repeat(MODEL_ID_MAX + 1), undefined, 7]) expect(modelIdProblem(bad)).toBeString();
  expect(modelIdProblem("x".repeat(MODEL_ID_MAX))).toBeUndefined();
});
