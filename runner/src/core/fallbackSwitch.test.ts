// Fallback on the real core with a scripted harness.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { isAccountSource, type AccountSource, type BillingSource } from "../../../shared/credentials";
import type { FallbackStep } from "../../../shared/fallbackChain";
import type { HarnessLoginStatus } from "../../../shared/harnessLogin";
import { ClaudeAccounts } from "../adapters/claude/accounts";
import { keepPlan, keptPlanEntries, windowsIn } from "../adapters/claude/context";
import { claudeAccountLabel, claudeEnv } from "../adapters/claude/credentials";
import { saveConfig } from "../config";
import { CredentialStore } from "../credentials";
import { QueueDeferred, SendCancelled, type PlanIdentity } from "./adapter";
import { RequestBroker } from "./broker";
import { EventBus } from "./bus";
import type { CoreEvents } from "./events";
import { FakeAdapter, type Step } from "./fakeAdapter";
import { LiveControl } from "./live";
import { Prefs } from "./prefs";
import { SessionCore } from "./sessions";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((f) => f()));

const steps: FallbackStep[] = [{ harness: "claude", source: "anthropic", model: "sonnet", effort: "high", permissionMode: "plan" }];
const PLAN = { kind: "plan", label: "Claude plan" } as const;
const KEY = { kind: "apiKey", label: "Anthropic API key" } as const;
const at = (s: any, kind = PLAN) => s.state({ billing: kind });
const reply: Step = (s) => {
  s.event({ type: "msg", msg: { id: `a-${Math.random()}`, role: "assistant", ts: 2, parts: [{ type: "text", text: "Done." }] } });
  s.state({ status: "idle" });
};
const limit = (hit: { resetsAt?: number } = {}): Step => (s) => {
  s.event({ type: "msg", msg: { id: `e-${Math.random()}`, role: "assistant", ts: 2, parts: [], error: "You've hit your session limit" } });
  s.limitReached?.(hit);
  s.state({ status: "idle" });
};
const tool: Step = (s) => s.event({ type: "msg", msg: { id: `t-${Math.random()}`, role: "assistant", ts: 2, parts: [{ type: "tool", id: "c1", name: "Edit", kind: "edit", input: {}, status: "done" }] } });
const settled = async (t: ReturnType<typeof setup>, want: (s: any) => boolean) => {
  for (let i = 0; i < 200; i++) {
    const s = await t.core.open("claude:one");
    if (want(s) && s.state.status === "idle" && !s.sending && !s.pins) return s;
    await Bun.sleep(5);
  }
  throw new Error("never settled");
};

function setup({ ticked = true, key = true, now = Date.now } = {}) {
  const base = "/tmp/claude-1001/auto/unit";
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, "core-")), file = join(dir, "runner.json");
  saveConfig({ runnerId: "auto-test" }, file);
  const adapter = new FakeAdapter(), credentials = new CredentialStore(join(dir, "credentials.json"));
  adapter.capabilities = { ...adapter.capabilities, sourceSwitch: true };
  adapter.addStored("one", []);
  const prefs = new Prefs(file, 0);
  const core = new SessionCore({ adapters: [adapter], now, bus: new EventBus<CoreEvents>(), send: () => true, prefs, epoch: "auto", log: () => {} });
  const live = new LiveControl(core, new RequestBroker(), { credentials, idleMs: 60_000 });
  cleanups.push(() => core.stop());
  if (key) credentials.set("anthropic", `fake-auto-${crypto.randomUUID()}`);
  Object.assign(adapter, { move: { modes: [{ mode: "plan", level: 0 }, { mode: "full", level: 5 }] } });
  adapter.listModels = async () => ({
    models: [{ id: "sonnet", label: "Sonnet" }, { id: "haiku", label: "Haiku" }],
    efforts: [{ id: "high", label: "High" }],
    permissionModes: [{ id: "plan", label: "Plan" }, { id: "full", label: "Full" }],
  });
  if (ticked) prefs.set("claude:one", { fallbackChain: { enabled: true, steps }, source: "subscription" });
  // A turn on the plan runs out; anything on the key answers.
  const t = { dir, file, adapter, core, live, credentials, prefs, sends: () => adapter.drivers.reduce((n, d) => n + d.sent.length, 0) };
  adapter.script = () => {
    return adapter.drivers.at(-1)!.opts.credential?.source === "anthropic" ? [(s) => at(s, KEY as any), reply] : [(s) => at(s), limit()];
  };
  return t;
}
const notices = (s: any): string[] => s.transcript.messages.filter((m: any) => m.role === "notice").map((m: any) => m.parts[0].text);
const sentOn = (t: ReturnType<typeof setup>) => t.adapter.drivers.map((d) => [d.opts.credential?.source, d.sent]);

