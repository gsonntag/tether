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

  test("a harness that isn't persistent: the cut-off turn is continued by Tether (not rejoined)", async () => {
    const { adapter, core, live } = await stoppedMidTurn({ persistent: false });
    await live.rejoin();
    expect(adapter.drivers.length).toBe(1);
    expect(adapter.drivers[0]!.sent[0]).toContain("The Tether runner restarted while you were working.");
    const s = await core.open("claude:s1");
    expect(s.transcript!.messages.some((m) => m.role === "notice" && /restarted mid-turn; continuing/.test(JSON.stringify(m.parts)))).toBe(true);
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

  test("a setting the harness reports otherwise (not applied yet) stays, to be sent at the next start", async () => {
    const { adapter, live, prefs } = setup({ persistent: true });
    adapter.addStored("s1", []);
    await live.send("claude:s1", "hi");
    prefs.set("claude:s1", { permissionMode: "read-only" });
    adapter.drivers[0]!.sink.state({ permissionMode: "auto" });
    expect(prefs.get("claude:s1").permissionMode).toBe("read-only");
    adapter.drivers[0]!.sink.state({ permissionMode: "read-only" });
    expect(prefs.get("claude:s1").permissionMode).toBeUndefined();
  });

  test("a harness that doesn't keep them: a mode it reports (a plan approved) is kept for the next start", async () => {
    const { adapter, live, prefs } = setup({ persistent: false });
    adapter.addStored("s1", []);
    await live.send("claude:s1", "hi");
    adapter.drivers[0]!.sink.state({ permissionMode: "acceptEdits" });
    expect(prefs.get("claude:s1").permissionMode).toBe("acceptEdits");
  });
});

