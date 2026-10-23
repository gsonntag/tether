// Credentials, Stage 0 (credentials/, .claude/credentials/SPEC.md): the store never lets a value
// out, "#credential" entries parse and validate, quotas are per credential, the registry routes by
// id, and a session's credential reaches its harness process through the start hook.

import { resetHome } from "../testenv";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import { claudeHomeOf, homeOptions, homeSessionStore } from "../adapters/claudeHome";
import { claudeHome, codexHome } from "../context/paths";
import { join } from "node:path";
import { entryProblem } from "../../../web/src/shared/defaultOrder";
import { formatEntry, parseEntry, type ChainEntry } from "../../../web/src/shared/protocol";
import { credentialOptions } from "../adapters/claude";
import { config } from "../config";
import { defaultOrder, saveDefaultOrder, sessionStart } from "../defaultOrder";
import { markExhausted, nextEntry, pickEntry, providerOf, quotaKey } from "../fallback";
import { isSensitive } from "../guard";
import { agentEnv, resetSecretsCache, setSecret } from "../secrets";
import { LiveSession, type HandoffOpts } from "../session";
import { examplePlugin } from "./example";
import {
  cleanView,
  credentialAction,
  credentialAvailable,
  envNameAllowed,
  homeFor,
  scrub,
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

/** A plugin that does nothing but own its provider's ids (so entries on them are available). */
const owner = (provider: string, over: Partial<CredentialPlugin> = {}): CredentialPlugin => ({ provider, label: provider, discover: async () => [], envFor: async () => ({}), ...over });

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
    register(owner("azure"));
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
    register(owner("anthropic"));
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

  test("a word after a flag is its value; anything else refuses the start instead of being dropped", () => {
    expect(credentialOptions({ env: {}, args: ["--x", "-1"] }).extraArgs).toEqual({ x: "-1" });
    expect(() => credentialOptions({ env: {}, args: ["-v"] })).toThrow(/--flag \[value\]/);
    expect(() => credentialOptions({ env: {}, args: ["--a", "b", "stray"] })).toThrow(/“stray”/);
  });
});

