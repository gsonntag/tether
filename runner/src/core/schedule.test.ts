// Scheduled sends (SPEC §9): the one timer, and scheduled messages in the queue, on a fake clock.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEDULE_LATE_MAX_MS } from "../../../shared/schedule";
import type { RunnerToServer } from "../../../shared/protocol";
import { saveConfig } from "../config";
import { RequestBroker } from "./broker";
import { EventBus } from "./bus";
import type { CoreEvents } from "./events";
import { FakeAdapter, FakeDriver, say } from "./fakeAdapter";
import { LiveControl } from "./live";
import { Prefs } from "./prefs";
import { SCHEDULE_TICK_MS, Scheduler } from "./scheduler";
import { SessionCore } from "./sessions";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((f) => f()));
const until = async (f: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(10);
  }
};
const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 10, 18, 12, 0);

function setup(o: { prefsFile?: string; dir?: string; clock?: { t: number } } = {}) {
  const clock = o.clock ?? { t: T0 };
  const adapter = new FakeAdapter();
  adapter.script = (text) => (text.startsWith("boom") ? [() => Promise.reject(new Error("The source needs a key."))] : [say(`a-${text}`, `echo ${text}`)]);
  const bus = new EventBus<CoreEvents>();
  const frames: RunnerToServer[] = [];
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), "tether-sched-"));
  const prefsFile = o.prefsFile ?? join(dir, "runner.json");
  if (!o.prefsFile) saveConfig({ runnerId: "test" }, prefsFile);
  const prefs = new Prefs(prefsFile, 0);
  const core = new SessionCore({ adapters: [adapter], bus, send: (m) => (frames.push(m), true), epoch: "e1", prefs, evictMs: 60_000, log: () => {}, now: () => clock.t });
  const live = new LiveControl(core, new RequestBroker(), { idleMs: 60_000, attachmentsDir: join(dir, "attachments") });
  cleanups.push(() => (live.queue.stop(), core.stop()));
  const driver = () => adapter.drivers.at(-1)!;
  const sent = () => adapter.drivers.flatMap((d) => d.sent);
  const end = (d: FakeDriver = driver()) => d.sink.state({ status: "idle" });
  /** the clock moves on and the timer fires */
  const advance = (ms: number) => {
    clock.t += ms;
    live.queue.scheduler.tick();
  };
  return { adapter, core, live, prefs, prefsFile, dir, clock, driver, sent, end, advance };
}

describe("the scheduler's one timer", () => {
  function fake(next: () => number | undefined, now = { t: 0 }) {
    const set: { ms: number; f: () => void }[] = [];
    let fired = 0;
    const timers = { set: ((f: () => void, ms: number) => (set.push({ f, ms }), set.length)) as unknown as typeof setTimeout, clear: (() => {}) as typeof clearTimeout };
    const s = new Scheduler({ now: () => now.t, next, fire: () => void fired++ }, timers);
    return { s, set, now, fired: () => fired };
  }

  test("never waits more than a minute (no timer for days); re-arms each time it fires", () => {
    let next: number | undefined = 3 * 24 * HOUR;
    const f = fake(() => next);
    f.s.arm();
    expect(f.set.map((x) => x.ms)).toEqual([SCHEDULE_TICK_MS]);
    f.now.t += SCHEDULE_TICK_MS;
    f.set.at(-1)!.f();
    expect(f.fired()).toBe(1);
    expect(f.set.map((x) => x.ms)).toEqual([SCHEDULE_TICK_MS, SCHEDULE_TICK_MS]);
    // Close to its time: set for exactly then.
    f.now.t = next! - 5000;
    f.set.at(-1)!.f();
    expect(f.set.at(-1)!.ms).toBe(5000);
    next = undefined;
    f.set.at(-1)!.f();
    expect(f.set).toHaveLength(3);
  });

  test("a sooner time re-arms; a later one keeps the timer; one due that can't go looks again in a minute", () => {
    let next: number | undefined = 30 * MIN;
    const f = fake(() => next);
    f.s.arm();
    next = 10_000;
    f.s.arm();
    expect(f.set.map((x) => x.ms)).toEqual([SCHEDULE_TICK_MS, 10_000]);
    next = 20_000;
    f.s.arm();
    expect(f.set).toHaveLength(2);
    // Due already (the turn still runs): no busy loop.
    f.now.t = 20_000;
    f.set.at(-1)!.f();
    expect(f.set.at(-1)!.ms).toBe(SCHEDULE_TICK_MS);
  });

  test("a clock that jumps ahead is caught at the next look", () => {
    const f = fake(() => 2 * HOUR);
    f.s.arm();
    f.now.t = 3 * HOUR; // the machine slept
    f.set.at(-1)!.f();
    expect(f.fired()).toBe(1);
  });

  test("halted, it never arms again", () => {
    const f = fake(() => 1000);
    f.s.halt();
    f.s.arm();
    expect(f.set).toHaveLength(0);
  });
});

