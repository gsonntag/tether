import { describe, expect, test } from "bun:test";
import { modeLabel, pickerModes } from "./modes";

describe("mode picker", () => {
  test("Claude, Codex and opencode all offer plan mode", () => {
    expect(pickerModes({ modes: ["default", "plan"] })).toEqual(["default", "plan"]); // Claude Code, Codex
    expect(pickerModes({ modes: ["build", "plan"], permissionMode: "build" })).toEqual(["build", "plan"]); // opencode
  });

  test("modes that approve on their own never show; one mode left is no choice", () => {
    expect(pickerModes({ modes: ["default", "acceptEdits", "plan", "auto", "bypassPermissions"] })).toEqual(["default", "plan"]);
    expect(pickerModes({ modes: ["default", "bypassPermissions"] })).toEqual([]); // Antigravity
    expect(pickerModes({})).toEqual([]);
  });

  test("labels", () => {
    expect(["default", "plan", "build", "deep-research"].map(modeLabel)).toEqual(["Default", "Plan", "Build", "Deep research"]);
  });
});
