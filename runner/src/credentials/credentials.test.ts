// Credentials, Stage 0 (credentials/, .claude/credentials/SPEC.md): the store never lets a value
// out, "#credential" entries parse and validate, quotas are per credential, the registry routes by
// id, and a session's credential reaches its harness process through the start hook.

import { resetHome } from "../testenv";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { join } from "node:path";
import { entryProblem } from "../../../web/src/shared/defaultOrder";
import { formatEntry, parseEntry, type ChainEntry } from "../../../web/src/shared/protocol";
import { credentialOptions } from "../adapters/claude";
import { config } from "../config";
import { defaultOrder, saveDefaultOrder, sessionStart } from "../defaultOrder";
import { markExhausted, pickEntry, providerOf, quotaKey } from "../fallback";
import { isSensitive } from "../guard";
import { agentEnv, resetSecretsCache } from "../secrets";
import { LiveSession, type HandoffOpts } from "../session";
import { examplePlugin } from "./example";
import {
  credentialAction,
  credentialIds,
  credentialModels,
  launchFor,
  listCredentials,
  pluginFor,
  register,
  registered,
  removeCredential,
  testCredential,
  unregister,
  type CredentialPlugin,
} from "./registry";
import * as store from "./store";

const KEY = "ex-SECRET-value-1234";

beforeEach(() => {
  resetHome();
  store.resetCredentialStore();
  resetSecretsCache();
  unregister();
  config().exhausted = {};
});
afterEach(() => {
  unregister();
  delete config().defaultOrder;
  config().exhausted = {};
});

describe("store", () => {
  test("values go in and come back only through get; views carry the last 4 chars; mode 600", async () => {
    await store.put({ id: "example:a", kind: "apiKey", label: "A", values: { apiKey: KEY }, endpointHost: "a.example.com", models: [{ harness: "pi", id: "example/echo-1" }] });
    expect(store.get("example:a")?.values.apiKey).toBe(KEY);
    const v = store.views("example");
    expect(v).toEqual([
      { id: "example:a", kind: "apiKey", provider: "example", label: "A", endpointHost: "a.example.com", last4: "1234", source: "tether", state: "ok", setAt: expect.any(Number), models: [{ harness: "pi", id: "example/echo-1" }] },
    ]);
    expect(JSON.stringify(v)).not.toContain(KEY);
    expect(statSync(store.credentialsFile()).mode & 0o777).toBe(0o600);
    // update never touches values
    await store.update("example:a", { label: "B", values: { apiKey: "x" } } as any);
    expect(store.get("example:a")).toMatchObject({ label: "B", values: { apiKey: KEY } });
    expect(await store.remove("example:a")).toBe(true);
    expect(store.ids()).toEqual([]);
  });

  test("short values show no last 4; bad ids are refused", async () => {
    await store.put({ id: "example:s", kind: "apiKey", label: "S", values: { apiKey: "short" } });
    expect(store.views()[0]!.last4).toBeUndefined();
    await expect(store.put({ id: "nocolon", kind: "apiKey", label: "x", values: {} })).rejects.toThrow(/credential id/);
    await expect(store.put({ id: "example:a#b", kind: "apiKey", label: "x", values: {} })).rejects.toThrow(/credential id/);
  });

  test("the app never sees a value: listCredentials, actions and removal answer without it", async () => {
    register(examplePlugin);
    const { list } = { list: await listCredentials() };
    expect(list.credentials).toEqual([]);
    await credentialAction("example", "add", { name: "k1", apiKey: KEY, label: "My key" });
    const after = await listCredentials({ order: ["claude-code:opus", "pi:example/echo-1#example:k1"] });
    expect(JSON.stringify(after)).not.toContain(KEY);
    expect(after.providers).toEqual([{ provider: "example", label: "Example keys", actions: ["add"] }]);
    expect(after.credentials[0]).toMatchObject({ id: "example:k1", label: "My key", last4: "1234", usedIn: ["Default order #2"] });
    expect(await testCredential("example:k1")).toEqual({ ok: true, result: "valid" });
    await removeCredential("example:k1");
    expect((await listCredentials()).credentials).toEqual([]);
  });

  test("the guard keeps agents off the store and the account homes, wherever the config dir is", () => {
    expect(isSensitive(store.credentialsFile())).toBe(true);
    expect(isSensitive(join(store.accountsDir(), "anthropic-work", ".credentials.json"))).toBe(true);
    expect(isSensitive(join(store.accountsDir(), "x", "config.toml"))).toBe(true);
    const was = process.env.TETHER_CONFIG_DIR;
    process.env.TETHER_CONFIG_DIR = "/srv/tether-conf";
    try {
      expect(isSensitive("/srv/tether-conf/credentials.json")).toBe(true);
      expect(isSensitive("/srv/tether-conf/secrets.json")).toBe(true);
      expect(isSensitive("/srv/tether-conf/runner.json")).toBe(false);
    } finally {
      process.env.TETHER_CONFIG_DIR = was;
    }
  });
});

