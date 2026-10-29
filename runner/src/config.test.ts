import { expect, test } from "bun:test";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "./config";

const dir = () => mkdtempSync(join(tmpdir(), "tether-config-"));

test("defaults to the hostname when there's no file or no id", () => {
  const d = dir();
  expect(loadConfig(join(d, "runner.json")).runnerId).toBe(hostname());
  writeFileSync(join(d, "blank.json"), '{"runnerId":"  "}');
  expect(loadConfig(join(d, "blank.json")).runnerId).toBe(hostname());
});

test("saves privately and reads back", () => {
  const file = join(dir(), "sub", "runner.json");
  saveConfig({ runnerId: "tether-dev" }, file);
  expect(loadConfig(file).runnerId).toBe("tether-dev");
  expect(statSync(file).mode & 0o777).toBe(0o600);
});

test("a corrupt file is an error, not a silent reset", () => {
  const file = join(dir(), "runner.json");
  writeFileSync(file, "{");
  expect(() => loadConfig(file)).toThrow(/Can't read/);
});
