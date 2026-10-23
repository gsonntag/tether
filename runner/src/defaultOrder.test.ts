// The default order (defaultOrder.ts): saving it, where a new session starts on it, the suggested
// starting point, and the migration from named model profiles (config.ts migrateProfiles).

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR, config, migrateProfiles, type RunnerConfig } from "./config";
import { defaultOrder, saveDefaultOrder, sessionStart, suggestOrder } from "./defaultOrder";
import { markExhausted } from "./fallback";
import { claudeModelRefs, FALLBACK_MODELS } from "./adapters/claude";

afterEach(() => {
  delete config().defaultOrder;
  config().exhausted = {};
});

const cfgOf = (o: Partial<RunnerConfig> & Record<string, unknown>) => ({ runnerId: "r", projects: [], hidden: [], archived: [], titles: {}, exhausted: {}, sessions: {}, ...o }) as RunnerConfig;

describe("migrateProfiles", () => {
  test("the first profile the user made seeds the default order; profiles go; it runs once", () => {
    const cfg = cfgOf({
      profiles: [
        { name: "luna", chain: ["pi:openai-codex/gpt-6-luna", "pi:azure/gpt-6-luna"] }, // shipped, unchanged
        { name: "Work", chain: [" claude-code:opus ", "sonnet", "", "codex:gpt-6-luna", "claude-code:opus"] },
        { name: "Other", chain: ["kiro:auto"] },
      ],
    });
    migrateProfiles(cfg);
    expect(cfg.defaultOrder).toEqual(["claude-code:opus", "claude-code:sonnet", "codex:gpt-6-luna"]);
    expect("profiles" in cfg).toBe(false);
    const once = JSON.stringify(cfg);
    migrateProfiles(cfg);
    expect(JSON.stringify(cfg)).toBe(once);
  });

  test("only the profiles Tether shipped: no default order", () => {
    const cfg = cfgOf({
      profiles: [
        { name: "luna", chain: ["pi:openai-codex/gpt-6-luna", "pi:azure/gpt-6-luna"] },
        { name: "claude-then-luna", chain: ["claude-code:opus", "pi:openai-codex/gpt-6-luna", "pi:azure/gpt-6-luna"] },
      ],
    });
    migrateProfiles(cfg);
    expect(cfg.defaultOrder).toBeUndefined();
    expect("profiles" in cfg).toBe(false);
  });

  test("a shipped profile whose models were changed counts as the user's", () => {
    const cfg = cfgOf({ profiles: [{ name: "luna", chain: ["pi:azure/gpt-6-luna"] }] });
    migrateProfiles(cfg);
    expect(cfg.defaultOrder).toEqual(["pi:azure/gpt-6-luna"]);
  });

  test("a saved default order is kept", () => {
    const cfg = cfgOf({ defaultOrder: ["codex:gpt-6-sol"], profiles: [{ name: "Work", chain: ["claude-code:opus"] }] });
    migrateProfiles(cfg);
    expect(cfg.defaultOrder).toEqual(["codex:gpt-6-sol"]);
  });

  test("sessions keep their chain and lose the profile name; one without a chain gets the profile's", () => {
    const cfg = cfgOf({
      profiles: [{ name: "Work", chain: ["claude-code:opus", "codex:gpt-6-luna"] }],
      sessions: {
        a: { profile: "luna", chain: ["pi:azure/gpt-6-luna"], guard: "ask" },
        b: { profile: "Work" },
        c: { profile: "codex-current" },
        d: { profile: "gone" },
        e: { chain: ["claude-code:opus"] },
      } as any,
    });
    migrateProfiles(cfg);
    expect(cfg.sessions).toEqual({
      a: { chain: ["pi:azure/gpt-6-luna"], guard: "ask" },
      b: { chain: ["claude-code:opus", "codex:gpt-6-luna"] },
      c: { chain: ["codex:gpt-6.1-sol", "codex:gpt-6-sol", "codex:gpt-6-luna", "codex:gpt-6-astra"] },
      d: {},
      e: { chain: ["claude-code:opus"] },
    });
  });

  test("a bad hand-edited profiles value doesn't break loading", () => {
    const cfg = cfgOf({ profiles: "nope" as any, sessions: { a: { profile: 3 } } as any });
    migrateProfiles(cfg);
    expect(cfg.defaultOrder).toBeUndefined();
    expect(cfg.sessions).toEqual({ a: {} });
  });
});

