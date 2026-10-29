import { expect, test } from "bun:test";
import { effortLabel, modelLabel, permissionModeLabel, prettyModel } from "./labels";

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