describe("a setting changed while live: shown only as the harness takes it, never looser at the next send", () => {
  async function live_(caps: Partial<HarnessCapabilities>) {
    const t = setup(caps);
    t.live.settingMs = 60;
    t.live.confirmMs = 80;
    t.adapter.addStored("s1", []);
    await t.core.subscribe("claude:s1");
    await t.live.send("claude:s1", "hi");
    await t.live.setPermissionMode("claude:s1", "auto");
    return { ...t, d: t.adapter.drivers[0]!, s: await t.core.open("claude:s1") };
  }

  test("rejected: every device goes back to what runs, the pref too, and the next send runs as shown", async () => {
    const { live, prefs, d, s, frames } = await live_({ persistent: true });
    d.setPermissionMode = async () => {
      throw new Error("Invalid request");
    };
    const before = frames.length;
    await expect(live.setPermissionMode("claude:s1", "read-only")).rejects.toThrow("didn't take that setting (Invalid request). It's unchanged.");
    expect(s.state.permissionMode).toBe("auto");
    expect(prefs.get("claude:s1").permissionMode).toBeUndefined();
    // Told to every watcher (a state event back to Auto went out after the Read only one).
    const states = frames.slice(before).filter((f: any) => f.t === "event" && f.event.type === "state" && f.event.state.permissionMode).map((f: any) => f.event.state.permissionMode);
    expect(states).toEqual(["read-only", "auto"]);
    await live.send("claude:s1", "next");
    expect(d.sent).toEqual(["hi", "next"]);
  });

  test("no answer in time: rolled back the same way", async () => {
    const { live, d, s } = await live_({ persistent: true });
    d.setPermissionMode = () => new Promise(() => {});
    await expect(live.setPermissionMode("claude:s1", "read-only")).rejects.toThrow("didn't answer");
    expect(s.state.permissionMode).toBe("auto");
  });

  test("taken but not confirmed: rolled back; confirmed late: kept", async () => {
    const { live, d, s, prefs } = await live_({ persistent: true });
    // Taken without a word back (the fake harness otherwise reports what it's given).
    d.onSetting = undefined;
    await expect(live.setPermissionMode("claude:s1", "read-only")).rejects.toThrow("didn't confirm");
    expect(s.state.permissionMode).toBe("auto");
    // Confirmed within the wait: applied.
    d.setPermissionMode = async (m) => void setTimeout(() => d.sink.state({ permissionMode: m }), 30);
    await live.setPermissionMode("claude:s1", "read-only");
    expect(s.state.permissionMode).toBe("read-only");
    expect(prefs.get("claude:s1").permissionMode).toBeUndefined();
  });

  test("a pending setting is applied and confirmed before the send; never confirmed: dropped, shown as confirmed, nothing sent", async () => {
    const { live, d, prefs, s } = await live_({ persistent: true });
    // Left pending (as when a change made while stored couldn't be confirmed yet).
    prefs.set("claude:s1", { permissionMode: "read-only" });
    s.setState({ permissionMode: "read-only" });
    const applied: string[] = [];
    d.onSetting = (_k, v) => void applied.push(v);
    await expect(live.send("claude:s1", "next")).rejects.toThrow("didn't confirm your new mode, so it's back to mode auto and nothing was sent");
    expect(d.sent).toEqual(["hi"]);
    expect(applied).toEqual(["read-only"]);
    // Dropped: shown as what the harness confirmed, and the next send goes out on that.
    expect(s.state.permissionMode).toBe("auto");
    expect(prefs.get("claude:s1").permissionMode).toBeUndefined();
    await live.send("claude:s1", "next");
    expect(d.sent).toEqual(["hi", "next"]);
    // Confirmed late after all: the true value shows, and it's said.
    d.sink.state({ permissionMode: "read-only" });
    expect(s.state.permissionMode).toBe("read-only");
    expect(s.transcript!.messages.some((m) => (m.parts[0] as any)?.text === "Claude Code applied your earlier change to the mode after all.")).toBe(true);
  });

  test("a pending setting confirmed within the wait: the send goes ahead", async () => {
    const { live, d, prefs } = await live_({ persistent: true });
    prefs.set("claude:s1", { permissionMode: "read-only" });
    d.onSetting = (k, v) => void setTimeout(() => d.sink.state({ [k]: v }), 30);
    await live.send("claude:s1", "next");
    expect(d.sent).toEqual(["hi", "next"]);
    expect(prefs.get("claude:s1").permissionMode).toBeUndefined();
  });

  test("rolled back after a timeout, then confirmed late: the true value shows and it's said", async () => {
    const { live, d, s } = await live_({ persistent: true });
    d.onSetting = undefined;
    await expect(live.setPermissionMode("claude:s1", "read-only")).rejects.toThrow("It's unchanged.");
    expect(s.state.permissionMode).toBe("auto");
    d.sink.state({ permissionMode: "read-only" });
    expect(s.state.permissionMode).toBe("read-only");
    expect(s.transcript!.messages.at(-1)!.parts[0]).toMatchObject({ text: "Claude Code applied your earlier change to the mode after all." });
  });

  test("changes made one after another are applied one at a time, in order", async () => {
    const { live, d } = await live_({ persistent: true });
    const order: string[] = [];
    d.onSetting = async (k, v) => {
      order.push(`start ${v}`);
      await Bun.sleep(v === "read-only" ? 30 : 1);
      order.push(`done ${v}`);
      d.sink.state({ [k]: v });
    };
    await Promise.all([live.setPermissionMode("claude:s1", "read-only"), live.setPermissionMode("claude:s1", "full-access")]);
    expect(order).toEqual(["start read-only", "done read-only", "start full-access", "done full-access"]);
  });

  test("a harness that doesn't confirm (Claude): a failed change is rolled back; a taken one stands", async () => {
    const { live, d, s } = await live_({ persistent: false });
    expect(s.state.permissionMode).toBe("auto");
    d.setPermissionMode = async () => {
      throw new Error("nope");
    };
    await expect(live.setPermissionMode("claude:s1", "plan")).rejects.toThrow("It's unchanged.");
    expect(s.state.permissionMode).toBe("auto");
  });
});