describe("saveDefaultOrder", () => {
  test("trims, drops repeats, saves to runner.json; empty clears; a bad entry saves nothing", () => {
    expect(defaultOrder()).toBeUndefined();
    expect(saveDefaultOrder([" claude-code:opus", "codex:gpt-6-luna", "claude-code:opus", ""])).toEqual(["claude-code:opus", "codex:gpt-6-luna"]);
    expect(JSON.parse(readFileSync(join(CONFIG_DIR, "runner.json"), "utf8")).defaultOrder).toEqual(["claude-code:opus", "codex:gpt-6-luna"]);
    expect(() => saveDefaultOrder(["opus"])).toThrow(/harness/);
    expect(() => saveDefaultOrder(["codex:"])).toThrow(/no model/);
    expect(() => saveDefaultOrder("codex:x")).toThrow();
    expect(defaultOrder()).toEqual(["claude-code:opus", "codex:gpt-6-luna"]);
    // A copy: changing what it returned doesn't change it.
    defaultOrder()!.push("x");
    expect(defaultOrder()).toHaveLength(2);
    expect(saveDefaultOrder([])).toBeUndefined();
    expect(defaultOrder()).toBeUndefined();
  });
});

describe("a new session on the default order", () => {
  const order = ["claude-code:opus", "codex:gpt-6-luna", "pi:openai-codex/gpt-6-luna"];

  test("starts on its first entry, with a copy of it as the session's chain", () => {
    const st = sessionStart({ harness: "pi", useOrder: true }, order);
    expect(st).toEqual({ harness: "claude-code", model: "opus", chain: order });
    expect(st.chain).not.toBe(order);
  });

  test("a model picked, or no order saved: that harness and model, no chain", () => {
    expect(sessionStart({ harness: "codex", model: "gpt-6-sol" }, order)).toEqual({ harness: "codex", model: "gpt-6-sol" });
    expect(sessionStart({ harness: "codex" }, order)).toEqual({ harness: "codex" });
    expect(sessionStart({ harness: "codex", useOrder: true }, undefined)).toEqual({ harness: "codex" });
    expect(sessionStart({ harness: "codex", useOrder: true }, [])).toEqual({ harness: "codex" });
  });

  test("skips entries whose harness isn't installed or whose quota is out", () => {
    expect(sessionStart({ harness: "pi", useOrder: true }, order, (h) => h !== "claude-code")).toMatchObject({ harness: "codex", model: "gpt-6-luna", chain: order });
    markExhausted("claude-code:opus", Date.now() + 60_000);
    expect(sessionStart({ harness: "pi", useOrder: true }, order)).toMatchObject({ harness: "codex", model: "gpt-6-luna" });
    // Everything out: the first installed entry anyway (fallback waits for its reset).
    markExhausted("codex", Date.now() + 60_000);
    markExhausted("openai-codex", Date.now() + 60_000);
    expect(sessionStart({ harness: "pi", useOrder: true }, order)).toMatchObject({ harness: "claude-code", model: "opus" });
    // None installed: the harness asked for.
    expect(sessionStart({ harness: "kiro", useOrder: true }, order, () => false)).toEqual({ harness: "kiro" });
  });

  test("an entry on a harness's default model starts without one", () => {
    expect(sessionStart({ harness: "pi", useOrder: true }, ["codex:default"])).toEqual({ harness: "codex", chain: ["codex:default"] });
  });

  test("editing the saved order changes sessions started afterwards, not earlier ones", () => {
    saveDefaultOrder(order);
    const before = sessionStart({ harness: "pi", useOrder: true }, defaultOrder());
    saveDefaultOrder(["codex:gpt-6-sol"]);
    expect(before.chain).toEqual(order);
    expect(sessionStart({ harness: "pi", useOrder: true }, defaultOrder())).toEqual({ harness: "codex", model: "gpt-6-sol", chain: ["codex:gpt-6-sol"] });
  });
});