describe("scheduled messages", () => {
  test("wait for their time, then go; Home shows the time without needing you", async () => {
    const { adapter, core, live, sent, advance } = setup();
    adapter.addStored("s1", []);
    await live.queue.add("claude:s1", "later", [], { at: T0 + HOUR });
    const s = await core.open("claude:s1");
    await Bun.sleep(80);
    expect(sent()).toEqual([]);
    expect(s.summary.scheduledAt).toBe(T0 + HOUR);
    expect(s.summary.queued).toBeUndefined();
    expect(s.summary.queuePaused).toBeUndefined();
    advance(HOUR - 1000);
    await Bun.sleep(80);
    expect(sent()).toEqual([]);
    advance(1000);
    await until(() => sent().length === 1);
    expect(sent()).toEqual(["later"]);
    expect(s.state.queue).toEqual([]);
    expect(s.summary.scheduledAt).toBeUndefined();
    // On time: no late notice.
    expect(s.transcript?.messages.some((m) => m.scheduledFor)).toBeFalsy();
  });

  test("refuse a time long past or more than a year ahead", async () => {
    const { adapter, live } = setup();
    adapter.addStored("s1", []);
    await expect(live.queue.add("claude:s1", "x", [], { at: T0 - 10 * MIN })).rejects.toThrow(/passed/);
    await expect(live.queue.add("claude:s1", "x", [], { at: T0 + 400 * 24 * HOUR })).rejects.toThrow(/within a year/);
    await expect(live.queue.add("claude:s1", "x", [], { at: Number.NaN })).rejects.toThrow(/Pick a time/);
  });

  test("don't hold the queue: an unscheduled message goes as usual", async () => {
    const { adapter, live, sent } = setup();
    adapter.addStored("s1", []);
    await live.queue.add("claude:s1", "tomorrow", [], { at: T0 + 20 * HOUR });
    await live.queue.add("claude:s1", "now", []);
    await until(() => sent().length === 1);
    expect(sent()).toEqual(["now"]);
  });

  test("due while a turn runs: goes next, ahead of the queue, marked late when it is", async () => {
    const { adapter, core, live, sent, end, advance } = setup();
    adapter.addStored("s1", []);
    await live.send("claude:s1", "first");
    await live.queue.add("claude:s1", "queued", []);
    await live.queue.add("claude:s1", "timed", [], { at: T0 + MIN });
    advance(10 * MIN);
    await Bun.sleep(80);
    expect(sent()).toEqual(["first"]);
    end();
    await until(() => sent().length === 2);
    expect(sent()).toEqual(["first", "timed"]);
    const s = await core.open("claude:s1");
    const late = s.transcript!.messages.find((m) => m.scheduledFor);
    expect(late?.scheduledFor).toBe(T0 + MIN);
    expect(late?.ts).toBe(T0 + 10 * MIN);
    end();
    await until(() => sent().length === 3);
    expect(sent().at(-1)).toBe("queued");
  });

  test("go whatever holds the rest, and release nothing", async () => {
    const { adapter, core, live, sent, end, advance } = setup();
    adapter.addStored("s1", []);
    await live.send("claude:s1", "first");
    await live.queue.add("claude:s1", "queued", []);
    await live.queue.add("claude:s1", "timed", [], { at: T0 + HOUR });
    await live.interrupt("claude:s1");
    const s = await core.open("claude:s1");
    expect(s.state.queueHeldBy).toBe("stopped");
    advance(HOUR);
    await until(() => sent().length === 2);
    expect(sent().at(-1)).toBe("timed");
    end();
    await Bun.sleep(100);
    expect(sent()).toHaveLength(2);
    expect(s.state.queueHeldBy).toBe("stopped");
    expect(s.state.queue.map((m) => m.text)).toEqual(["queued"]);
  });

  test("Stop with only scheduled messages waiting pauses nothing", async () => {
    const { adapter, core, live } = setup();
    adapter.addStored("s1", []);
    await live.send("claude:s1", "first");
    await live.queue.add("claude:s1", "timed", [], { at: T0 + HOUR });
    await live.interrupt("claude:s1");
    const s = await core.open("claude:s1");
    expect(s.state.queueHeld).toBeUndefined();
    expect(s.summary.queuePaused).toBeUndefined();
  });

  test("edit text and time, send now, cancel", async () => {
    const { adapter, core, live, sent, advance } = setup();
    adapter.addStored("s1", []);
    const a = await live.queue.add("claude:s1", "a", [], { at: T0 + HOUR });
    const b = await live.queue.add("claude:s1", "b", [], { at: T0 + HOUR });
    const c = await live.queue.add("claude:s1", "c", [], { at: T0 + 3 * HOUR });
    await live.queue.edit("claude:s1", a.id, "a2");
    await live.queue.schedule("claude:s1", a.id, T0 + 2 * HOUR);
    await live.queue.cancel("claude:s1", b.id);
    await expect(live.queue.move("claude:s1", c.id, 0)).rejects.toThrow(/its time/);
    await expect(live.queue.schedule("claude:s1", c.id, T0 - HOUR)).rejects.toThrow(/passed/);
    advance(HOUR);
    await Bun.sleep(80);
    expect(sent()).toEqual([]);
    advance(HOUR);
    await until(() => sent().length === 1);
    expect(sent()).toEqual(["a2"]);
    adapter.drivers.at(-1)!.sink.state({ status: "idle" });
    await live.queue.schedule("claude:s1", c.id, null);
    await until(() => sent().length === 2);
    expect(sent()).toEqual(["a2", "c"]);
    const s = await core.open("claude:s1");
    expect(s.state.queue).toEqual([]);
    expect(s.transcript!.messages.some((m) => m.scheduledFor)).toBe(false);
  });

  test("survive a restart; one due while the runner was off goes on start, marked late", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tether-sched-"));
    const clock = { t: T0 };
    const a = setup({ dir, clock });
    a.adapter.addStored("s1", []);
    await a.live.queue.add("claude:s1", "while off", [], { at: T0 + HOUR });
    await a.live.queue.add("claude:s1", "next week", [], { at: T0 + 7 * 24 * HOUR });
    a.prefs.flush();
    a.live.queue.stop();
    a.core.stop();
    clock.t = T0 + HOUR + 14 * MIN;
    const b = setup({ dir, prefsFile: a.prefsFile, clock });
    b.adapter.addStored("s1", []);
    await b.live.queue.restore();
    await until(() => b.sent().length === 1);
    expect(b.sent()).toEqual(["while off"]);
    const s = await b.core.open("claude:s1");
    expect(s.transcript!.messages.find((m) => m.scheduledFor)?.scheduledFor).toBe(T0 + HOUR);
    expect(s.state.queue.map((m) => m.text)).toEqual(["next week"]);
    expect(s.summary.scheduledAt).toBe(T0 + 7 * 24 * HOUR);
  });

  test("more than a day late: held for you (Home: needs you), Send now sends it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tether-sched-"));
    const clock = { t: T0 };
    const a = setup({ dir, clock });
    a.adapter.addStored("s1", []);
    const m = await a.live.queue.add("claude:s1", "stale", [], { at: T0 + HOUR });
    a.prefs.flush();
    a.live.queue.stop();
    a.core.stop();
    clock.t = T0 + HOUR + SCHEDULE_LATE_MAX_MS + MIN;
    const b = setup({ dir, prefsFile: a.prefsFile, clock });
    b.adapter.addStored("s1", []);
    await b.live.queue.restore();
    await Bun.sleep(100);
    expect(b.sent()).toEqual([]);
    const s = await b.core.open("claude:s1");
    expect(s.state.queue[0]?.held).toBe("late");
    expect(s.summary.queuePaused).toBe(true);
    expect(s.summary.scheduledAt).toBeUndefined();
    // In runner.json too: another restart still holds it.
    expect(b.prefs.get("claude:s1").queue?.[0]?.held).toBe("late");
    await b.live.queue.schedule("claude:s1", m.id, null);
    await until(() => b.sent().length === 1);
    expect(s.summary.queuePaused).toBeUndefined();
  });

  test("a send that fails keeps the message, waiting for you; the rest isn't held", async () => {
    const { adapter, core, live, sent, advance } = setup();
    adapter.addStored("s1", []);
    await live.queue.add("claude:s1", "boom", [], { at: T0 + MIN });
    advance(MIN);
    await until(() => sent().length === 1);
    const s = await core.open("claude:s1");
    await until(() => s.state.queue[0]?.held === "failed");
    expect(s.transcript!.messages.some((m) => m.role === "notice" && m.level === "error")).toBe(true);
    expect(s.state.queueHeld).toBeUndefined();
    expect(s.summary.queuePaused).toBe(true);
    // It isn't tried again by itself.
    advance(5 * MIN);
    await Bun.sleep(100);
    expect(sent()).toHaveLength(1);
    await live.queue.add("claude:s1", "other", []);
    await until(() => sent().length === 2);
    expect(sent().at(-1)).toBe("other");
  });

  test("due while the terminal drives: waits for Back to Tether", async () => {
    const { adapter, core, live, sent, advance } = setup();
    adapter.addStored("s1", []);
    await live.queue.add("claude:s1", "timed", [], { at: T0 + MIN });
    const s = await core.open("claude:s1");
    live.setMode(s, "terminal");
    advance(2 * MIN);
    await Bun.sleep(100);
    expect(sent()).toEqual([]);
    live.setMode(s, "live");
    await until(() => sent().length === 1);
  });
});
