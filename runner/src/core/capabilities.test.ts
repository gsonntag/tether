// The core's behaviour that follows a harness's capability flags (SPEC §2.5, §6, §6a): steering,
// subagent steering, harness-made session ids, a shared terminal and persistent sessions. Each
// test flips the flag on the fake harness and checks the core does what the flag says.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerToServer } from "../../../shared/protocol";
import type { HarnessCapabilities } from "../../../shared/transcript";
import { saveConfig } from "../config";
import { RequestBroker } from "./broker";
import { EventBus } from "./bus";
import type { CoreEvents } from "./events";
import { FAKE_CAPS, FakeAdapter, idle, say, subagent, toolCall, type Step } from "./fakeAdapter";
import { LiveControl } from "./live";
import { Prefs } from "./prefs";
import { SessionCore } from "./sessions";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((f) => f()));

function setup(caps: Partial<HarnessCapabilities> = {}, o: { idleMs?: number; prefsFile?: string } = {}) {
  const adapter = new FakeAdapter();
  adapter.capabilities = { ...FAKE_CAPS, ...caps };
  const bus = new EventBus<CoreEvents>();
  const frames: RunnerToServer[] = [];
  const prefsFile = o.prefsFile ?? join(mkdtempSync(join(tmpdir(), "tether-caps-")), "runner.json");
  if (!o.prefsFile) saveConfig({ runnerId: "test" }, prefsFile);
  const prefs = new Prefs(prefsFile, 0);
  const core = new SessionCore({ adapters: [adapter], bus, send: (m) => (frames.push(m), true), epoch: "e1", prefs, evictMs: 50, log: () => {} });
  const live = new LiveControl(core, new RequestBroker(), { idleMs: o.idleMs ?? 60_000 });
  live.reaskMs = 5;
  cleanups.push(() => core.stop());
  return { adapter, core, live, prefs, prefsFile, frames };
}

/** A turn that waits until released (so steering has something running to go into). */
function held(): { step: Step; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  return { step: async () => gate, release };
}

describe("steering (capabilities.canSteer)", () => {
  test("a harness that can steer takes a message into the running turn; not when idle", async () => {
    const { adapter, live } = setup({ canSteer: true });
    adapter.addStored("s1", []);
    const h = held();
    adapter.script = () => [say("a1", "working"), h.step, idle];
    const sending = live.send("claude:s1", "start");
    await Bun.sleep(5);
    await live.steer("claude:s1", "also this");
    expect(adapter.drivers[0]!.steered).toEqual(["also this"]);
    h.release();
    await sending;
    await expect(live.steer("claude:s1", "late")).rejects.toThrow("Nothing is running to steer");
  });

  test("a harness that can't steer refuses, and says why", async () => {
    const { adapter, live } = setup({ canSteer: false });
    adapter.addStored("s1", []);
    const h = held();
    adapter.script = () => [h.step, idle];
    const sending = live.send("claude:s1", "start");
    await Bun.sleep(5);
    await expect(live.steer("claude:s1", "x")).rejects.toThrow("can't take a message while it works");
    expect(adapter.drivers[0]!.steered).toEqual([]);
    h.release();
    await sending;
  });
});

describe("subagents (capabilities.subagents.steer)", () => {
  test('"direct": a running subagent takes your message itself (send or steer), not after it ends', async () => {
    const { adapter, core, live } = setup({ subagents: { view: true, stop: true, steer: "direct" } });
    adapter.addStored("s1", []);
    const h = held();
    adapter.script = () => [toolCall("m", "toolu_A", "Agent"), subagent("child-1", "toolu_A"), h.step, idle];
    const sending = live.send("claude:s1", "go");
    await Bun.sleep(5);
    await live.send("claude:child-1", "look in src too");
    await live.steer("claude:child-1", "and be quick");
    expect(adapter.drivers[0]!.steeredSubagents).toEqual([
      ["child-1", "look in src too"],
      ["child-1", "and be quick"],
    ]);
    // Stopped: it has finished, so a message goes to the main session instead.
    await live.interrupt("claude:child-1");
    expect((await core.open("claude:child-1")).childRunning).toBe(false);
    await expect(live.steer("claude:child-1", "more")).rejects.toThrow("This subagent has finished");
    h.release();
    await sending;
  });

  test("false: a subagent takes no messages", async () => {
    const { adapter, live } = setup({ subagents: { view: true, stop: true, steer: false } });
    adapter.addStored("s1", []);
    const h = held();
    adapter.script = () => [toolCall("m", "toolu_A", "Agent"), subagent("child-1", "toolu_A"), h.step, idle];
    const sending = live.send("claude:s1", "go");
    await Bun.sleep(5);
    await expect(live.send("claude:child-1", "hi")).rejects.toThrow("Subagents can't take messages");
    expect(adapter.drivers[0]!.steeredSubagents).toEqual([]);
    h.release();
    await sending;
  });
});

