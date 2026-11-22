// Fallback on the real core with a scripted harness.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import type { FallbackStep } from "../../../shared/fallbackChain";
import { saveConfig } from "../config";
import { CredentialStore } from "../credentials";
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

function setup({ ticked = true, key = true } = {}) {
  const base = "/tmp/claude-1001/auto/unit";
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, "core-")), file = join(dir, "runner.json");
  saveConfig({ runnerId: "auto-test" }, file);
  const adapter = new FakeAdapter(), credentials = new CredentialStore(join(dir, "credentials.json"));
  adapter.capabilities = { ...adapter.capabilities, sourceSwitch: true };
  adapter.addStored("one", []);
  const prefs = new Prefs(file, 0);
  const core = new SessionCore({ adapters: [adapter], bus: new EventBus<CoreEvents>(), send: () => true, prefs, epoch: "auto", log: () => {} });
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
const notices = (s: any) => s.transcript.messages.filter((m: any) => m.role === "notice").map((m: any) => m.parts[0].text);
const sentOn = (t: ReturnType<typeof setup>) => t.adapter.drivers.map((d) => [d.opts.credential?.source, d.sent]);

describe("the fallback chain", () => {
  test("on: the source changes, one notice, the same message once, and it stays on the key", async () => {
    const t = setup();
    await t.live.send("claude:one", "fix it");
    const s = await settled(t, (s) => s.state.billing?.kind === "apiKey");
    expect(sentOn(t)).toEqual([["subscription", ["fix it"]], ["anthropic", ["fix it"]]]);
    expect(notices(s)).toEqual(["Plan limit reached. Switched to Anthropic API key. Resending your message."]);
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
    expect(t.adapter.drivers).toHaveLength(1);
    expect(t.prefs.get(s.id).source).toBe("anthropic");
    expect(notices(s)[0]).toContain("Switched to Anthropic API key. The turn already acted. Send a message to continue.");
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
    expect(t.adapter.drivers).toHaveLength(1);
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
    await t.live.send("claude:one", "fix it");
    const s = await settled(t, () => true);
    await Bun.sleep(20);
    expect(notices(s)).toEqual(["Plan limit reached. No available fallback step on this harness."]);

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

  test("stops at a cross-harness hop instead of skipping ahead", async () => {
    const t = setup();
    await t.live.setFallbackChain("claude:one", true, [
      { harness: "codex", source: "subscription", model: "gpt" }, ...steps,
    ]);
    await t.live.send("claude:one", "go");
    const s = await settled(t, (s) => notices(s).includes("Plan limit reached. The next step needs another harness."));
    expect(s.state.fallbackChain?.active).toBeUndefined();
    expect(t.sends()).toBe(1);
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
