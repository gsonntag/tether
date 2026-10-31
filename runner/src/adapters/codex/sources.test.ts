import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { providerConfig, privateEnvironment, sourceBilling, threadConnection } from "./sources";
import { remember, remembered, rememberIn } from "./remember";

let dir: string | undefined;
afterEach(() => { rememberIn(undefined); if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

test("private OpenAI and Azure providers require only the isolated environment key and disallow account fallback", () => {
  const openai = providerConfig("openai");
  const azure = providerConfig("azure", "https://example.openai.azure.com/openai/v1");
  expect(openai["model_providers.tether_openai.requires_openai_auth"]).toBe(false);
  expect(openai["model_providers.tether_openai.env_key"]).toBe("TETHER_CODEX_API_KEY");
  expect(openai["model_providers.tether_openai.base_url"]).toBe("https://api.openai.com/v1");
  expect(azure["model_providers.tether_azure.requires_openai_auth"]).toBe(false);
  expect(azure["model_providers.tether_azure.base_url"]).toBe("https://example.openai.azure.com/openai/v1");
  expect(() => providerConfig("azure")).toThrow("endpoint");
  expect(sourceBilling("azure")).toEqual({ kind: "provider", label: "Azure" });
  expect(sourceBilling("openai")).toEqual({ kind: "apiKey", label: "OpenAI API key" });
});

test("private processes remove inherited auth and tracing; unset supplies no key", () => {
  const names = ["OPENAI_API_KEY", "CODEX_API_KEY", "AZURE_OPENAI_API_KEY", "ANTHROPIC_API_KEY", "RUST_LOG", "OTEL_EXPORTER_OTLP_ENDPOINT", "TETHER_CODEX_API_KEY", "TETHER_GATEWAY_KEY"];
  const old = Object.fromEntries(names.map((k) => [k, process.env[k]]));
  const key = randomUUID();
  try {
    for (const k of names) process.env[k] = key;
    const env = privateEnvironment("/tmp/private-codex", key);
    expect(env.TETHER_CODEX_API_KEY).toBe(key);
    expect(env.CODEX_HOME).toBe("/tmp/private-codex");
    for (const name of names.filter((n) => n !== "TETHER_CODEX_API_KEY")) expect(env[name]).toBeUndefined();
    expect(privateEnvironment("/tmp/private-codex").TETHER_CODEX_API_KEY).toBeUndefined();
  } finally { for (const name of names) if (old[name] === undefined) delete process.env[name]; else process.env[name] = old[name]; }
});

test("remembering launch settings cannot put a credential into the session store", () => {
  dir = mkdtempSync("/tmp/claude-1001/keys/codex-remember-");
  const file = join(dir, "threads.json");
  rememberIn(file);
  const key = randomUUID();
  remember("id", { start: { model: "gpt-6-luna", credential: { source: "openai", revision: "r", key } }, applied: { model: "gpt-6-luna", credential: { source: "openai", revision: "r", key }, at: 1 } });
  expect(readFileSync(file, "utf8")).not.toContain(key);
  expect(readFileSync(file, "utf8")).not.toContain("credential");
  expect(remembered("id")?.start).toEqual({ model: "gpt-6-luna" });
});

test("existing sessions refuse another source before connecting to any daemon", async () => {
  rememberIn(undefined);
  remember("api", { source: { id: "private", source: "openai", projectPath: "/tmp" } });
  await expect(threadConnection("api", { source: "subscription", revision: "subscription" })).rejects.toThrow("another billing source");
  await expect(threadConnection("subscription", { source: "azure", revision: "a", key: randomUUID(), endpoint: "https://example.com" })).rejects.toThrow("another billing source");
});


test("an API source whose mapping cannot be persisted fails before it can be offered as a session", () => {
  dir = mkdtempSync("/tmp/claude-1001/keys/codex-mapping-");
  writeFileSync(join(dir, "not-a-directory"), "x");
  rememberIn(join(dir, "not-a-directory", "threads.json"));
  expect(() => remember("id", { source: { id: "private", source: "openai", projectPath: "/tmp" } })).toThrow("billing source");
});
