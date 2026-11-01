// Where a session's API cost starts when its source becomes a key (SPEC "API session dollars"): whole
// when Tether knows what it spent on an API before, partial with a reason when it can't. Real core,
// real ledger file, a fake harness that confirms its billing as a real one does at each start.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { saveConfig } from "../config";
import { CostLedger } from "../costs";
import { CredentialStore } from "../credentials";
import { RequestBroker } from "./broker";
import { EventBus } from "./bus";
import type { CoreEvents } from "./events";
import { FakeAdapter, type Step } from "./fakeAdapter";
import { LiveControl } from "./live";
import { Prefs } from "./prefs";
import { SessionCore } from "./sessions";

const PLAN = { kind: "plan", label: "Claude plan" } as const;
const KEY = { kind: "apiKey", label: "Anthropic API key" } as const;
const UNKNOWN = { kind: "unknown", label: "Unknown" } as const;

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((f) => f()));

function setup(o: { stored?: typeof PLAN | typeof KEY | typeof UNKNOWN; dir?: string } = {}) {
  const base = "/tmp/claude-1001/costsw/unit";
  mkdirSync(base, { recursive: true });
  const dir = o.dir ?? mkdtempSync(join(base, "core-"));
  const file = join(dir, "runner.json"), costsFile = join(dir, "costs.json");
  if (!o.dir) saveConfig({ runnerId: "costsw-test" }, file);
  const adapter = new FakeAdapter(), credentials = new CredentialStore(join(dir, "credentials.json"));
  adapter.capabilities = { ...adapter.capabilities, sourceSwitch: true };
  // What Claude Code confirmed on the session's latest start (keptBilling), as discovery reads it.
  adapter.addStored("one", [], o.stored ? { billing: o.stored } : {});
  const stored = o.stored;
  if (stored) adapter.storedBilling = async () => stored;
  const prefs = new Prefs(file, 0), costs = new CostLedger(costsFile);
  const core = new SessionCore({ adapters: [adapter], bus: new EventBus<CoreEvents>(), send: () => true, prefs, epoch: "costsw", log: () => {}, costs });
  const live = new LiveControl(core, new RequestBroker(), { credentials, idleMs: 60_000, costs });
  cleanups.push(() => core.stop());
  if (!o.dir) credentials.set("anthropic", `fake-costsw-${crypto.randomUUID()}`);
  // Each start confirms what it runs on; a turn on the key reports what this process spent.
  let spent = 0;
  adapter.script = () => {
    const d = adapter.drivers.at(-1)!;
    const keyed = d.opts.credential?.source === "anthropic";
    const steps: Step[] = [(s) => s.state({ billing: keyed ? KEY : PLAN })];
    if (keyed) steps.push((s) => s.cost?.({ id: `process-${adapter.drivers.length}`, usd: (spent += 0.25), estimated: true, complete: true }));
    steps.push((s) => {
      s.event({ type: "msg", msg: { id: `a-${Math.random()}`, role: "assistant", ts: 2, parts: [{ type: "text", text: "Done." }] } });
      s.state({ status: "idle" });
    });
    return steps;
  };
  return { dir, file, costsFile, adapter, core, live, prefs, costs, credentials };
}
const idle = async (t: ReturnType<typeof setup>, id = "claude:one") => {
  for (let i = 0; i < 200; i++) {
    const s = await t.core.open(id);
    if (s.state.status === "idle" && !s.sending && !s.pins) return s;
    await Bun.sleep(5);
  }
  throw new Error("never idle");
};

