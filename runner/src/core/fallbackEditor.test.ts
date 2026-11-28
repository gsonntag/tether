import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fallbackStepProblem, type FallbackStep } from "../../../shared/fallbackChain";
import type { AccountSource } from "../../../shared/credentials";
import { ClaudeAccounts } from "../adapters/claude/accounts";
import { saveConfig } from "../config";
import { CredentialStore } from "../credentials";
import { RequestBroker } from "./broker";
import { EventBus } from "./bus";
import { FakeAdapter } from "./fakeAdapter";
import { LiveControl } from "./live";
import { Prefs } from "./prefs";
import { SessionCore } from "./sessions";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

test("fallback editor saves the session order, runner defaults and preset edits across restarts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fallback-editor-"));
  const file = join(dir, "runner.json");
  saveConfig({ runnerId: "test" }, file);
  const adapter = new FakeAdapter();
  adapter.addStored("one", []);
  adapter.addStored("two", []);
  const start = () => {
    const prefs = new Prefs(file);
    const core = new SessionCore({ adapters: [adapter], bus: new EventBus(), prefs, send: () => true, epoch: "test" });
    cleanups.unshift(() => core.stop());
    return new LiveControl(core, new RequestBroker());
  };
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const steps: FallbackStep[] = [
    { harness: "codex", source: "azure", model: "deployment", effort: "high" },
    { harness: "claude", source: "anthropic", model: "sonnet" },
  ];
  const live = start();
  expect((await live.fallbackSetup("claude:one")).chain).toEqual({ enabled: false, steps: [] });
  await live.setFallbackChain("claude:one", true, steps);
  const [preset] = live.editFallbackPreset({ action: "save", name: "Work", steps });
  live.editFallbackPreset({ action: "rename", id: preset!.id, name: "Long task" });

  const reloaded = start();
  const one = await reloaded.fallbackSetup("claude:one");
  expect(one.chain).toEqual({ enabled: true, steps });
  expect(one.presets).toEqual([{ ...preset!, name: "Long task" }]);
  expect((await reloaded.fallbackSetup("claude:two")).chain).toEqual({ enabled: false, steps });
  expect(reloaded.editFallbackPreset({ action: "delete", id: preset!.id })).toEqual([]);
  expect((await start().fallbackSetup("claude:two")).presets).toEqual([]);
});

test("account sources appear in createdAt order (falling back to mtime) and mark sameAccountAs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fallback-accounts-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "runner.json");
  saveConfig({ runnerId: "test" }, file);
  const accounts = new ClaudeAccounts(join(dir, "claude-accounts"));
  const credentials = new CredentialStore(join(dir, "credentials.json"));

  // Create three accounts: one legacy (no createdAt, earliest mtime), one newer, one middle.
  const first = accounts.create();
  const second = accounts.create();
  const third = accounts.create();
  const idA = "a".repeat(64);
  const idB = "b".repeat(64);
  const idC = "c".repeat(64);

  // Legacy file without createdAt: set explicit older mtime.
  const firstFile = join(accounts.configDir(first), ".tether-account.json");
  writeFileSync(firstFile, JSON.stringify({ accountId: idA, email: "a@example.test", organization: "Org A" }), { mode: 0o600 });
  utimesSync(firstFile, new Date(1_000_000), new Date(1_000_000));

  accounts.save(third, { accountId: idC, email: "c@example.test", organization: "Org C" }, 3_000_000);
  accounts.save(second, { accountId: idB, email: "b@example.test", organization: "Org B" }, 2_000_000);

  expect(accounts.list().map((e) => e.source)).toEqual([first, second, third]);

  const adapter = new FakeAdapter("claude");
  adapter.billing = {
    keys: ["anthropic"],
    label: (source) => source === "anthropic" ? { kind: "apiKey", label: "Anthropic API key" }
      : source === "subscription" ? { kind: "plan", label: "Claude plan" }
      : { kind: "plan", label: `Claude plan · ${source.slice(8, 16)}`, source },
    loggedIn: async () => true,
    primaryIdentity: async () => ({ accountId: idB, email: "b@example.test", organization: "Org B" }),
  };
  adapter.addStored("one", []);
  const prefs = new Prefs(file, 0);
  const core = new SessionCore({ adapters: [adapter], bus: new EventBus(), prefs, send: () => true, epoch: "test" });
  cleanups.push(() => core.stop());
  const live = new LiveControl(core, new RequestBroker(), { credentials, claudeAccounts: accounts });

  const { options } = await live.sources("claude");
  expect(options.map((o) => o.source)).toEqual(["subscription", first, second, third]);
  expect(options.find((o) => o.source === first)?.sameAccountAs).toBeUndefined();
  expect(options.find((o) => o.source === second)?.sameAccountAs).toBe("subscription");
  expect(options.find((o) => o.source === third)?.sameAccountAs).toBeUndefined();
});

test("a step on a removed account survives cleanFallbackSteps and reports its problem", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fallback-removed-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "runner.json");
  saveConfig({ runnerId: "test" }, file);
  const adapter = new FakeAdapter("claude");
  adapter.addStored("one", []);
  const credentials = new CredentialStore(join(dir, "credentials.json"));
  const prefs = new Prefs(file, 0);
  const core = new SessionCore({ adapters: [adapter], bus: new EventBus(), prefs, send: () => true, epoch: "test" });
  cleanups.push(() => core.stop());
  const live = new LiveControl(core, new RequestBroker(), { credentials });

  const removed: AccountSource = "account:11111111-1111-4111-8111-111111111111";
  const step: FallbackStep = { harness: "claude", source: removed, model: "default" };
  const saved = await live.setFallbackChain("claude:one", true, [step]);
  expect(saved.steps).toEqual([step]);
  const setup = await live.fallbackSetup("claude:one");
  expect(setup.chain.steps).toEqual([step]);
  const catalog = setup.harnesses.find((h) => h.harness === "claude");
  expect(fallbackStepProblem(step, catalog)).toBe("Login or key unavailable.");
});
