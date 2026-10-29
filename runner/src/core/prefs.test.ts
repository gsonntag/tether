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
