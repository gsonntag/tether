import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../config";
import { EventBus } from "./bus";
import type { CoreEvents } from "./events";
import { FakeAdapter, idle, say, toolCall } from "./fakeAdapter";
import { LiveControl } from "./live";
import { Prefs } from "./prefs";
import { RequestBroker } from "./broker";
import { SessionCore } from "./sessions";
import type { Sink } from "./adapter";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function prefsFile() {
  const file = join(mkdtempSync(join(tmpdir(), "tether-retry-")), "runner.json");
  saveConfig({ runnerId: "test" }, file);
  return file;
}

function setup(o: { prefsPath?: string; adapter?: FakeAdapter } = {}) {
  const adapter = o.adapter ?? new FakeAdapter();
  const path = o.prefsPath ?? prefsFile();
  const prefs = new Prefs(path);
  const bus = new EventBus<CoreEvents>();
  const core = new SessionCore({ adapters: [adapter], bus, send: () => true, epoch: crypto.randomUUID(), prefs, evictMs: 20, log: () => {} });
  const broker = new RequestBroker([], { saved: prefs.requests(), closed: prefs.closedRequests(), persist: (l, c) => prefs.setRequests(l, c) });
  const live = new LiveControl(core, broker, { idleMs: 60_000 });
  cleanups.push(async () => {
    await live.closeAll().catch(() => {});
    core.stop();
  });
  return { adapter, bus, core, live, prefs, prefsPath: path };
}

async function until(cond: () => boolean, ms = 3_000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await Bun.sleep(2);
  }
}

const limit = (attempt: number, retryAt?: number) => async (sink: Sink) => {
  sink.rateLimited?.({ retryAt });
  sink.event({ type: "msg", msg: { id: `limited-${attempt}`, role: "assistant", ts: attempt, error: "Rate limited", parts: [{ type: "text", text: "Rate limited" }] } });
  sink.state({ status: "idle" });
};

function fastRetry(live: LiveControl, calls: { attempt: number; deadline: number; hint?: number }[] = []) {
  live.retries.gapMs = 1;
  live.retries.time = (attempt, now, deadline, hint) => {
    calls.push({ attempt, deadline, ...(hint !== undefined ? { hint } : {}) });
    return Math.max(now + 10, hint ?? 0);
  };
  return calls;
}

