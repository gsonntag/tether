import { describe, expect, test } from "bun:test";
import { LEVEL, SLOT_LABEL, supportRows } from "./harnessSupport";
import type { HarnessCapabilities, SlotCapability } from "./shared/protocol";

const cap = (level: SlotCapability["level"]): SlotCapability => ({ level, note: level });
const all = (level: SlotCapability["level"]) => Object.fromEntries(Object.keys(SLOT_LABEL).map((s) => [s, cap(level)])) as any;

describe("Harness support table", () => {
  test("installed harnesses only, in the usual order; every feature, goal included", () => {
    const caps = { "claude-code": all("native"), codex: all("native"), pi: all("emulated"), opencode: all("native"), kiro: all("unsupported"), antigravity: all("emulated") } as HarnessCapabilities;
    const { harnesses, rows } = supportRows(caps, ["pi", "claude-code", "antigravity"]);
    expect(harnesses).toEqual(["claude-code", "pi", "antigravity"]);
    expect(rows.map((r) => r.slot)).toEqual(["mcp", "skills", "memory", "goal", "plan", "todos", "ask_user", "schedules", "commands", "agents", "hooks", "env"]);
  });

  test("plain labels for each level", () => {
    expect([LEVEL.native.label, LEVEL.emulated.label, LEVEL.unsupported.label]).toEqual(["Native", "Tether", "Not available"]);
  });
});