describe("a setting changed during a turn (capabilities.settingsApply)", () => {
  async function running(caps: Partial<HarnessCapabilities>) {
    const t = setup({ ...caps });
    t.adapter.addStored("s1", []);
    const h = held();
    t.adapter.script = () => [h.step, idle];
    await t.live.setPermissionMode("claude:s1", "full-access");
    const sending = t.live.send("claude:s1", "go");
    await Bun.sleep(5);
    const s = await t.core.open("claude:s1");
    return { ...t, s, h, sending };
  }

  test('"nextTurn": the running turn\'s own value shows beside the change until the turn ends', async () => {
    const { live, s, h, sending } = await running({ settingsApply: "nextTurn" });
    await live.setPermissionMode("claude:s1", "read-only");
    expect(s.state).toMatchObject({ permissionMode: "read-only", turnSettings: { permissionMode: "full-access" } });
    // Changed back to what the turn runs with: nothing differs.
    await live.setPermissionMode("claude:s1", "full-access");
    expect(s.state.turnSettings).toBeUndefined();
    await live.setPermissionMode("claude:s1", "read-only");
    expect(s.state.turnSettings).toEqual({ permissionMode: "full-access" });
    h.release();
    await sending;
    expect(s.state.turnSettings).toBeUndefined();
    expect(s.state.permissionMode).toBe("read-only");
  });

  test('"now" (default): a change applies to the running turn; nothing extra shows', async () => {
    const { live, s, h, sending } = await running({});
    await live.setPermissionMode("claude:s1", "read-only");
    expect(s.state.turnSettings).toBeUndefined();
    h.release();
    await sending;
  });

  test("while a handoff TUI drives, settings are refused (it takes none from Tether); shared is fine", async () => {
    const t = setup({ terminal: "handoff" });
    t.adapter.addStored("s1", []);
    const s = await t.core.open("claude:s1");
    s.setState({ mode: "terminal", terminal: { kind: "handoff" } });
    await expect(t.live.setPermissionMode("claude:s1", "plan")).rejects.toThrow("Claude Code's terminal is driving. Change it there.");
    expect(s.state.permissionMode).toBeUndefined();
    const u = setup({ terminal: "shared" });
    u.adapter.addStored("s1", []);
    await u.live.send("claude:s1", "hi");
    (await u.core.open("claude:s1")).setState({ terminal: { kind: "shared" } });
    await u.live.setPermissionMode("claude:s1", "plan");
    expect(u.adapter.drivers[0]!.settings.permissionMode).toBe("plan");
  });
});