describe("automatic rate limit retry integration", () => {
  test("retries the same message through multiple limits and retains the attempt budget", async () => {
    const { adapter, core, live } = setup();
    adapter.addStored("multi", []);
    const calls = fastRetry(live);
    adapter.script = (_text) => {
      const n = adapter.drivers[0]?.sent.length ?? 0;
      return n <= 2 ? [limit(n)] : [say("answer", "recovered"), idle];
    };
    await live.send("claude:multi", "same prompt");
    const session = await core.open("claude:multi");
    await until(() => adapter.drivers[0]?.sent.length === 3 && !session.retry);
    expect(adapter.drivers[0]!.sent).toHaveLength(3);
    expect(adapter.drivers[0]!.sent.every((text) => text === "same prompt")).toBe(true);
    expect(calls.map((x) => x.attempt)).toEqual([1, 2]);
    expect(new Set(calls.map((x) => x.deadline)).size).toBe(1);
    expect(core.o.prefs.get(session.id).retry).toBeUndefined();
  });

  test("stops after five additional attempts and marks the final unread failure once", async () => {
    const { adapter, bus, core, live } = setup();
    adapter.addStored("exhaust", []);
    const turns: CoreEvents["turnEnded"][] = [];
    bus.on("turnEnded", (event) => turns.push(event));
    const calls = fastRetry(live);
    adapter.script = () => [limit(adapter.drivers[0]?.sent.length ?? 1)];
    await live.send("claude:exhaust", "retry me");
    const session = await core.open("claude:exhaust");
    await until(() => adapter.drivers[0]?.sent.length === 6 && !session.retry && core.o.prefs.get(session.id).unread !== undefined, 10_000);
    await Bun.sleep(20);
    expect(adapter.drivers[0]!.sent).toHaveLength(6);
    expect(calls.map((x) => x.attempt)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(turns.filter((event) => !event.recovering)).toHaveLength(1);
    expect(core.o.prefs.get(session.id)).toMatchObject({ unread: "failed", failure: "Rate limited" });
  }, 10_000);

  test("holds a queued message until the retry recovers, then drains it", async () => {
    const { adapter, core, live } = setup();
    adapter.addStored("queue", []);
    live.retries.gapMs = 1;
    live.retries.time = (_attempt, now) => now + 600;
    adapter.script = () => (adapter.drivers[0]?.sent.length === 1 ? [limit(1)] : [say("ok", "ok"), idle]);
    await live.send("claude:queue", "first");
    const s = await core.open("claude:queue");
    await until(() => !!s.retry);
    await live.queue.add(s.id, "queued after recovery", []);
    await Bun.sleep(2);
    expect(adapter.drivers[0]!.sent).toEqual(["first"]);
    await expect(live.queue.resume(s.id)).rejects.toThrow("rate limit retry is waiting");
    await until(() => adapter.drivers[0]!.sent.length === 3 && s.state.queue.length === 0);
    expect(adapter.drivers[0]!.sent).toEqual(["first", "first", "queued after recovery"]);
  });

  test("Retry now skips backoff but keeps a provider retry-after lower bound", async () => {
    const { adapter, core, live } = setup();
    adapter.addStored("retry-now", []);
    fastRetry(live);
    const providerAt = Date.now() + 150;
    adapter.script = () => (adapter.drivers[0]?.sent.length === 1 ? [limit(1, providerAt)] : [say("ok", "ok"), idle]);
    await live.send("claude:retry-now", "prompt");
    const s = await core.open("claude:retry-now");
    await until(() => !!s.retry);
    expect(s.retry!.minAt).toBeGreaterThanOrEqual(providerAt);
    await live.retryNow(s.id);
    await Bun.sleep(30);
    expect(adapter.drivers[0]!.sent).toHaveLength(1);
    await until(() => adapter.drivers[0]!.sent.length === 2 && !s.retry);
    expect(adapter.drivers[0]!.sent).toEqual(["prompt", "prompt"]);
  });

  test("a rejected send carrying rateLimit metadata joins the same successful retry chain", async () => {
    const { adapter, bus, core, live } = setup();
    adapter.addStored("rejected", []);
    fastRetry(live);
    const ends: CoreEvents["turnEnded"][] = [];
    bus.on("turnEnded", (event) => ends.push(event));
    adapter.script = () => (adapter.drivers[0]?.sent.length === 1
      ? [() => { throw Object.assign(new Error("Rate limited"), { rateLimit: { retryAt: Date.now() - 1 } }); }]
      : [say("ok", "recovered"), idle]);
    await live.send("claude:rejected", "prompt after error");
    const s = await core.open("claude:rejected");
    await until(() => adapter.drivers[0]!.sent.length === 2 && !s.retry);
    expect(adapter.drivers[0]!.sent).toEqual(["prompt after error", "prompt after error"]);
    expect(core.o.prefs.get(s.id)).toMatchObject({ unread: "finished" });
    expect(core.o.prefs.get(s.id).failure).toBeUndefined();
    expect(ends.filter((event) => !event.recovering && event.error)).toEqual([]);
  });

  test("Retry now bypasses a normal backoff", async () => {
    const { adapter, core, live } = setup();
    adapter.addStored("skip-backoff", []);
    live.retries.gapMs = 1;
    live.retries.time = (_attempt, now) => now + 5_000;
    adapter.script = () => (adapter.drivers[0]?.sent.length === 1 ? [limit(1)] : [say("ok", "ok"), idle]);
    await live.send("claude:skip-backoff", "prompt");
    const s = await core.open("claude:skip-backoff");
    await until(() => !!s.retry);
    await live.retryNow(s.id);
    await until(() => adapter.drivers[0]!.sent.length === 2 && !s.retry);
    expect(adapter.drivers[0]!.sent).toHaveLength(2);
  });

  test("spreads retries from different sessions sharing the same provider scope", async () => {
    const { adapter, core, live } = setup();
    adapter.addStored("scope-a", []);
    adapter.addStored("scope-b", []);
    live.retries.gapMs = 20;
    live.retries.time = (_attempt, now) => now + 10;
    const dispatches: { id: string; at: number }[] = [];
    adapter.script = (text) => [async (sink) => {
      dispatches.push({ id: text, at: Date.now() });
      if (dispatches.filter((d) => d.id === text).length === 1) {
        sink.rateLimited?.({});
        sink.state({ status: "idle" });
      } else {
        sink.event({ type: "msg", msg: { id: `done-${text}`, role: "assistant", ts: Date.now(), parts: [{ type: "text", text: "done" }] } });
        sink.state({ status: "idle" });
      }
    }];
    await Promise.all([live.send("claude:scope-a", "a"), live.send("claude:scope-b", "b")]);
    const a = await core.open("claude:scope-a");
    const b = await core.open("claude:scope-b");
    await until(() => dispatches.length === 4 && !a.retry && !b.retry);
    const retries = dispatches.slice(2);
    expect(retries).toHaveLength(2);
    expect(Math.abs(retries[0]!.at - retries[1]!.at)).toBeGreaterThanOrEqual(15);
  });

  test("cancelling while retry startup is pending prevents the retry dispatch", async () => {
    const { adapter, core, live } = setup();
    adapter.addStored("cancel-start", []);
    live.retries.gapMs = 1;
    live.retries.time = (_attempt, now) => now + 60_000;
    adapter.script = () => (adapter.drivers[0]?.sent.length === 1 ? [limit(1)] : [say("ok", "ok"), idle]);
    await live.send("claude:cancel-start", "original");
    const s = await core.open("claude:cancel-start");
    await until(() => !!s.retry);
    await s.driver!.close();
    s.driver = undefined;
    let releaseStart!: () => void;
    const gate = new Promise<void>((resolve) => (releaseStart = resolve));
    adapter.startGate = gate;
    await live.retryNow(s.id);
    await until(() => !!s.starting);
    // Let the retry timer enter ensureDriver/start, then cancel before it can hand off the prompt.
    await live.cancelRetry(s.id);
    releaseStart();
    await Bun.sleep(35);
    expect(adapter.drivers[0]!.sent).toHaveLength(1);
    expect(s.retry).toBeUndefined();
  });

  test("terminal takeover cancels a waiting retry", async () => {
    const { adapter, core, live } = setup();
    adapter.addStored("terminal", []);
    fastRetry(live);
    live.retries.time = (_attempt, now) => now + 60_000;
    adapter.script = () => [limit(1)];
    await live.send("claude:terminal", "original");
    const s = await core.open("claude:terminal");
    await until(() => !!s.retry);
    live.setMode(s, "terminal");
    expect(s.retry).toBeUndefined();
    await Bun.sleep(20);
    expect(adapter.drivers[0]!.sent).toHaveLength(1);
  });

  test("does not replay a restored retry when the persistent native turn is still running", async () => {
    const path = prefsFile();
    const first = setup({ prefsPath: path });
    first.adapter.capabilities = { ...first.adapter.capabilities, persistent: true };
    first.adapter.addStored("native-running", [], { status: "running" });
    first.live.retries.gapMs = 1;
    first.live.retries.time = (_attempt, now) => now + 60_000;
    first.adapter.script = () => [limit(1)];
    await first.live.send("claude:native-running", "uncertain turn");
    const original = await first.core.open("claude:native-running");
    await until(() => !!original.retry);
    await first.live.closeAll();
    first.core.stop();

    const adapter = new FakeAdapter();
    adapter.capabilities = { ...adapter.capabilities, persistent: true };
    adapter.addStored("native-running", [], { status: "running" });
    const resume = adapter.resume.bind(adapter);
    adapter.resume = async (nativeId, projectPath, opts, sink) => {
      const driver = await resume(nativeId, projectPath, opts, sink);
      driver.runningElsewhere = true;
      sink.state({ status: "running" });
      return driver;
    };
    const second = setup({ prefsPath: path, adapter });
    await second.live.restoreRetries();
    const restored = await second.core.open("claude:native-running");
    expect(restored.retry).toBeUndefined();
    expect(adapter.drivers).toHaveLength(1); // joined to observe the native process
    await Bun.sleep(30);
    expect(adapter.drivers[0]!.sent).toHaveLength(0);
    expect(second.prefs.get(restored.id).retry).toBeUndefined();
  });

  test("cancelling a waiting retry ends the turn as stopped; a Tether send replaces it without holding the queue", async () => {
    for (const how of ["cancel", "tether"] as const) {
      const { adapter, bus, core, live } = setup();
      adapter.addStored(how, []);
      live.retries.gapMs = 1;
      live.retries.time = (_attempt, now) => now + 60_000;
      adapter.script = () => (adapter.drivers[0]?.sent.length === 1 ? [limit(1)] : [say("ok", "ok"), idle]);
      const ends: CoreEvents["turnEnded"][] = [];
      bus.on("turnEnded", (e) => ends.push(e));
      await live.send(`claude:${how}`, "initial");
      const s = await core.open(`claude:${how}`);
      await until(() => !!s.retry);
      expect(ends).toEqual([expect.objectContaining({ recovering: true })]);
      if (how === "cancel") {
        await live.cancelRetry(s.id);
        expect(ends.at(-1)).toEqual({ sessionId: s.id, stopped: true });
      } else {
        await live.send(s.id, "on your behalf", [], { tether: true });
        await until(() => ends.length === 2);
        expect(ends.at(-1)?.recovering).toBeUndefined();
        expect(ends.at(-1)?.stopped).toBeUndefined();
        expect(s.state.queueHeld).toBeFalsy();
      }
      expect(s.retry).toBeUndefined();
    }
  });

  test("Stop, a direct send, and a model change cancel a waiting retry", async () => {
    for (const action of ["stop", "send", "model"] as const) {
      const { adapter, core, live } = setup();
      adapter.addStored(action, []);
      live.retries.gapMs = 1;
      live.retries.time = (attempt, now) => now + 60_000;
      adapter.script = () => (adapter.drivers[0]?.sent.length === 1 ? [limit(1)] : [say("ok", "ok"), idle]);
      await live.send(`claude:${action}`, "initial");
      const s = await core.open(`claude:${action}`);
      await until(() => !!s.retry);
      if (action === "stop") await live.interrupt(s.id);
      else if (action === "send") await live.send(s.id, "new direct send");
      else await live.setModel(s.id, "model-after-retry");
      expect(s.retry).toBeUndefined();
      await Bun.sleep(2);
      expect(s.retry).toBeUndefined();
    }
  });

  test("does not retry a turn that used a tool, was steered, or has background work", async () => {
    {
      const { adapter, core, live } = setup();
      adapter.addStored("tool", []);
      fastRetry(live);
      adapter.script = () => [toolCall("tool-msg", "tool-1"), limit(1)];
      await live.send("claude:tool", "run tool");
      const s = await core.open("claude:tool");
      expect(s.retry).toBeUndefined();
      expect(adapter.drivers[0]!.sent).toHaveLength(1);
    }
    {
      const { adapter, core, live } = setup();
      adapter.capabilities = { ...adapter.capabilities, canSteer: true };
      adapter.addStored("steer", []);
      fastRetry(live);
      let unblock!: () => void;
      const gate = new Promise<void>((resolve) => (unblock = resolve));
      adapter.script = () => [async (sink) => { await gate; sink.rateLimited?.({}); sink.state({ status: "idle" }); }];
      const sending = live.send("claude:steer", "initial");
      const s = await core.open("claude:steer");
      await until(() => !!adapter.drivers[0]?.sent.length);
      await live.steer(s.id, "steer this turn");
      unblock();
      await sending;
      await until(() => s.state.status === "idle");
      expect(s.retry).toBeUndefined();
      expect(adapter.drivers[0]!.steered).toEqual(["steer this turn"]);
    }
    {
      const { adapter, core, live } = setup();
      adapter.addStored("background", []);
      fastRetry(live);
      adapter.script = () => [async (sink, driver) => { driver.isBusy = true; sink.rateLimited?.({}); sink.state({ status: "idle" }); }];
      await live.send("claude:background", "start background");
      const s = await core.open("claude:background");
      expect(s.retry).toBeUndefined();
      expect(adapter.drivers[0]!.sent).toHaveLength(1);
    }
  });

  test("does not retry when the session is already running elsewhere", async () => {
    const { adapter, core, live } = setup();
    adapter.addStored("elsewhere", []);
    // A started driver can observe work from another native client before a prompt is handed off.
    adapter.script = () => [idle];
    const session = await core.open("claude:elsewhere");
    const driver = await core.load(session).then(() => live.send(session.id, "prompt").catch(() => undefined)).then(() => adapter.drivers[0]);
    expect(driver).toBeDefined();
    // The retry guard is also exercised at dispatch: a native turn already running is never replayed.
    driver!.runningElsewhere = true;
    await expect(live.send(session.id, "another prompt")).rejects.toThrow("still working on a turn started elsewhere");
    expect(session.retry).toBeUndefined();
    expect(driver!.sent).toHaveLength(1);
  });

  test("restores a waiting retry without duplicating the original send", async () => {
    const path = prefsFile();
    const first = setup({ prefsPath: path });
    first.adapter.addStored("restore", []);
    first.live.retries.gapMs = 1;
    first.live.retries.time = (_attempt, now) => now + 100;
    first.adapter.script = () => [limit(1)];
    await first.live.send("claude:restore", "persist me");
    const before = await first.core.open("claude:restore");
    await until(() => !!before.retry);
    await first.live.closeAll();
    first.core.stop();
    const secondAdapter = new FakeAdapter();
    secondAdapter.addStored("restore", []);
    secondAdapter.script = () => [say("restored", "done"), idle];
    const second = setup({ prefsPath: path, adapter: secondAdapter });
    await second.live.restoreRetries();
    const restored = await second.core.open("claude:restore");
    expect(restored.retry?.phase).toBe("waiting");
    expect(first.adapter.drivers[0]!.sent).toHaveLength(1);
    await until(() => secondAdapter.drivers[0]?.sent.length === 1 && !restored.retry);
    expect(first.adapter.drivers[0]!.sent).toHaveLength(1);
    expect(secondAdapter.drivers[0]!.sent).toEqual(["persist me"]);
  });

  test("history changed while the runner was down refuses retry and holds queued work", async () => {
    const path = prefsFile();
    const first = setup({ prefsPath: path });
    first.adapter.addStored("changed-history", []);
    first.live.retries.gapMs = 1;
    first.live.retries.time = (_attempt, now) => now + 60_000;
    first.adapter.script = () => [limit(1)];
    await first.live.send("claude:changed-history", "do not duplicate");
    const original = await first.core.open("claude:changed-history");
    await until(() => !!original.retry);
    await first.live.queue.add(original.id, "wait behind retry", []);
    await first.live.closeAll();
    first.core.stop();

    const adapter = new FakeAdapter();
    adapter.addStored("changed-history", [{ id: "external", role: "assistant", ts: Date.now(), parts: [{ type: "text", text: "another client changed this conversation" }] }]);
    const second = setup({ prefsPath: path, adapter });
    await second.live.restoreRetries();
    await second.live.queue.restore();
    const restored = await second.core.open("claude:changed-history");
    expect(restored.retry).toBeUndefined();
    expect(restored.state.queue).toHaveLength(1);
    expect(restored.state.queueHeldBy).toBe("failed");
    expect(second.prefs.get(restored.id).queueHeldBy).toBe("failed");
    expect(adapter.drivers).toHaveLength(0);
  });

  test("missing stored history revision refuses a nonpersistent retry and holds queued work", async () => {
    const path = prefsFile();
    const first = setup({ prefsPath: path });
    first.adapter.addStored("missing-revision", []);
    first.live.retries.gapMs = 1;
    first.live.retries.time = (_attempt, now) => now + 60_000;
    first.adapter.script = () => [limit(1)];
    await first.live.send("claude:missing-revision", "do not duplicate");
    const original = await first.core.open("claude:missing-revision");
    await until(() => !!original.retry);
    await first.live.queue.add(original.id, "wait behind retry", []);
    await first.live.closeAll();
    first.core.stop();

    const adapter = new FakeAdapter();
    adapter.addStored("missing-revision", []);
    adapter.storeRevision = () => undefined;
    const second = setup({ prefsPath: path, adapter });
    await second.live.restoreRetries();
    await second.live.queue.restore();
    const restored = await second.core.open("claude:missing-revision");
    expect(restored.retry).toBeUndefined();
    expect(restored.state.queue).toHaveLength(1);
    expect(restored.state.queueHeldBy).toBe("failed");
    expect(second.prefs.get(restored.id).queueHeldBy).toBe("failed");
    expect(adapter.drivers).toHaveLength(0);
  });

  test("never replays a retry persisted in the sending phase", async () => {
    const path = prefsFile();
    const first = setup({ prefsPath: path });
    first.adapter.addStored("uncertain", []);
    first.live.retries.gapMs = 1;
    first.live.retries.time = (_attempt, now) => now + 60_000;
    first.adapter.script = () => [limit(1)];
    await first.live.send("claude:uncertain", "may have gone out");
    const s = await first.core.open("claude:uncertain");
    await until(() => !!s.retry);
    first.prefs.set(s.id, { retry: { ...s.retry!, phase: "sending" } });
    first.prefs.flush();
    await first.live.closeAll();
    first.core.stop();

    const adapter = new FakeAdapter();
    adapter.addStored("uncertain", []);
    const second = setup({ prefsPath: path, adapter });
    await second.live.restoreRetries();
    await Bun.sleep(30);
    expect(adapter.drivers).toHaveLength(0);
    expect(second.prefs.get("claude:uncertain").retry).toBeUndefined();
  });
});