describe("the fallback chain", () => {
  test("on: the source changes, one notice, the same message once, and it stays on the key", async () => {
    const t = setup();
    await t.live.send("claude:one", "fix it");
    const s = await settled(t, (s) => s.state.billing?.kind === "apiKey");
    expect(sentOn(t)).toEqual([["subscription", ["fix it"]], ["anthropic", ["fix it"]]]);
    expect(notices(s)).toEqual(["Hit its limit. Switched to step 1 · Anthropic API key. Resending your message."]);
    expect(t.prefs.get(s.id).source).toBe("anthropic");
    await t.live.send(s.id, "next");
    expect(t.adapter.drivers).toHaveLength(2);
    expect(t.prefs.get(s.id).source).toBe("anthropic");
  });

  test("off, the default: the usual error, nothing else", async () => {
    const t = setup({ ticked: false });
    await t.live.send("claude:one", "fix it");
    const s = await settled(t, () => true);
    await Bun.sleep(30);
    expect(t.sends()).toBe(1);
    expect(notices(s)).toEqual([]);
    expect(t.prefs.get(s.id).source).toBe("subscription");
  });

  test("tools already ran: switched and said, not resent", async () => {
    const t = setup();
    t.adapter.script = () => [(s) => at(s), tool, limit()];
    await t.live.send("claude:one", "fix it");
    const s = await settled(t, (s) => !!s.state.nextBilling || t.prefs.get(s.id).source === "anthropic");
    await Bun.sleep(30);
    expect(t.adapter.drivers[0]!.sent).toEqual(["fix it"]);
    expect(t.adapter.drivers).toHaveLength(2);
    expect(t.adapter.drivers[1]!.opts.credential?.source).toBe("anthropic");
    expect(t.adapter.drivers[1]!.sent).toEqual([]);
    expect(t.prefs.get(s.id).source).toBe("anthropic");
    expect(notices(s)[0]).toContain("Switched to step 1 · Anthropic API key. The turn already acted. Send a message to continue.");
  });

  test("a hop that waits on the person says so once: the held-back end comes as waiting", async () => {
    const t = setup();
    const ends: CoreEvents["turnEnded"][] = [], statuses: CoreEvents["fallbackStatus"][] = [];
    t.core.o.bus.on("turnEnded", (e) => ends.push(e));
    t.core.o.bus.on("fallbackStatus", (e) => statuses.push(e));
    t.adapter.script = () => [(s) => at(s), tool, limit()];
    await t.live.send("claude:one", "fix it");
    await settled(t, (s) => notices(s).some((text: string) => text.includes("Send a message to continue.")));
    await Bun.sleep(20);
    expect(ends).toEqual([{ sessionId: "claude:one", error: "You've hit your session limit", fallbackPending: true }]);
    expect(statuses).toEqual([{ sessionId: "claude:one", status: "waiting", error: "You've hit your session limit" }]);
  });

  test("a steer in that turn isn't resent either", async () => {
    const t = setup();
    t.adapter.capabilities = { ...t.adapter.capabilities, canSteer: true };
    let go!: () => void;
    const wait = new Promise<void>((r) => (go = r));
    t.adapter.script = () => [(s) => at(s), () => wait, limit()];
    const sending = t.live.send("claude:one", "fix it");
    await Bun.sleep(10);
    await t.live.steer("claude:one", "and this");
    go();
    await sending;
    const s = await settled(t, () => true);
    await Bun.sleep(30);
    expect(t.adapter.drivers).toHaveLength(2);
    expect(t.adapter.drivers[1]!.sent).toEqual([]);
    expect(notices(s)[0]).toContain("The turn already acted.");
  });

  test("the notice carries the reset the signal gave, else a full window's, else none", async () => {
    const soon = Date.now() + 3_600_000;
    const t = setup();
    t.adapter.script = () => (t.adapter.drivers.at(-1)!.opts.credential?.source === "anthropic" ? [reply] : [(s) => at(s), limit({ resetsAt: soon })]);
    await t.live.send("claude:one", "fix it");
    const s = await settled(t, (s) => t.prefs.get(s.id).source === "anthropic");
    expect(s.transcript!.messages.find((m) => m.role === "notice")?.resetsAt).toBe(soon);

    const t2 = setup();
    t2.adapter.planUsage = async () => ({ fiveHour: { percent: 40, resetsAt: soon - 5 }, week: { percent: 100, resetsAt: soon } });
    await t2.live.send("claude:one", "fix it");
    const s2 = await settled(t2, (s) => s.state.billing?.kind === "apiKey");
    expect(s2.transcript!.messages.find((m) => m.role === "notice")?.resetsAt).toBe(soon);

    const t3 = setup();
    t3.adapter.planUsage = async () => ({ week: { percent: 40, resetsAt: soon } });
    await t3.live.send("claude:one", "fix it");
    const s3 = await settled(t3, (s) => s.state.billing?.kind === "apiKey");
    expect(s3.transcript!.messages.find((m) => m.role === "notice")?.resetsAt).toBeUndefined();
  });

  test("a key that fails stops as usual: no second switch, no loop", async () => {
    const t = setup();
    t.adapter.script = () => (t.adapter.drivers.at(-1)!.opts.credential?.source === "anthropic" ? [(s) => at(s, KEY as any), limit()] : [(s) => at(s), limit()]);
    await t.live.send("claude:one", "fix it");
    await settled(t, (s) => s.state.billing?.kind === "apiKey");
    await Bun.sleep(40);
    expect(t.sends()).toBe(2);
    expect(t.adapter.drivers).toHaveLength(2);
  });

  test("a key session never switches, nor a stopped turn", async () => {
    const t = setup();
    t.prefs.set("claude:one", { source: "anthropic" });
    t.adapter.script = () => [(s) => at(s, KEY as any), limit()];
    await t.live.send("claude:one", "fix it");
    await Bun.sleep(30);
    expect(t.sends()).toBe(1);

    const u = setup();
    let go!: () => void;
    const wait = new Promise<void>((r) => (go = r));
    u.adapter.script = () => [(s) => at(s), () => wait, (s) => s.limitReached?.({})];
    const sending = u.live.send("claude:one", "fix it");
    await Bun.sleep(10);
    const s = await u.core.open("claude:one");
    await u.live.interrupt("claude:one");
    go();
    await sending.catch(() => {});
    await Bun.sleep(30);
    expect(u.sends()).toBe(1);
    expect(u.prefs.get(s.id).source).toBe("subscription");
  });

  test("no key left, or a terminal open: it stays, and says so", async () => {
    const t = setup({ key: false });
    const ends: CoreEvents["turnEnded"][] = [], statuses: string[] = [];
    t.core.o.bus.on("turnEnded", (e) => ends.push(e));
    t.core.o.bus.on("fallbackStatus", ({ status }) => statuses.push(status));
    await t.live.send("claude:one", "fix it");
    const s = await settled(t, () => true);
    await Bun.sleep(20);
    expect(notices(s)[0]).toContain("Used every available source.");
    // One turn end (texting and peers report it once); push tells the exhaustion itself.
    expect(ends).toEqual([{ sessionId: "claude:one", error: "You've hit your session limit", fallbackPending: true }]);
    expect(statuses).toEqual(["exhausted"]);

    const u = setup();
    u.adapter.script = () => [(s) => at(s), (s, d) => void (u.core.sessions.get("claude:one")!.setState({ terminal: { kind: "shared" } as any }), d), limit()];
    await u.live.send("claude:one", "fix it");
    await Bun.sleep(40);
    const v = await u.core.open("claude:one");
    expect(notices(v)).toEqual(["Plan limit reached. Close the terminal first."]);
    expect(u.prefs.get(v.id).source).toBe("subscription");
  });

  test("a queue held by the failed turn goes on after the resend", async () => {
    const t = setup();
    let go!: () => void;
    const wait = new Promise<void>((r) => (go = r));
    const plan: Step[] = [(s) => at(s), () => wait, limit()];
    t.adapter.script = () => (t.adapter.drivers.at(-1)!.opts.credential?.source === "anthropic" ? [(s) => at(s, KEY as any), reply] : plan);
    const sending = t.live.send("claude:one", "fix it");
    await Bun.sleep(10);
    await t.live.queue.add("claude:one", "after", []);
    go();
    await sending;
    const done = await settled(t, () => t.adapter.drivers.at(-1)!.sent.includes("after"));
    expect(done.state.queue).toEqual([]);
    expect(t.adapter.drivers.at(-1)!.sent).toEqual(["fix it", "after"]);
  });

  test("the last key picked from the chip is remembered, called off too", async () => {
    const t = setup({ ticked: false });
    t.prefs.set("claude:one", { source: "subscription" });
    t.adapter.script = () => [(s) => at(s), reply];
    await t.live.send("claude:one", "hello");
    await settled(t, () => true);
    await t.live.setSource("claude:one", "anthropic");
    expect(t.prefs.get("claude:one").lastKey).toBe("anthropic");
    await t.live.setSource("claude:one", "subscription");
    expect(t.prefs.get("claude:one").lastKey).toBe("anthropic");
  });

  test("a carried harness: the change goes with the resend, and the new thread keeps chain progress", async () => {
    const t = setup();
    t.adapter.capabilities = { ...t.adapter.capabilities, sourceCarry: true };
    t.live.carrier = async (_from, source, model, settings) => {
      expect(model).toBe("sonnet");
      expect(settings).toEqual({ effort: "high", permissionMode: "plan" });
      t.adapter.addStored("carried-1", []);
      const id = "claude:carried-1";
      t.prefs.set(id, { carrying: true, projectPath: t.dir, source });
      await t.live.resumeLive(await t.core.open(id));
      return id;
    };
    await t.live.send("claude:one", "fix it");
    for (let i = 0; i < 200 && !t.prefs.get("claude:one").movedTo; i++) await Bun.sleep(5);
    const on = t.adapter.drivers.at(-1)!;
    expect([on.nativeId, on.opts.credential?.source, on.sent]).toEqual(["carried-1", "anthropic", ["fix it"]]);
    expect(t.prefs.get("claude:carried-1")).toMatchObject({ fallbackChain: { enabled: true, steps, active: 0 }, lastKey: "anthropic" });
    expect(t.prefs.get("claude:one").movedTo).toBe("claude:carried-1");
  });

  test("skips unavailable and overly permissive steps, and records the chosen settings", async () => {
    const t = setup();
    await t.live.setFallbackChain("claude:one", true, [
      { ...steps[0]!, model: "missing" },
      { ...steps[0]!, permissionMode: "full" },
      steps[0]!,
    ]);
    await t.live.send("claude:one", "go");
    const s = await settled(t, (s) => s.state.billing?.kind === "apiKey");
    expect(s.id).toBe("claude:one");
    expect(t.adapter.drivers.at(-1)?.opts).toMatchObject({ model: "sonnet", effort: "high", permissionMode: "plan" });
    expect(new Prefs(t.file).get(s.id).fallbackChain?.active).toBe(2);
  });

  test("waits for Tether's rate-limit retries before switching sources", async () => {
    const t = setup();
    t.live.retries.gapMs = 0;
    t.live.retries.time = (attempt, now) => attempt === 1 ? now + 10 : undefined;
    t.adapter.script = () => t.adapter.drivers.at(-1)!.opts.credential?.source === "anthropic"
      ? [(s) => at(s, KEY as any), reply]
      : [(s) => at(s), (s) => s.rateLimited?.({}), (s) => s.state({ status: "idle" })];
    await t.live.send("claude:one", "go");
    const s = await settled(t, (s) => s.state.billing?.kind === "apiKey");
    expect(sentOn(t)).toEqual([["subscription", ["go", "go"]], ["anthropic", ["go"]]]);
    expect(notices(s).at(-1)).toContain("Rate limit retries exhausted.");
  });

  test("resumes a saved chain from its active step", async () => {
    const t = setup();
    const active = { ...steps[0]!, model: "sonnet" };
    t.prefs.set("claude:one", {
      source: "anthropic", model: active.model, permissionMode: "plan", effort: "high",
      fallbackChain: { enabled: true, active: 1, steps: [
        { ...active, source: "subscription" }, active, { ...active, model: "haiku" },
      ] },
    });
    t.live.retries.time = () => undefined;
    t.adapter.script = () => t.adapter.drivers.at(-1)!.opts.model === "haiku"
      ? [reply]
      : [(s) => s.rateLimited?.({}), (s) => s.state({ status: "idle" })];
    await t.live.send("claude:one", "go");
    const s = await settled(t, (s) => s.state.fallbackChain?.active === 2);
    expect(s.id).toBe("claude:one");
    expect(t.adapter.drivers.map((d) => d.opts.model)).toEqual(["sonnet", "haiku"]);
    expect(sentOn(t)).toEqual([["anthropic", ["go"]], ["anthropic", ["go"]]]);
  });

  test("saves a plan reset and returns to it before sending the next message", async () => {
    let now = Date.now();
    const t = setup({ now: () => now });
    const resetsAt = now + 60_000;
    const plan = { harness: "claude", source: "subscription", model: "haiku" } as const;
    t.prefs.set("claude:one", { model: "haiku" });
    await t.live.setFallbackChain("claude:one", true, [plan, ...steps]);
    t.adapter.script = (text) => text === "hit" && t.adapter.drivers.at(-1)?.opts.credential?.source === "subscription"
      ? [(s) => at(s), limit({ resetsAt })]
      : [reply];
    await t.live.send("claude:one", "hit");
    await settled(t, (s) => s.state.fallbackChain?.active === 1);
    expect(new Prefs(t.file).get("claude:one").fallbackProgress?.steps[0]?.retryAt).toBe(resetsAt);
    await t.live.send("claude:one", "before reset");
    now = resetsAt + 1;
    await t.live.send("claude:one", "after reset");
    const active = await settled(t, (s) => s.state.fallbackChain?.active === 0);
    expect(active.id).toBe("claude:one");
    expect(sentOn(t)).toEqual([
      ["subscription", ["hit"]], ["anthropic", ["hit", "before reset"]], ["subscription", ["after reset"]],
    ]);
  });

  test("returns to a carried chain's original session with a handoff file", async () => {
    let now = Date.now();
    const t = setup({ now: () => now });
    const reset = now + 60_000;
    t.adapter.capabilities = { ...t.adapter.capabilities, sourceCarry: true };
    t.prefs.set("claude:one", { model: "haiku" });
    await t.live.setFallbackChain("claude:one", true, [{ harness: "claude", source: "subscription", model: "haiku" }, ...steps]);
    t.live.carrier = async (_from, source) => {
      t.adapter.addStored("paid", []);
      t.prefs.set("claude:paid", { carrying: true, projectPath: t.dir, source });
      return "claude:paid";
    };
    t.live.fallbackArchive = async (from, to) => {
      expect(from).toBe("claude:paid");
      expect(to).toBe("claude:one");
      return "/private/fallback/history.md";
    };
    t.adapter.script = (text) => text === "hit" && t.adapter.drivers.at(-1)?.opts.credential?.source === "subscription"
      ? [(s) => at(s), limit({ resetsAt: reset })]
      : [reply];
    await t.live.send("claude:one", "hit");
    for (let i = 0; i < 200 && !t.prefs.get("claude:one").movedTo; i++) await Bun.sleep(5);
    expect(t.prefs.get("claude:one").movedTo).toBe("claude:paid");
    now = reset + 1;
    await t.live.send("claude:paid", "keep working");
    expect(t.prefs.get("claude:paid").movedTo).toBe("claude:one");
    expect(t.prefs.get("claude:one").movedTo).toBeUndefined();
    expect(t.adapter.drivers.at(-1)?.nativeId).toBe("one");
    expect(t.adapter.drivers.at(-1)?.sent[0]).toContain("/private/fallback/history.md");
  });

  test("sends continue after a reset, and Stop cancels a pending continuation", async () => {
    for (const stop of [false, true]) {
      const t = setup();
      t.live.fallbackResetDelay = 35;
      const reset = Date.now() + 100;
      const plan = { harness: "claude", source: "subscription", model: "haiku" } as const;
      t.prefs.set("claude:one", { model: "haiku" });
      await t.live.setFallbackChain("claude:one", true, [plan], true);
      const statuses: string[] = [];
      t.core.o.bus.on("fallbackStatus", ({ status }) => statuses.push(status));
      t.adapter.script = (text) => text === "start" ? [(s) => at(s), limit({ resetsAt: reset })] : [reply];
      await t.live.send("claude:one", "start");
      await settled(t, (s) => notices(s).some((text: string) => text.includes("Used every available source.")));
      expect(t.prefs.get("claude:one").fallbackResumeAt).toBe(reset + 35);
      if (stop) await t.live.interrupt("claude:one");
      await Bun.sleep(200);
      expect(statuses).toEqual(stop ? ["exhausted"] : ["exhausted", "resumed"]);
      expect(t.adapter.drivers.flatMap((driver) => driver.sent)).toEqual(stop ? ["start"] : ["start", "continue"]);
      expect(t.prefs.get("claude:one").fallbackResumeAt).toBeUndefined();
      expect(t.prefs.get("claude:one").fallbackChain?.enabled).toBe(true);
    }
  });

  test("skips an unavailable cross-harness step and keeps the configured order", async () => {
    const t = setup();
    await t.live.setFallbackChain("claude:one", true, [
      { harness: "codex", source: "subscription", model: "gpt" }, ...steps,
    ]);
    await t.live.send("claude:one", "go");
    const s = await settled(t, (s) => s.state.fallbackChain?.active === 1);
    expect(s.state.billing?.kind).toBe("apiKey");
    expect(t.sends()).toBe(2);
  });

  test("a plan report from a key's process doesn't reach the plan", async () => {
    const t = setup({ ticked: false });
    t.prefs.set("claude:one", { source: "anthropic" });
    t.adapter.script = () => [(s) => s.plan?.({ week: { percent: 9 } }), reply];
    await t.live.send("claude:one", "hello");
    expect((await t.core.open("claude:one")).state.plan).toBeUndefined();
  });

  test("a plan report is marked with when it came", async () => {
    const t = setup({ ticked: false });
    t.adapter.script = () => [(s) => s.plan?.({ week: { percent: 9 } }), reply];
    await t.live.send("claude:one", "hello");
    expect((await t.core.open("claude:one")).state.plan?.week?.at).toBeGreaterThan(Date.now() - 5000);
  });
});

