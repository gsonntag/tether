import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FallbackStep } from "../../../shared/fallbackChain";
import { saveConfig } from "../config";
import { RequestBroker } from "./broker";
import { EventBus } from "./bus";
import { FakeAdapter } from "./fakeAdapter";
import { LiveControl } from "./live";
import { Prefs } from "./prefs";
import { SessionCore } from "./sessions";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

test("fallback editor saves the session order, runner defaults and preset edits across restarts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fallback-editor-"));
  const file = join(dir, "runner.json");
  saveConfig({ runnerId: "test" }, file);
  const adapter = new FakeAdapter();
  adapter.addStored("one", []);
  adapter.addStored("two", []);
  const start = () => {
    const prefs = new Prefs(file);
    const core = new SessionCore({ adapters: [adapter], bus: new EventBus(), prefs, send: () => true, epoch: "test" });
    cleanups.unshift(() => core.stop());
    return new LiveControl(core, new RequestBroker());
  };
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const steps: FallbackStep[] = [
    { harness: "codex", source: "azure", model: "deployment", effort: "high" },
    { harness: "claude", source: "anthropic", model: "sonnet" },
  ];
  const live = start();
  expect((await live.fallbackSetup("claude:one")).chain).toEqual({ enabled: false, steps: [] });
  await live.setFallbackChain("claude:one", true, steps);
  const [preset] = live.editFallbackPreset({ action: "save", name: "Work", steps });
  live.editFallbackPreset({ action: "rename", id: preset!.id, name: "Long task" });

  const reloaded = start();
  const one = await reloaded.fallbackSetup("claude:one");
  expect(one.chain).toEqual({ enabled: true, steps });
  expect(one.presets).toEqual([{ ...preset!, name: "Long task" }]);
  expect((await reloaded.fallbackSetup("claude:two")).chain).toEqual({ enabled: false, steps });
  expect(reloaded.editFallbackPreset({ action: "delete", id: preset!.id })).toEqual([]);
  expect((await start().fallbackSetup("claude:two")).presets).toEqual([]);
});
