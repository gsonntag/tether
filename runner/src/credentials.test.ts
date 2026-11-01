import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CredentialStore, SecretStream, redact, redactValue } from "./credentials";

const dir = () => { const root = "/tmp/claude-1001/keys/unit"; mkdirSync(root, { recursive: true }); return mkdtempSync(join(root, "credentials-")); };
const fake = (tag: string) => `fake-${tag}-${crypto.randomUUID()}`;

describe("private credentials", () => {
  test("Azure's settings: a resource name is made into the v1 endpoint, a URL is kept; its key is apart", () => {
    const store = new CredentialStore(join(dir(), "credentials.json"));
    expect(store.setAzure({ endpoint: "My-Res", deployments: [] }).azure).toEqual({ set: false, endpoint: "https://my-res.openai.azure.com/openai/v1", deployments: [] });
    expect(store.setAzure({ endpoint: "https://foundry-x.services.ai.azure.com", deployments: [] }).azure.endpoint).toBe("https://foundry-x.services.ai.azure.com/openai/v1");
    expect(store.setAzure({ endpoint: "https://x.cognitiveservices.azure.com/openai/v1/", deployments: [] }).azure.endpoint).toBe("https://x.cognitiveservices.azure.com/openai/v1");
    for (const bad of ["http://x.openai.azure.com", "https://u:p@x.openai.azure.com", "https://x.openai.azure.com/openai/v1?api-version=1", "has space"]) expect(() => store.setAzure({ endpoint: bad, deployments: [] })).toThrow("resource name or HTTPS endpoint");
    const rates = { input: 1.25, output: 10, cached: 0.125 };
    store.setAzure({ endpoint: "my-res", deployments: [{ name: " d-one ", model: "gpt-6-luna", rates }, { name: "d-two" }] });
    expect(store.status().azure.deployments).toEqual([{ name: "d-one", model: "gpt-6-luna", type: "global", rates }, { name: "d-two", type: "global" }]);
    // No key yet: settings without a source.
    expect(store.snapshot("azure", "d-one")).toBeUndefined();
    const key = fake("azure");
    store.set("azure", key);
    expect(store.status().azure.deployments).toHaveLength(2);
    expect(store.snapshot("azure", "d-one")).toMatchObject({ key, deployment: "d-one", rates, endpoint: "https://my-res.openai.azure.com/openai/v1" });
    expect(store.snapshot("azure", "d-two")!.rates).toBeUndefined();
    expect(store.snapshot("azure", "gone")).toBeUndefined();
    // Each deployment is its own revision: one's rates changing leaves the other's process current.
    const two = store.snapshot("azure", "d-two")!.revision;
    store.setAzure({ endpoint: "my-res", deployments: [{ name: "d-one", rates: { ...rates, input: 2 } }, { name: "d-two" }] });
    expect(store.snapshot("azure", "d-two")!.revision).toBe(two);
    expect(store.snapshot("azure", "d-two")!.revision).not.toContain(key);
    // Unsetting the key keeps the settings.
    store.unset("azure");
    expect(store.status().azure).toMatchObject({ set: false, endpoint: "https://my-res.openai.azure.com/openai/v1" });
    expect(() => store.setAzure({ endpoint: "r", deployments: [{ name: "a" }, { name: "a" }] })).toThrow("twice");
    expect(() => store.setAzure({ endpoint: "r", deployments: [{ name: "has space" }] })).toThrow("valid deployment");
    expect(() => store.setAzure({ endpoint: "r", deployments: [{ name: "a", model: "a b" }] })).toThrow("valid model");
    expect(() => store.setAzure({ endpoint: "r", deployments: [{ name: "a", rates: { input: -1, output: 0, cached: 0 } }] })).toThrow("USD rates");
    expect(() => store.setAzure({ endpoint: "r", deployments: [{ name: "a", type: "provisioned" }] })).toThrow("deployment type");
    expect(() => store.setAzure({ endpoint: "r", deployments: [{ name: "a", rates: { input: 1, output: 1, cached: 1, cacheWrite: -1 } }] })).toThrow("USD rates");
    expect(() => store.setAzure({ endpoint: "r", deployments: Array.from({ length: 51 }, (_, n) => ({ name: `d${n}` })) })).toThrow("valid Azure deployments");
  });
  test("loaded Azure metadata fails closed too, and unsupported file fields never enter snapshots", () => {
    const file = join(dir(), "credentials.json"), key = fake("loaded");
    for (const endpoint of [`https://example.azure.com/${key}`, "http://example.azure.com/v1"]) {
      writeFileSync(file, JSON.stringify({ version: 1, codex: { key, revision: "one", source: "azure", endpoint } }), { mode: 0o600 });
      expect(() => new CredentialStore(file)).toThrow("Sending is disabled");
    }
    writeFileSync(file, JSON.stringify({ version: 1, anthropic: { key, revision: key } }), { mode: 0o600 });
    expect(() => new CredentialStore(file)).toThrow("Sending is disabled");
    writeFileSync(file, JSON.stringify({ version: 1, anthropic: { key, revision: "two", endpoint: key, arbitrary: key } }), { mode: 0o600 });
    const store = new CredentialStore(file);
    expect(store.status().anthropic).toEqual({ set: true, last4: key.slice(-4) });
    expect(store.snapshot("anthropic")).toEqual({ key, revision: "two", file, source: "anthropic" });
  });
  test("a key accidentally pasted into public Azure metadata cannot reach argv or status", () => {
    const store = new CredentialStore(join(dir(), "credentials.json")), key = fake("metadata");
    expect(() => store.set("azure", key, `https://example.azure.com/${key}`)).toThrow("must not contain a key");
    expect(() => store.set("azure", key, "https://example.azure.com/openai/v1", key)).toThrow("must not contain a key");
    expect(store.status().azure.set).toBe(false);
    store.set("azure", key);
    for (const d of [{ name: key }, { name: "d", model: key }]) expect(() => store.setAzure({ endpoint: "r", deployments: [d] })).toThrow("must not contain a key");
    expect(() => store.setAzure({ endpoint: `https://example.azure.com/${key}`, deployments: [] })).toThrow("must not contain a key");
    store.setAzure({ endpoint: "r", deployments: [{ name: "deployment-name-0123456789" }] });
    // A key that is already in Azure's settings is refused, before it's ever saved.
    expect(() => store.set("openai", "deployment-name-0123456789")).toThrow("must not contain a key");
    expect(store.status().openai.set).toBe(false);
    expect(JSON.stringify(store.status())).not.toContain(key);
  });
  test("short invalid input cannot poison subsequent protocol data or property names", () => {
    const store = new CredentialStore(join(dir(), "credentials.json"));
    expect(() => store.set("anthropic", "a")).toThrow("valid key");
    const wire = { data: { sessionId: "claude:abc", state: { status: "waiting", permissionMode: "default" } } };
    expect(redactValue(wire)).toEqual(wire);
    const key = fake("structural"); store.set("anthropic", key);
    expect(Object.keys(redactValue({ [key]: "value" }))).toEqual([key]);
  });
  test("a key split at every possible PTY boundary is redacted before browser output", () => {
    const key = fake("stream"), store = new CredentialStore(join(dir(), "credentials.json"));
    store.set("anthropic", key);
    for (let at = 1; at < key.length; at++) {
      const stream = new SecretStream();
      const a = stream.write(Buffer.from(`before ${key.slice(0, at)}`));
      const b = stream.write(Buffer.from(`${key.slice(at)} after!`));
      expect(Buffer.concat([a, b]).toString()).toBe("before [redacted] after!");
    }
  });
  test("only status leaves the store; keys persist solely in a private atomic file", () => {
    const root = dir(), file = join(root, "credentials.json"), key = fake("anthropic");
    const store = new CredentialStore(file);
    expect(store.snapshot("anthropic")).toBeUndefined();
    const status = store.set("anthropic", key);
    expect(status.anthropic).toEqual({ set: true, last4: key.slice(-4) });
    expect(JSON.stringify(status)).not.toContain(key);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(root)).toEqual(["credentials.json"]);
    expect(new CredentialStore(file).snapshot("anthropic")!.key).toBe(key);
    expect(redact(`provider echoed ${key}`)).toBe("provider echoed [redacted]");
    expect(redactValue({ error: [key] })).toEqual({ error: ["[redacted]"] });
    store.unset("anthropic");
    expect(readFileSync(file, "utf8")).not.toContain(key);
    expect(store.snapshot("anthropic")).toBeUndefined();
    expect(store.snapshot("subscription")).toMatchObject({ source: "subscription", revision: "subscription" });
    // A process running the retired key may still emit an error.
    expect(redact(key)).toBe("[redacted]");
  });
  test("all three keys stay set together; setting or unsetting one touches no other", () => {
    const store = new CredentialStore(join(dir(), "credentials.json"));
    const first = fake("openai"), second = fake("azure"), third = fake("anthropic");
    store.set("openai", first);
    const before = store.snapshot("openai")!.revision;
    store.set("azure", second, "https://example.openai.azure.com/openai/v1", "deploy");
    store.set("anthropic", third);
    expect(store.status()).toMatchObject({ openai: { set: true }, azure: { set: true, deployments: [{ name: "deploy" }] }, anthropic: { set: true } });
    expect(store.snapshot("openai")).toMatchObject({ key: first, revision: before });
    store.unset("azure");
    expect(store.snapshot("openai")).toMatchObject({ key: first, revision: before });
    expect(store.snapshot("azure", "deploy")).toBeUndefined();
    expect(readFileSync(store.file, "utf8")).not.toContain(second);
    const again = new CredentialStore(store.file);
    expect(again.status()).toMatchObject({ openai: { set: true }, azure: { set: false }, anthropic: { set: true } });
    expect(again.snapshot("openai")!.revision).toBe(before);
  });
  test("a replaced key is the same slot under a new revision", () => {
    const store = new CredentialStore(join(dir(), "credentials.json"));
    store.set("openai", fake("old"));
    const before = store.snapshot("openai")!.revision;
    store.set("openai", fake("new"));
    expect(store.snapshot("openai")!.revision).not.toBe(before);
  });
  test("the file as it was written before per-session sources still reads, and migrates on its next change", () => {
    const file = join(dir(), "credentials.json"), openai = fake("v1-openai"), anthropic = fake("v1-anthropic");
    writeFileSync(file, JSON.stringify({ version: 1, anthropic: { key: anthropic, revision: "a1" }, codex: { key: openai, revision: "c1", source: "openai" } }) + "\n", { mode: 0o600 });
    const store = new CredentialStore(file);
    expect(store.snapshot("openai")).toMatchObject({ key: openai, revision: "c1", source: "openai" });
    expect(store.snapshot("anthropic")).toMatchObject({ key: anthropic, revision: "a1" });
    expect(store.snapshot("azure")).toBeUndefined();
    expect(JSON.parse(readFileSync(file, "utf8")).version).toBe(1); // reading rewrites nothing
    store.set("azure", fake("v1-azure"), "https://example.azure.com/openai/v1");
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(saved.version).toBe(3);
    expect(saved.codex).toBeUndefined();
    expect(saved.openai).toEqual({ key: openai, revision: "c1" });
    expect(new CredentialStore(file).snapshot("openai")!.revision).toBe("c1");
    writeFileSync(file, JSON.stringify({ version: 1, codex: { key: openai, revision: "c1", source: "azure", endpoint: "https://example.azure.com/openai/v1", deployment: "d" } }), { mode: 0o600 });
    expect(new CredentialStore(file).snapshot("azure", "d")).toMatchObject({ key: openai, deployment: "d" });
    writeFileSync(file, JSON.stringify({ version: 1, codex: { key: openai, revision: "c1", source: "other" } }), { mode: 0o600 });
    expect(() => new CredentialStore(file)).toThrow("Sending is disabled");
    writeFileSync(file, JSON.stringify({ version: 4 }), { mode: 0o600 });
    expect(() => new CredentialStore(file)).toThrow("Sending is disabled");
  });
  test("types and Override: a row's pricing reaches its snapshot, and its model, type or rates restart only its process", () => {
    const store = new CredentialStore(join(dir(), "credentials.json"));
    store.set("azure", fake("azure"));
    const over = { input: 3, output: 7, cached: 1, cacheWrite: 4 };
    store.setAzure({ endpoint: "my-res", deployments: [{ name: "a", model: "gpt-6-luna", type: "dataZone" }, { name: "b", model: "DeepSeek-V4", type: "regional", rates: over }, { name: "c" }] });
    expect(store.status().azure.deployments).toEqual([{ name: "a", model: "gpt-6-luna", type: "dataZone" }, { name: "b", model: "DeepSeek-V4", type: "regional", rates: over }, { name: "c", type: "global" }]);
    expect(store.snapshot("azure", "a")!.pricing).toEqual({ model: "gpt-6-luna", type: "dataZone" });
    expect(store.snapshot("azure", "b")!.pricing).toEqual({ model: "DeepSeek-V4", type: "regional", rates: over });
    expect(store.snapshot("azure", "c")!.pricing).toEqual({ type: "global" });
    const [a, b] = [store.snapshot("azure", "a")!.revision, store.snapshot("azure", "b")!.revision];
    store.setAzure({ endpoint: "my-res", deployments: [{ name: "a", model: "gpt-6-luna", type: "global" }, { name: "b", model: "DeepSeek-V4", type: "regional", rates: over }, { name: "c" }] });
    expect(store.snapshot("azure", "a")!.revision).not.toBe(a);
    expect(store.snapshot("azure", "b")!.revision).toBe(b);
    store.setAzure({ endpoint: "my-res", deployments: [{ name: "a", model: "gpt-6.1-sol", type: "global" }, { name: "b", model: "DeepSeek-V4", type: "regional", rates: over }] });
    expect(store.snapshot("azure", "b")!.revision).toBe(b);
  });
  test("migration: version 3 rows from before types are Global; saved rates become their Override", () => {
    const file = join(dir(), "credentials.json"), azure = fake("v3-azure");
    const rates = { input: 1.1, output: 4.4, cached: 0.275 };
    writeFileSync(file, JSON.stringify({ version: 3, azure: { key: azure, revision: "z3" }, azureSettings: { endpoint: "https://east-res.openai.azure.com/openai/v1", deployments: [{ name: "manual", model: "gpt-6-luna", rates }, { name: "table", model: "gpt-6-luna" }] } }) + "\n", { mode: 0o600 });
    const store = new CredentialStore(file);
    expect(store.status().azure.deployments).toEqual([{ name: "manual", model: "gpt-6-luna", type: "global", rates }, { name: "table", model: "gpt-6-luna", type: "global" }]);
    expect(store.snapshot("azure", "manual")!.pricing).toEqual({ model: "gpt-6-luna", type: "global", rates });
    expect(store.snapshot("azure", "table")!.pricing).toEqual({ model: "gpt-6-luna", type: "global" });
    store.set("anthropic", fake("v3-anthropic"));
    expect(JSON.parse(readFileSync(file, "utf8")).azureSettings.deployments[1]).toEqual({ name: "table", model: "gpt-6-luna", type: "global" });
  });
  test("version 2's Azure slot becomes its key and a list of one deployment with its rates, rewritten at the next change", () => {
    const file = join(dir(), "credentials.json"), azure = fake("v2-azure"), openai = fake("v2-openai");
    const rates = { input: 1.1, output: 4.4, cached: 0.275 };
    writeFileSync(file, JSON.stringify({ version: 2, openai: { key: openai, revision: "o2" }, azure: { key: azure, revision: "z2", endpoint: "https://east-res.openai.azure.com/openai/v1", deployment: "luna-prod", rates } }) + "\n", { mode: 0o600 });
    const store = new CredentialStore(file);
    expect(store.status().azure).toEqual({ set: true, last4: azure.slice(-4), endpoint: "https://east-res.openai.azure.com/openai/v1", deployments: [{ name: "luna-prod", type: "global", rates }] });
    const snap = store.snapshot("azure", "luna-prod")!;
    expect(snap).toMatchObject({ key: azure, deployment: "luna-prod", rates, endpoint: "https://east-res.openai.azure.com/openai/v1" });
    expect(snap.revision.startsWith("z2:")).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8")).version).toBe(2); // reading rewrites nothing
    store.set("anthropic", fake("v2-anthropic"));
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(saved.version).toBe(3);
    expect(saved.azure).toEqual({ key: azure, revision: "z2" });
    expect(saved.azureSettings).toEqual({ endpoint: "https://east-res.openai.azure.com/openai/v1", deployments: [{ name: "luna-prod", type: "global", rates }] });
    expect(saved.openai).toEqual({ key: openai, revision: "o2" });
    // The same process stays current across the rewrite.
    expect(new CredentialStore(file).snapshot("azure", "luna-prod")!.revision).toBe(snap.revision);
    // No deployment: none listed, and rates that priced whatever model was picked aren't kept.
    writeFileSync(file, JSON.stringify({ version: 2, azure: { key: azure, revision: "z2", endpoint: "https://east-res.openai.azure.com/openai/v1", rates } }), { mode: 0o600 });
    expect(new CredentialStore(file).status().azure.deployments).toEqual([]);
    // No Azure at all (the prod file's shape): nothing appears.
    writeFileSync(file, JSON.stringify({ version: 2, openai: { key: openai, revision: "o2" } }), { mode: 0o600 });
    expect(new CredentialStore(file).status().azure).toEqual({ set: false, deployments: [] });
  });
  test("invalid input and file errors never echo key text; corrupt and public files fail closed", () => {
    const root = dir(), file = join(root, "credentials.json");
    const store = new CredentialStore(file);
    expect(() => store.set("azure", fake("a"), "http://example.com")).toThrow("HTTPS");
    expect(() => store.set("azure", fake("b"), "https://user:password@example.com")).toThrow("HTTPS");
    expect(() => store.set("anthropic", "has a space")).toThrow("valid key");
    writeFileSync(file, "{broken", { mode: 0o600 });
    expect(() => new CredentialStore(file)).toThrow("Sending is disabled");
    writeFileSync(file, '{"version":1}'); chmodSync(file, 0o644);
    expect(() => new CredentialStore(file)).toThrow("private credentials file");
    const link = join(root, "link"); symlinkSync(file, link);
    expect(() => new CredentialStore(link)).toThrow("private credentials file");
  });
});
