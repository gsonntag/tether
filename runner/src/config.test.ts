import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { displayName, loadConfig, saveConfig } from "./config";

const dir = () => mkdtempSync(join(tmpdir(), "tether-config-"));

test("first start generates a unique id and keeps it", () => {
  const file = join(dir(), "runner.json");
  const first = loadConfig(file);
  expect(first.runnerId).toMatch(/^[0-9a-f-]{36}$/);
  expect(loadConfig(file).runnerId).toBe(first.runnerId);
  expect(JSON.parse(readFileSync(file, "utf8")).runnerId).toBe(first.runnerId);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(loadConfig(join(dir(), "runner.json")).runnerId).not.toBe(first.runnerId);
});

test("a blank id is replaced; other fields are kept", () => {
  const file = join(dir(), "runner.json");
  writeFileSync(file, '{"runnerId":"  ","name":"Laptop"}');
  const cfg = loadConfig(file);
  expect(cfg.runnerId).toMatch(/^[0-9a-f-]{36}$/);
  expect(cfg.name).toBe("Laptop");
});

test("an existing id is used as is; the name defaults to the hostname", () => {
  const file = join(dir(), "sub", "runner.json");
  saveConfig({ runnerId: "tether-dev" }, file);
  const cfg = loadConfig(file);
  expect(cfg.runnerId).toBe("tether-dev");
  expect(displayName(cfg)).toBe(hostname());
  expect(displayName({ runnerId: "x", name: "Laptop" })).toBe("Laptop");
});

test("a corrupt file is an error, not a silent reset", () => {
  const file = join(dir(), "runner.json");
  writeFileSync(file, "{");
  expect(() => loadConfig(file)).toThrow(/Can't read/);
});
