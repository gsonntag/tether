// Microsoft Foundry keys (credentials/foundry.ts, SPEC 5/5a): the user's Codex-native setup is
// found as-is (provider + profiles), the key resolves store → env → login shell, a Codex process
// gets `-c` overrides equal to `codex -p <profile>`, pi gets base URL + key, Azure's answers map
// to Test results, and no value reaches a view, an action result or a process it isn't for.

import { resetHome } from "../testenv";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentEnv, resetSecretsCache } from "../secrets";
import { classifyCodexError } from "../adapters/codex";
import { classify, isTransient } from "../fallback";
import { azureResult, codexAzureProviders, codexArgs, foundryPlugin, normalizeEndpoint, PI_AZURE_EXT, resourceId, setFetch, suggestionOrder, setShellReader, shellVar, SHELL_TIMEOUT, TETHER_CODEX_PROVIDER, _shellFile } from "./foundry";
import { credentialAction, credentialModels, launchFor, listCredentials, register, removeCredential, testCredential, unregister } from "./registry";
import * as store from "./store";

const KEY = "az-SECRET-key-value-9876";
const SHELL_KEY = "sh-SECRET-from-bashrc-5555";
const BASE = "https://east-coast-gavin-resource.openai.azure.com/openai/v1";
const ID = "azure:east-coast-gavin-resource";

/** The user's real layout (SPEC 5a), in the scratch HOME. */
function userCodexConfig() {
  const dir = join(process.env.HOME!, ".codex");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "config.toml"),
    `model = "gpt-6-luna"\n\n[projects."/tmp/x"]\ntrust_level = "trusted"\n\n[model_providers.azure]\nname = "Azure OpenAI"\nbase_url = "${BASE}"\nenv_key = "AZURE_OPENAI_API_KEY"\nwire_api = "responses"\n`,
  );
  for (const [p, m] of [["azure-luna", "gpt-6-luna"], ["azure-sol", "gpt-6.1-sol"], ["azure-astra", "gpt-6-astra"]])
    writeFileSync(join(dir, `${p}.config.toml`), `model_provider = "azure"\nmodel = "${m}"\nmodel_reasoning_effort = "high"\n`);
  // Not Azure: ignored.
  writeFileSync(join(dir, "other.config.toml"), `model = "gpt-6-luna"\n`);
}

type Call = { url: string; method: string; headers: Record<string, string>; body?: any };
let calls: Call[] = [];
/** Azure stand-in: `answer(url, body)` gives status + JSON. */
function fakeAzure(answer: (url: string, body: any) => [number, any]) {
  calls = [];
  setFetch((async (url: any, init: any = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url: String(url), method: init.method ?? "GET", headers: init.headers ?? {}, body });
    const [status, json] = answer(String(url), body);
    return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
  }));
}

let shellReads: string[] = [];
beforeEach(() => {
  resetHome();
  store.resetCredentialStore();
  resetSecretsCache();
  unregister();
  register(foundryPlugin);
  delete process.env.AZURE_OPENAI_API_KEY;
  shellReads = [];
  setShellReader(async (name) => (shellReads.push(name), name === "AZURE_OPENAI_API_KEY" ? SHELL_KEY : undefined));
  fakeAzure(() => [200, { data: [] }]);
});
afterEach(() => {
  unregister();
  setShellReader();
  setFetch();
  delete process.env.AZURE_OPENAI_API_KEY;
});

const entry = (harness: "codex" | "pi", model: string) => ({ harness, model, credential: ID });

