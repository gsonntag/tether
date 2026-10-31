import { expect, test } from "bun:test";
import { CLAUDE_UNSET } from "../../../../shared/transcript";
import { modelList } from "./models";

const LEVELS = ["low", "medium", "high"] as const;
const info = (value: string, resolvedModel: string, displayName: string, efforts = true): any => ({ value, resolvedModel, displayName, description: "", ...(efforts ? { supportsEffort: true, supportedEffortLevels: [...LEVELS] } : {}) });

test("Claude Code's own default isn't offered: nothing runs on it", () => {
  const list = modelList([info("default", CLAUDE_UNSET.model, "Default (recommended)"), info("opus", CLAUDE_UNSET.model, "Opus 5.5"), info("haiku", "claude-haiku-5-5", "Haiku 5.5")]);
  expect(list.models.map((m) => m.id)).toEqual(["opus", "haiku"]);
  expect(list.models[0]).toMatchObject({ label: "Opus 5.5", resolved: CLAUDE_UNSET.model });
});

test("a model without effort says so, with an empty list", () => {
  const list = modelList([info("opus", CLAUDE_UNSET.model, "Opus 5.5"), info("claude-haiku-4-5-20251001", "claude-haiku-4-5-20251001", "Haiku 4.5", false)]);
  expect(list.models.find((m) => m.id.includes("haiku"))!.efforts).toEqual([]);
});

test("the model Tether runs when nothing is chosen is offered even when Claude Code doesn't list it", () => {
  const list = modelList([info("haiku", "claude-haiku-5-5", "Haiku 5.5")]);
  expect(list.models[0]).toMatchObject({ id: CLAUDE_UNSET.model, label: "Opus 5.5" });
});
