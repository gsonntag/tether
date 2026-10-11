import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// (the preloaded src/testenv.ts already points it at the shared scratch dir)
if (!process.env.TETHER_TEST_ROOT) process.env.TETHER_CONFIG_DIR = mkdtempSync(join(tmpdir(), "tether-uiprefs-"));
const { config, setUiPrefs, uiPrefs, CONFIG_DIR } = await import("./config");

test("sidebar window: 3 days by default, saved in runner.json, unknown values refused", () => {
  delete config().ui;
  expect(uiPrefs()).toEqual({ sidebarDays: 3 });
  expect(setUiPrefs({ sidebarDays: 7 })).toEqual({ sidebarDays: 7 });
  expect(JSON.parse(readFileSync(join(CONFIG_DIR, "runner.json"), "utf8")).ui).toEqual({ sidebarDays: 7 });
  expect(setUiPrefs({ sidebarDays: 0 })).toEqual({ sidebarDays: 0 }); // all
  expect(() => setUiPrefs({ sidebarDays: 5 })).toThrow();
  expect(uiPrefs()).toEqual({ sidebarDays: 0 });
  expect(setUiPrefs({})).toEqual({ sidebarDays: 0 });
  // A hand-edited bad value reads as the default.
  config().ui = { sidebarDays: -2 };
  expect(uiPrefs()).toEqual({ sidebarDays: 3 });
  delete config().ui;
});