test("a harness that makes its own session ids: newSession waits for it, with the folder and settings", async () => {
  const { adapter, live, core } = setup();
  adapter.asyncIds = true;
  const dir = mkdtempSync(join(tmpdir(), "tether-caps-dir-"));
  const { sessionId } = await live.newSession({ harness: "claude", projectPath: dir, model: "m1", permissionMode: "auto" });
  expect(sessionId).toBe("claude:new-1");
  expect(adapter.newIds).toEqual([{ projectPath: dir, opts: { model: "m1", effort: undefined, permissionMode: "auto" } }]);
  expect((await core.open(sessionId)).state).toMatchObject({ mode: "live", model: "m1", permissionMode: "auto" });
});

test("a shared terminal keeps the session live: no idle close while the TUI is attached", async () => {
  const { adapter, core, live } = setup({ terminal: "shared" }, { idleMs: 20 });
  adapter.addStored("s1", []);
  await live.send("claude:s1", "hi");
  const s = await core.open("claude:s1");
  s.setState({ terminal: { kind: "shared" } });
  await Bun.sleep(80);
  expect(s.state.mode).toBe("live");
  expect(adapter.drivers[0]!.closed).toBe(false);
  // Detached: it closes when idle, as any live session does.
  s.setState({ terminal: undefined });
  await Bun.sleep(80);
  expect(s.state.mode).toBe("stored");
});

describe("persistent harnesses (capabilities.persistent)", () => {
  /** A runner that stopped mid-turn: the session's `running` mark is in runner.json. */
  async function stoppedMidTurn(caps: Partial<HarnessCapabilities>) {
    const first = setup(caps);
    first.adapter.addStored("s1", [{ id: "u1", role: "user", ts: 1, parts: [{ type: "text", text: "go" }] }]);
    const h = held();
    first.adapter.script = () => [h.step, idle];
    void first.live.send("claude:s1", "go");
    await Bun.sleep(5);
    expect(first.prefs.get("claude:s1").running).toBe(true);
    await first.live.closeAll();
    first.prefs.flush();
    // The next runner process, same runner.json.
    const next = setup(caps, { prefsFile: first.prefsFile });
    next.adapter.addStored("s1", [{ id: "u1", role: "user", ts: 1, parts: [{ type: "text", text: "go" }] }]);
    return next;
  }

  test("a turn running when the runner stopped goes on: the runner rejoins it, with no cut-off notice", async () => {
    const { adapter, core, live, prefs } = await stoppedMidTurn({ persistent: true });
    await live.rejoin();
    expect(adapter.drivers.length).toBe(1);
    const s = await core.open("claude:s1");
    expect(s.state.mode).toBe("live");
    expect(s.transcript!.messages.some((m) => m.role === "notice")).toBe(false);
    // It had finished meanwhile (the resumed driver says idle): nothing left to remember.
    expect(prefs.get("claude:s1").running).toBeUndefined();
  });

  test("a harness that isn't persistent: no rejoin, and the cut-off turn is reported", async () => {
    const { adapter, core, live } = await stoppedMidTurn({ persistent: false });
    await live.rejoin();
    expect(adapter.drivers.length).toBe(0);
    const s = await core.open("claude:s1");
    await core.load(s);
    expect(s.transcript!.messages.at(-1)).toMatchObject({ role: "notice", level: "warning" });
  });
});

describe("settings the harness keeps per session (capabilities.persistent)", () => {
  test("a stored session shows the session's own settings, and starting sends only what you set in Tether", async () => {
    const { adapter, core, live } = setup({ persistent: true });
    adapter.addStored("s1", []);
    adapter.sessionDefaults = { model: "luna", effort: "low", permissionMode: "read-only" };
    const s = await core.open("claude:s1");
    expect(s.state).toMatchObject({ model: "luna", effort: "low", permissionMode: "read-only" });
    expect(adapter.defaultsAsked.at(-1)).toEqual({ projectPath: "/p", nativeId: "s1" });
    await live.send("claude:s1", "hi");
    expect(adapter.drivers[0]!.opts).toEqual({});
  });

  test("a setting made in Tether is sent once; after the harness reports it, the harness's value rules", async () => {
    const { adapter, core, live, prefs } = setup({ persistent: true });
    adapter.addStored("s1", []);
    await live.setEffort("claude:s1", "medium");
    expect(prefs.get("claude:s1").effort).toBe("medium");
    await live.send("claude:s1", "hi");
    expect(adapter.drivers[0]!.opts).toEqual({ effort: "medium" });
    // The harness reports the session's settings (applied): Tether won't send them again.
    adapter.drivers[0]!.sink.state({ effort: "medium", model: "luna" });
    expect(prefs.get("claude:s1").effort).toBeUndefined();
    // Changed elsewhere (Codex's TUI): shown, and not undone at the next start.
    adapter.drivers[0]!.sink.state({ effort: "high" });
    expect((await core.open("claude:s1")).state.effort).toBe("high");
    expect(prefs.get("claude:s1").effort).toBeUndefined();
  });

  test("a harness that doesn't keep them: a mode it reports (a plan approved) is kept for the next start", async () => {
    const { adapter, live, prefs } = setup({ persistent: false });
    adapter.addStored("s1", []);
    await live.send("claude:s1", "hi");
    adapter.drivers[0]!.sink.state({ permissionMode: "acceptEdits" });
    expect(prefs.get("claude:s1").permissionMode).toBe("acceptEdits");
  });
});