describe("P4 review 5: never running looser than shown", () => {
  test("a send that joins a turn another client started is refused, and the session shows it running", async () => {
    const { adapter, core, live } = setup({ persistent: true, settingsApply: "nextTurn" });
    adapter.addStored("s1", []);
    const orig = adapter.resume.bind(adapter);
    adapter.resume = async (...a: Parameters<FakeAdapter["resume"]>) => {
      const d = (await orig(...a)) as import("./fakeAdapter").FakeDriver;
      d.runningElsewhere = true;
      d.sink.state({ status: "running", turnSettings: { permissionMode: "full-access", looser: true } });
      return d;
    };
    await expect(live.send("claude:s1", "write it")).rejects.toThrow("still working on a turn started elsewhere");
    const s = await core.open("claude:s1");
    expect(adapter.drivers[0]!.sent).toEqual([]);
    expect(s.state).toMatchObject({ mode: "live", status: "running", turnSettings: { permissionMode: "full-access", looser: true } });
  });

  test("the turn's note stays while its subagents still run on its settings, and goes when the last ends", async () => {
    const { adapter, core, live, prefs } = setup({ settingsApply: "nextTurn" });
    adapter.addStored("s1", []);
    adapter.script = () => [toolCall("m", "toolu_A", "Agent"), subagent("child-1", "toolu_A"), (sink) => sink.state({ turnSettings: { permissionMode: "full-access" } }), idle];
    await live.send("claude:s1", "go");
    const s = await core.open("claude:s1");
    const d = adapter.drivers[0]!;
    // The main turn ended while its subagent runs (the driver is busy): the note stays.
    d.isBusy = true;
    s.setState({ turnSettings: { permissionMode: "full-access" } });
    d.sink.state({ status: "running" });
    d.sink.state({ status: "idle" });
    expect(s.state.turnSettings).toEqual({ permissionMode: "full-access" });
    // Still marked running (a restart must find the subagent again).
    expect(prefs.get("claude:s1").running).toBe(true);
    d.isBusy = false;
    d.children.get("child-1")!.ended!();
    expect(s.state.turnSettings).toBeUndefined();
    expect(prefs.get("claude:s1").running).toBeUndefined();
  });

  test("a change made while a send is still starting the turn isn't noted against a turn that doesn't run yet", async () => {
    const { adapter, core, live } = setup({ settingsApply: "nextTurn" });
    adapter.addStored("s1", []);
    let open!: () => void;
    adapter.startGate = new Promise<void>((r) => (open = r));
    const sending = live.send("claude:s1", "go");
    await Bun.sleep(5);
    const setting = live.setPermissionMode("claude:s1", "plan");
    await Bun.sleep(5);
    const s = await core.open("claude:s1");
    expect(s.state.permissionMode).toBe("plan");
    expect(s.state.turnSettings).toBeUndefined();
    open();
    await sending;
    await setting;
  });

  test("while a handoff TUI is being started, settings are refused too", async () => {
    const { adapter, core, live } = setup({ terminal: "handoff" });
    adapter.addStored("s1", []);
    live.terminal = { blocked: () => "Handing over to the terminal…" } as any;
    const s = await core.open("claude:s1");
    await expect(live.setPermissionMode("claude:s1", "plan")).rejects.toThrow("terminal is driving");
    expect(s.state.permissionMode).toBeUndefined();
  });

  test("policy steps see the mode the running turn has, not the one for the next turn", async () => {
    const adapter = new FakeAdapter();
    adapter.capabilities = { ...FAKE_CAPS, persistent: true, settingsApply: "nextTurn" };
    const bus = new EventBus<CoreEvents>();
    const prefsFile = join(mkdtempSync(join(tmpdir(), "tether-caps-")), "runner.json");
    saveConfig({ runnerId: "test" }, prefsFile);
    const core = new SessionCore({ adapters: [adapter], bus, send: () => true, epoch: "e1", prefs: new Prefs(prefsFile, 0), evictMs: 50, log: () => {} });
    const seen: (string | undefined)[] = [];
    const live = new LiveControl(core, new RequestBroker([(_r, ctx) => (seen.push(ctx.permissionMode), { verdict: "allow", source: "rule" })]), {});
    cleanups.push(() => core.stop());
    adapter.addStored("s1", []);
    adapter.script = () => [(sink) => sink.state({ permissionMode: "read-only", turnSettings: { permissionMode: "full-access" } }), async (sink) => void (await sink.request({ kind: "approval", tool: "bash", input: {} })), idle];
    await live.send("claude:s1", "go");
    expect(seen).toEqual(["full-access"]);
  });
});

test("a runner stop while a subagent outlives its turn keeps the session marked running (to be rejoined)", async () => {
  const { adapter, live, prefs } = setup({ persistent: true, settingsApply: "nextTurn" });
  adapter.addStored("s1", []);
  adapter.script = () => [toolCall("m", "toolu_A", "Agent"), subagent("child-1", "toolu_A"), (_s, d) => void (d.isBusy = true), idle];
  await live.send("claude:s1", "go");
  expect(prefs.get("claude:s1").running).toBe(true);
  await live.closeAll();
  expect(prefs.get("claude:s1").running).toBe(true);
});