describe("the user's Codex setup, as-is", () => {
  test("finds the Azure provider and its three profiles; other profiles and providers are left out", () => {
    userCodexConfig();
    const [p, ...rest] = codexAzureProviders();
    expect(rest).toEqual([]);
    expect(p).toMatchObject({ id: "azure", baseUrl: BASE, envKey: "AZURE_OPENAI_API_KEY", wireApi: "responses" });
    expect(p!.profiles.map((x) => [x.name, x.model, x.overrides])).toEqual([
      ["azure-astra", "gpt-6-astra", { model_reasoning_effort: "high" }],
      ["azure-luna", "gpt-6-luna", { model_reasoning_effort: "high" }],
      ["azure-sol", "gpt-6.1-sol", { model_reasoning_effort: "high" }],
    ]);
  });

  test("one row per resource, key from the login shell (named by its file), models for Codex and pi as “· Azure”", async () => {
    userCodexConfig();
    writeFileSync(join(process.env.HOME!, ".bashrc"), "export AZURE_OPENAI_BASE_URL\nexport AZURE_OPENAI_API_KEY\n");
    const list = await listCredentials();
    expect(list.providers).toEqual([{ provider: "azure", label: "Microsoft Foundry", actions: ["add"] }]);
    const [c] = list.credentials;
    expect(c).toMatchObject({ id: ID, kind: "apiKey", label: "east-coast-gavin-resource", endpointHost: "east-coast-gavin-resource.openai.azure.com", source: "shell", sourceNote: "From ~/.bashrc", state: "ok", last4: "5555" });
    expect(c!.actions).toEqual(["storeKey", "addModel"]);
    expect(c!.models!.filter((m) => m.harness === "codex").map((m) => [m.id, m.label, m.credentialLabel])).toEqual([
      ["gpt-6-astra", "azure-astra", "Azure"],
      ["gpt-6-luna", "azure-luna", "Azure"],
      ["gpt-6.1-sol", "azure-sol", "Azure"],
    ]);
    expect(c!.models!.filter((m) => m.harness === "pi").map((m) => m.id)).toEqual(["azure/gpt-6-astra", "azure/gpt-6-luna", "azure/gpt-6.1-sol"]);
    expect((await credentialModels("codex")).map((m) => `${m.id}#${m.credential} ${m.credentialLabel}`)).toContain(`gpt-6.1-sol#${ID} Azure`);
    expect(JSON.stringify(list)).not.toContain(SHELL_KEY);
  });

  test("a Codex session on a profile's model gets `-c` equal to `codex -p <profile>`, and only that key", async () => {
    userCodexConfig();
    const l = await launchFor(entry("codex", "gpt-6.1-sol"));
    expect(l.args).toEqual(["-c", 'model_provider="azure"', "-c", 'model="gpt-6.1-sol"', "-c", 'model_reasoning_effort="high"']);
    expect(l.env).toEqual({ AZURE_OPENAI_API_KEY: SHELL_KEY });
  });

  test("a pi session gets the base URL, the key, and the extension that makes it win over pi's own stored key", async () => {
    userCodexConfig();
    const l = await launchFor(entry("pi", "azure/gpt-6-luna"));
    expect(l).toEqual({ env: { AZURE_OPENAI_API_KEY: SHELL_KEY, AZURE_OPENAI_BASE_URL: BASE, AZURE_TETHER_SESSION_KEY: "1" }, args: ["-e", PI_AZURE_EXT] });
  });

  test("the pi extension sets the key as pi's runtime key (never auth.json) and takes it out of the env", async () => {
    const ext = (await import(PI_AZURE_EXT)).default;
    const handlers: Record<string, (e: any, ctx: any) => Promise<void>> = {};
    const set: [string, string][] = [];
    const ctx = { modelRegistry: { runtime: { setRuntimeApiKey: async (p: string, k: string) => void set.push([p, k]) } }, ui: { notify: () => {} } };
    process.env.AZURE_OPENAI_API_KEY = KEY;
    process.env.AZURE_TETHER_SESSION_KEY = "1";
    ext({ on: (ev: string, fn: any) => (handlers[ev] = fn) });
    await handlers.session_start!({}, ctx);
    expect(set).toEqual([["azure", KEY]]);
    expect(process.env.AZURE_OPENAI_API_KEY).toBeUndefined();
    expect(process.env.AZURE_TETHER_SESSION_KEY).toBeUndefined();
    // Not started by Tether for a credential: inert.
    process.env.AZURE_OPENAI_API_KEY = KEY;
    const none: Record<string, unknown> = {};
    ext({ on: (ev: string, fn: any) => (none[ev] = fn) });
    expect(none).toEqual({});
    // A pi without runtime keys: says so in the session.
    process.env.AZURE_TETHER_SESSION_KEY = "1";
    const notes: string[] = [];
    ext({ on: (ev: string, fn: any) => (handlers[ev] = fn) });
    await handlers.session_start!({}, { modelRegistry: {}, ui: { notify: (m: string) => notes.push(m) } });
    expect(notes[0]).toMatch(/pi's own azure key/);
    expect(notes[0]).not.toContain(KEY);
  });

  test("key order: Tether's store, then the runner's env, then the shell (read once, cached)", async () => {
    userCodexConfig();
    expect((await launchFor(entry("codex", "gpt-6-luna"))).env.AZURE_OPENAI_API_KEY).toBe(SHELL_KEY);
    expect((await launchFor(entry("codex", "gpt-6-luna"))).env.AZURE_OPENAI_API_KEY).toBe(SHELL_KEY);
    expect(shellReads).toEqual(["AZURE_OPENAI_API_KEY"]);
    process.env.AZURE_OPENAI_API_KEY = "env-SECRET-value-4444";
    expect((await launchFor(entry("codex", "gpt-6-luna"))).env.AZURE_OPENAI_API_KEY).toBe("env-SECRET-value-4444");
    expect((await listCredentials()).credentials[0]).toMatchObject({ source: "env", last4: "4444" });
    await credentialAction(ID, "replaceKey", { apiKey: KEY });
    expect((await launchFor(entry("codex", "gpt-6-luna"))).env.AZURE_OPENAI_API_KEY).toBe(KEY);
    expect((await listCredentials()).credentials[0]).toMatchObject({ source: "tether", last4: "9876", actions: ["addModel", "replaceKey"] });
  });

  test("“Store in Tether” keeps the shell's key in the store; the app never sees it", async () => {
    userCodexConfig();
    const r: any = await credentialAction(ID, "storeKey", undefined);
    expect(store.get(ID)?.values.apiKey).toBe(SHELL_KEY);
    expect(JSON.stringify(r)).not.toContain(SHELL_KEY);
    const [c] = (await listCredentials()).credentials;
    expect(c).toMatchObject({ source: "tether", state: "ok" });
    // Removing it falls back to the shell; the Codex resource stays.
    await removeCredential(ID);
    expect((await listCredentials()).credentials[0]).toMatchObject({ id: ID, source: "shell" });
    await expect(removeCredential(ID)).rejects.toThrow(/Codex config/);
  });

  test("no key anywhere: listed as not set up; a session refuses to start rather than run keyless", async () => {
    userCodexConfig();
    setShellReader(async () => undefined);
    const [c] = (await listCredentials()).credentials;
    expect(c).toMatchObject({ state: "missing", stateNote: "No key found (not in Tether, the runner env, or ~/.bashrc as AZURE_OPENAI_API_KEY)." });
    await expect(launchFor(entry("codex", "gpt-6-luna"))).rejects.toThrow(/east-coast-gavin-resource: No key found/);
  });

  test("a missing key isn't looked for in the shell on every list, only on demand (Test, a session start)", async () => {
    userCodexConfig();
    setShellReader(async (name) => (shellReads.push(name), undefined));
    await listCredentials();
    await listCredentials();
    expect(shellReads).toEqual(["AZURE_OPENAI_API_KEY"]);
    await testCredential(ID);
    expect(shellReads.length).toBe(2);
    await launchFor(entry("codex", "gpt-6-luna")).catch(() => {});
    expect(shellReads.length).toBe(3);
    // A found one is kept; Store in Tether / Test read it again.
    setShellReader(async (name) => (shellReads.push(name), SHELL_KEY));
    shellReads = [];
    await listCredentials();
    await launchFor(entry("codex", "gpt-6-luna"));
    expect(shellReads.length).toBe(1);
    await testCredential(ID);
    expect(shellReads.length).toBe(2);
  });

  test("a shell that never answers times out, isn't cached, and doesn't hold up the next ask", async () => {
    let hang = true;
    setShellReader((name) => (hang ? new Promise(() => {}) : Promise.resolve(name === "AZURE_OPENAI_API_KEY" ? SHELL_KEY : undefined)), 50);
    const t0 = Date.now();
    expect(await shellVar("AZURE_OPENAI_API_KEY")).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(5_000);
    hang = false;
    expect(await shellVar("AZURE_OPENAI_API_KEY")).toBe(SHELL_KEY);
    setShellReader(async () => SHELL_TIMEOUT, 50);
    expect(await shellVar("AZURE_OPENAI_API_KEY")).toBeUndefined();
  });
});

describe("the real login shell", () => {
  const profile = (text: string) => writeFileSync(join(process.env.HOME!, ".profile"), text);
  const alive = (tag: string) => Bun.spawnSync(["pgrep", "-f", tag]).stdout.toString().trim();

  test("answers as soon as the value is printed, though an rc file leaves `sleep 600 &` holding stdout; that job is killed", async () => {
    setShellReader(undefined, 4_000);
    profile("export FOUNDRY_TEST_VAR=from-profile-1234\nsleep 600.4242 &\n");
    const t0 = Date.now();
    expect(await shellVar("FOUNDRY_TEST_VAR")).toBe("from-profile-1234");
    expect(Date.now() - t0).toBeLessThan(3_500);
    await Bun.sleep(200);
    expect(alive("sleep 600.4242")).toBe("");
  });

  test("a shell stuck in its rc times out, kills its group, and the next ask runs again", async () => {
    setShellReader(undefined, 500);
    profile("sleep 600.4343\nexport FOUNDRY_TEST_VAR=never\n");
    const t0 = Date.now();
    expect(await shellVar("FOUNDRY_TEST_VAR")).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(2_500);
    await Bun.sleep(200);
    expect(alive("sleep 600.4343")).toBe("");
    profile("export FOUNDRY_TEST_VAR=second-try\n");
    expect(await shellVar("FOUNDRY_TEST_VAR")).toBe("second-try");
  });
});

describe("profiles and hosts", () => {
  test("two profiles on one deployment at other efforts are two entries; each launches with its own; NaN/Infinity left out", async () => {
    userCodexConfig();
    const dir = join(process.env.HOME!, ".codex");
    writeFileSync(join(dir, "azure-luna-low.config.toml"), `model_provider = "azure"\nmodel = "gpt-6-luna"\nmodel_reasoning_effort = "low"\nodd = nan\nbig = inf\n`);
    // Same deployment, same settings: one entry.
    writeFileSync(join(dir, "zz-luna-copy.config.toml"), `model_provider = "azure"\nmodel = "gpt-6-luna"\nmodel_reasoning_effort = "high"\n`);
    const [c] = (await listCredentials()).credentials;
    expect(c!.models!.filter((m) => m.harness === "codex").map((m) => [m.id, m.label])).toEqual([
      ["gpt-6-astra", "azure-astra"],
      ["gpt-6-luna", "azure-luna"],
      ["gpt-6-luna@azure-luna-low", "azure-luna-low"],
      ["gpt-6.1-sol", "azure-sol"],
    ]);
    expect(c!.models!.filter((m) => m.harness === "pi").map((m) => m.id)).toEqual(["azure/gpt-6-astra", "azure/gpt-6-luna", "azure/gpt-6.1-sol"]);
    expect((await launchFor(entry("codex", "gpt-6-luna@azure-luna-low"))).args).toEqual(["-c", 'model_provider="azure"', "-c", 'model="gpt-6-luna"', "-c", 'model_reasoning_effort="low"']);
    expect((await launchFor(entry("codex", "gpt-6-luna"))).args).toEqual(["-c", 'model_provider="azure"', "-c", 'model="gpt-6-luna"', "-c", 'model_reasoning_effort="high"']);
    // Test calls each deployment once.
    fakeAzure(() => [200, {}]);
    await testCredential(ID);
    expect(calls.map((x) => x.body.model).sort()).toEqual(["gpt-6-astra", "gpt-6-luna", "gpt-6.1-sol"]);
  });

  test("a stored key goes only to its own host: a Codex provider with the same resource name elsewhere gets its own row and not that key", async () => {
    await store.put({ id: ID, kind: "apiKey", label: "Mine", values: { apiKey: KEY }, endpointHost: "east-coast-gavin-resource.cognitiveservices.azure.com", meta: { baseUrl: "https://east-coast-gavin-resource.cognitiveservices.azure.com/openai/v1" } });
    userCodexConfig();
    const list = (await listCredentials()).credentials;
    const mine = list.find((c) => c.id === ID)!;
    const codex = list.find((c) => c.id !== ID)!;
    expect(mine).toMatchObject({ endpointHost: "east-coast-gavin-resource.cognitiveservices.azure.com", source: "tether" });
    expect(codex).toMatchObject({ id: "azure:east-coast-gavin-resource-azure", endpointHost: "east-coast-gavin-resource.openai.azure.com", source: "shell" });
    expect((await launchFor({ harness: "codex", model: "gpt-6-luna", credential: codex.id })).env.AZURE_OPENAI_API_KEY).toBe(SHELL_KEY);
    expect((await launchFor({ harness: "codex", model: "gpt-6-luna", credential: ID })).args).toContain('model_providers.tether-azure.base_url="https://east-coast-gavin-resource.cognitiveservices.azure.com/openai/v1"');
  });
});

describe("Tether-native keys", () => {
  test("endpoints as people paste them", () => {
    expect(normalizeEndpoint("east-coast")).toBe("https://east-coast.openai.azure.com/openai/v1");
    expect(normalizeEndpoint("https://east.openai.azure.com/")).toBe("https://east.openai.azure.com/openai/v1");
    expect(normalizeEndpoint("east.cognitiveservices.azure.com")).toBe("https://east.cognitiveservices.azure.com/openai/v1");
    expect(normalizeEndpoint(`${BASE}/responses?api-version=x`)).toBe(BASE);
    expect(() => normalizeEndpoint("http://east.openai.azure.com")).toThrow(/https/);
    expect(() => normalizeEndpoint("https://u:p@east.openai.azure.com")).toThrow(/credentials/);
    expect(resourceId("east-coast-gavin-resource.openai.azure.com")).toBe(ID);
  });

  test("add → add model (tested first) → a Codex process defines the provider itself; remove model; remove", async () => {
    fakeAzure((url, body) => (url.endsWith("/models") ? [200, { data: [{ id: "gpt-6-luna", capabilities: { chat_completion: true } }, { id: "text-embedding-3", capabilities: { chat_completion: false } }] }] : body?.model === "nope" ? [404, { error: { code: "DeploymentNotFound", message: "The API deployment for this resource does not exist." } }] : [200, { id: "r" }]));
    const added: any = await credentialAction("azure", "add", { endpoint: "https://west.openai.azure.com/", apiKey: KEY, label: "Work" });
    expect(JSON.stringify(added)).not.toContain(KEY);
    expect(calls[0]).toMatchObject({ url: "https://west.openai.azure.com/openai/v1/models", method: "GET" });
    expect(calls[0]!.headers["api-key"]).toBe(KEY);
    let [c] = (await listCredentials()).credentials;
    expect(c).toMatchObject({ id: "azure:west", label: "Work", source: "tether", last4: "9876", state: "ok" });
    expect(c!.models).toEqual([]);

    expect(((await credentialAction("azure:west", "suggest", undefined)) as any).message).toBe("gpt-6-luna");
    await expect(credentialAction("azure:west", "addModel", { deployment: "nope" })).rejects.toThrow(/isn't a deployment/);
    await expect(credentialAction("azure:west", "addModel", { deployment: "bad name" })).rejects.toThrow(/letters/);
    await credentialAction("azure:west", "addModel", { deployment: "gpt-6-luna" });
    expect(calls.at(-1)).toMatchObject({ url: "https://west.openai.azure.com/openai/v1/responses", method: "POST", body: { model: "gpt-6-luna", input: "Say OK.", max_output_tokens: 16, store: false } });
    [c] = (await listCredentials()).credentials;
    expect(c!.models!.map((m) => `${m.harness}:${m.id}`)).toEqual(["codex:gpt-6-luna", "pi:azure/gpt-6-luna"]);
    expect(c!.actions).toContain("removeModel");

    const l = await launchFor({ harness: "codex", model: "gpt-6-luna", credential: "azure:west" });
    const at = `model_providers.${TETHER_CODEX_PROVIDER}`;
    expect(l.args).toEqual(["-c", `${at}.name="Microsoft Foundry"`, "-c", `${at}.base_url="https://west.openai.azure.com/openai/v1"`, "-c", `${at}.env_key="AZURE_OPENAI_API_KEY"`, "-c", `${at}.wire_api="responses"`, "-c", `model_provider="${TETHER_CODEX_PROVIDER}"`, "-c", 'model="gpt-6-luna"']);
    expect(l.env).toEqual({ AZURE_OPENAI_API_KEY: KEY });

    await credentialAction("azure:west", "removeModel", { deployment: "gpt-6-luna" });
    expect((await listCredentials()).credentials[0]!.models).toEqual([]);
    await removeCredential("azure:west");
    expect((await listCredentials()).credentials).toEqual([]);
  });

  test("a key Azure refuses isn't stored; adding the same resource twice says Replace key", async () => {
    fakeAzure(() => [401, { error: { code: "401", message: "Access denied due to invalid subscription key." } }]);
    await expect(credentialAction("azure", "add", { endpoint: "west", apiKey: KEY })).rejects.toThrow(/didn't accept/);
    expect(store.ids()).toEqual([]);
    fakeAzure(() => [200, { data: [] }]);
    await credentialAction("azure", "add", { endpoint: "west", apiKey: KEY });
    await expect(credentialAction("azure", "add", { endpoint: "west", apiKey: KEY })).rejects.toThrow(/Replace key/);
  });

  test("a model added to the Codex resource (key from the shell) is kept without storing a key", async () => {
    userCodexConfig();
    await credentialAction(ID, "addModel", { deployment: "gpt-6-mini" });
    expect(store.get(ID)?.values).toEqual({});
    const [c] = (await listCredentials()).credentials;
    expect(c).toMatchObject({ source: "shell" });
    expect(c!.models!.filter((m) => m.harness === "codex").map((m) => m.id)).toContain("gpt-6-mini");
    // Its Codex process runs it on the user's own provider.
    expect((await launchFor(entry("codex", "gpt-6-mini"))).args).toEqual(["-c", 'model_provider="azure"', "-c", 'model="gpt-6-mini"']);
    await expect(credentialAction(ID, "removeModel", { deployment: "gpt-6-luna" })).rejects.toThrow(/Codex profile azure-luna/);
  });
});

describe("Test and faults", () => {
  test("one tiny call per model: all answer / one is a wrong deployment", async () => {
    userCodexConfig();
    fakeAzure(() => [200, {}]);
    expect(await testCredential(ID)).toEqual({ ok: true, result: "valid", message: "All 3 models answer." });
    expect(calls.map((c) => c.body.model).sort()).toEqual(["gpt-6-astra", "gpt-6-luna", "gpt-6.1-sol"]);
    expect(calls.every((c) => c.headers["api-key"] === SHELL_KEY)).toBe(true);
    fakeAzure((_u, b) => (b.model === "gpt-6-astra" ? [404, { error: { code: "DeploymentNotFound", message: "x" } }] : [200, {}]));
    expect(await testCredential(ID)).toEqual({ ok: false, result: "wrong deployment", message: "“gpt-6-astra” isn't a deployment on this resource." });
  });

  test("Azure's answers: invalid key, rate limit (its quota-increase link doesn't count), real quota", () => {
    expect(azureResult(401, { code: "401", message: "Access denied" })).toMatchObject({ ok: false, result: "invalid" });
    const rate = { code: "429", message: "Requests to the Responses_Create Operation have exceeded token rate limit of your current AIServices S0 pricing tier. Please retry after 6 seconds. Please go here: https://aka.ms/oai/quotaincrease if you would like to further increase the default rate limit." };
    expect(azureResult(429, rate, "gpt-6-luna")).toEqual({ ok: true, result: "rate limited", message: "“gpt-6-luna” works; Azure is rate-limiting it right now (retry after 6s)." });
    expect(azureResult(429, { code: "insufficient_quota", message: "You exceeded your current quota" }, "gpt-6-luna")).toMatchObject({ ok: false, result: "quota" });
  });

  test("the same Azure errors in a session: a rate limit backs off, a billing quota doesn't retry; usageLimitExceeded on a credential is never the ChatGPT limit", () => {
    const rate = "Requests to the Responses_Create Operation have exceeded token rate limit of your current AIServices S0 pricing tier. Please retry after 6 seconds. Please go here: https://aka.ms/oai/quotaincrease";
    // Codex retries a 429 itself, then fails the turn with the status.
    expect(isTransient(rate, 429)).toBe(true);
    expect(classify(rate, 429).resetAt).toBeGreaterThan(Date.now());
    expect(isTransient("insufficient_quota: You exceeded your current quota", 429)).toBe(false);
    expect(classifyCodexError({ codexErrorInfo: "usageLimitExceeded" }, "credential/model", () => 1).hint).toEqual({ kind: "quota" });
  });
});

describe("safety", () => {
  test("the shell is asked for the variable by indirection: a bad name is never run", async () => {
    setShellReader(async () => "x");
    expect(await shellVar("A; rm -rf /")).toBeUndefined();
  });

  test("startup-file detection names the file, not the value", () => {
    writeFileSync(join(process.env.HOME!, ".profile"), `export AZURE_OPENAI_API_KEY="${KEY}"\n`);
    expect(_shellFile("AZURE_OPENAI_API_KEY")).toBe("~/.profile");
    expect(_shellFile("OTHER")).toBeUndefined();
  });

  test("only the session's credential's key reaches a process; others get none", async () => {
    userCodexConfig();
    const on = await launchFor(entry("codex", "gpt-6-luna"));
    const p = Bun.spawn(["sh", "-c", 'printf "%s" "$AZURE_OPENAI_API_KEY"'], { stdout: "pipe", env: agentEnv(on.env) });
    expect(await new Response(p.stdout).text()).toBe(SHELL_KEY);
    const off = await launchFor({ harness: "codex", model: "gpt-6-luna" });
    const q = Bun.spawn(["sh", "-c", 'printf "%s" "$AZURE_OPENAI_API_KEY"'], { stdout: "pipe", env: agentEnv(off.env) });
    expect(await new Response(q.stdout).text()).toBe("");
  });

  test("suggestions: OpenAI models first, newest first, snapshots after; the rest A–Z", () => {
    expect(suggestionOrder(["DeepSeek-R1", "gpt-4o", "gpt-6.1-sol", "AI21-Jamba", "gpt-6-luna-2026-09-01", "gpt-6-luna", "o3"])).toEqual(["gpt-6.1-sol", "gpt-6-luna", "gpt-4o", "gpt-6-luna-2026-09-01", "o3", "AI21-Jamba", "DeepSeek-R1"]);
  });

  test("codexArgs quotes values as TOML", () => {
    const args = codexArgs({ baseUrl: "https://x.openai.azure.com/openai/v1", wireApi: "responses", deployments: new Map([["m", { deployment: "m", profile: { name: "p", model: "m", overrides: { model_reasoning_effort: 'hi"gh', n: 3, b: true } } }]]) }, "m");
    expect(args.slice(-6)).toEqual(["-c", 'model_reasoning_effort="hi\\"gh"', "-c", "n=3", "-c", "b=true"]);
  });
});
