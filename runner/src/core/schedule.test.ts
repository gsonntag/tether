// Scheduled sends (SPEC §9): the one timer, and scheduled messages in the queue, on a fake clock.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEDULE_LATE_MAX_MS } from "../../../shared/schedule";
import { sourceSwitchBlocker } from "../../../shared/sourceSwitch";
import type { LiveState } from "../../../shared/transcript";
import { readFileSync } from "node:fs";
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

function setup(o: { prefsFile?: string; dir?: string; clock?: { t: number }; slow?: string } = {}) {
  const clock = o.clock ?? { t: T0 };
  const adapter = new FakeAdapter();
  // "boom…" fails to send; "hang…" runs until the test ends it.
  adapter.script = (text) => (text.startsWith("boom") ? [() => Promise.reject(new Error("The source needs a key."))] : text.startsWith("hang") ? [] : [say(`a-${text}`, `echo ${text}`)]);
  if (o.slow) {
    // One session opens slowly (a big store): others' queues get going meanwhile.
    const info = adapter.sessionInfo.bind(adapter);
    adapter.sessionInfo = async (n: string) => (n === o.slow ? (await Bun.sleep(200), info(n)) : info(n));
  }
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

describe("scheduled messages, review", () => {
  test("Stop holds the ones due behind the turn; ones coming due later still go", async () => {
    const { adapter, core, live, sent, end, advance } = setup();
    adapter.addStored("s1", []);
    await live.send("claude:s1", "hang on");
    await live.queue.add("claude:s1", "due", [], { at: T0 + MIN });
    await live.queue.add("claude:s1", "later", [], { at: T0 + HOUR });
    advance(2 * MIN);
    await Bun.sleep(80);
    await live.interrupt("claude:s1");
    await Bun.sleep(150);
    expect(sent()).toEqual(["hang on"]);
    const s = await core.open("claude:s1");
    expect(s.state.queue.find((m) => m.text === "due")?.held).toBe("stopped");
    expect(s.summary.queuePaused).toBe(true);
    advance(HOUR);
    await until(() => sent().length === 2);
    expect(sent().at(-1)).toBe("later");
    end();
  });

  test("a failed turn holds the ones due behind it", async () => {
    const { adapter, core, live, sent, advance } = setup();
    adapter.addStored("s1", []);
    await live.send("claude:s1", "hang on");
    await live.queue.add("claude:s1", "due", [], { at: T0 + MIN });
    advance(2 * MIN);
    const d = adapter.drivers.at(-1)!;
    d.sink.event({ type: "msg", msg: { id: "err", role: "assistant", ts: 1, parts: [], error: "overloaded" } });
    d.sink.state({ status: "idle" });
    await Bun.sleep(150);
    expect(sent()).toEqual(["hang on"]);
    expect((await core.open("claude:s1")).state.queue[0]?.held).toBe("failed");
  });

  test("on start, a message the runner was off for more than a day after is held even when another session opens slowly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tether-sched-"));
    const file = join(dir, "runner.json");
    // As a runner that stopped at T0 left it: the stale one restored first, a slow one after it (so
    // the first could go before the first tick).
    const q = (id: string, text: string, at: number) => ({ projectPath: dir, at: Date.now(), queue: [{ id, text, queuedAt: T0, at }] });
    saveConfig({ runnerId: "test", aliveAt: T0, sessions: { "claude:s1": q("a", "stale", T0 + HOUR), "claude:s2": q("b", "next week", T0 + 7 * 24 * HOUR) } }, file);
    const clock = { t: T0 + HOUR + SCHEDULE_LATE_MAX_MS + 3 * HOUR };
    const b = setup({ dir, prefsFile: file, clock, slow: "s2" });
    expect(b.prefs.queued()).toEqual(["claude:s1", "claude:s2"]);
    b.adapter.addStored("s1", []);
    b.adapter.addStored("s2", []);
    await b.live.queue.restore();
    await Bun.sleep(150);
    expect(b.sent()).toEqual([]);
    expect((await b.core.open("claude:s1")).state.queue[0]?.held).toBe("late");
  });

  test("due behind the terminal for more than a day while the runner ran: still goes (only time off counts)", async () => {
    const { adapter, core, live, sent, advance } = setup();
    adapter.addStored("s1", []);
    await live.queue.add("claude:s1", "timed", [], { at: T0 + MIN });
    const s = await core.open("claude:s1");
    live.setMode(s, "terminal");
    // The runner keeps looking (one tick a minute) all the while.
    for (let i = 0; i < 26 * 60; i++) advance(MIN);
    expect(s.state.queue[0]?.held).toBeUndefined();
    live.setMode(s, "live");
    await until(() => sent().length === 1);
  });

  test("a machine asleep for more than a day after its time: held on waking", async () => {
    const { adapter, core, live, sent, advance } = setup();
    adapter.addStored("s1", []);
    await live.queue.add("claude:s1", "timed", [], { at: T0 + MIN });
    advance(30_000);
    advance(SCHEDULE_LATE_MAX_MS + HOUR);
    await Bun.sleep(100);
    expect(sent()).toEqual([]);
    expect((await core.open("claude:s1")).state.queue[0]?.held).toBe("late");
  });

  test("Send now: no late notice behind a running turn, never held late", async () => {
    const { adapter, core, live, sent, end, advance } = setup();
    adapter.addStored("s1", []);
    await live.send("claude:s1", "hang on");
    const m = await live.queue.add("claude:s1", "plain", []);
    await live.queue.schedule("claude:s1", m.id, null);
    const s = await core.open("claude:s1");
    expect(s.state.queue[0]?.asap).toBe(true);
    advance(SCHEDULE_LATE_MAX_MS + HOUR); // asleep, even
    end();
    await until(() => sent().length === 2);
    expect(sent().at(-1)).toBe("plain");
    expect(s.transcript!.messages.some((x) => x.scheduledFor)).toBe(false);
  });

  test("edit text and time in one change: the new text goes", async () => {
    const { adapter, live, sent } = setup();
    adapter.addStored("s1", []);
    const m = await live.queue.add("claude:s1", "old text", [], { at: T0 + HOUR });
    await live.queue.edit("claude:s1", m.id, "new text", T0);
    await until(() => sent().length === 1);
    expect(sent()).toEqual(["new text"]);
    await expect(live.queue.edit("claude:s1", "nope", "x", T0)).rejects.toThrow(/isn't waiting/);
  });

  test("editing a held message's text keeps it held at its time", async () => {
    const { adapter, core, live, sent, advance } = setup();
    adapter.addStored("s1", []);
    await live.send("claude:s1", "hang on");
    const m = await live.queue.add("claude:s1", "due", [], { at: T0 + MIN });
    advance(2 * MIN);
    await live.interrupt("claude:s1");
    await live.queue.edit("claude:s1", m.id, "due, edited");
    await Bun.sleep(100);
    const q = (await core.open("claude:s1")).state.queue[0]!;
    expect(q).toMatchObject({ text: "due, edited", held: "stopped", at: T0 + MIN });
    expect(sent()).toEqual(["hang on"]);
  });

  test("runner.json keeps a session whose message is scheduled far ahead, however old its entry", () => {
    const dir = mkdtempSync(join(tmpdir(), "tether-sched-"));
    const f = join(dir, "runner.json");
    const old = Date.now() - 91 * 24 * HOUR;
    saveConfig({ runnerId: "t", sessions: { "claude:s1": { projectPath: "/x", at: old, queue: [{ id: "q", text: "far", queuedAt: old, at: Date.now() + 9 * 24 * HOUR }] }, "claude:s2": { projectPath: "/x", at: old } } }, f);
    const p = new Prefs(f, 0);
    p.set("claude:other", { title: "x" });
    p.flush();
    const saved = JSON.parse(readFileSync(f, "utf8")).sessions;
    expect(saved["claude:s1"]).toBeDefined();
    expect(saved["claude:s2"]).toBeUndefined();
  });

  test("a message scheduled for later doesn't block a source change; one due does", () => {
    const st = (queue: LiveState["queue"]) => ({ mode: "live", status: "idle", requests: [], queue }) as LiveState;
    expect(sourceSwitchBlocker(st([{ id: "q", text: "x", queuedAt: 0, at: Date.now() + HOUR }]))).toBeUndefined();
    expect(sourceSwitchBlocker(st([{ id: "q", text: "x", queuedAt: 0, at: Date.now() - 1000 }]))).toBe("queue");
    expect(sourceSwitchBlocker(st([{ id: "q", text: "x", queuedAt: 0, at: Date.now() - 1000, held: "late" }]))).toBeUndefined();
  });

  test("handed over to the session that takes this one's place, with the hold", async () => {
    const { adapter, core, live } = setup();
    adapter.addStored("s1", []);
    adapter.addStored("s2", []);
    await live.send("claude:s1", "hang on");
    await live.queue.add("claude:s1", "plain", []);
    await live.queue.add("claude:s1", "timed", [], { at: T0 + HOUR });
    await live.interrupt("claude:s1");
    await live.queue.handOver("claude:s1", "claude:s2");
    const [a, b] = [await core.open("claude:s1"), await core.open("claude:s2")];
    expect(a.state.queue).toEqual([]);
    expect(b.state.queue.map((m) => m.text)).toEqual(["plain", "timed"]);
    expect(b.state.queueHeldBy).toBe("stopped");
    expect(b.summary.scheduledAt).toBe(T0 + HOUR);
  });
});

