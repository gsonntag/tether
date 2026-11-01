import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CredentialStore, SecretStream, redact, redactValue } from "./credentials";

const dir = () => { const root = "/tmp/claude-1001/keys/unit"; mkdirSync(root, { recursive: true }); return mkdtempSync(join(root, "credentials-")); };
const fake = (tag: string) => `fake-${tag}-${crypto.randomUUID()}`;

describe("private credentials", () => {
  test("Azure saves with a blank optional deployment", () => {
    const store = new CredentialStore(join(dir(), "credentials.json"));
    store.set("azure", fake("blank"), "https://example.azure.com/openai/v1", "");
    expect(store.status().azure.set).toBe(true);
    expect(store.status().azure.deployment).toBeUndefined();
    expect(store.snapshot("codex").deployment).toBeUndefined();
    expect(() => store.set("azure", fake("bad"), "https://example.azure.com/openai/v1", "has space")).toThrow("valid deployment");
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
    expect(store.snapshot("claude")).toEqual({ key, revision: "two", file, source: "anthropic" });
  });
  test("a key accidentally pasted into public Azure metadata cannot reach argv or status", () => {
    const store = new CredentialStore(join(dir(), "credentials.json")), key = fake("metadata");
    expect(() => store.set("azure", key, `https://example.azure.com/${key}`)).toThrow("must not contain a key");
    expect(() => store.set("azure", key, "https://example.azure.com/openai/v1", key)).toThrow("must not contain a key");
    expect(store.status().azure.set).toBe(false);
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
    expect(store.snapshot("claude").source).toBe("subscription");
    const status = store.set("anthropic", key);
    expect(status.anthropic).toEqual({ set: true, last4: key.slice(-4) });
    expect(JSON.stringify(status)).not.toContain(key);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(root)).toEqual(["credentials.json"]);
    expect(new CredentialStore(file).snapshot("claude").key).toBe(key);
    expect(redact(`provider echoed ${key}`)).toBe("provider echoed [redacted]");
    expect(redactValue({ error: [key] })).toEqual({ error: ["[redacted]"] });
    store.unset("anthropic");
    expect(readFileSync(file, "utf8")).not.toContain(key);
    expect(store.snapshot("claude").source).toBe("subscription");
    // A process running the retired key may still emit an error.
    expect(redact(key)).toBe("[redacted]");
  });
  test("Codex slots replace each other; unsetting never reactivates an old key", () => {
    const store = new CredentialStore(join(dir(), "credentials.json"));
    const first = fake("openai"), second = fake("azure");
    store.set("openai", first);
    const before = store.snapshot("codex").revision;
    store.set("azure", second, "https://example.openai.azure.com/openai/v1", "deploy");
    expect(store.status()).toMatchObject({ openai: { set: false }, azure: { set: true, deployment: "deploy" } });
    expect(store.snapshot("codex").revision).not.toBe(before);
    expect(readFileSync(store.file, "utf8")).not.toContain(first);
    store.unset("openai");
    expect(store.snapshot("codex").source).toBe("azure");
    store.unset("azure");
    expect(store.snapshot("codex")).toMatchObject({ source: "subscription", revision: "subscription" });
    expect(new CredentialStore(store.file).status().openai.set).toBe(false);
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