// Helper for multi-account Claude + optional Codex fallback tests.
function setupAccounts(opts: {
  now?: () => number;
  probe?: (source: AccountSource) => Promise<HarnessLoginStatus>;
  primaryIdentity?: () => PlanIdentity | undefined;
  codex?: boolean;
  bedrock?: boolean;
  windowsFile?: string;
} = {}) {
  const base = "/tmp/claude-1001/auto/unit";
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, "multi-")), file = join(dir, "runner.json");
  saveConfig({ runnerId: "multi-test" }, file);
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const accounts = new ClaudeAccounts(join(dir, "claude-accounts"));
  const credentials = new CredentialStore(join(dir, "credentials.json"));
  credentials.set("anthropic", `fake-key-${crypto.randomUUID()}`);
  if (opts.bedrock) {
    credentials.set("bedrock", `fake-bedrock-${crypto.randomUUID()}`);
    credentials.setBedrock({
      region: "us-east-1",
      auth: "key",
      models: [{ id: "us.anthropic.claude-sonnet-4-6-v1:0", harness: "claude", alias: "sonnet" }],
    });
  }
  const accX = accounts.create();
  const idX = { accountId: "1".repeat(64), email: "x@example.test", organization: "Org X" };
  accounts.save(accX, idX, 1_000);
  const accY = accounts.create();
  const idY = { accountId: "2".repeat(64), email: "y@example.test", organization: "Org Y" };
  accounts.save(accY, idY, 2_000);
  const idMain = { accountId: "0".repeat(64), email: "main@example.test", organization: "Main Org" };

  const claude = new FakeAdapter("claude");
  claude.capabilities = { ...claude.capabilities, sourceSwitch: true, move: { import: "native" } };
  claude.billing = {
    keys: opts.bedrock ? ["anthropic", "bedrock"] : ["anthropic"],
    label: (source: BillingSource) =>
      source === "anthropic" ? { kind: "apiKey", label: "Anthropic API key" }
      : source === "bedrock" ? { kind: "provider", label: "Amazon Bedrock" }
      : isAccountSource(source) ? { kind: "plan", label: claudeAccountLabel(source), source }
      : { kind: "plan", label: "Claude plan" },
    loggedIn: async () => true,
    primaryIdentity: async () => (opts.primaryIdentity ? opts.primaryIdentity() : idMain),
  };
  Object.assign(claude, { move: { modes: [{ mode: "plan", level: 0 }, { mode: "default", level: 1 }, { mode: "full", level: 5 }] } });
  claude.listModels = async () => ({
    models: [{ id: "sonnet", label: "Sonnet" }, { id: "haiku", label: "Haiku" }],
    efforts: [{ id: "high", label: "High" }],
    permissionModes: [{ id: "plan", label: "Plan" }, { id: "default", label: "Default" }, { id: "full", label: "Full" }],
  });
  claude.addStored("one", []);
  claude.storedPlans = () => keptPlanEntries();

  const adapters = [claude];
  let codex: FakeAdapter | undefined;
  if (opts.codex) {
    codex = new FakeAdapter("codex");
    codex.capabilities = { ...codex.capabilities, sourceSwitch: true, sourceCarry: true, move: { import: "native" } };
    codex.billing = {
      keys: ["openai"],
      label: (source) => source === "openai" ? { kind: "apiKey", label: "OpenAI API key" } : { kind: "plan", label: "ChatGPT plan" },
      loggedIn: async () => true,
    };
    Object.assign(codex, { move: { modes: [{ mode: "read-only", level: 0 }, { mode: "auto", level: 3 }] } });
    codex.listModels = async () => ({
      models: [{ id: "sonnet", label: "Sonnet" }, { id: "gpt", label: "GPT" }],
      efforts: [],
      permissionModes: [{ id: "read-only", label: "Read-only" }, { id: "auto", label: "Auto" }],
    });
    codex.addStored("cx1", []);
    adapters.push(codex);
  }

  if (opts.windowsFile !== undefined) {
    windowsIn(opts.windowsFile);
    cleanups.push(() => windowsIn(undefined));
  } else {
    windowsIn(undefined);
  }

  const prefs = new Prefs(file, 0);
  const core = new SessionCore({ adapters, now: opts.now ?? Date.now, bus: new EventBus<CoreEvents>(), send: () => true, prefs, epoch: "multi", log: () => {} });
  const live = new LiveControl(core, new RequestBroker(), {
    credentials,
    claudeAccounts: accounts,
    idleMs: 60_000,
    probeClaudeAccount: opts.probe ?? (async () => ({ state: "signedIn" })),
  });
  cleanups.push(() => core.stop());
  return { dir, file, accounts, credentials, claude, codex, prefs, core, live, accX, accY, idX, idY, idMain };
}

const waitUntil = async (fn: () => boolean | Promise<boolean>, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await Bun.sleep(10);
  }
  throw new Error("timed out waiting for condition");
};

