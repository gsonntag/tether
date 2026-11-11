import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../config";
import { Prefs } from "./prefs";

test("session settings are saved into runner.json beside the rest and read back", () => {
  const file = join(mkdtempSync(join(tmpdir(), "tether-prefs-")), "runner.json");
  saveConfig({ runnerId: "box", name: "Box" }, file);
  const p = new Prefs(file);
  p.set("claude:1", { model: "haiku", projectPath: "/p" });
  p.set("claude:1", { effort: "high" });
  p.flush();
  const saved = JSON.parse(readFileSync(file, "utf8"));
  expect(saved.runnerId).toBe("box");
  expect(saved.name).toBe("Box");
  expect(saved.sessions["claude:1"]).toMatchObject({ model: "haiku", effort: "high", projectPath: "/p" });
  expect(new Prefs(file).get("claude:1")).toMatchObject({ model: "haiku", effort: "high" });
  expect(new Prefs(file).get("claude:2")).toEqual({});
});

test("runner settings are kept in runner.json and survive a session save", () => {
  const file = join(mkdtempSync(join(tmpdir(), "tether-prefs-")), "runner.json");
  saveConfig({ runnerId: "r1" }, file);
  const p = new Prefs(file, 0);
  expect(p.settings()).toEqual({});
  expect(p.setSettings({ backgroundSubagents: true })).toEqual({ backgroundSubagents: true });
  p.set("claude:s1", { model: "opus" });
  p.flush();
  const saved = JSON.parse(readFileSync(file, "utf8"));
  expect(saved.settings).toEqual({ backgroundSubagents: true });
  expect(new Prefs(file).settings()).toEqual({ backgroundSubagents: true });
  p.setSettings({ backgroundSubagents: false });
  expect(JSON.parse(readFileSync(file, "utf8")).settings).toBeUndefined();
});