describe("#credential entries", () => {
  test("parse and format round-trip; no suffix, no credential", () => {
    expect(parseEntry("pi:azure/gpt-6-luna#azure:east", "claude-code")).toEqual({ harness: "pi", model: "azure/gpt-6-luna", credential: "azure:east" });
    expect(parseEntry("gpt-6-luna#azure:east", "codex")).toEqual({ harness: "codex", model: "gpt-6-luna", credential: "azure:east" });
    expect(parseEntry("codex:gpt-6-luna", "pi")).toEqual({ harness: "codex", model: "gpt-6-luna" });
    expect(parseEntry("codex:gpt-6-luna#", "pi")).toEqual({ harness: "codex", model: "gpt-6-luna" });
    expect(formatEntry({ harness: "codex", model: "gpt-6-luna", credential: "azure:east" })).toBe("codex:gpt-6-luna#azure:east");
    expect(formatEntry(parseEntry("pi:azure/gpt-6-luna#azure:east", "pi"))).toBe("pi:azure/gpt-6-luna#azure:east");
  });

  test("entryProblem: the shape always, existence when the runner's ids are given", () => {
    expect(entryProblem("codex:gpt-6-luna#azure:east")).toBeUndefined();
    expect(entryProblem("codex:gpt-6-luna#azure:east", new Set(["azure:east"]))).toBeUndefined();
    expect(entryProblem("codex:gpt-6-luna#azure:west", new Set(["azure:east"]))).toMatch(/isn't on this runner/);
    expect(entryProblem("codex:gpt-6-luna#nope")).toMatch(/isn't one/);
    expect(entryProblem("codex:#azure:east")).toMatch(/no model/);
    expect(entryProblem("codex:gpt-6-luna")).toBeUndefined();
  });

  test("saving a default order checks credentials against the runner's", async () => {
    register(examplePlugin);
    await credentialAction("example", "add", { name: "k1", apiKey: KEY });
    const ids = await credentialIds();
    expect([...ids]).toEqual(["example:k1"]);
    expect(saveDefaultOrder(["pi:example/echo-1#example:k1", "claude-code:opus"], ids)).toEqual(["pi:example/echo-1#example:k1", "claude-code:opus"]);
    expect(() => saveDefaultOrder(["pi:example/echo-1#example:gone"], ids)).toThrow(/isn't on this runner/);
    expect(defaultOrder()).toEqual(["pi:example/echo-1#example:k1", "claude-code:opus"]);
  });

  test("a new session on the order starts on its first entry's credential; a picked model can name one", () => {
    expect(sessionStart({ harness: "claude-code", useOrder: true }, ["codex:gpt-6-luna#azure:east", "claude-code:opus"], () => true)).toEqual({
      harness: "codex",
      model: "gpt-6-luna",
      credential: "azure:east",
      chain: ["codex:gpt-6-luna#azure:east", "claude-code:opus"],
    });
    expect(sessionStart({ harness: "pi", model: "azure/gpt-6-luna#azure:east" }, undefined)).toEqual({ harness: "pi", model: "azure/gpt-6-luna", credential: "azure:east" });
  });
});

describe("quotas per credential", () => {
  test("providerOf adds the credential; account A at its limit moves to account B", () => {
    expect(providerOf("opus", "claude-code")).toBe("claude-code:opus");
    expect(providerOf("opus", "claude-code", "anthropic:work")).toBe("claude-code:opus#anthropic:work");
    expect(providerOf("gpt-6-luna", "codex", "azure:east")).toBe("codex#azure:east");
    expect(providerOf("azure/gpt-6-luna", "pi", "azure:east")).toBe("azure#azure:east");
    const chain = ["claude-code:opus#anthropic:a", "claude-code:opus#anthropic:b", "claude-code:opus"];
    markExhausted(quotaKey(parseEntry(chain[0]!, "claude-code")), Date.now() + 60_000);
    const pick = pickEntry(chain, "claude-code");
    expect("entry" in pick && pick.entry).toEqual({ harness: "claude-code", model: "opus", credential: "anthropic:b" });
    // the machine's own login is its own quota
    markExhausted(quotaKey(parseEntry(chain[1]!, "claude-code")), Date.now() + 60_000);
    const next = pickEntry(chain, "claude-code");
    expect("entry" in next && next.entry).toEqual({ harness: "claude-code", model: "opus" });
  });
});

describe("registry", () => {
  const stub = (provider: string, over: Partial<CredentialPlugin> = {}): CredentialPlugin => ({
    provider,
    label: provider,
    discover: async () => [],
    envFor: async () => ({}),
    ...over,
  });

  test("routes by the id's provider; one plugin per provider", () => {
    const a = stub("azure");
    register(a, stub("bedrock"));
    expect(pluginFor("azure:east")).toBe(a);
    expect(pluginFor("kiro:me")).toBeUndefined();
    expect(() => register(stub("azure"))).toThrow(/twice/);
    expect(() => register(stub("Bad Name"))).toThrow(/lowercase/);
    expect(registered().map((p) => p.provider)).toEqual(["azure", "bedrock"]);
  });

  test("listCredentials: in registration order, other providers' ids dropped, a failing plugin reported", async () => {
    register(
      stub("azure", { discover: async () => [{ id: "azure:z", kind: "apiKey", provider: "azure", label: "Z", source: "shell", state: "ok" }, { id: "bedrock:sneaky", kind: "apiKey", provider: "bedrock", label: "S", source: "tether", state: "ok" }] }),
      stub("broken", { discover: async () => Promise.reject(new Error("no CLI")) }),
    );
    const l = await listCredentials();
    expect(l.credentials.map((c) => c.id)).toEqual(["azure:z"]);
    expect(l.providers.map((p) => p.provider)).toEqual(["azure", "broken"]);
    expect(l.errors).toEqual([{ provider: "broken", error: "no CLI" }]);
  });

  test("credential models join the harness's list with the credential named", async () => {
    register(
      stub("azure", {
        discover: async () => [{ id: "azure:east", kind: "apiKey", provider: "azure", label: "Azure (east)", source: "tether", state: "ok" }],
        models: async () => [
          { harness: "codex", id: "gpt-6-luna", credentialLabel: "Azure" },
          { harness: "pi", id: "azure/gpt-6-luna" },
        ],
      }),
    );
    await listCredentials();
    expect(await credentialModels("codex")).toEqual([{ id: "gpt-6-luna", credential: "azure:east", credentialLabel: "Azure" }]);
    expect(await credentialModels("pi")).toEqual([{ id: "azure/gpt-6-luna", credential: "azure:east", credentialLabel: "Azure (east)" }]);
    expect(await credentialModels("claude-code")).toEqual([]);
  });

  test("launchFor: nothing without a credential; refuses one nobody handles; checks what a plugin gives", async () => {
    expect(await launchFor({ harness: "codex", model: "x" })).toEqual({ env: {}, args: [] });
    await expect(launchFor({ harness: "codex", model: "x", credential: "azure:east" })).rejects.toThrow(/isn't available/);
    register(stub("azure", { envFor: async () => ({ "BAD NAME": "x" }) }));
    await expect(launchFor({ harness: "codex", model: "x", credential: "azure:east" })).rejects.toThrow(/bad environment variable/);
  });

  test("actions and removal go to the owner; unknown ones say so", async () => {
    register(examplePlugin);
    await expect(credentialAction("example", "fly", {})).rejects.toThrow(/no “fly”/);
    await expect(credentialAction("nobody", "add", {})).rejects.toThrow(/Nothing on this runner/);
    await expect(removeCredential("example:none")).rejects.toThrow(/Only keys stored/);
  });
});

describe("the process-start hook", () => {
  /** A harness whose "process" is a shell printing its credential env and args. */
  function stubSession(credential?: string) {
    const handoffs: ChainEntry[] = [];
    const sink = {
      emit: () => {},
      summary: () => {},
      handoff: async (_f: LiveSession, to: ChainEntry, _r: string, _p?: string, _o?: HandoffOpts) => void handoffs.push(to),
    };
    class Stub extends LiveSession {
      output = "";
      async start() {
        const cred = await this.credentialLaunch();
        const p = Bun.spawn(["sh", "-c", 'printf "%s|%s" "$EXAMPLE_API_KEY" "$TETHER_OWN"; for a in "$@"; do printf " %s" "$a"; done', "sh", ...cred.args], {
          stdout: "pipe",
          env: agentEnv({ ...cred.env, TETHER_OWN: "guard" }),
        });
        this.output = await new Response(p.stdout).text();
      }
      protected async send() {}
      async abort() {}
      async applyModel(m: string) {
        this.setState({ model: m });
      }
      async setThinking() {}
      async setPermissionMode() {}
      async rename() {}
      async listCommands() {
        return [];
      }
      async continueTurn() {}
      protected shutdown() {}
    }
    const s = new Stub("pi", { nativeId: crypto.randomUUID(), projectPath: process.env.HOME! }, sink);
    s.t.state.model = "example/echo-1";
    if (credential) s.t.state.credential = credential;
    return { s, handoffs };
  }

  test("the credential's env and args reach the spawned process, and only for a session on it", async () => {
    register(examplePlugin);
    await credentialAction("example", "add", { name: "k1", apiKey: KEY });
    const on = stubSession("example:k1");
    await on.s.start();
    expect(on.s.output).toBe(`${KEY}|guard --example-credential example:k1`);
    on.s.close();
    const off = stubSession();
    await off.s.start();
    expect(off.s.output).toBe("|guard");
    off.s.close();
  });

  test("a credential whose plugin is gone stops the start instead of running on another login", async () => {
    const { s } = stubSession("example:k1");
    await expect(s.start()).rejects.toThrow(/isn't available/);
    s.close();
  });

  test("picking a model on another credential (or the own login) moves to a new session; same credential switches the model", async () => {
    const { s, handoffs } = stubSession("example:k1");
    await s.setModelOrOrder("example/echo-2#example:k1");
    expect(s.t.state.model).toBe("example/echo-2");
    await s.setModelOrOrder("example/echo-1#example:k2");
    await s.setModelOrOrder("anthropic/claude-opus-5-5");
    expect(handoffs).toEqual([
      { harness: "pi", model: "example/echo-1", credential: "example:k2" },
      { harness: "pi", model: "anthropic/claude-opus-5-5" },
    ]);
    expect(s.currentEntry).toEqual({ harness: "pi", model: "example/echo-2", credential: "example:k1" });
    s.close();
  });
});

describe("Claude Code options", () => {
  test("env over the launch's (or the runner's), args as extraArgs", () => {
    expect(credentialOptions({ env: {}, args: [] })).toEqual({});
    const o = credentialOptions({ env: { AWS_REGION: "us-east-1" }, args: ["--settings", "/x.json", "--debug", "--model=opus"] }, { env: { A: "1" }, extraArgs: { keep: null } });
    expect(o).toEqual({ env: { A: "1", AWS_REGION: "us-east-1" }, extraArgs: { keep: null, settings: "/x.json", debug: null, model: "opus" } });
  });
});