describe("multi-account fallback hops & provisionalStart", () => {
  test("subscription -> account:X -> account:Y resumes native id, passes CLAUDE_CONFIG_DIR, preserves lastSubscription, and returns Y -> X after retryAt", async () => {
    let now = 10_000_000;
    const t = setupAccounts({ now: () => now });
    const resetX = now + 60_000;
    t.prefs.setLastSubscription("claude", "subscription");
    t.prefs.set("claude:one", { source: "subscription", model: "sonnet", permissionMode: "plan" });
    await t.live.setFallbackChain("claude:one", true, [
      { harness: "claude", source: t.accX, model: "sonnet", permissionMode: "plan" },
      { harness: "claude", source: t.accY, model: "sonnet", permissionMode: "plan" },
    ]);
    t.claude.script = (text) => {
      const src = t.claude.drivers.at(-1)!.opts.credential?.source;
      if (text === "go" && src === "subscription") return [(s) => at(s), limit()];
      if (text === "go" && src === t.accX) return [(s) => at(s, { kind: "plan", label: claudeAccountLabel(t.accX), source: t.accX } as any), limit({ resetsAt: resetX })];
      return [(s) => at(s, { kind: "plan", label: src === t.accY ? claudeAccountLabel(t.accY) : claudeAccountLabel(t.accX), source: src } as any), reply];
    };

    await t.live.send("claude:one", "go");
    await waitUntil(async () => {
      const s = await t.core.open("claude:one");
      return s.state.fallbackChain?.active === 1 && s.state.status === "idle" && !s.sending && !s.pins;
    });

    const s = await t.core.open("claude:one");
    expect(t.prefs.get("claude:one").source).toBe(t.accY);
    expect(t.prefs.lastSubscription("claude")).toBe("subscription");
    expect(t.claude.drivers.map((d) => d.nativeId)).toEqual(["one", "one", "one"]);
    const yDriver = t.claude.drivers.at(-1)!;
    expect(yDriver.opts.credential?.claudeAccount?.configDir).toBe(t.accounts.configDir(t.accY));
    expect(claudeEnv(yDriver.opts.credential).CLAUDE_CONFIG_DIR).toBe(t.accounts.configDir(t.accY));
    expect(t.claude.drivers.map((d) => d.sent)).toEqual([["go"], ["go"], ["go"]]);
    const allNotices = notices(s);
    expect(allNotices.some((n) => n.includes("step 1") && !n.includes("account:"))).toBe(true);
    expect(allNotices.some((n) => n.includes("step 2") && !n.includes("account:"))).toBe(true);
    expect(allNotices.every((n) => !n.includes("account:"))).toBe(true);

    // Return Y -> X at the next message after retryAt.
    now = resetX + 1;
    await t.live.send("claude:one", "back to x");
    await waitUntil(() => t.prefs.get("claude:one").source === t.accX && !s.sending && s.state.status === "idle");
    expect(s.state.fallbackChain?.active).toBe(0);
    expect(t.claude.drivers.at(-1)!.sent).toEqual(["back to x"]);
  });

  test("B1 skips account:Y when identity-tagged planFor shows 100% full, without starting Y", async () => {
    const now = 20_000_000;
    const resetY = now + 3_600_000;
    const t = setupAccounts({ now: () => now });
    t.core.notePlan("claude", { fiveHour: { percent: 100, resetsAt: resetY, exhausted: true } }, t.accY, t.idY);
    t.prefs.set("claude:one", { source: "subscription", model: "sonnet", permissionMode: "plan" });
    await t.live.setFallbackChain("claude:one", true, [
      { harness: "claude", source: t.accY, model: "sonnet", permissionMode: "plan" },
      { harness: "claude", source: "anthropic", model: "sonnet", permissionMode: "plan" },
    ]);
    t.claude.script = () =>
      t.claude.drivers.at(-1)!.opts.credential?.source === "anthropic" ? [(s) => at(s, KEY as any), reply] : [(s) => at(s), limit()];

    await t.live.send("claude:one", "go");
    await waitUntil(async () => {
      const s = await t.core.open("claude:one");
      return s.state.fallbackChain?.active === 1 && s.state.status === "idle" && !s.sending;
    });
    expect(t.claude.drivers.map((d) => d.opts.credential?.source)).toEqual(["subscription", "anthropic"]);
    expect(t.prefs.get("claude:one").fallbackProgress?.steps[0]?.retryAt).toBe(resetY);
  });

  test("R5'/G4: identity change + refreshPlan, late report from old process, untagged window, and restart persistence", async () => {
    const now = 30_000_000;
    const resetFuture = now + 3_600_000;
    let currentPrimary: PlanIdentity = { accountId: "0".repeat(64), email: "old@example.test", organization: "Old Org" };
    const winFile = join(mkdtempSync(join("/tmp/claude-1001/auto/unit", "win-")), "claude-windows.json");
    cleanups.push(() => rmSync(join(winFile, ".."), { recursive: true, force: true }));

    // 1. Save full window for old primary identity AND an extra account to disk.
    windowsIn(winFile);
    keepPlan({ fiveHour: { percent: 100, resetsAt: resetFuture, exhausted: true } }, "subscription", currentPrimary);
    const t = setupAccounts({ now: () => now, primaryIdentity: () => currentPrimary, windowsFile: winFile });
    // Also persist account:X's full window across restart.
    keepPlan({ fiveHour: { percent: 100, resetsAt: resetFuture, exhausted: true } }, t.accX, t.idX);

    // Verify untagged legacy window is ignored for skip decisions.
    t.core.notePlan("claude", { fiveHour: { percent: 100, resetsAt: resetFuture, exhausted: true } }, t.accY); // no identity!
    t.prefs.set("claude:one", { source: "subscription", model: "sonnet", permissionMode: "plan" });
    await t.live.setFallbackChain("claude:one", true, [
      { harness: "claude", source: t.accY, model: "sonnet", permissionMode: "plan" },
    ]);
    t.claude.script = () =>
      t.claude.drivers.at(-1)!.opts.credential?.source === t.accY ? [reply] : [(s) => at(s), limit()];
    await t.live.send("claude:one", "try y");
    await waitUntil(async () => (await t.core.open("claude:one")).state.fallbackChain?.active === 0 && t.claude.drivers.at(-1)?.sent.length === 1);
    expect(t.prefs.get("claude:one").source).toBe(t.accY);

    // 2. Late report from an old process started before login change is dropped.
    const oldDriverSink = t.claude.drivers[0]!.sink;
    currentPrimary = { accountId: "9".repeat(64), email: "new@example.test", organization: "New Org" };
    t.claude.planUsageFor = async () => undefined; // identity changed, keptPlan returns undefined for new primary
    t.live.harnessLoginChanged("claude", "subscription");
    await t.core.refreshPlan("claude");
    oldDriverSink.plan?.({ fiveHour: { percent: 100, resetsAt: resetFuture, exhausted: true } }, { accountId: "0".repeat(64), email: "old@example.test", organization: "Old Org" });
    expect(t.core.planFor("claude", "subscription")).toBeUndefined();

    // 3. Simulate runner restart: reload claude-windows.json; old main login limit does NOT apply to new primary,
    //    while account:X's persisted full window DOES survive restart and skips X!
    windowsIn(winFile);
    const core2 = new SessionCore({ adapters: [t.claude], now: () => now, bus: new EventBus<CoreEvents>(), send: () => true, prefs: new Prefs(t.file, 0), epoch: "multi2", log: () => {} });
    cleanups.push(() => core2.stop());
    const live2 = new LiveControl(core2, new RequestBroker(), {
      credentials: t.credentials,
      claudeAccounts: t.accounts,
      probeClaudeAccount: async () => ({ state: "signedIn" }),
    });
    expect(core2.planEntryFor("claude", t.accX)?.plan.fiveHour?.percent).toBe(100);
    t.claude.drivers.length = 0;
    core2.o.prefs.set("claude:one", { source: t.accY, model: "sonnet", permissionMode: "plan" });
    await live2.setFallbackChain("claude:one", true, [
      { harness: "claude", source: t.accX, model: "sonnet", permissionMode: "plan" },
      { harness: "claude", source: "subscription", model: "sonnet", permissionMode: "plan" },
    ]);
    t.claude.script = () =>
      t.claude.drivers.at(-1)!.opts.credential?.source === "subscription" ? [reply] : [(s) => at(s), limit()];
    await live2.send("claude:one", "after restart");
    await waitUntil(async () => (await core2.open("claude:one")).state.fallbackChain?.active === 1);
    // accX was skipped due to persisted window; new main subscription was NOT skipped despite old primary's window on disk.
    expect(t.claude.drivers.map((d) => d.opts.credential?.source)).toEqual([t.accY, "subscription"]);
  });

  test("B2: plan limit shares backoff with same (harness, source, model) even when start === -1, not other models; rate-limit retries do not share", async () => {
    const now = 40_000_000;
    const t = setupAccounts({ now: () => now });
    // Start on subscription/sonnet (not matching step 0's effort, so start === -1).
    t.prefs.set("claude:one", { source: "subscription", model: "sonnet", effort: "high", permissionMode: "plan" });
    await t.live.setFallbackChain("claude:one", true, [
      { harness: "claude", source: "subscription", model: "sonnet", permissionMode: "default" }, // same source+model, different mode -> gets shared backoff!
      { harness: "claude", source: "subscription", model: "haiku", permissionMode: "plan" },    // different model -> NOT backed off!
      { harness: "claude", source: "anthropic", model: "sonnet", permissionMode: "plan" },
    ]);
    const reset = now + 120_000;
    t.claude.script = () =>
      t.claude.drivers.at(-1)!.opts.model === "haiku" ? [reply] : [(s) => at(s), limit({ resetsAt: reset })];

    await t.live.send("claude:one", "go");
    await waitUntil(async () => (await t.core.open("claude:one")).state.fallbackChain?.active === 1);
    const prog = t.prefs.get("claude:one").fallbackProgress!;
    expect(prog.steps[0]?.retryAt).toBe(reset);
    expect(prog.steps[0]?.why).toBe("limit");

    // Rate-limit retries exhausted do NOT share backoff across sibling steps.
    const t2 = setupAccounts({ now: () => now });
    t2.live.retries.time = () => undefined;
    t2.prefs.set("claude:one", { source: "subscription", model: "sonnet", permissionMode: "plan" });
    await t2.live.setFallbackChain("claude:one", true, [
      { harness: "claude", source: "subscription", model: "sonnet", permissionMode: "plan" },
      { harness: "claude", source: "subscription", model: "sonnet", effort: "high", permissionMode: "plan" },
    ]);
    t2.claude.script = () =>
      t2.claude.drivers.at(-1)!.opts.effort === "high" ? [reply] : [(s) => s.rateLimited?.({}), (s) => s.state({ status: "idle" })];
    await t2.live.send("claude:one", "rate");
    await waitUntil(async () => (await t2.core.open("claude:one")).state.fallbackChain?.active === 1);
    expect(t2.claude.drivers).toHaveLength(2);
  });

  test("B8/R1/G3/G10: signed-out Y skipped, unknown probe proceeds, failed start is silent and advances; Stop or chain edit during probe cancels", async () => {
    const probes: AccountSource[] = [];
    const t = setupAccounts({
      probe: async (src) => {
        probes.push(src);
        if (src === t.accX) return { state: "signedOut" };
        return { state: "unknown" }; // G10: unknown proceeds to provisional start
      },
    });
    const busEvents: string[] = [];
    t.core.o.bus.on("turnEnded", () => busEvents.push("turnEnded"));
    t.prefs.set("claude:one", { source: "subscription", model: "sonnet", permissionMode: "plan" });
    await t.live.setFallbackChain("claude:one", true, [
      { harness: "claude", source: t.accX, model: "sonnet", permissionMode: "plan" },
      { harness: "claude", source: t.accY, model: "sonnet", permissionMode: "plan" },
      { harness: "claude", source: "anthropic", model: "sonnet", permissionMode: "plan" },
    ]);
    // accY fails auth on provisional start -> silent (G3), advances to anthropic!
    t.claude.onStart = (opts) => {
      if (opts.credential?.source === t.accY) throw new Error("Claude could not confirm the Claude subscription account.");
    };
    t.claude.script = () =>
      t.claude.drivers.at(-1)!.opts.credential?.source === "anthropic" ? [(s) => at(s, KEY as any), reply] : [(s) => at(s), limit()];

    await t.live.send("claude:one", "go");
    await waitUntil(async () => {
      const s = await t.core.open("claude:one");
      return s.state.fallbackChain?.active === 2 && s.state.status === "idle" && !s.sending;
    });
    const s = await t.core.open("claude:one");
    expect(probes).toEqual([t.accX, t.accY]);
    expect(t.prefs.get("claude:one").fallbackProgress?.steps[0]?.retryAt).toBeGreaterThan(Date.now());
    expect(t.prefs.get("claude:one").fallbackProgress?.steps[1]?.retryAt).toBeGreaterThan(Date.now());
    expect(notices(s).some((n) => n.includes("Couldn't start"))).toBe(false);
    expect(s.state.error).toBeUndefined();
    expect(t.prefs.get("claude:one").failure).toBeUndefined();
    expect(busEvents.length).toBe(2); // initial limit turn + final anthropic reply, NO extra turnEnded from failed Y!

    // Stop during probe cancels with no backoff; chain edit during probe cancels with no backoff.
    for (const action of ["stop", "edit"] as const) {
      let releaseProbe!: () => void;
      const probeWait = new Promise<void>((r) => (releaseProbe = r));
      let probeStarted!: () => void;
      const onProbe = new Promise<void>((r) => (probeStarted = r));
      const u = setupAccounts({
        probe: async () => {
          probeStarted();
          await probeWait;
          return { state: "signedIn" };
        },
      });
      u.prefs.set("claude:one", { source: "subscription", model: "sonnet", permissionMode: "plan" });
      await u.live.setFallbackChain("claude:one", true, [
        { harness: "claude", source: u.accX, model: "sonnet", permissionMode: "plan" },
      ]);
      u.claude.script = () => [(s) => at(s), limit()];
      await u.live.send("claude:one", "go");
      await onProbe;
      if (action === "stop") await u.live.interrupt("claude:one");
      else await u.live.setFallbackChain("claude:one", false, []);
      releaseProbe();
      await Bun.sleep(40);
      expect(u.prefs.get("claude:one").source).toBe("subscription");
      expect(u.claude.drivers).toHaveLength(1);
      expect(u.prefs.get("claude:one").fallbackProgress?.steps[0]?.retryAt).toBeUndefined();
    }
  });

  test("B5/G10: background shell makes same-harness hop wait (ignoring shell queue entry), 30m cap warns + waiting, Stop cancels including returning wait", async () => {
    const t = setupAccounts();
    t.prefs.set("claude:one", { source: "subscription", model: "sonnet", permissionMode: "plan" });
    await t.live.setFallbackChain("claude:one", true, [
      { harness: "claude", source: t.accX, model: "sonnet", permissionMode: "plan" },
    ]);
    t.claude.script = () =>
      t.claude.drivers.at(-1)!.opts.credential?.source === t.accX ? [reply] : [(s) => at(s), limit()];

    const s = await t.core.open("claude:one");
    s.shellsRunning = 1;
    s.setState({ shellsRunning: 1 });
    await t.live.send("claude:one", "go");
    await waitUntil(() => s.state.fallbackWaiting === true);
    expect(t.prefs.get("claude:one").source).toBe("subscription");
    // Simulate `!` shell finishing and adding a shell queue entry (G10: must not deadlock handoff!).
    s.shellsRunning = 0;
    s.setState({ shellsRunning: undefined });
    await t.live.queue.add("claude:one", "shell output", [], { shell: { command: "ls", cardId: "c1" } });
    await waitUntil(() => t.prefs.get("claude:one").source === t.accX && s.state.status === "idle" && !s.sending);
    expect(s.state.fallbackWaiting).toBeUndefined();

    // 30-minute cap gives notice + waiting().
    let now = 50_000_000;
    const u = setupAccounts({ now: () => now });
    u.live.fallbackHandoffMaxMs = 1000;
    const statuses: string[] = [];
    u.core.o.bus.on("fallbackStatus", (e) => statuses.push(e.status));
    u.prefs.set("claude:one", { source: "subscription", model: "sonnet", permissionMode: "plan" });
    await u.live.setFallbackChain("claude:one", true, [
      { harness: "claude", source: u.accX, model: "sonnet", permissionMode: "plan" },
    ]);
    u.claude.script = () => [(s) => at(s), limit()];
    const su = await u.core.open("claude:one");
    su.shellsRunning = 1;
    su.setState({ shellsRunning: 1 });
    await u.live.send("claude:one", "go");
    await waitUntil(() => su.state.fallbackWaiting === true);
    now += 2000;
    await waitUntil(() => su.state.fallbackWaiting === undefined && notices(su).some((n) => n.includes("Background work is still running.")));
    expect(statuses).toContain("waiting");

    // Stop during returning wait cancels the user's send too instead of falling through to old source (G10).
    const v = setupAccounts();
    v.prefs.set("claude:one", {
      source: v.accY,
      model: "sonnet",
      permissionMode: "plan",
      fallbackChain: {
        enabled: true,
        active: 1,
        steps: [
          { harness: "claude", source: v.accX, model: "sonnet", permissionMode: "plan" },
          { harness: "claude", source: v.accY, model: "sonnet", permissionMode: "plan" },
        ],
      },
      fallbackProgress: { steps: { 0: { retryAt: Date.now() - 1000 } } },
    });
    const sv = await v.core.open("claude:one");
    sv.shellsRunning = 1;
    sv.setState({ shellsRunning: 1 });
    const sendPromise = v.live.send("claude:one", "user msg");
    await waitUntil(() => sv.state.fallbackWaiting === true);
    await v.live.interrupt("claude:one");
    await expect(sendPromise).rejects.toBeInstanceOf(SendCancelled);
    expect(v.claude.drivers).toHaveLength(0);
  });

  test("G1 & G10: same-source hop on anthropic/bedrock leaves nextBilling undefined; manual billing-chip switch clears active", async () => {
    const t = setupAccounts({ bedrock: true });
    const s = await t.core.open("claude:one");
    // Anthropic same-source confirmation leaves nextBilling undefined.
    t.prefs.set("claude:one", { source: "anthropic" });
    s.setState({ billing: { kind: "apiKey", label: "Anthropic API key" } });
    await t.live.setSource("claude:one", "anthropic");
    expect(s.state.nextBilling).toBeUndefined();

    // Bedrock same-source confirmation leaves nextBilling undefined.
    t.prefs.set("claude:one", { source: "bedrock", deployment: "us.anthropic.claude-sonnet-4-6-v1:0" });
    s.setState({ billing: { kind: "provider", label: "Amazon Bedrock" } });
    await t.live.setSource("claude:one", "bedrock", "us.anthropic.claude-sonnet-4-6-v1:0");
    expect(s.state.nextBilling).toBeUndefined();

    // Main login billing without source still confirms.
    t.prefs.set("claude:one", { source: "subscription" });
    s.setState({ billing: { kind: "plan", label: "Claude plan" } });
    await t.live.setSource("claude:one", "subscription");
    expect(s.state.nextBilling).toBeUndefined();

    // Manual billing-chip switch clears fallbackChain.active (G10).
    await t.live.setFallbackChain("claude:one", true, [
      { harness: "claude", source: "subscription", model: "sonnet", permissionMode: "plan" },
      { harness: "claude", source: t.accX, model: "sonnet", permissionMode: "plan" },
    ]);
    t.prefs.set("claude:one", { fallbackChain: { ...s.state.fallbackChain!, active: 1 } });
    s.setState({ fallbackChain: { ...s.state.fallbackChain!, active: 1 } });
    await t.live.setSource("claude:one", "anthropic");
    expect(s.state.fallbackChain?.active).toBeUndefined();
  });

  test("R1'''/R2/G3: Stop during provisional startup leaves state byte-identical; chain edit keeps edit; permission race backs off; failure after enqueued does not resend", async () => {
    // 1. Stop during provisional startup leaves state byte-identical.
    {
      let releaseStart!: () => void;
      const startGate = new Promise<void>((r) => (releaseStart = r));
      let secondStarted!: () => void;
      const onSecond = new Promise<void>((r) => (secondStarted = r));
      const t = setupAccounts();
      t.prefs.set("claude:one", { source: "subscription", model: "sonnet", permissionMode: "plan" });
      await t.live.setFallbackChain("claude:one", true, [
        { harness: "claude", source: t.accX, model: "sonnet", permissionMode: "plan" },
      ]);
      t.claude.onStart = async (opts) => {
        if (opts.credential?.source === t.accX) {
          secondStarted();
          await startGate;
        }
      };
      t.claude.script = () => [(s) => at(s), limit()];
      await t.live.send("claude:one", "go");
      await onSecond;
      const s = await t.core.open("claude:one");
      expect(s.state.switching).toEqual({ step: 0 });
      const { switching: _sw, ...stateBefore } = s.state;
      const snapshotBefore = JSON.stringify(stateBefore);
      await t.live.interrupt("claude:one");
      releaseStart();
      await Bun.sleep(40);
      expect(s.state.switching).toBeUndefined();
      expect(JSON.stringify(s.state)).toBe(snapshotBefore);
      expect(t.prefs.get("claude:one").source).toBe("subscription");
      expect(t.prefs.get("claude:one").fallbackProgress?.steps[0]?.retryAt).toBeUndefined();
    }

    // 2. Chain edit during provisional startup keeps the edit and leaves no trace of the hop.
    {
      let releaseStart!: () => void;
      const startGate = new Promise<void>((r) => (releaseStart = r));
      let secondStarted!: () => void;
      const onSecond = new Promise<void>((r) => (secondStarted = r));
      const t = setupAccounts();
      t.prefs.set("claude:one", { source: "subscription", model: "sonnet", permissionMode: "plan" });
      await t.live.setFallbackChain("claude:one", true, [
        { harness: "claude", source: t.accX, model: "sonnet", permissionMode: "plan" },
      ]);
      t.claude.onStart = async (opts) => {
        if (opts.credential?.source === t.accX) {
          secondStarted();
          await startGate;
        }
      };
      t.claude.script = () => [(s) => at(s), limit()];
      await t.live.send("claude:one", "go");
      await onSecond;
      const newSteps: FallbackStep[] = [{ harness: "claude", source: "anthropic", model: "haiku", permissionMode: "plan" }];
      await t.live.setFallbackChain("claude:one", true, newSteps);
      releaseStart();
      await Bun.sleep(40);
      const s = await t.core.open("claude:one");
      expect(s.state.fallbackChain).toEqual({ enabled: true, steps: newSteps });
      expect(t.prefs.get("claude:one").source).toBe("subscription");
    }

    // 3. Permission lowered between catalog fetch and beforeEnqueue backs off step 0 and continues to step 1 (R2).
    {
      const t = setupAccounts();
      t.prefs.set("claude:one", { source: "subscription", model: "sonnet", permissionMode: "default" });
      await t.live.setFallbackChain("claude:one", true, [
        { harness: "claude", source: t.accX, model: "sonnet", permissionMode: "default" },
        { harness: "claude", source: t.accY, model: "sonnet", permissionMode: "plan" },
      ]);
      t.claude.onStart = async (opts) => {
        if (opts.credential?.source === t.accX) {
          // Mode lowered mid-hop before enqueue!
          const s = await t.core.open("claude:one");
          t.prefs.set("claude:one", { permissionMode: "plan" });
          s.setState({ permissionMode: "plan" });
        }
      };
      t.claude.script = () =>
        t.claude.drivers.at(-1)!.opts.credential?.source === t.accY ? [reply] : [(s) => at(s), limit()];
      await t.live.send("claude:one", "go");
      await waitUntil(async () => (await t.core.open("claude:one")).state.fallbackChain?.active === 1);
      expect(t.prefs.get("claude:one").source).toBe(t.accY);
      expect(t.prefs.get("claude:one").fallbackProgress?.steps[0]?.retryAt).toBeGreaterThan(Date.now());
    }

    // 4. Failure AFTER enqueued does not resend (R1').
    {
      const t = setupAccounts();
      t.prefs.set("claude:one", { source: "subscription", model: "sonnet", permissionMode: "plan" });
      await t.live.setFallbackChain("claude:one", true, [
        { harness: "claude", source: t.accX, model: "sonnet", permissionMode: "plan" },
        { harness: "claude", source: t.accY, model: "sonnet", permissionMode: "plan" },
      ]);
      t.claude.script = () => {
        const src = t.claude.drivers.at(-1)!.opts.credential?.source;
        if (src === "subscription") return [(s) => at(s), limit()];
        // Throws inside script = AFTER onEnqueued fired!
        return [() => { throw new Error("mid-turn boom"); }];
      };
      await t.live.send("claude:one", "go");
      await waitUntil(async () => {
        const s = await t.core.open("claude:one");
        return s.state.error === "mid-turn boom" && s.state.status === "idle";
      });
      // Stayed on accX, did NOT resend to accY.
      expect(t.prefs.get("claude:one").source).toBe(t.accX);
      expect(t.claude.drivers.map((d) => d.opts.credential?.source)).toEqual(["subscription", t.accX]);
    }
  });

  test("R6.3': hopReservation serializes racing user send, terminal open, and abort cleanup", async () => {
    // 1. User send racing old-driver teardown waits and then runs on the committed driver (no-resend acted turn).
    {
      let releaseClose!: () => void;
      const closeGate = new Promise<void>((r) => (releaseClose = r));
      const t = setupAccounts();
      t.prefs.set("claude:one", { source: "subscription", model: "sonnet", permissionMode: "plan" });
      await t.live.setFallbackChain("claude:one", true, [
        { harness: "claude", source: t.accX, model: "sonnet", permissionMode: "plan" },
      ]);
      t.claude.onDriver = (d) => {
        if (d.opts.credential?.source === "subscription") d.closeGate = closeGate;
      };
      t.claude.script = (text) =>
        text === "first" && t.claude.drivers.at(-1)!.opts.credential?.source === "subscription"
          ? [(s) => at(s), tool, limit()]
          : [reply];

      await t.live.send("claude:one", "first");
      await Bun.sleep(20);
      // Old driver is now closing under hopLock; send a racing user message!
      const racingSend = t.live.send("claude:one", "after hop");
      await Bun.sleep(20);
      expect(t.claude.drivers).toHaveLength(1); // still waiting on teardown!
      releaseClose();
      await racingSend;
      await waitUntil(() => t.claude.drivers.length === 2 && t.claude.drivers[1]!.sent.includes("after hop"));
      expect(t.claude.drivers).toHaveLength(2);
      expect(t.claude.drivers[1]!.opts.credential?.source).toBe(t.accX);
      expect(t.claude.drivers[1]!.sent).toEqual(["after hop"]);
    }

    // 2. Terminal open (release) during a hop waits until hop commits.
    {
      let releaseStart!: () => void;
      const startGate = new Promise<void>((r) => (releaseStart = r));
      let secondStarted!: () => void;
      const onSecond = new Promise<void>((r) => (secondStarted = r));
      const t = setupAccounts();
      t.prefs.set("claude:one", { source: "subscription", model: "sonnet", permissionMode: "plan" });
      await t.live.setFallbackChain("claude:one", true, [
        { harness: "claude", source: t.accX, model: "sonnet", permissionMode: "plan" },
      ]);
      t.claude.onStart = async (opts) => {
        if (opts.credential?.source === t.accX) {
          secondStarted();
          await startGate;
        }
      };
      t.claude.script = () => [(s) => at(s), tool, limit()];
      await t.live.send("claude:one", "first");
      await onSecond;
      const s = await t.core.open("claude:one");
      let terminalReleased = false;
      const termWait = t.live.release(s).then(() => { terminalReleased = true; });
      await Bun.sleep(20);
      expect(terminalReleased).toBe(false);
      releaseStart();
      await termWait;
      expect(terminalReleased).toBe(true);
    }

    // 3. Abort cleanup releases the reservation and a waiting send runs on the original.
    {
      let releaseStart!: () => void;
      const startGate = new Promise<void>((r) => (releaseStart = r));
      let secondStarted!: () => void;
      const onSecond = new Promise<void>((r) => (secondStarted = r));
      const t = setupAccounts();
      t.prefs.set("claude:one", { source: "subscription", model: "sonnet", permissionMode: "plan" });
      await t.live.setFallbackChain("claude:one", true, [
        { harness: "claude", source: t.accX, model: "sonnet", permissionMode: "plan" },
      ]);
      t.claude.onStart = async (opts) => {
        if (opts.credential?.source === t.accX) {
          secondStarted();
          await startGate;
          throw new Error("auth failed");
        }
      };
      t.claude.script = (text) => text === "first" ? [(s) => at(s), limit()] : [reply];
      await t.live.send("claude:one", "first");
      await onSecond;
      const queuedSend = t.live.send("claude:one", "retry on original");
      await Bun.sleep(20);
      releaseStart();
      await queuedSend;
      await waitUntil(() => t.claude.drivers.at(-1)!.sent.includes("retry on original"));
      expect(t.prefs.get("claude:one").source).toBe("subscription");
      expect(t.claude.drivers.at(-1)!.sent).toEqual(["retry on original"]);
    }
  });

  test("R1''''/R2/R6a: cross-harness Codex -> account:Y moveFallback (success, auth fail discard, Stop, permission reject, fast turn-end deferral) & returnToFallback (abort byte-identical, no-resend startup-ready)", async () => {
    // 1. Codex -> Claude account:Y via moveFallback; also verifies R2 identical-step skip compares harness (both have source="subscription", model="sonnet").
    {
      const t = setupAccounts({ codex: true });
      t.prefs.set("codex:cx1", { source: "subscription", model: "sonnet", permissionMode: "read-only" });
      await t.live.setFallbackChain("codex:cx1", true, [
        { harness: "claude", source: t.accY, model: "sonnet", permissionMode: "plan" },
      ]);
      t.live.fallbackMover = async (_id, harness, source) => {
        t.claude.addStored("moved-y", []);
        t.prefs.set(`${harness}:moved-y`, { source, projectPath: "/p", carrying: true });
        return { sessionId: `${harness}:moved-y` };
      };
      t.codex!.script = () => [(s) => at(s), limit()];
      t.claude.script = () => [reply];

      await t.live.send("codex:cx1", "cross");
      await waitUntil(() => t.prefs.get("codex:cx1").movedTo === "claude:moved-y");
      expect(t.claude.drivers.at(-1)!.opts.credential?.source).toBe(t.accY);
      expect(t.claude.drivers.at(-1)!.sent[0]).toContain("Continue the task");
    }

    // 2. Codex -> Claude account:Y where start fails: original survives, successor discarded.
    {
      const t = setupAccounts({ codex: true });
      const discarded: string[] = [];
      t.claude.move!.discard = async (id) => { discarded.push(id); };
      t.prefs.set("codex:cx1", { source: "subscription", model: "gpt", permissionMode: "read-only" });
      await t.live.setFallbackChain("codex:cx1", true, [
        { harness: "claude", source: t.accY, model: "sonnet", permissionMode: "plan" },
      ]);
      t.live.fallbackMover = async (_id, harness, source) => {
        t.claude.addStored("bad-y", []);
        t.prefs.set(`${harness}:bad-y`, { source, projectPath: "/p", carrying: true });
        return { sessionId: `${harness}:bad-y` };
      };
      t.claude.onStart = () => { throw new Error("account Y auth failed"); };
      t.codex!.script = () => [(s) => at(s), limit()];
      await t.live.send("codex:cx1", "fail move");
      await waitUntil(async () => notices(await t.core.open("codex:cx1")).some((n) => n.includes("Used every available source.")));
      expect(t.prefs.get("codex:cx1").movedTo).toBeUndefined();
      expect(discarded).toEqual(["bad-y"]);
      // Exhausted notice contains no raw `account:`.
      expect(notices(await t.core.open("codex:cx1")).every((n) => !n.includes("account:"))).toBe(true);
    }

    // 3. Fast successor turn ends with limit BEFORE replaceWith finishes: limit is processed after commit with chain intact!
    {
      const t = setupAccounts({ codex: true });
      t.prefs.set("codex:cx1", { source: "subscription", model: "gpt", permissionMode: "read-only" });
      await t.live.setFallbackChain("codex:cx1", true, [
        { harness: "claude", source: t.accX, model: "sonnet", permissionMode: "plan" },
        { harness: "claude", source: "anthropic", model: "sonnet", permissionMode: "plan" },
      ]);
      t.live.fallbackMover = async (_id, harness, source) => {
        t.claude.addStored("fast-x", []);
        t.prefs.set(`${harness}:fast-x`, { source, projectPath: "/p", carrying: true });
        return { sessionId: `${harness}:fast-x` };
      };
      t.codex!.script = () => [(s) => at(s), limit()];
      // fast-x immediately hits limit synchronously during send(); anthropic replies!
      t.claude.script = () =>
        t.claude.drivers.at(-1)!.opts.credential?.source === "anthropic" ? [(s) => at(s, KEY as any), reply] : [(s) => at(s), limit()];

      await t.live.send("codex:cx1", "chain");
      await waitUntil(async () => {
        if (t.prefs.get("codex:cx1").movedTo !== "claude:fast-x") return false;
        const s = await t.core.open("claude:fast-x");
        return s.state.fallbackChain?.active === 1 && s.state.status === "idle" && !s.sending;
      });
      expect(t.prefs.get("claude:fast-x").source).toBe("anthropic");
    }

    // 4. Stop while successor is starting discards it and no turn runs; permission rejection on move path backs off.
    {
      let releaseStart!: () => void;
      const startGate = new Promise<void>((r) => (releaseStart = r));
      let started!: () => void;
      const onStart = new Promise<void>((r) => (started = r));
      const t = setupAccounts({ codex: true });
      const discarded: string[] = [];
      t.claude.move!.discard = async (id) => { discarded.push(id); };
      t.prefs.set("codex:cx1", { source: "subscription", model: "gpt", permissionMode: "read-only" });
      await t.live.setFallbackChain("codex:cx1", true, [
        { harness: "claude", source: t.accX, model: "sonnet", permissionMode: "plan" },
      ]);
      t.live.fallbackMover = async (_id, harness, source) => {
        t.claude.addStored("stop-x", []);
        t.prefs.set(`${harness}:stop-x`, { source, projectPath: "/p", carrying: true });
        return { sessionId: `${harness}:stop-x` };
      };
      t.claude.onStart = async () => { started(); await startGate; };
      t.codex!.script = () => [(s) => at(s), limit()];
      await t.live.send("codex:cx1", "stop move");
      await onStart;
      await t.live.interrupt("codex:cx1");
      releaseStart();
      await Bun.sleep(40);
      expect(discarded).toEqual(["stop-x"]);
      expect(t.claude.drivers.flatMap((d) => d.sent)).toEqual([]);
      expect(t.prefs.get("codex:cx1").fallbackProgress?.steps[0]?.retryAt).toBeUndefined();
    }

    // 5. returnToFallback: abort leaves historical session byte-identical; permission rejection backs off; no-resend commits on startup ready.
    {
      let now = 60_000_000;
      const t = setupAccounts({ now: () => now });
      t.claude.addStored("old-hist", [{ id: "m1", role: "user", ts: 1, parts: [{ type: "text", text: "hi" }] }]);
      t.prefs.set("claude:old-hist", { source: t.accX, model: "haiku", permissionMode: "plan", movedTo: "claude:one", projectPath: "/p" });
      const oldSess = await t.core.open("claude:old-hist");
      oldSess.movedTo = "claude:one";
      await t.core.load(oldSess);
      const oldStateBefore = JSON.stringify(oldSess.state);
      const oldPrefsBefore = JSON.stringify(t.prefs.get("claude:old-hist"));

      t.prefs.set("claude:one", {
        source: t.accY,
        model: "sonnet",
        permissionMode: "plan",
        fallbackChain: {
          enabled: true,
          active: 1,
          steps: [
            { harness: "claude", source: t.accX, model: "sonnet", permissionMode: "plan" },
            { harness: "claude", source: t.accY, model: "sonnet", permissionMode: "plan" },
          ],
        },
        fallbackProgress: { steps: { 0: { retryAt: now - 1000, sessionId: "claude:old-hist" } } },
      });
      t.live.fallbackArchive = async () => "/private/fallback/h.md";
      t.claude.onStart = (opts) => {
        if (opts.credential?.source === t.accX) throw new Error("return auth fail");
      };
      t.claude.script = () => [reply];
      await t.live.send("claude:one", "try return");
      // Return aborted on auth fail -> old historical session is byte-identical!
      expect(JSON.stringify(oldSess.state)).toBe(oldStateBefore);
      expect(JSON.stringify(t.prefs.get("claude:old-hist"))).toBe(oldPrefsBefore);
      expect(t.prefs.get("claude:one").fallbackProgress?.steps[0]?.retryAt).toBeGreaterThan(now);

      // Now allow return with acted turn (no resend -> startup-ready commit!).
      t.claude.onStart = undefined;
      const returnAt = now + 5_000;
      t.prefs.set("claude:one", {
        fallbackProgress: { steps: { 0: { retryAt: returnAt, sessionId: "claude:old-hist" } } },
      });
      t.claude.script = () => [(s) => at(s), tool, () => { now = returnAt + 1; }, limit()];
      await t.live.send("claude:one", "acted limit");
      await waitUntil(() => t.prefs.get("claude:one").movedTo === "claude:old-hist");
      expect(oldSess.driver).toBeDefined();
      expect((oldSess.driver as any).sent).toEqual([]);
    }

    // 6. returnToFallback with permission rejection backs off; Stop does not back off; unavailable higher-priority account backs off even when returning (R1'''', G10).
    {
      let now = 70_000_000;
      const t = setupAccounts({ now: () => now });
      t.claude.addStored("old-perm", []);
      t.prefs.set("claude:old-perm", { source: t.accX, model: "sonnet", permissionMode: "default", movedTo: "claude:one", projectPath: "/p" });
      const oldPerm = await t.core.open("claude:old-perm");
      oldPerm.movedTo = "claude:one";
      t.prefs.set("claude:one", {
        source: t.accY,
        model: "sonnet",
        permissionMode: "default",
        fallbackChain: {
          enabled: true,
          active: 1,
          steps: [
            { harness: "claude", source: t.accX, model: "sonnet", permissionMode: "default" },
            { harness: "claude", source: t.accY, model: "sonnet", permissionMode: "plan" },
          ],
        },
        fallbackProgress: { steps: { 0: { retryAt: now - 1000, sessionId: "claude:old-perm" } } },
      });
      // Lower permission mid-archive so returnToFallback hits permission rejection -> backs off step 0!
      t.live.fallbackArchive = async () => {
        const s = await t.core.open("claude:one");
        t.prefs.set("claude:one", { permissionMode: "plan" });
        s.setState({ permissionMode: "plan" });
        return "/private/fallback/p.md";
      };
      t.claude.script = () => [reply];
      await t.live.send("claude:one", "perm return");
      expect(t.prefs.get("claude:one").fallbackProgress?.steps[0]?.retryAt).toBeGreaterThan(now);

      // Unavailable higher-priority account gets backed off even when returning (G10).
      const removedAcc: AccountSource = "account:99999999-9999-4999-8999-999999999999";
      const u = setupAccounts({ now: () => now });
      u.prefs.set("claude:one", {
        source: u.accY,
        model: "sonnet",
        permissionMode: "plan",
        fallbackChain: {
          enabled: true,
          active: 1,
          steps: [
            { harness: "claude", source: removedAcc, model: "sonnet", permissionMode: "plan" },
            { harness: "claude", source: u.accY, model: "sonnet", permissionMode: "plan" },
          ],
        },
        fallbackProgress: { steps: { 0: { retryAt: now - 1000 } } },
      });
      u.claude.script = () => [reply];
      await u.live.send("claude:one", "keep going");
      expect(u.prefs.get("claude:one").fallbackProgress?.steps[0]?.retryAt).toBeGreaterThan(now);
      expect(u.claude.drivers.at(-1)!.sent).toEqual(["keep going"]);
    }
  });

  test("R6b'/R6b'': Codex carry errors before answer keeps original; no-resend sets nextSource; Stop/chain-edit/permission between enqueue and answer discards; manual carry still works", async () => {
    // 1. Carry prompt accepted then errors before answering -> original kept, successor discarded.
    {
      const t = setupAccounts({ codex: true });
      const discarded: string[] = [];
      t.codex!.move!.discard = async (id) => { discarded.push(id); };
      t.credentials.set("openai", `fake-openai-${crypto.randomUUID()}`);
      t.prefs.set("codex:cx1", { source: "subscription", model: "gpt", permissionMode: "read-only" });
      await t.live.setFallbackChain("codex:cx1", true, [
        { harness: "codex", source: "openai", model: "gpt", permissionMode: "read-only" },
      ]);
      t.live.carrier = async (_from, source) => {
        t.codex!.addStored("c-err", []);
        t.prefs.set("codex:c-err", { carrying: true, projectPath: "/p", source });
        return "codex:c-err";
      };
      t.codex!.script = () => {
        const src = t.codex!.drivers.at(-1)!.opts.credential?.source;
        if (src === "openai") return [(s) => { s.event({ type: "msg", msg: { id: "err1", role: "assistant", ts: 2, parts: [], error: "upstream fail" } }); s.state({ status: "idle" }); }];
        return [(s) => at(s), limit()];
      };
      await t.live.send("codex:cx1", "go");
      await waitUntil(async () => notices(await t.core.open("codex:cx1")).some((n) => n.includes("Used every available source.")));
      expect(t.prefs.get("codex:cx1").movedTo).toBeUndefined();
      expect(discarded).toEqual(["c-err"]);
    }

    // 2. Carry no-resend hop (acted turn) sets nextSource and creates no thread.
    {
      const t = setupAccounts({ codex: true });
      t.credentials.set("openai", `fake-openai-${crypto.randomUUID()}`);
      let carried = 0;
      t.live.carrier = async () => { carried++; return "codex:never"; };
      t.prefs.set("codex:cx1", { source: "subscription", model: "gpt", permissionMode: "read-only" });
      await t.live.setFallbackChain("codex:cx1", true, [
        { harness: "codex", source: "openai", model: "gpt", permissionMode: "read-only" },
      ]);
      t.codex!.script = () => [(s) => at(s), tool, limit()];
      await t.live.send("codex:cx1", "acted");
      await waitUntil(() => t.prefs.get("codex:cx1").nextSource === "openai");
      expect(carried).toBe(0);
    }

    // 3. Stop, chain edit, or permission lowered between enqueue and answer on fallback carry discards successor.
    for (const kind of ["stop", "edit", "permission"] as const) {
      let finishAnswer!: () => void;
      const answerWait = new Promise<void>((r) => (finishAnswer = r));
      let enqueued!: () => void;
      const onEnqueued = new Promise<void>((r) => (enqueued = r));
      const t = setupAccounts({ codex: true });
      const discarded: string[] = [];
      t.codex!.move!.discard = async (id) => { discarded.push(id); };
      t.credentials.set("openai", `fake-openai-${crypto.randomUUID()}`);
      t.prefs.set("codex:cx1", { source: "subscription", model: "gpt", permissionMode: "auto" });
      await t.live.setFallbackChain("codex:cx1", true, [
        { harness: "codex", source: "openai", model: "gpt", permissionMode: "auto" },
      ]);
      t.live.carrier = async (_from, source) => {
        t.codex!.addStored(`c-${kind}`, []);
        t.prefs.set(`codex:c-${kind}`, { carrying: true, projectPath: "/p", source });
        return `codex:c-${kind}`;
      };
      t.codex!.script = () => {
        const src = t.codex!.drivers.at(-1)!.opts.credential?.source;
        if (src === "openai") return [async () => { enqueued(); await answerWait; }, reply];
        return [(s) => at(s), limit()];
      };
      await t.live.send("codex:cx1", "go");
      await onEnqueued;
      if (kind === "stop") await t.live.interrupt("codex:cx1");
      else if (kind === "edit") await t.live.setFallbackChain("codex:cx1", false, []);
      else {
        const s = await t.core.open("codex:cx1");
        t.prefs.set("codex:cx1", { permissionMode: "read-only" });
        s.setState({ permissionMode: "read-only" });
      }
      finishAnswer();
      await waitUntil(() => discarded.includes(`c-${kind}`));
      expect(t.prefs.get("codex:cx1").movedTo).toBeUndefined();
      if (kind === "permission") {
        expect(t.prefs.get("codex:cx1").fallbackProgress?.steps[0]?.retryAt).toBeGreaterThan(Date.now());
      } else {
        expect(t.prefs.get("codex:cx1").fallbackProgress?.steps[0]?.retryAt).toBeUndefined();
      }
    }

    // 4. Ordinary manual carry still completes with no regression.
    {
      const t = setupAccounts({ codex: true });
      t.credentials.set("openai", `fake-openai-${crypto.randomUUID()}`);
      t.prefs.set("codex:cx1", { source: "subscription", model: "gpt", permissionMode: "read-only" });
      t.live.carrier = async (_from, source) => {
        t.codex!.addStored("c-manual", []);
        t.prefs.set("codex:c-manual", { carrying: true, projectPath: "/p", source });
        return "codex:c-manual";
      };
      t.codex!.script = () => [reply];
      await t.live.setSource("codex:cx1", "openai");
      await t.live.send("codex:cx1", "manual carry");
      expect(t.prefs.get("codex:cx1").movedTo).toBe("codex:c-manual");
    }
  });

  test("O1/O2'/G3'': chained hop when Y hits limit right after commit; interrupt on carry successor sets retrySuppressed; no-resend carry failure restores snapshot + lastKey and backs off; provisional successor holds turnEnded until commit", async () => {
    // 1. O1: Y hits limit right after commit -> token already released synchronously inside commit -> hops to step 2 (anthropic).
    {
      const t = setupAccounts();
      t.prefs.set("claude:one", { source: "subscription", model: "sonnet", permissionMode: "plan" });
      await t.live.setFallbackChain("claude:one", true, [
        { harness: "claude", source: t.accX, model: "sonnet", permissionMode: "plan" },
        { harness: "claude", source: "anthropic", model: "sonnet", permissionMode: "plan" },
      ]);
      t.claude.script = () => {
        const src = t.claude.drivers.at(-1)!.opts.credential?.source;
        if (src === "anthropic") return [(s) => at(s, KEY as any), reply];
        return [(s) => at(s), limit()];
      };
      await t.live.send("claude:one", "double limit");
      await waitUntil(async () => (await t.core.open("claude:one")).state.fallbackChain?.active === 1);
      expect(t.prefs.get("claude:one").source).toBe("anthropic");
    }

    // 2. O1: interrupt called on carry successor sets retrySuppressed on original and discards successor.
    {
      let finishAnswer!: () => void;
      const answerWait = new Promise<void>((r) => (finishAnswer = r));
      let enqueued!: () => void;
      const onEnqueued = new Promise<void>((r) => (enqueued = r));
      const t = setupAccounts({ codex: true });
      const discarded: string[] = [];
      t.codex!.move!.discard = async (id) => { discarded.push(id); };
      t.credentials.set("openai", `fake-openai-${crypto.randomUUID()}`);
      t.prefs.set("codex:cx1", { source: "subscription", model: "gpt", permissionMode: "read-only" });
      await t.live.setFallbackChain("codex:cx1", true, [
        { harness: "codex", source: "openai", model: "gpt", permissionMode: "read-only" },
      ]);
      t.live.carrier = async (_from, source) => {
        t.codex!.addStored("c-succ-stop", []);
        t.prefs.set("codex:c-succ-stop", { carrying: true, projectPath: "/p", source });
        return "codex:c-succ-stop";
      };
      t.codex!.script = () => {
        const src = t.codex!.drivers.at(-1)!.opts.credential?.source;
        if (src === "openai") return [async () => { enqueued(); await answerWait; }, reply];
        return [(s) => at(s), limit()];
      };
      await t.live.send("codex:cx1", "go");
      await onEnqueued;
      await t.live.interrupt("codex:c-succ-stop");
      finishAnswer();
      await waitUntil(() => discarded.includes("c-succ-stop"));
      const orig = await t.core.open("codex:cx1");
      expect(orig.retrySuppressed).toBe(true);
      expect(t.prefs.get("codex:cx1").movedTo).toBeUndefined();
    }

    // 3. O2' + Round 13 note: deferred no-resend carry fails on next message -> snapshot (including lastKey, nextSource, active) restored and 10-min backoff recorded.
    {
      let now = 80_000_000;
      const t = setupAccounts({ codex: true, now: () => now });
      t.credentials.set("openai", `fake-openai-${crypto.randomUUID()}`);
      t.prefs.set("codex:cx1", { source: "subscription", model: "gpt", permissionMode: "read-only" });
      await t.live.setFallbackChain("codex:cx1", true, [
        { harness: "codex", source: "openai", model: "gpt", permissionMode: "read-only" },
      ]);
      t.live.carrier = async () => { throw new Error("carry auth failed"); };
      t.codex!.script = () => [(s) => at(s), tool, limit()];
      await t.live.send("codex:cx1", "acted");
      await waitUntil(() => t.prefs.get("codex:cx1").nextSource === "openai");
      expect(t.prefs.get("codex:cx1").lastKey).toBe("openai");
      await expect(t.live.send("codex:cx1", "next message")).rejects.toThrow("carry auth failed");
      const p = t.prefs.get("codex:cx1");
      expect(p.nextSource).toBeUndefined();
      expect(p.nextBilling).toBeUndefined();
      expect(p.sourceSwitchFailed).toBeUndefined();
      expect(p.lastKey).toBeUndefined();
      expect(p.fallbackChain?.active).toBeUndefined();
      expect(p.fallbackProgress?.steps[0]?.retryAt).toBe(now + 10 * 60_000);
    }

    // 4. G3'': provisional successor turnEnded is held until commit (0 on discard, 1 on commit).
    {
      const t = setupAccounts({ codex: true });
      const turnEnds: string[] = [];
      t.core.o.bus.on("turnEnded", ({ sessionId }) => turnEnds.push(sessionId));
      t.credentials.set("openai", `fake-openai-${crypto.randomUUID()}`);
      t.prefs.set("codex:cx1", { source: "subscription", model: "gpt", permissionMode: "read-only" });
      await t.live.setFallbackChain("codex:cx1", true, [
        { harness: "codex", source: "openai", model: "gpt", permissionMode: "read-only" },
      ]);
      t.live.carrier = async (_from, source) => {
        t.codex!.addStored("c-g3", []);
        t.prefs.set("codex:c-g3", { carrying: true, projectPath: "/p", source });
        return "codex:c-g3";
      };
      t.codex!.script = () => {
        const src = t.codex!.drivers.at(-1)!.opts.credential?.source;
        if (src === "openai") return [reply];
        return [(s) => at(s), limit()];
      };
      await t.live.send("codex:cx1", "go");
      await waitUntil(() => t.prefs.get("codex:cx1").movedTo === "codex:c-g3");
      await Bun.sleep(30);
      expect(turnEnds.filter((id) => id === "codex:c-g3")).toHaveLength(1);
    }
  });

  test("Q1/Q1': queued messages wait unheld across hop and drain once on successor; limit turn with error doesn't hold queue; user send mid-hop queues unheld", async () => {
    // 1. Pre-queued message + user send during hop both drain once after same-session commit, with no 'failed' hold.
    {
      let releaseStart!: () => void;
      const startGate = new Promise<void>((r) => (releaseStart = r));
      let secondStarted!: () => void;
      const onSecond = new Promise<void>((r) => (secondStarted = r));
      const t = setupAccounts();
      t.prefs.set("claude:one", { source: "subscription", model: "sonnet", permissionMode: "plan" });
      await t.live.setFallbackChain("claude:one", true, [
        { harness: "claude", source: t.accX, model: "sonnet", permissionMode: "plan" },
      ]);
      t.claude.onStart = async (opts) => {
        if (opts.credential?.source === t.accX) {
          secondStarted();
          await startGate;
        }
      };
      t.claude.script = () => {
        const src = t.claude.drivers.at(-1)!.opts.credential?.source;
        if (src === t.accX) return [reply];
        return [(s) => at(s), limit()];
      };
      await t.live.queue.add("claude:one", "pre-queued", []);
      await t.live.send("claude:one", "initial");
      await onSecond;
      // Send a user message mid-hop: queued unheld (Q1).
      await t.live.send("claude:one", "mid-hop user msg");
      const s = await t.core.open("claude:one");
      expect(s.state.queueHeldBy).toBeUndefined();
      expect(s.state.queue.map((q) => q.text)).toEqual(["pre-queued", "mid-hop user msg"]);
      releaseStart();
      await waitUntil(() => {
        const d = t.claude.drivers.find((x) => x.opts.credential?.source === t.accX);
        return (d?.sent.length ?? 0) >= 3;
      });
      const accDriver = t.claude.drivers.find((x) => x.opts.credential?.source === t.accX)!;
      expect(accDriver.sent).toEqual(["initial", "pre-queued", "mid-hop user msg"]);
      expect(s.state.queue).toEqual([]);
      expect(s.state.queueHeldBy).toBeUndefined();
    }

    // 2. Q1': QueueDeferred restores an already-admitted drain item untouched (same id/schedule/hold) and sends once after commit.
    {
      let releaseStart!: () => void;
      const startGate = new Promise<void>((r) => (releaseStart = r));
      let secondStarted!: () => void;
      const onSecond = new Promise<void>((r) => (secondStarted = r));
      const t = setupAccounts();
      t.prefs.set("claude:one", { source: "subscription", model: "sonnet", permissionMode: "plan" });
      await t.live.setFallbackChain("claude:one", true, [
        { harness: "claude", source: t.accX, model: "sonnet", permissionMode: "plan" },
      ]);
      t.claude.onStart = async (opts) => {
        if (opts.credential?.source === t.accX) {
          secondStarted();
          await startGate;
        }
      };
      t.claude.script = () => {
        const src = t.claude.drivers.at(-1)!.opts.credential?.source;
        if (src === t.accX) return [reply];
        return [(s) => at(s), limit()];
      };
      const added = await t.live.queue.add("claude:one", "deferred-drain", []);
      await t.live.send("claude:one", "trigger");
      await onSecond;
      const s = await t.core.open("claude:one");
      // Simulate a queued drain racing into sendNow while hop is active.
      await expect(t.live.send("claude:one", "deferred-drain", [], { queued: true })).rejects.toBeInstanceOf(QueueDeferred);
      expect(s.state.queue[0]?.id).toBe(added.id);
      expect(s.state.queueHeldBy).toBeUndefined();
      releaseStart();
      await waitUntil(() => (t.claude.drivers.find((x) => x.opts.credential?.source === t.accX)?.sent.length ?? 0) >= 2);
      expect(t.claude.drivers.find((x) => x.opts.credential?.source === t.accX)!.sent).toEqual(["trigger", "deferred-drain"]);
    }
  });

  test("O3'/Q2/Q2'/O5'/G11': orgId separation & stale generation drop; background probe change & stale drop; cross-harness return notice & returning retryAt persist", async () => {
    // 1. O3' + Q2: same email + org name with different orgId -> no window sharing, and late report from old process dropped.
    {
      const now = 90_000_000;
      const t = setupAccounts({ now: () => now });
      const idOrgA: PlanIdentity = { accountId: "a".repeat(64), email: "same@example.test", organization: "Acme" };
      const idOrgB: PlanIdentity = { accountId: "b".repeat(64), email: "same@example.test", organization: "Acme" };
      const accA = t.accounts.create();
      const accB = t.accounts.create();
      t.accounts.save(accA, idOrgA as any, 3000);
      t.accounts.save(accB, idOrgB as any, 4000);
      t.core.notePlan("claude", { fiveHour: { percent: 100, resetsAt: now + 3_600_000, exhausted: true } }, accA, idOrgA);
      // accB has same email & org name, different accountId (orgId) -> must NOT share accA's full window!
      t.prefs.set("claude:one", { source: "subscription", model: "sonnet", permissionMode: "plan" });
      await t.live.setFallbackChain("claude:one", true, [
        { harness: "claude", source: accB, model: "sonnet", permissionMode: "plan" },
      ]);
      t.claude.script = () =>
        t.claude.drivers.at(-1)!.opts.credential?.source === accB ? [reply] : [(s) => at(s), limit()];
      await t.live.send("claude:one", "should use B");
      await waitUntil(async () => (await t.core.open("claude:one")).state.fallbackChain?.active === 0);
      expect(t.prefs.get("claude:one").source).toBe(accB);

      // Late report from old process after login change on accB is dropped by generation guard (Q2).
      const oldDriver = t.claude.drivers.find((d) => d.opts.credential?.source === accB)!;
      t.live.harnessLoginChanged("claude", accB);
      oldDriver.sink.plan?.({ fiveHour: { percent: 99, resetsAt: now + 9_999_000 } }, idOrgA);
      expect(t.core.planEntryFor("claude", accB)).toBeUndefined();
    }

    // 2. O5': background probe settles from unknown -> signedOut -> onProbeChanged fires; stale generation completion dropped.
    {
      let releaseFirst!: () => void;
      const firstWait = new Promise<void>((r) => (releaseFirst = r));
      let call = 0;
      const changed: AccountSource[] = [];
      const t = setupAccounts({
        probe: async (src) => {
          if (src !== t.accX) return { state: "signedIn" };
          call++;
          if (call === 1) {
            await firstWait;
            return { state: "signedOut" };
          }
          return { state: "signedIn" };
        },
      });
      t.live.onProbeChanged = (src) => changed.push(src);
      const first = await t.live.sources("claude");
      expect(first.options.find((o) => o.source === t.accX)?.probe).toBe("unknown");
      releaseFirst();
      await waitUntil(() => changed.includes(t.accX));
      const second = await t.live.sources("claude");
      expect(second.options.find((o) => o.source === t.accX)?.probe).toBe("signedOut");

      // Stale generation completion is dropped.
      let releaseStale!: () => void;
      const staleWait = new Promise<void>((r) => (releaseStale = r));
      const changed2: AccountSource[] = [];
      const u = setupAccounts({
        probe: async (src) => {
          if (src === t.accX) {
            await staleWait;
            return { state: "signedOut" };
          }
          return { state: "signedIn" };
        },
      });
      u.live.onProbeChanged = (src) => changed2.push(src);
      await u.live.sources("claude");
      u.live.harnessLoginChanged("claude", u.accX);
      releaseStale();
      await Bun.sleep(30);
      expect(changed2.includes(u.accX)).toBe(false);
    }

    // 3. G11': cross-harness return notice names step.harness (Codex -> Claude account) and returning pass with all skipped persists retryAt.
    {
      let now = 95_000_000;
      const t = setupAccounts({ codex: true, now: () => now });
      t.claude.addStored("old-cl", []);
      t.prefs.set("claude:old-cl", { source: t.accX, model: "sonnet", permissionMode: "plan", movedTo: "codex:cx1", projectPath: "/p" });
      const oldCl = await t.core.open("claude:old-cl");
      oldCl.movedTo = "codex:cx1";
      t.prefs.set("codex:cx1", {
        source: "subscription",
        model: "gpt",
        permissionMode: "read-only",
        fallbackChain: {
          enabled: true,
          active: 1,
          steps: [
            { harness: "claude", source: t.accX, model: "sonnet", permissionMode: "plan" },
            { harness: "codex", source: "subscription", model: "gpt", permissionMode: "read-only" },
          ],
        },
        fallbackProgress: { steps: { 0: { retryAt: now - 1000, sessionId: "claude:old-cl" } } },
      });
      t.live.fallbackArchive = async () => "/private/fallback/ret.md";
      t.claude.script = () => [reply];
      const orig = await t.core.open("codex:cx1");
      await t.core.load(orig);
      await t.live.send("codex:cx1", "return to claude");
      await waitUntil(() => t.prefs.get("codex:cx1").movedTo === "claude:old-cl");
      expect(notices(orig).some((n) => n.includes("Returned to step 1 · Claude plan"))).toBe(true);
    }
  });

  test("PR1 blockers: silent carry startup failure + O2 exhausted; heldSideEffects replay; Stop holds queue; native->archive move fallback; scheduled mid-hop + handoffGate drain/add ordering", async () => {
    // 1. Blocker 1 + O2 + G11': resend-carry carrier/startup auth failure is silent (no notice, no sourceSwitchFailed, no inbox failure), backs off, tries next cross-harness step which also fails -> exhausted with nextSource cleared.
    {
      const t = setupAccounts({ codex: true });
      t.credentials.set("openai", `fake-openai-${crypto.randomUUID()}`);
      t.prefs.set("codex:cx1", { source: "subscription", model: "gpt", permissionMode: "read-only" });
      await t.live.setFallbackChain("codex:cx1", true, [
        { harness: "codex", source: "openai", model: "gpt", permissionMode: "read-only" },
        { harness: "claude", source: t.accX, model: "sonnet", permissionMode: "plan" },
      ]);
      // Carrier fails at startup (provisional flag passed) -> silent backoff, moves to step 2 (claude).
      let sawProvisional = false;
      t.live.carrier = async (_from, _source, _m, _s, extra) => {
        sawProvisional = !!extra?.provisional;
        throw new Error("OpenAI key rejected at start.");
      };
      t.live.fallbackMover = async () => { throw new Error("Cross-harness start failed."); };
      t.codex!.script = () => [(s) => at(s), limit()];
      const orig = await t.core.open("codex:cx1");
      await t.core.load(orig);
      await t.live.send("codex:cx1", "try carry then cross");
      await waitUntil(() => notices(orig).some((n) => n.includes("Used every available source.")));
      expect(sawProvisional).toBe(true);
      expect(t.prefs.get("codex:cx1").nextSource).toBeUndefined();
      expect(t.prefs.get("codex:cx1").sourceSwitchFailed).toBeUndefined();
      expect(t.prefs.get("codex:cx1").failure).not.toContain("OpenAI key rejected");
      expect(notices(orig).some((n) => n.includes("Couldn't start"))).toBe(false);
      expect(t.prefs.get("codex:cx1").fallbackProgress?.steps[0]?.retryAt).toBeGreaterThan(Date.now());
      expect(t.prefs.get("codex:cx1").fallbackProgress?.steps[1]?.retryAt).toBeGreaterThan(Date.now());
    }

    // 1b. Blocker 1: carrier returns a provisional successor whose startDriver fails -> silent (no notice, no inbox failure on discarded successor), backs off and advances.
    {
      const t = setupAccounts({ codex: true });
      t.credentials.set("openai", `fake-openai-${crypto.randomUUID()}`);
      t.prefs.set("codex:cx1", { source: "subscription", model: "gpt", permissionMode: "read-only" });
      await t.live.setFallbackChain("codex:cx1", true, [
        { harness: "codex", source: "openai", model: "gpt", permissionMode: "read-only" },
      ]);
      t.live.carrier = async (_from, source) => {
        t.codex!.addStored("c-start-fail", []);
        t.prefs.set("codex:c-start-fail", { carrying: true, projectPath: "/p", source });
        return "codex:c-start-fail";
      };
      t.codex!.onStart = (opts) => {
        if (opts.credential?.source === "openai") throw new Error("not logged in to OpenAI");
      };
      t.codex!.script = () => [(s) => at(s), limit()];
      const orig = await t.core.open("codex:cx1");
      await t.core.load(orig);
      await t.live.send("codex:cx1", "provisional start fail");
      await waitUntil(() => notices(orig).some((n) => n.includes("Used every available source.")));
      expect(t.prefs.get("codex:c-start-fail").failure).toBeUndefined();
      expect(t.prefs.get("codex:cx1").sourceSwitchFailed).toBeUndefined();
      expect(notices(orig).some((n) => n.includes("Couldn't start"))).toBe(false);
    }

    // 2. Blocker 2 (G3''): heldSideEffects holds turnStarted + message + toolCall on provisional carry successor and replays them on commit (and drops on discard).
    {
      const t = setupAccounts({ codex: true });
      const busEvents: string[] = [];
      t.core.o.bus.on("turnStarted", ({ sessionId }) => { if (sessionId === "codex:c-held") busEvents.push("turnStarted"); });
      t.core.o.bus.on("message", ({ sessionId }) => { if (sessionId === "codex:c-held") busEvents.push("message"); });
      t.core.o.bus.on("turnEnded", ({ sessionId }) => { if (sessionId === "codex:c-held") busEvents.push("turnEnded"); });
      t.credentials.set("openai", `fake-openai-${crypto.randomUUID()}`);
      t.prefs.set("codex:cx1", { source: "subscription", model: "gpt", permissionMode: "read-only" });
      await t.live.setFallbackChain("codex:cx1", true, [
        { harness: "codex", source: "openai", model: "gpt", permissionMode: "read-only" },
      ]);
      t.live.carrier = async (_from, source) => {
        t.codex!.addStored("c-held", []);
        t.prefs.set("codex:c-held", { carrying: true, projectPath: "/p", source });
        return "codex:c-held";
      };
      t.codex!.script = () => {
        const src = t.codex!.drivers.at(-1)!.opts.credential?.source;
        if (src === "openai") return [reply];
        return [(s) => at(s), limit()];
      };
      await t.live.send("codex:cx1", "go");
      await waitUntil(() => t.prefs.get("codex:cx1").movedTo === "codex:c-held");
      await Bun.sleep(30);
      expect(busEvents).toContain("turnStarted");
      expect(busEvents).toContain("message");
      expect(busEvents.filter((e) => e === "turnEnded")).toHaveLength(1);
      expect(busEvents.indexOf("turnStarted")).toBeLessThan(busEvents.indexOf("turnEnded"));
    }

    // 3. Blocker 3: Stop during a hop holds queued messages "stopped" so they don't drain on the exhausted source.
    {
      let releaseStart!: () => void;
      const startGate = new Promise<void>((r) => (releaseStart = r));
      let secondStarted!: () => void;
      const onSecond = new Promise<void>((r) => (secondStarted = r));
      const t = setupAccounts();
      t.prefs.set("claude:one", { source: "subscription", model: "sonnet", permissionMode: "plan" });
      await t.live.setFallbackChain("claude:one", true, [
        { harness: "claude", source: t.accX, model: "sonnet", permissionMode: "plan" },
      ]);
      t.claude.onStart = async (opts) => {
        if (opts.credential?.source === t.accX) {
          secondStarted();
          await startGate;
        }
      };
      t.claude.script = () => [(s) => at(s), limit()];
      await t.live.queue.add("claude:one", "must stay held", []);
      await t.live.send("claude:one", "hit limit");
      await onSecond;
      await t.live.interrupt("claude:one");
      releaseStart();
      await Bun.sleep(100);
      const s = await t.core.open("claude:one");
      expect(s.state.queueHeldBy).toBe("stopped");
      expect(s.state.queue.map((m) => m.text)).toEqual(["must stay held"]);
      expect(t.claude.drivers.flatMap((d) => d.sent)).toEqual(["hit limit"]);
    }

    // 4. Blocker 4: Failed native import falls back to archiveOnly move and succeeds.
    {
      const t = setupAccounts({ codex: true });
      t.prefs.set("codex:cx1", { source: "subscription", model: "gpt", permissionMode: "read-only" });
      await t.live.setFallbackChain("codex:cx1", true, [
        { harness: "claude", source: t.accX, model: "sonnet", permissionMode: "plan" },
      ]);
      const calls: boolean[] = [];
      t.live.fallbackMover = async (_id, _h, source, _opts, extra) => {
        calls.push(!!extra?.archiveOnly);
        if (!extra?.archiveOnly) {
          t.claude.addStored("nat-bad", []);
          t.prefs.set("claude:nat-bad", { source, projectPath: "/p", carrying: true });
          return { sessionId: "claude:nat-bad", after: "a1", native: true };
        }
        t.claude.addStored("arch-ok", []);
        t.prefs.set("claude:arch-ok", { source, projectPath: "/p", carrying: true });
        return { sessionId: "claude:arch-ok", history: "/tmp/history.md" };
      };
      let firstAttempt = true;
      t.claude.onStart = (opts) => {
        if (firstAttempt && opts.credential?.source === t.accX) {
          firstAttempt = false;
          throw new Error("imported rollout corrupt");
        }
      };
      t.codex!.script = () => [(s) => at(s), limit()];
      t.claude.script = () => [reply];
      await t.live.send("codex:cx1", "move me");
      await waitUntil(() => t.prefs.get("codex:cx1").movedTo === "claude:arch-ok");
      expect(calls).toEqual([false, true]);
    }

    // 5. Blocker 5 (Q1): scheduled message coming due mid-hop waits unheld and drains after commit.
    {
      let now = 100_000_000;
      let releaseStart!: () => void;
      const startGate = new Promise<void>((r) => (releaseStart = r));
      let secondStarted!: () => void;
      const onSecond = new Promise<void>((r) => (secondStarted = r));
      const t = setupAccounts({ now: () => now });
      t.prefs.set("claude:one", { source: "subscription", model: "sonnet", permissionMode: "plan" });
      await t.live.setFallbackChain("claude:one", true, [
        { harness: "claude", source: t.accX, model: "sonnet", permissionMode: "plan" },
      ]);
      t.claude.onStart = async (opts) => {
        if (opts.credential?.source === t.accX) {
          secondStarted();
          await startGate;
        }
      };
      t.claude.script = () =>
        t.claude.drivers.at(-1)!.opts.credential?.source === t.accX ? [reply] : [(s) => at(s), limit()];
      await t.live.queue.add("claude:one", "scheduled mid-hop", [], { at: now + 60_000 });
      await t.live.send("claude:one", "trigger");
      await onSecond;
      // Advance time past the scheduled message while hop is active.
      now += 120_000;
      t.live.queue.later("claude:one");
      await Bun.sleep(80);
      const s = await t.core.open("claude:one");
      expect(s.state.queue).toHaveLength(1);
      expect(s.state.queue[0]!.held).toBeUndefined();
      expect(s.state.queueHeldBy).toBeUndefined();
      releaseStart();
      await waitUntil(() => (t.claude.drivers.find((d) => d.opts.credential?.source === t.accX)?.sent.length ?? 0) >= 2);
      expect(t.claude.drivers.find((d) => d.opts.credential?.source === t.accX)!.sent).toEqual(["trigger", "scheduled mid-hop"]);
    }

    // 6. Blocker 5 (Q1' + Round 14 note 3): during handOver, drain doesn't claim work on original, and queue.add on successor waits for handoffGate so moved items stay ahead.
    {
      const t = setupAccounts({ codex: true });
      t.credentials.set("openai", `fake-openai-${crypto.randomUUID()}`);
      t.prefs.set("codex:cx1", { source: "subscription", model: "gpt", permissionMode: "read-only" });
      await t.live.setFallbackChain("codex:cx1", true, [
        { harness: "codex", source: "openai", model: "gpt", permissionMode: "read-only" },
      ]);
      t.live.carrier = async (_from, source) => {
        t.codex!.addStored("c-gate", []);
        t.prefs.set("codex:c-gate", { carrying: true, projectPath: "/p", source });
        return "codex:c-gate";
      };
      // Hook handOver to pause mid-handoff so we can test drain on original + queue.add on successor!
      const origHandOver = t.live.queue.handOver.bind(t.live.queue);
      let enteredHandOver!: () => void;
      const onHandOver = new Promise<void>((r) => (enteredHandOver = r));
      let finishHandOver!: () => void;
      const handOverGate = new Promise<void>((r) => (finishHandOver = r));
      t.live.queue.handOver = async (fromId, toId) => {
        enteredHandOver();
        await handOverGate;
        return origHandOver(fromId, toId);
      };
      t.codex!.script = () => {
        const src = t.codex!.drivers.at(-1)!.opts.credential?.source;
        if (src === "openai") return [reply];
        return [(s) => at(s), limit()];
      };
      await t.live.queue.add("codex:cx1", "moved-first", []);
      await t.live.send("codex:cx1", "start");
      await onHandOver;
      // While handoffGate is active during handOver:
      // (a) A drain waking on original must NOT claim work (throws QueueDeferred / paused).
      await expect(t.live.send("codex:cx1", "moved-first", [], { queued: true })).rejects.toBeInstanceOf(QueueDeferred);
      // (b) queue.add on successor waits until handOver finishes, so moved-first stays ahead of added-second.
      const addPromise = t.live.queue.add("codex:c-gate", "added-second", []);
      finishHandOver();
      await addPromise;
      await waitUntil(() => (t.codex!.drivers.find((d) => d.opts.credential?.source === "openai")?.sent.length ?? 0) >= 3);
      const openaiDriver = t.codex!.drivers.find((d) => d.opts.credential?.source === "openai")!;
      expect(openaiDriver.sent).toEqual(["start", "moved-first", "added-second"]);
    }
  });
});