describe("what a plugin may give a process", () => {
  test("env names: providers' own and harness homes yes; what runs code, home, Tether's own no", async () => {
    for (const k of ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_USE_BEDROCK", "AWS_PROFILE", "AZURE_OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_BASE_URL", "PI_CODING_AGENT_DIR", "EXAMPLE_API_KEY", "MY_AZURE_KEY"])
      expect(envNameAllowed(k)).toBe(true);
    for (const k of ["PATH", "HOME", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "NODE_OPTIONS", "BUN_INSTALL", "TETHER_GUARD_KEY", "GIT_SSH_COMMAND", "SSH_AUTH_SOCK", "XDG_CONFIG_HOME", "https_proxy", "BASH_ENV", "PYTHONPATH"])
      expect(envNameAllowed(k)).toBe(false);
    // declared for the credential (a Codex provider's env_key): allowed over the deny list, never over ENV_NEVER
    expect(envNameAllowed("GIT_TOKEN", ["GIT_TOKEN"])).toBe(true);
    expect(envNameAllowed("PATH", ["PATH"])).toBe(false);
    expect(envNameAllowed("TETHER_GUARD_KEY", ["TETHER_GUARD_KEY"])).toBe(false);
    register(owner("azure", { envFor: async () => ({ NODE_OPTIONS: "--require /tmp/x.js" }) }));
    await expect(launchFor({ harness: "codex", model: "x", credential: "azure:east" })).rejects.toThrow(/can't set NODE_OPTIONS/);
    unregister("azure");
    register(owner("azure", { envFor: async () => ({ GIT_TOKEN: "tok-123456" }), envNames: () => ["GIT_TOKEN"] }));
    expect((await launchFor({ harness: "codex", model: "x", credential: "azure:east" })).env).toEqual({ GIT_TOKEN: "tok-123456" });
  });
});

describe("what reaches the app", () => {
  test("a view keeps only its own fields; a plugin's extras never leave", async () => {
    register(
      owner("azure", {
        discover: async () => [{ id: "azure:z", kind: "apiKey", provider: "azure", label: "Z", source: "shell", state: "ok", last4: "1234", apiKey: KEY, values: { k: KEY }, models: [{ harness: "codex", id: "gpt", token: KEY }] } as any],
      }),
    );
    const l = await listCredentials();
    expect(l.credentials).toEqual([{ id: "azure:z", kind: "apiKey", provider: "azure", label: "Z", source: "shell", state: "ok", last4: "1234", models: [{ harness: "codex", id: "gpt" }] }]);
    expect(JSON.stringify(l)).not.toContain(KEY);
    expect(cleanView({ id: "azure:z", label: "Z", last4: KEY })?.last4).toBeUndefined();
  });

  test("an action answers a typed result (message, https url, code, models, suggestions, next), never the raw one", async () => {
    register(
      owner("anthropic", {
        action: async (_id, name) =>
          name === "signIn"
            ? { url: "https://claude.ai/oauth?x=1", message: "Open it and paste the code", next: { action: "signInCode", prompt: "Code", secret: true }, token: KEY, raw: { a: 1 } }
            : name === "list"
              ? { models: [{ id: "us.anthropic.claude-opus-5-5", label: "Opus", harness: "claude-code" }, { nope: 1 }], suggestions: ["gpt-6-luna", 3] }
              : name === "bad"
                ? { url: "javascript:alert(1)", code: "ABCD-1234" }
                : "a string",
      }),
    );
    expect(await credentialAction("anthropic", "signIn", {})).toEqual({ url: "https://claude.ai/oauth?x=1", message: "Open it and paste the code", next: { action: "signInCode", prompt: "Code", secret: true } });
    expect(await credentialAction("anthropic", "list", {})).toEqual({ models: [{ id: "us.anthropic.claude-opus-5-5", label: "Opus", harness: "claude-code" }], suggestions: ["gpt-6-luna"] });
    expect(await credentialAction("anthropic", "bad", {})).toEqual({ code: "ABCD-1234" });
    expect(await credentialAction("anthropic", "other", {})).toBeUndefined();
  });

  test("messages are scrubbed of every known value: stored keys, your secrets, what a process was given", async () => {
    register(examplePlugin);
    await credentialAction("example", "add", { name: "k1", apiKey: KEY });
    await setSecret("MY_TOKEN", { value: "secret-token-xyz" });
    expect(scrub(`bad key ${KEY} and secret-token-xyz`)).toBe("bad key •••• and ••••");
    register(
      owner("azure", {
        test: async () => ({ ok: false, result: "invalid", message: `401 for key ${KEY}` }),
        action: async () => {
          throw new Error(`rejected ${KEY}`);
        },
        discover: async () => Promise.reject(new Error(`can't read ${KEY}`)),
      }),
    );
    expect((await testCredential("azure:x")).message).toBe("401 for key ••••");
    await expect(credentialAction("azure", "add", {})).rejects.toThrow("rejected ••••");
    expect((await listCredentials()).errors).toEqual([{ provider: "azure", error: "can't read ••••" }]);
    await setSecret("MY_TOKEN", { remove: true });
  });
});

describe("an unavailable credential is passed over", () => {
  test("plugin missing or record removed: sessionStart, pickEntry and nextEntry skip it like an uninstalled harness", async () => {
    const order = ["codex:gpt-6-luna#azure:east", "claude-code:opus"];
    // no plugin for azure on this runner
    expect(credentialAvailable("azure:east")).toBe(false);
    expect(sessionStart({ harness: "claude-code", useOrder: true }, order, () => true)).toMatchObject({ harness: "claude-code", model: "opus" });
    const pick = pickEntry(order, "claude-code");
    expect("entry" in pick && pick.entry).toEqual({ harness: "claude-code", model: "opus" });
    expect(nextEntry(["claude-code:sonnet", ...order], { harness: "claude-code", model: "sonnet" }, "claude-code")).toEqual({ harness: "claude-code", model: "opus" });

    // a stored one, removed: gone at once, and the answer says where it was used
    register(examplePlugin);
    await credentialAction("example", "add", { name: "k1", apiKey: KEY });
    expect(credentialAvailable("example:k1")).toBe(true);
    config().sessions["pi:s1"] = { chain: ["pi:example/echo-1#example:k1"] } as any;
    const r = await removeCredential("example:k1", ["claude-code:opus", "pi:example/echo-1#example:k1"]);
    expect(r.usedIn).toEqual(["Default order #2", "1 session"]);
    expect(credentialAvailable("example:k1")).toBe(false);
    expect(pickEntry(["pi:example/echo-1#example:k1", "pi:x/y"], "pi")).toEqual({ entry: { harness: "pi", model: "x/y" } });
    delete config().sessions["pi:s1"];
  });

  test("model lists answer from the last list and refresh it in the background", async () => {
    let calls = 0;
    let release!: () => void;
    register(
      owner("azure", {
        discover: async () => {
          calls++;
          if (calls > 1) await new Promise<void>((r) => (release = r));
          return [{ id: "azure:east", kind: "apiKey", provider: "azure", label: "Azure", source: "tether", state: "ok", models: [{ harness: "codex", id: `m${calls}` }] }];
        },
      }),
    );
    expect((await credentialModels("codex")).map((m) => m.id)).toEqual(["m1"]);
    // stale: answered at once from the old list while discovery (blocked here) runs
    const real = Date.now;
    Date.now = () => real() + 60_000;
    try {
      const t0 = performance.now();
      expect((await credentialModels("codex")).map((m) => m.id)).toEqual(["m1"]);
      expect(performance.now() - t0).toBeLessThan(500);
      release();
      await Bun.sleep(10);
      expect((await credentialModels("codex")).map((m) => m.id)).toEqual(["m2"]);
    } finally {
      Date.now = real;
    }
  });
});

describe("account homes (homeFor)", () => {
  test("Tether reads a session's native files in its credential's home; the machine's login is unchanged", async () => {
    const home = join(process.env.HOME!, ".config", "tether", "accounts", "work", "claude");
    register(owner("anthropic", { homeFor: (id, h) => (id === "anthropic:work" && h === "claude-code" ? home : undefined) }));
    expect(homeFor("anthropic:work", "claude-code")).toBe(home);
    expect(homeFor("anthropic:work", "codex")).toBeUndefined();
    expect(homeFor("anthropic:other", "claude-code")).toBeUndefined();
    expect(claudeHome()).toBe(join(process.env.HOME!, ".claude"));
    expect(claudeHome("anthropic:work")).toBe(home);
    expect(codexHome("anthropic:work")).toBe(join(process.env.HOME!, ".codex"));

    // a stored session on that credential: its transcript is read from the account home
    const id = crypto.randomUUID();
    const project = join(process.env.HOME!, "proj");
    const dir = join(home, "projects", project.replace(/[^a-zA-Z0-9]/g, "-"));
    mkdirSync(dir, { recursive: true });
    const line = (o: object) => JSON.stringify({ sessionId: id, cwd: project, version: "2", gitBranch: "", isSidechain: false, userType: "external", ...o });
    writeFileSync(
      join(dir, `${id}.jsonl`),
      [
        line({ type: "user", uuid: "u1", parentUuid: null, timestamp: "2026-10-23T10:00:00.000Z", message: { role: "user", content: "hello from the work account" } }),
        line({ type: "assistant", uuid: "a1", parentUuid: "u1", timestamp: "2026-10-23T10:00:01.000Z", message: { id: "m1", role: "assistant", model: "x", type: "message", content: [{ type: "text", text: "hi" }] } }),
      ].join("\n") + "\n",
    );
    expect(homeOptions(id)).toEqual({});
    config().sessions[`claude-code:${id}`] = { credential: "anthropic:work" } as any;
    try {
      expect(claudeHomeOf(id)).toBe(home);
      const msgs = await getSessionMessages(id, { dir: project, ...homeOptions(id) });
      expect(msgs.map((m) => m.uuid)).toEqual(["u1", "a1"]);
      // without the store the SDK looks in the machine's home and finds nothing
      expect(await getSessionMessages(id, { dir: project }).catch(() => [])).toEqual([]);
      expect((await homeSessionStore(home).listSessions!(project.replace(/[^a-zA-Z0-9]/g, "-"))).map((s) => s.sessionId)).toEqual([id]);
    } finally {
      delete config().sessions[`claude-code:${id}`];
    }
  });
});