describe("a session whose source becomes a key", () => {
  test("from the chip after plan turns: whole from the switch, and the plan adds nothing", async () => {
    const t = setup({ stored: PLAN });
    await t.live.send("claude:one", "on the plan");
    const s = await idle(t);
    expect(s.state.billing).toEqual(PLAN);
    expect(t.costs.has(s.id)).toBe(false);
    await t.live.setSource(s.id, "anthropic");
    // Decided at the switch, while the plan is what's confirmed.
    expect(t.costs.get(s.id)).toEqual({ usd: 0, estimated: false, complete: true });
    expect(t.prefs.get(s.id).metered).toBe(true);
    await t.live.send(s.id, "on the key");
    await idle(t);
    expect(s.state.billing).toEqual(KEY);
    expect(s.state.cost).toEqual({ usd: 0.25, estimated: true, complete: true });
    expect(new CostLedger(t.costsFile).get(s.id)).toEqual({ usd: 0.25, estimated: true, complete: true });
  });

  test("a stored plan session, its source changed and confirmed at its next start, after a runner restart", async () => {
    const t = setup({ stored: PLAN });
    t.prefs.set("claude:one", { source: "anthropic" }); // set by an older runner, never begun
    t.prefs.flush();
    t.core.stop();
    const again = setup({ stored: PLAN, dir: t.dir });
    await again.live.send("claude:one", "on the key");
    const s = await idle(again);
    expect(s.state.cost).toEqual({ usd: 0.25, estimated: true, complete: true });
  });

  test("earlier source Unknown stays partial, with earlier-usage and a subtotal", async () => {
    const t = setup({ stored: UNKNOWN });
    await t.live.setSource("claude:one", "anthropic");
    await t.live.send("claude:one", "on the key");
    const s = await idle(t);
    expect(s.state.cost).toEqual({ usd: 0.25, estimated: true, complete: false, reasons: ["earlier-usage"] });
  });

  test("an earlier key period whose entry was lost stays partial, whatever came between", async () => {
    const t = setup({ stored: PLAN });
    t.prefs.set("claude:one", { metered: true }); // costs.json lost it
    await t.live.setSource("claude:one", "anthropic");
    await t.live.send("claude:one", "on the key");
    const s = await idle(t);
    expect(s.state.cost).toMatchObject({ usd: 0.25, complete: false, reasons: ["earlier-usage"] });
  });

  test("its last start on a key with no entry (before the ledger) stays partial", async () => {
    const t = setup({ stored: KEY });
    t.prefs.set("claude:one", { source: "anthropic" });
    await t.live.send("claude:one", "on the key");
    const s = await idle(t);
    expect(s.state.cost).toMatchObject({ usd: 0.25, complete: false, reasons: ["earlier-usage"] });
  });

  test("key, back to the plan, and the key again: what the ledger holds stays whole", async () => {
    const t = setup({ stored: PLAN });
    await t.live.setSource("claude:one", "anthropic");
    await t.live.send("claude:one", "key");
    await idle(t);
    await t.live.setSource("claude:one", "subscription");
    await t.live.send("claude:one", "plan");
    await idle(t);
    await t.live.setSource("claude:one", "anthropic");
    await t.live.send("claude:one", "key again");
    const s = await idle(t);
    expect(s.state.cost).toEqual({ usd: 0.75, estimated: true, complete: true }); // two processes: 0.25 and 0.5
  });

  test("a new session on a key is whole from its first request", async () => {
    const t = setup();
    const { sessionId } = await t.live.newSession({ harness: "claude", projectPath: t.dir, source: "anthropic" });
    await t.live.send(sessionId, "first");
    const s = await idle(t, sessionId);
    expect(s.state.cost).toEqual({ usd: 0.25, estimated: true, complete: true });
  });

  test("a cost report with no entry yet can't prove nothing came before", async () => {
    const t = setup({ stored: PLAN });
    await t.live.send("claude:one", "plan");
    const s = await idle(t);
    s.setState({ billing: KEY }); // confirmed elsewhere, never through the state sink
    t.adapter.drivers.at(-1)!.sink.cost?.({ id: "stray", usd: 0.1, estimated: true, complete: true });
    expect(s.state.cost).toEqual({ usd: 0.1, estimated: true, complete: false, reasons: ["earlier-usage"] });
  });
});