describe("suggestOrder", () => {
  const models = (...ids: string[]) => ids.map((id) => ({ id }));

  test("signed-in subscriptions in order: Claude Code (Opus), Codex, pi on another ChatGPT account, Kiro", () => {
    expect(
      suggestOrder([
        { harness: "claude-code", signedIn: true, models: models("default", "sonnet", "opus", "haiku") },
        { harness: "codex", signedIn: true, account: "a", models: models("default", "gpt-6-sol", "gpt-6-luna") },
        { harness: "pi", signedIn: true, account: "b", models: models("anthropic/claude-opus-5-5", "openai-codex/gpt-6-luna", "openai-codex/gpt-6-sol") },
        { harness: "opencode", models: models("opencode/big-pickle") },
        { harness: "kiro", signedIn: true, models: models("auto", "claude-sonnet-4.5") },
      ]),
    ).toEqual(["claude-code:opus", "codex:gpt-6-sol", "pi:openai-codex/gpt-6-sol", "kiro:auto"]);
  });

  test("Claude Code's Opus is pinned to what its alias runs now, from its own list or the fallback list", () => {
    const live = claudeModelRefs([
      { value: "default", displayName: "Default (recommended)", resolvedModel: "claude-opus-5-5" },
      { value: "opus", displayName: "Opus 5.5", resolvedModel: "claude-opus-5-5" },
      { value: "sonnet", displayName: "Sonnet 5.5", resolvedModel: "claude-sonnet-5-5" },
      { value: "claude-opus-4-8", displayName: "Opus 4.8", resolvedModel: "claude-opus-4-8" },
    ]);
    expect(live).toEqual([
      { id: "default", label: "Default (recommended)" },
      { id: "opus", label: "Opus 5.5", resolved: "claude-opus-5-5" },
      { id: "sonnet", label: "Sonnet 5.5", resolved: "claude-sonnet-5-5" },
      { id: "claude-opus-4-8", label: "Opus 4.8" },
    ]);
    expect(suggestOrder([{ harness: "claude-code", signedIn: true, models: live }])).toEqual(["claude-code:claude-opus-5-5"]);
    expect(suggestOrder([{ harness: "claude-code", signedIn: true, models: FALLBACK_MODELS }])).toEqual([`claude-code:${FALLBACK_MODELS.find((m) => m.id === "opus")!.resolved}`]);
    expect(FALLBACK_MODELS.find((m) => m.id === "opus")!.resolved).toMatch(/^claude-opus-\d/);
  });

  test("the same ChatGPT account through pi and Codex is listed once; signed-out harnesses are left out", () => {
    expect(
      suggestOrder([
        { harness: "claude-code", signedIn: false, models: models("opus") },
        { harness: "codex", signedIn: true, account: "a", models: models("gpt-6-sol") },
        { harness: "pi", signedIn: true, account: "a", models: models("openai-codex/gpt-6-sol") },
      ]),
    ).toEqual(["codex:gpt-6-sol"]);
    expect(suggestOrder([{ harness: "pi", signedIn: true, models: models("openai-codex/gpt-6-luna") }])).toEqual(["pi:openai-codex/gpt-6-luna"]);
    expect(suggestOrder([{ harness: "claude-code", signedIn: true, models: [] }])).toEqual(["claude-code:opus"]);
  });

  test("no login it can see: the first installed harness with a model; nothing installed: empty", () => {
    expect(suggestOrder([{ harness: "opencode", models: models("opencode/big-pickle") }, { harness: "antigravity", models: models("gemini-3-pro") }])).toEqual(["opencode:opencode/big-pickle"]);
    expect(suggestOrder([])).toEqual([]);
  });
});
