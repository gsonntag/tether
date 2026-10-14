import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// (the preloaded src/testenv.ts already points it at the shared scratch dir)
if (!process.env.TETHER_TEST_ROOT) process.env.TETHER_CONFIG_DIR = mkdtempSync(join(tmpdir(), "tether-uiprefs-"));
const { config, setUiPrefs, uiPrefs, CONFIG_DIR } = await import("./config");

test("sidebar window: 3 days by default, saved in runner.json, unknown values refused", () => {
  delete config().ui;
  expect(uiPrefs().sidebarDays).toBe(3);
  expect(setUiPrefs({ sidebarDays: 7 }).sidebarDays).toBe(7);
  expect(JSON.parse(readFileSync(join(CONFIG_DIR, "runner.json"), "utf8")).ui).toEqual({ sidebarDays: 7 });
  expect(setUiPrefs({ sidebarDays: 0 }).sidebarDays).toBe(0); // all
  expect(() => setUiPrefs({ sidebarDays: 5 })).toThrow();
  expect(uiPrefs().sidebarDays).toBe(0);
  expect(setUiPrefs({}).sidebarDays).toBe(0);
  // A hand-edited bad value reads as the default.
  config().ui = { sidebarDays: -2 };
  expect(uiPrefs().sidebarDays).toBe(3);
  delete config().ui;
});

test("expand shell: off by default, saved alongside the other prefs, one bad value refuses the whole change", () => {
  delete config().ui;
  expect(uiPrefs()).toEqual({ sidebarDays: 3, expandShell: false });
  expect(setUiPrefs({ expandShell: true })).toEqual({ sidebarDays: 3, expandShell: true });
  expect(setUiPrefs({ sidebarDays: 7 })).toEqual({ sidebarDays: 7, expandShell: true });
  expect(() => setUiPrefs({ expandShell: "yes" as any, sidebarDays: 1 })).toThrow();
  expect(uiPrefs()).toEqual({ sidebarDays: 7, expandShell: true });
  // Keys from a newer web app are ignored, not stored.
  expect(setUiPrefs({ nope: 1 } as any)).toEqual({ sidebarDays: 7, expandShell: true });
  expect(JSON.parse(readFileSync(join(CONFIG_DIR, "runner.json"), "utf8")).ui).toEqual({ sidebarDays: 7, expandShell: true });
  delete config().ui;
});