describe("the plan runs out with the box ticked (planOut)", () => {
  test("the switch starts whole, and the resent turn is all it costs", async () => {
    const t = setup({ stored: PLAN });
    t.prefs.set("claude:one", { autoKey: true, source: "subscription" });
    t.adapter.script = () => {
      const keyed = t.adapter.drivers.at(-1)!.opts.credential?.source === "anthropic";
      if (keyed) return [(s) => s.state({ billing: KEY }), (s) => s.cost?.({ id: "p", usd: 0.4, estimated: true, complete: true }), (s) => {
        s.event({ type: "msg", msg: { id: `a-${Math.random()}`, role: "assistant", ts: 2, parts: [{ type: "text", text: "Done." }] } });
        s.state({ status: "idle" });
      }];
      return [(s) => s.state({ billing: PLAN }), (s) => {
        s.event({ type: "msg", msg: { id: `e-${Math.random()}`, role: "assistant", ts: 2, parts: [], error: "You've hit your session limit" } });
        s.limitReached?.({});
        s.state({ status: "idle" });
      }];
    };
    await t.live.send("claude:one", "go");
    for (let i = 0; i < 400; i++) {
      const s = await t.core.open("claude:one");
      if (s.state.billing?.kind === "apiKey" && s.state.status === "idle" && !s.sending && !s.pins && s.state.cost?.usd) break;
      await Bun.sleep(5);
    }
    const s = await t.core.open("claude:one");
    expect(s.state.cost).toEqual({ usd: 0.4, estimated: true, complete: true });
  });
});

describe("a source change on a new thread (capabilities.sourceCarry)", () => {
  const carrying = (stored: typeof PLAN | typeof KEY | typeof UNKNOWN) => {
    const t = setup({ stored });
    t.adapter.capabilities = { ...t.adapter.capabilities, sourceCarry: true };
    let n = 0;
    // What the move module and the runner's adopt do: a stored thread, begun whole on a key.
    t.live.carrier = async (_from, source) => {
      const nativeId = `carried-${++n}`;
      t.adapter.addStored(nativeId, []);
      const id = `claude:${nativeId}`;
      t.prefs.set(id, { carrying: true, projectPath: t.dir, source });
      if (source !== "subscription") t.live.beginCost(id, true);
      await t.live.resumeLive(await t.core.open(id));
      return id;
    };
    return t;
  };
  test("from the plan: the new thread is whole, and the old one began nothing", async () => {
    const t = carrying(PLAN);
    await t.live.send("claude:one", "plan");
    await idle(t);
    await t.live.setSource("claude:one", "anthropic");
    expect(t.costs.has("claude:one")).toBe(false);
    await t.live.send("claude:one", "key");
    const n = await idle(t, "claude:carried-1");
    expect(n.state.cost).toEqual({ usd: 0.25, estimated: true, complete: true });
  });
  test("from a key thread whose entry was lost: the new thread can't be whole", async () => {
    const t = carrying(KEY);
    t.prefs.set("claude:one", { source: "anthropic", metered: true });
    await t.live.setSource("claude:one", "subscription");
    await t.live.send("claude:one", "plan");
    const n = await idle(t, "claude:carried-1");
    expect(t.costs.get(n.id)).toMatchObject({ complete: false, reasons: ["earlier-usage"] });
  });
  test("from a key thread with an entry: its total comes along, whole", async () => {
    const t = carrying(KEY);
    t.prefs.set("claude:one", { source: "anthropic" });
    t.costs.begin("claude:one", true);
    t.costs.report("claude:one", "old", { usd: 1, estimated: true, complete: true });
    await t.live.setSource("claude:one", "subscription");
    await t.live.send("claude:one", "plan");
    const n = await idle(t, "claude:carried-1");
    expect(t.costs.get(n.id)).toEqual({ usd: 1, estimated: true, complete: true });
  });
});
