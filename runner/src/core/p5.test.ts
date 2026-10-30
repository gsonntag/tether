// P5 in the core: the message queue, steering (and via the main agent), attachments, read state.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ATTACH_CHUNK } from "../../../shared/limits";
import type { RunnerToServer } from "../../../shared/protocol";
import type { ToolPart } from "../../../shared/transcript";
import { saveConfig } from "../config";
import { AttachmentStore } from "./attachments";
import { RequestBroker } from "./broker";
import { EventBus } from "./bus";
import type { CoreEvents } from "./events";
import { FakeAdapter, FakeDriver, say, subagent, toolCall } from "./fakeAdapter";
import { AUTO_CONTINUE_TEXT, LiveControl } from "./live";
import { Prefs } from "./prefs";
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

function setup(o: { prefsFile?: string; dir?: string } = {}) {
  const adapter = new FakeAdapter();
  // Turns run until the test ends them.
  adapter.script = (text) => [say(`a-${text}`, `echo ${text}`)];
  const bus = new EventBus<CoreEvents>();
  const frames: RunnerToServer[] = [];
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), "tether-p5-"));
  const prefsFile = o.prefsFile ?? join(dir, "runner.json");
  if (!o.prefsFile) saveConfig({ runnerId: "test" }, prefsFile);
  const prefs = new Prefs(prefsFile, 0);
  const core = new SessionCore({ adapters: [adapter], bus, send: (m) => (frames.push(m), true), epoch: "e1", prefs, evictMs: 60_000, log: () => {} });
  const live = new LiveControl(core, new RequestBroker(), { idleMs: 60_000, attachmentsDir: join(dir, "attachments") });
  cleanups.push(() => core.stop());
  const driver = () => adapter.drivers.at(-1)!;
  const end = (d: FakeDriver = driver(), error?: string) => {
    if (error) d.sink.event({ type: "msg", msg: { id: `err-${Date.now()}`, role: "assistant", ts: 1, parts: [], error } });
    d.sink.state({ status: "idle" });
  };
  const summaries = () => frames.filter((f): f is Extract<RunnerToServer, { t: "summary" }> => f.t === "summary").map((f) => f.summary);
  return { adapter, bus, core, live, prefs, prefsFile, dir, driver, end, summaries };
}

describe("the queue", () => {
  test("waits for the running turn, then goes out one per turn, in order", async () => {
    const { adapter, live, core, driver, end } = setup();
    adapter.addStored("s1", []);
    await live.send("claude:s1", "first");
    const s = await core.open("claude:s1");
    await live.queue.add("claude:s1", "second", []);
    await live.queue.add("claude:s1", "third", []);
    expect(s.state.queue.map((m) => m.text)).toEqual(["second", "third"]);
    expect(s.summary.queued).toBe(2);
    await Bun.sleep(80);
    expect(driver().sent).toEqual(["first"]);
    end();
    await until(() => driver().sent.length === 2);
    expect(driver().sent).toEqual(["first", "second"]);
    expect(s.state.queue.map((m) => m.text)).toEqual(["third"]);
    end();
    await until(() => driver().sent.length === 3);
    expect(s.state.queue).toEqual([]);
    expect(s.summary.queued).toBeUndefined();
  });

  test("queued on an idle session goes out now", async () => {
    const { adapter, live, driver } = setup();
    adapter.addStored("s1", []);
    await live.queue.add("claude:s1", "hello", []);
    await until(() => adapter.drivers.length > 0 && driver().sent.length === 1);
  });

  test("edit, move and cancel; any change is in runner.json at once", async () => {
    const { adapter, live, core, prefs } = setup();
    adapter.addStored("s1", []);
    await live.send("claude:s1", "busy");
    const a = await live.queue.add("claude:s1", "a", []);
    const b = await live.queue.add("claude:s1", "b", []);
    const c = await live.queue.add("claude:s1", "c", []);
    await live.queue.edit("claude:s1", a.id, "a2");
    await live.queue.move("claude:s1", c.id, 0);
    await live.queue.cancel("claude:s1", b.id);
    const s = await core.open("claude:s1");
    expect(s.state.queue.map((m) => m.text)).toEqual(["c", "a2"]);
    prefs.flush();
    expect(prefs.get("claude:s1").queue!.map((m) => m.text)).toEqual(["c", "a2"]);
    await expect(live.queue.edit("claude:s1", b.id, "x")).rejects.toThrow("isn't waiting");
    // Emptied by an edit: it's cancelled.
    await live.queue.edit("claude:s1", a.id, "  ");
    expect(s.state.queue.map((m) => m.text)).toEqual(["c"]);
  });

  test("Stop holds it until you send; a send of yours releases it after that turn", async () => {
    const { adapter, live, core, driver, end } = setup();
    adapter.addStored("s1", []);
    await live.send("claude:s1", "one");
    await live.queue.add("claude:s1", "later", []);
    const s = await core.open("claude:s1");
    await live.interrupt("claude:s1");
    expect(s.state).toMatchObject({ queueHeld: true, queueHeldBy: "stopped" });
    await Bun.sleep(100);
    expect(driver().sent).toEqual(["one"]);
    await live.send("claude:s1", "now this");
    expect(s.state.queueHeld).toBeUndefined();
    end();
    await until(() => driver().sent.length === 3);
    expect(driver().sent).toEqual(["one", "now this", "later"]);
  });

  test("Stop and send now: stops, sends, and the queue goes on after", async () => {
    const { adapter, live, driver, end } = setup();
    adapter.addStored("s1", []);
    await live.send("claude:s1", "one");
    await live.queue.add("claude:s1", "queued", []);
    await live.send("claude:s1", "urgent", [], { stop: true });
    expect(driver().interrupted).toBe(1);
    expect(driver().sent).toEqual(["one", "urgent"]);
    end();
    await until(() => driver().sent.length === 3);
  });

  test("Resume releases a held queue", async () => {
    const { adapter, live, core, driver } = setup();
    adapter.addStored("s1", []);
    await live.send("claude:s1", "one");
    await live.queue.add("claude:s1", "two", []);
    await live.interrupt("claude:s1");
    const s = await core.open("claude:s1");
    expect(s.state.queueHeld).toBe(true);
    await live.queue.resume("claude:s1");
    await until(() => driver().sent.length === 2);
  });

  test("a failed turn holds it", async () => {
    const { adapter, live, core, driver, end } = setup();
    adapter.addStored("s1", []);
    await live.send("claude:s1", "one");
    await live.queue.add("claude:s1", "two", []);
    end(driver(), "API error");
    const s = await core.open("claude:s1");
    await until(() => s.state.queueHeldBy === "failed");
    await Bun.sleep(80);
    expect(driver().sent).toEqual(["one"]);
  });

  test("a handoff holds it; Back to Tether (terminal -> live) releases it", async () => {
    const { adapter, live, core, bus, driver, end } = setup();
    adapter.addStored("s1", []);
    await live.send("claude:s1", "one");
    end();
    const s = await core.open("claude:s1");
    // As terminal/control.ts does on a handoff.
    await live.release(s);
    live.setMode(s, "terminal", { terminal: { kind: "handoff" } });
    await live.queue.add("claude:s1", "after the terminal", []);
    expect(s.state).toMatchObject({ queueHeld: true, queueHeldBy: "terminal" });
    await Bun.sleep(80);
    expect(adapter.drivers).toHaveLength(1);
    s.setState({ terminal: undefined });
    await live.resumeLive(s);
    await until(() => adapter.drivers.length === 2 && driver().sent.length === 1);
    expect(driver().sent).toEqual(["after the terminal"]);
    expect(s.state.queueHeld).toBeUndefined();
    void bus;
  });

  test("survives a restart; one whose turn a restart cut off waits held", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tether-p5-"));
    const a = setup({ dir });
    a.adapter.addStored("s1", []);
    await a.live.send("claude:s1", "one");
    await a.live.queue.add("claude:s1", "two", [], );
    a.prefs.flush();
    a.core.stop();
    // A new runner process on the same runner.json.
    const b = setup({ dir, prefsFile: a.prefsFile });
    b.adapter.addStored("s1", []);
    await b.live.queue.restore();
    const s = await b.core.open("claude:s1");
    expect(s.state.queue.map((m) => m.text)).toEqual(["two"]);
    expect(s.state.queueHeldBy).toBe("restart");
    await Bun.sleep(80);
    expect(b.adapter.drivers).toHaveLength(0);
    await b.live.queue.resume("claude:s1");
    await until(() => b.adapter.drivers.length === 1 && b.driver().sent.length === 1);
  });

  test("a harness that dies mid-turn ends the turn as failed: the queue holds, Home says failed", async () => {
    const { adapter, live, core, driver } = setup();
    adapter.addStored("s1", []);
    await live.send("claude:s1", "one");
    await live.queue.add("claude:s1", "two", []);
    const ended: any[] = [];
    core.o.bus.on("turnEnded", (e) => ended.push(e));
    driver().onExit?.("Claude Code stopped: killed");
    const s = await core.open("claude:s1");
    expect(ended).toEqual([{ sessionId: "claude:s1", error: "Claude Code stopped: killed" }]);
    await until(() => s.state.queueHeldBy === "failed");
    expect(core.book.get("claude:s1")?.unread).toBe("failed");
  });

  test("a turn cut off by a restart holds the queue even when something loads the session first", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tether-p5-"));
    const a = setup({ dir });
    a.adapter.addStored("s1", []);
    await a.live.send("claude:s1", "one");
    await a.live.queue.add("claude:s1", "two", []);
    a.prefs.flush();
    a.core.stop();
    const b = setup({ dir, prefsFile: a.prefsFile });
    b.adapter.addStored("s1", []);
    // A browser subscribes before the queue is restored (load clears `running`).
    await b.core.subscribe("claude:s1");
    await b.live.queue.restore();
    expect((await b.core.open("claude:s1")).state.queueHeldBy).toBe("restart");
  });

  test("a paused queue stays paused through a terminal round trip", async () => {
    const { adapter, live, core } = setup();
    adapter.addStored("s1", []);
    await live.send("claude:s1", "one");
    await live.queue.add("claude:s1", "two", []);
    await live.interrupt("claude:s1");
    const s = await core.open("claude:s1");
    live.queue.hold(s, "terminal");
    expect(s.state.queueHeldBy).toBe("stopped");
  });

  test("its text is capped as a whole, and a big queue still opens (cut on the wire)", async () => {
    const { adapter, live, core } = setup();
    adapter.addStored("s1", []);
    await live.send("claude:s1", "busy");
    const big = "語".repeat(150_000); // 450 KB of UTF-8
    await live.queue.add("claude:s1", big, []);
    await live.queue.add("claude:s1", big, []);
    await expect(live.queue.add("claude:s1", big, [])).rejects.toThrow("at most 1.0 MB of text together");
    const s = await core.open("claude:s1");
    const small = await live.queue.add("claude:s1", "x", []);
    await expect(live.queue.edit("claude:s1", small.id, "語".repeat(50_000))).rejects.toThrow("at most");
    // A queue saved before the cap (or right at it) still travels: each text cut, marked.
    const snap = await core.subscribe("claude:s1");
    expect(snap.state.queue[0]!.truncated).toBe(450_000);
    expect(JSON.stringify(snap).length).toBeLessThan(200_000);
    const { capEvent } = await import("../../../shared/limits");
    const ev = capEvent({ type: "state", state: { queue: s.state.queue } });
    expect(ev.type === "state" && ev.state.queue![1]!.truncated).toBe(450_000);
  });

  test("a message going out leaves runner.json only once the harness has it", async () => {
    const { adapter, live, core, prefs, driver, end } = setup();
    adapter.addStored("s1", []);
    await live.send("claude:s1", "one");
    await live.queue.add("claude:s1", "two", []);
    // Written at once, not after a debounce.
    expect(JSON.parse(readFileSync(prefs["file"] as string, "utf8")).sessions["claude:s1"].queue.map((m: any) => m.text)).toEqual(["two"]);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const d = driver();
    const orig = d.send.bind(d);
    d.send = async (t: string) => {
      await gate;
      return orig(t);
    };
    end();
    const s = await core.open("claude:s1");
    await until(() => s.state.queue.length === 0);
    // Not yet accepted: still saved.
    expect(JSON.parse(readFileSync(prefs["file"] as string, "utf8")).sessions["claude:s1"].queue.map((m: any) => m.text)).toEqual(["two"]);
    release();
    await until(() => d.sent.length === 2);
    await until(() => !JSON.parse(readFileSync(prefs["file"] as string, "utf8")).sessions["claude:s1"].queue);
  });

  test("Stop while a queued message's harness starts: it goes back, held, never lost", async () => {
    const { adapter, live, core } = setup();
    adapter.addStored("s1", []);
    await live.queue.add("claude:s1", "first", []);
    const s = await core.open("claude:s1");
    await live.queue.hold(s, "restart");
    let release!: () => void;
    adapter.startGate = new Promise((r) => (release = r));
    await live.queue.resume("claude:s1");
    await until(() => !!s.sending);
    await live.interrupt("claude:s1");
    release();
    await until(() => s.state.queue.length === 1);
    expect(s.state.queue[0]!.text).toBe("first");
    expect(s.state.queueHeldBy).toBe("stopped");
    expect(adapter.drivers[0]?.sent ?? []).toEqual([]);
  });

  test("Stop and send now while a queued message's harness starts: the queue follows NOW", async () => {
    const { adapter, live, core, driver, end } = setup();
    adapter.addStored("s1", []);
    await live.queue.add("claude:s1", "first", []);
    const s = await core.open("claude:s1");
    await live.queue.hold(s, "restart");
    let release!: () => void;
    adapter.startGate = new Promise((r) => (release = r));
    await live.queue.resume("claude:s1");
    await until(() => !!s.sending);
    const now = live.send("claude:s1", "NOW", [], { stop: true });
    await Bun.sleep(20);
    release();
    await now;
    await until(() => s.state.queue.length === 1);
    expect(s.state.queueHeld).toBeUndefined();
    expect(driver().sent).toEqual(["NOW"]);
    end();
    await until(() => driver().sent.length === 2);
    expect(driver().sent).toEqual(["NOW", "first"]);
  });

  test("a cancel from another device while a message goes out: dropped if it doesn't get there", async () => {
    const { adapter, live, core, prefs } = setup();
    adapter.addStored("s1", []);
    const q = await live.queue.add("claude:s1", "first", []);
    const s = await core.open("claude:s1");
    await live.queue.hold(s, "restart");
    let release!: () => void;
    adapter.startGate = new Promise((r) => (release = r));
    await live.queue.resume("claude:s1");
    await until(() => !!s.sending);
    await live.queue.cancel("claude:s1", q.id);
    // Out of runner.json at once.
    expect(JSON.parse(readFileSync(prefs["file"] as string, "utf8")).sessions["claude:s1"].queue).toBeUndefined();
    await live.interrupt("claude:s1");
    release();
    await Bun.sleep(100);
    // Stopped before it got there: not put back.
    expect(s.state.queue).toEqual([]);
  });

  test("every device hears how a message left the queue: sent, or cancelled (an edit that missed it says which)", async () => {
    const { adapter, live, core, end } = setup();
    adapter.addStored("s1", []);
    await live.send("claude:s1", "busy");
    const a = await live.queue.add("claude:s1", "a", []);
    const b = await live.queue.add("claude:s1", "b", []);
    await live.queue.cancel("claude:s1", b.id);
    end();
    const s = await core.open("claude:s1");
    await until(() => (s.state.queueGone ?? []).length === 2);
    expect(s.state.queueGone).toEqual([
      { id: b.id, how: "cancelled" },
      { id: a.id, how: "sent" },
    ]);
  });

  test("the message going out counts against the limits", async () => {
    const { adapter, live, core, driver, end } = setup();
    adapter.addStored("s1", []);
    await live.send("claude:s1", "busy");
    for (let i = 0; i < 50; i++) await live.queue.add("claude:s1", `m${i}`, []);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const d = driver();
    const orig = d.send.bind(d);
    d.send = async (t: string) => {
      await gate;
      return orig(t);
    };
    end();
    const s = await core.open("claude:s1");
    await until(() => s.state.queue.length === 49);
    await expect(live.queue.add("claude:s1", "one more", [])).rejects.toThrow("At most 50");
    release();
  });

  test("control characters never wait, and a queue measured as it travels always opens", async () => {
    const { adapter, live, core } = setup();
    adapter.addStored("s1", []);
    await live.send("claude:s1", "busy");
    const ctl = "\x01".repeat(20_900);
    // Stripped: nothing left of these.
    await expect(live.queue.add("claude:s1", ctl, [])).rejects.toThrow("Type a message first");
    await live.queue.add("claude:s1", `a${ctl}b\tc\n`, []);
    const s = await core.open("claude:s1");
    expect(s.state.queue[0]!.text).toBe("ab\tc\n");
    // A queue saved before these rules (50 x 20,900 controls) still travels small.
    const { capQueue, FRAME_BYTES_MAX } = await import("../../../shared/limits");
    const old = Array.from({ length: 50 }, (_, i) => ({ id: `q${i}`, text: ctl, queuedAt: 1 }));
    expect(JSON.stringify(capQueue(old)).length).toBeLessThan(FRAME_BYTES_MAX / 4);
    // Escapes count against the cap: 1 MB of quotes is 2 MB in a frame.
    await expect(live.queue.add("claude:s1", '"'.repeat(150_000), [])).resolves.toBeDefined();
    await expect(live.queue.add("claude:s1", '"'.repeat(150_000), [])).resolves.toBeDefined();
    await expect(live.queue.add("claude:s1", '"'.repeat(150_000), [])).resolves.toBeDefined();
    await expect(live.queue.add("claude:s1", '"'.repeat(150_000), [])).rejects.toThrow("at most");
  });

  test("another device changing the queue while a message goes out keeps it saved until the harness has it", async () => {
    const { adapter, live, core, prefs, driver, end } = setup();
    adapter.addStored("s1", []);
    await live.send("claude:s1", "one");
    await live.queue.add("claude:s1", "two", []);
    const other = await live.queue.add("claude:s1", "three", []);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const d = driver();
    const orig = d.send.bind(d);
    d.send = async (t: string) => {
      await gate;
      return orig(t);
    };
    end();
    const s = await core.open("claude:s1");
    await until(() => s.state.queue.length === 1);
    await live.queue.cancel("claude:s1", other.id);
    const saved = () => JSON.parse(readFileSync(prefs["file"] as string, "utf8")).sessions["claude:s1"].queue?.map((m: any) => m.text);
    expect(saved()).toEqual(["two"]);
    release();
    await until(() => d.sent.length === 2);
    await until(() => !saved());
  });

  test("a restart during a new session's first start keeps its queue, held, until the session is known", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tether-p5-"));
    const a = setup({ dir });
    a.prefs.set("claude:brand-new", { projectPath: "/p", queue: [{ id: "q1", text: "first words", queuedAt: 1 }] });
    a.prefs.flush();
    a.core.stop();
    const b = setup({ dir, prefsFile: a.prefsFile });
    await b.live.queue.restore();
    b.prefs.flush();
    const p = b.prefs.get("claude:brand-new");
    expect(p.queue?.map((m) => m.text)).toEqual(["first words"]);
    expect(p.queueHeldBy).toBe("restart");
  });

  test("subagents have none", async () => {
    const { adapter, live } = setup();
    adapter.addStored("kid", [], { parentSessionId: "claude:s1" });
    await expect(live.queue.add("claude:kid", "x", [])).rejects.toThrow("subagent");
  });
});

describe("steering", () => {
  test("into the running turn, when the harness can", async () => {
    const { adapter, live, driver } = setup();
    adapter.capabilities = { ...adapter.capabilities, canSteer: true };
    adapter.addStored("s1", []);
    await expect(live.steer("claude:s1", "too early")).rejects.toThrow("Nothing is running");
    await live.send("claude:s1", "go");
    await live.steer("claude:s1", "and also this");
    expect(driver().steered).toEqual(["and also this"]);
  });

  test("a subagent via its main agent: shown as yours, delivered once the main agent's call is seen", async () => {
    const { adapter, live, core, driver, end } = setup();
    adapter.capabilities = { ...adapter.capabilities, canSteer: true, subagents: { view: true, stop: true, steer: "via-parent" } };
    adapter.addStored("s1", []);
    adapter.script = (text) => (text === "go" ? [toolCall("a1", "t1", "Agent", {}), subagent("s1/agentA", "t1")] : []);
    await live.send("claude:s1", "go");
    const d = driver();
    (d as any).relayMessage = (id: string, text: string) => `pass to ${id}: ${text}`;
    (d as any).relayedBy = (id: string, tool: ToolPart) => tool.name === "SendMessage" && (tool.input as any).to === id.split("/")[1];
    await live.steer("claude:s1/agentA", "use tabs");
    expect(d.steered).toEqual(["[From Tether] pass to s1/agentA: use tabs"]);
    const kid = await core.open("claude:s1/agentA");
    const shown = () => kid.transcript!.messages.find((m) => m.id.startsWith("n-relay-"));
    expect(shown()).toMatchObject({ role: "user", relay: "sending", parts: [{ type: "text", text: "use tabs" }] });
    toolCall("a2", "t2", "SendMessage", { to: "agentA", message: "use tabs" })(d.sink, d);
    expect(shown()!.relay).toBe("delivered");
    // A second one the main agent never passes on.
    await live.steer("claude:s1/agentA", "and spaces");
    end(d);
    const second = () => kid.transcript!.messages.filter((m) => m.id.startsWith("n-relay-"))[1];
    expect(second()!.relay).toBe("sending");
    await until(() => second()!.relay === "failed", 4000);
  });
});

describe("attachments", () => {
  test("upload in chunks, read-only, named safely; a message may name only its session's files", async () => {
    const { adapter, live } = setup();
    adapter.addStored("s1", []);
    adapter.addStored("s2", []);
    const bytes = Buffer.alloc(ATTACH_CHUNK + 1000, 7);
    const chunk = (offset: number) => ({ sessionId: "claude:s1", uploadId: "upload0001", name: "../my photo", mimeType: "image/png", size: bytes.length, offset, data: bytes.subarray(offset, offset + ATTACH_CHUNK).toString("base64") });
    expect((await live.attachments.receive(chunk(0))).attachment).toBeUndefined();
    // A chunk sent again is harmless.
    expect((await live.attachments.receive(chunk(0))).attachment).toBeUndefined();
    const { attachment } = await live.attachments.receive(chunk(ATTACH_CHUNK));
    expect(attachment).toMatchObject({ name: "my_photo.png", mimeType: "image/png", size: bytes.length });
    expect(readFileSync(attachment!.path).equals(bytes)).toBe(true);
    expect(() => writeFileSync(attachment!.path, "x")).toThrow();
    expect(live.attachments.check(["claude:s1"], [attachment])).toEqual([attachment!]);
    expect(() => live.attachments.check(["claude:s2"], [attachment])).toThrow("doesn't belong");
    expect(() => live.attachments.check(["claude:s1"], [{ path: "/etc/passwd" }])).toThrow();
    await expect(live.attachments.receive({ ...chunk(0), uploadId: "upload0002", size: 30 * 1024 * 1024, mimeType: "application/zip" })).rejects.toThrow("Too large");
    await expect(live.attachments.receive({ ...chunk(0), uploadId: "upload0003", offset: 5 })).rejects.toThrow("Bad upload chunk");
  });

  test("a message's text lists them; images go to the harness too", async () => {
    const { adapter, live, driver } = setup();
    adapter.addStored("s1", []);
    const { attachment } = await live.attachments.receive({ sessionId: "claude:s1", uploadId: "upload0001", name: "notes.txt", mimeType: "text/plain", size: 5, offset: 0, data: Buffer.from("hello").toString("base64") });
    await live.send("claude:s1", "read this", [attachment!]);
    expect(driver().sent[0]).toBe(`read this\n\nAttached files:\n- ${attachment!.path} (text/plain, 5 B)`);
    expect(AttachmentStore.nativeImage(attachment!)).toBeUndefined();
  });
});

describe("attachments, housekeeping", () => {
  test("session folders are one-to-one; names are capped by bytes; partials are never attachments", async () => {
    const { sessionKey } = await import("./attachments");
    expect(sessionKey("claude:a.b")).not.toBe(sessionKey("claude:a_b"));
    const { safeName, NAME_BYTES_MAX } = await import("../../../shared/attachments");
    const { utf8Length } = await import("../../../shared/limits");
    const n = safeName("写".repeat(100) + ".png");
    expect(utf8Length(n)).toBeLessThanOrEqual(NAME_BYTES_MAX);
    expect(n.endsWith(".png")).toBe(true);
    const { adapter, live } = setup();
    adapter.addStored("s1", []);
    const { attachment } = await live.attachments.receive({ sessionId: "claude:s1", uploadId: "upload0009", name: "写".repeat(100) + ".txt", mimeType: "text/plain", size: 2, offset: 0, data: Buffer.from("hi").toString("base64") });
    expect(attachment!.name.endsWith(".txt")).toBe(true);
    const dir = live.attachments.sessionDir("claude:s1");
    writeFileSync(join(dir, ".abcd1234.partial"), "x");
    expect(() => live.attachments.check(["claude:s1"], [{ path: join(dir, ".abcd1234.partial") }])).toThrow("hasn't finished uploading");
  });

  test("uploads never sent go after a day; sent ones and running uploads stay", async () => {
    const { adapter, live } = setup();
    adapter.addStored("s1", []);
    const up = (id: string, name: string) => live.attachments.receive({ sessionId: "claude:s1", uploadId: id, name, mimeType: "text/plain", size: 2, offset: 0, data: Buffer.from("hi").toString("base64") });
    const sent = (await up("upload0001", "sent.txt")).attachment!;
    const unsent = (await up("upload0002", "unsent.txt")).attachment!;
    live.attachments.markUsed([sent]);
    const { existsSync } = await import("node:fs");
    live.attachments.sweepStored(Date.now() + 2 * 60 * 60 * 1000);
    expect(existsSync(unsent.path)).toBe(true);
    live.attachments.sweepStored(Date.now() + 25 * 60 * 60 * 1000);
    expect(existsSync(unsent.path)).toBe(false);
    expect(existsSync(sent.path)).toBe(true);
  });
});

describe("read state", () => {
  test("a turn that ends while nobody looks is unread on every device until someone looks", async () => {
    const { adapter, live, core, bus, end, driver, summaries } = setup();
    adapter.addStored("s1", []);
    await live.send("claude:s1", "go");
    end();
    const row = () => core.book.get("claude:s1")!;
    expect(row().unread).toBe("finished");
    // Someone opens it (presence).
    bus.emit("viewers", { sessions: { "claude:s1": ["phone"] } });
    expect(row().unread).toBeUndefined();
    // Looking at it while it finishes: never unread.
    await live.send("claude:s1", "again");
    end();
    expect(row().unread).toBeUndefined();
    bus.emit("viewers", { sessions: {} });
    await live.send("claude:s1", "fails");
    end(driver(), "Rate limited");
    expect(row()).toMatchObject({ unread: "failed", failure: "Rate limited" });
    live.read.set("claude:s1", false);
    expect(row().unread).toBeUndefined();
    live.read.set("claude:s1", true);
    expect(row().unread).toBe("finished");
    expect(summaries().some((u) => u.kind === "upsert" && u.sessions.some((x) => x.unread === "failed"))).toBe(true);
  });

  test("a turn a restart cut off goes on by itself; its queue follows it, not held, and Home shows no failure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tether-p5-"));
    const a = setup({ dir });
    a.adapter.addStored("s1", []);
    await a.live.send("claude:s1", "one");
    await a.live.queue.add("claude:s1", "two", []);
    a.prefs.flush();
    a.core.stop();
    const b = setup({ dir, prefsFile: a.prefsFile });
    b.adapter.addStored("s1", []);
    await b.live.rejoin();
    await b.live.queue.restore();
    const s = await b.core.open("claude:s1");
    expect(b.driver().sent[0]).toBe(AUTO_CONTINUE_TEXT);
    expect(s.state.queueHeld).toBeUndefined();
    expect(b.core.book.get("claude:s1")?.unread).toBeUndefined();
    // The continue's turn ends: the queued message goes next.
    b.end();
    await until(() => b.driver().sent.length === 2);
    expect(b.driver().sent[1]).toBe("two");
  });

  test("a restart soon after an automatic continue doesn't continue again: Failed on Home, the queue held", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tether-p5-"));
    const a = setup({ dir });
    a.adapter.addStored("s1", []);
    await a.live.send("claude:s1", "one");
    await a.live.queue.add("claude:s1", "two", []);
    a.prefs.flush();
    a.core.stop();
    const b = setup({ dir, prefsFile: a.prefsFile });
    b.adapter.addStored("s1", []);
    await b.live.rejoin();
    await b.live.queue.restore();
    expect(b.driver().sent[0]).toBe(AUTO_CONTINUE_TEXT);
    b.prefs.flush();
    b.core.stop();
    // Cut off again within two minutes.
    const c = setup({ dir, prefsFile: a.prefsFile });
    c.adapter.addStored("s1", []);
    await c.live.rejoin();
    await c.live.queue.restore();
    expect(c.adapter.drivers).toHaveLength(0);
    await c.core.discover();
    expect(c.core.book.get("claude:s1")).toMatchObject({ unread: "failed", failure: "The runner restarted mid-turn.", queuePaused: true });
    // ✓ on Home, then another restart: it doesn't come back.
    c.live.read.set("claude:s1", false);
    c.prefs.flush();
    c.core.stop();
    const d = setup({ dir, prefsFile: a.prefsFile });
    d.adapter.addStored("s1", []);
    await d.live.rejoin();
    expect(d.prefs.get("claude:s1").unread).toBeUndefined();
    expect(d.adapter.drivers).toHaveLength(0);
  });

  /** A runner stopped mid-turn (prefs say running), and a new one on the same runner.json. */
  async function cutOff(o: { stored?: any[]; queue?: string } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "tether-p5-"));
    const a = setup({ dir });
    a.adapter.addStored("s1", []);
    await a.live.send("claude:s1", "one");
    if (o.queue) await a.live.queue.add("claude:s1", o.queue, []);
    a.prefs.flush();
    a.core.stop();
    const b = setup({ dir, prefsFile: a.prefsFile });
    b.adapter.addStored("s1", o.stored ?? []);
    b.live.quiet = { quietMs: 200, pollMs: 50, maxMs: 2000 };
    return { a, b };
  }

  test("a crash left Claude Code writing the session: Tether waits for its store to go quiet, then continues once", async () => {
    const { b } = await cutOff({ queue: "two" });
    let changed = Date.now();
    (b.adapter as any).storeChangedAt = () => changed;
    const tick = setInterval(() => (changed = Date.now()), 30);
    await b.live.rejoin();
    await b.live.queue.restore();
    const s = await b.core.open("claude:s1");
    expect(b.adapter.drivers).toHaveLength(0);
    expect(s.state.queueHeldBy).toBe("restart");
    expect(s.transcript!.messages.some((m) => /Waiting for Claude Code from before the restart/.test(JSON.stringify(m.parts)))).toBe(true);
    await Bun.sleep(300);
    expect(b.adapter.drivers).toHaveLength(0);
    clearInterval(tick);
    await until(() => b.adapter.drivers.length === 1 && b.driver().sent.length === 1, 3000);
    expect(b.driver().sent[0]).toBe(AUTO_CONTINUE_TEXT);
    expect(s.state.queueHeld).toBeUndefined();
  });

  /** In the quiet wait: the store still changing until the test says stop. */
  async function inWait(o: { queue?: string } = {}) {
    const c = await cutOff(o);
    let changed = Date.now();
    (c.b.adapter as any).storeChangedAt = () => changed;
    const tick = setInterval(() => (changed = Date.now()), 30);
    cleanups.push(() => clearInterval(tick));
    await c.b.live.rejoin();
    await c.b.live.queue.restore();
    const s = await c.b.core.open("claude:s1");
    return { ...c, s, quiet: () => clearInterval(tick) };
  }

  test("a send during the wait queues, held, even with the queue empty; it follows the continue", async () => {
    const { b, s, quiet } = await inWait();
    expect(s.state.restartWait).toBe(true);
    await b.live.send("claude:s1", "mine", [], { stop: true });
    await b.live.send("claude:s1", "too");
    await Bun.sleep(150);
    expect(b.adapter.drivers).toHaveLength(0);
    expect(s.state.queue.map((m) => m.text)).toEqual(["mine", "too"]);
    expect(s.state).toMatchObject({ queueHeld: true, queueHeldBy: "restart", status: "idle" });
    quiet();
    await until(() => b.adapter.drivers.length === 1 && b.driver().sent.length === 1, 3000);
    expect(b.driver().sent[0]).toBe(AUTO_CONTINUE_TEXT);
    expect(s.state.restartWait).toBeUndefined();
    expect(s.state.queueHeld).toBeUndefined();
    b.end();
    await until(() => b.driver().sent.length === 2, 3000);
    expect(b.driver().sent[1]).toBe("mine");
  });

  test("Resume during the wait refuses and the queue stays held; a message queued with Tab holds too", async () => {
    const { b, s, quiet } = await inWait({ queue: "two" });
    await expect(b.live.queue.resume("claude:s1")).rejects.toThrow(/may still be working/);
    await b.live.queue.add("claude:s1", "three", []);
    await Bun.sleep(150);
    expect(b.adapter.drivers).toHaveLength(0);
    expect(s.state).toMatchObject({ queueHeld: true, queueHeldBy: "restart" });
    quiet();
    await until(() => b.adapter.drivers.length === 1 && b.driver().sent.length === 1, 3000);
    expect(b.driver().sent[0]).toBe(AUTO_CONTINUE_TEXT);
  });

  test("a queue emptied during the wait still holds what's queued next", async () => {
    const { b, s } = await inWait({ queue: "two" });
    await b.live.queue.cancel("claude:s1", s.state.queue[0]!.id);
    await b.live.queue.add("claude:s1", "three", []);
    await Bun.sleep(150);
    expect(b.adapter.drivers).toHaveLength(0);
    expect(s.state.queueHeldBy).toBe("restart");
  });

  test("a second restart during the wait waits again: the turn is kept, no Failed, continued once", async () => {
    const { a, b, quiet } = await inWait({ queue: "two" });
    expect(b.prefs.get("claude:s1")).toMatchObject({ running: true, queueHeldBy: "restart" });
    expect(b.prefs.get("claude:s1").continuedTurn).toBeUndefined();
    const since = b.prefs.get("claude:s1").restartWait;
    expect(since).toBeNumber();
    await b.live.closeAll();
    b.prefs.flush();
    b.core.stop();
    quiet();
    const c = setup({ prefsFile: a.prefsFile });
    c.adapter.addStored("s1", []);
    c.live.quiet = { quietMs: 200, pollMs: 50, maxMs: 2000 };
    let changed = Date.now();
    (c.adapter as any).storeChangedAt = () => changed;
    const tick = setInterval(() => (changed = Date.now()), 30);
    cleanups.push(() => clearInterval(tick));
    await c.live.rejoin();
    await c.live.queue.restore();
    const s = await c.core.open("claude:s1");
    expect(s.state.restartWait).toBe(true);
    expect(c.prefs.get("claude:s1").restartWait).toBe(since!);
    expect(c.prefs.get("claude:s1").unread).toBeUndefined();
    expect(c.adapter.drivers).toHaveLength(0);
    clearInterval(tick);
    await until(() => c.adapter.drivers.length === 1 && c.driver().sent.length === 1, 3000);
    expect(c.driver().sent[0]).toBe(AUTO_CONTINUE_TEXT);
    expect(c.prefs.get("claude:s1")).toMatchObject({ running: true, continuedTurn: true });
    expect(c.prefs.get("claude:s1").restartWait).toBeUndefined();
    expect(JSON.stringify(s.transcript!.messages)).not.toContain("This turn stopped");
    expect(s.state.queue.map((m) => m.text)).toEqual(["two"]);
    expect(s.state.queueHeld).toBeUndefined();
  });

  test("the ten minutes of the wait count across restarts", async () => {
    const { a, b } = await inWait();
    b.prefs.set("claude:s1", { restartWait: Date.now() - 60 * 60_000 });
    await b.live.closeAll();
    b.prefs.flush();
    b.core.stop();
    const c = setup({ prefsFile: a.prefsFile });
    c.adapter.addStored("s1", []);
    c.live.quiet = { quietMs: 200, pollMs: 50, maxMs: 2000 };
    (c.adapter as any).storeChangedAt = () => Date.now();
    await c.live.rejoin();
    await until(() => c.prefs.get("claude:s1").unread === "failed", 1000);
    expect(c.adapter.drivers).toHaveLength(0);
    expect(c.prefs.get("claude:s1").running).toBeUndefined();
  });

  test("a stale continuedTurn doesn't block the next cut-off turn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tether-p5-"));
    const a = setup({ dir });
    a.adapter.addStored("s1", []);
    a.prefs.set("claude:s1", { continuedTurn: true });
    await a.live.send("claude:s1", "one");
    expect(a.prefs.get("claude:s1").continuedTurn).toBeUndefined();
    a.prefs.flush();
    a.core.stop();
    const b = setup({ dir, prefsFile: a.prefsFile });
    b.adapter.addStored("s1", []);
    await b.live.rejoin();
    expect(b.driver().sent[0]).toBe(AUTO_CONTINUE_TEXT);
  });

  test("the terminal opened during the wait cancels the continue: no text, no notice, the queue held for the terminal", async () => {
    const { b, s, quiet } = await inWait({ queue: "two" });
    b.live.setMode(s, "terminal", { status: "idle", terminal: { kind: "handoff" } });
    expect(s.state.queueHeldBy).toBe("terminal");
    expect(s.state.restartWait).toBeUndefined();
    quiet();
    await Bun.sleep(350);
    expect(b.adapter.drivers).toHaveLength(0);
    expect(s.state.queue.map((m) => m.text)).toEqual(["two"]);
    expect(s.state.queueHeldBy).toBe("terminal");
    expect(JSON.stringify(s.transcript!.messages)).not.toContain("continuing");
    expect(b.prefs.get("claude:s1").running).toBeUndefined();
    expect(b.prefs.get("claude:s1").restartWait).toBeUndefined();
    expect(b.prefs.get("claude:s1").unread).toBeUndefined();
    // Back to Tether: what waited goes on.
    b.live.setMode(s, "live", { terminal: undefined });
    await until(() => b.adapter.drivers.length === 1 && b.driver().sent.length === 1, 3000);
    expect(b.driver().sent).toEqual(["two"]);
  });

  test("the terminal opened and closed during the wait still cancels the continue", async () => {
    const { b, s, quiet } = await inWait();
    b.live.setMode(s, "terminal", { status: "idle", terminal: { kind: "handoff" } });
    b.live.setMode(s, "stored", { terminal: undefined });
    quiet();
    await Bun.sleep(350);
    expect(b.adapter.drivers).toHaveLength(0);
  });

  test("Stop during the wait: nothing continued, and a send still waits for the store", async () => {
    const { b, s, quiet } = await inWait({ queue: "two" });
    await b.live.interrupt("claude:s1");
    expect(s.state.queueHeldBy).toBe("stopped");
    await b.live.send("claude:s1", "mine");
    await Bun.sleep(150);
    expect(b.adapter.drivers).toHaveLength(0);
    quiet();
    await until(() => s.state.restartWait === undefined, 3000);
    await Bun.sleep(150);
    expect(b.adapter.drivers).toHaveLength(0);
    expect(s.state.queueHeldBy).toBe("stopped");
    expect(b.prefs.get("claude:s1").unread).toBeUndefined();
  });

  test("the store shows the cut-off turn finished: not continued, and the queue goes on", async () => {
    const answered = [
      { id: "u1", role: "user", ts: 1, parts: [{ type: "text", text: "one" }] },
      { id: "a1", role: "assistant", ts: 2, parts: [{ type: "text", text: "done" }] },
    ];
    const { b } = await cutOff({ stored: answered, queue: "two" });
    await b.live.rejoin();
    await b.live.queue.restore();
    await until(() => b.adapter.drivers.length === 1 && b.driver().sent.length === 1);
    expect(b.driver().sent).toEqual(["two"]);
  });

  test("the left-behind process finishes the turn while Tether waits: nothing continued, and the queue goes on", async () => {
    const answered = [
      { id: "u1", role: "user", ts: 1, parts: [{ type: "text", text: "one" }] },
      { id: "a1", role: "assistant", ts: 2, parts: [{ type: "text", text: "done" }] },
    ];
    const { b } = await cutOff({ stored: answered, queue: "two" });
    const changed = Date.now();
    (b.adapter as any).storeChangedAt = () => changed;
    await b.live.rejoin();
    await b.live.queue.restore();
    expect((await b.core.open("claude:s1")).state.queueHeldBy).toBe("restart");
    await until(() => b.adapter.drivers.length === 1 && b.driver().sent.length === 1, 3000);
    expect(b.driver().sent).toEqual(["two"]);
  });

  test("still being written after the longest wait: Failed on Home and a held queue, never a second process", async () => {
    const { b } = await cutOff({ queue: "two" });
    (b.adapter as any).storeChangedAt = () => Date.now();
    b.live.quiet = { quietMs: 200, pollMs: 50, maxMs: 300 };
    await b.live.rejoin();
    await b.live.queue.restore();
    const s = await b.core.open("claude:s1");
    await until(() => b.prefs.get("claude:s1").unread === "failed", 3000);
    expect(b.adapter.drivers).toHaveLength(0);
    expect(s.state.queueHeldBy).toBe("restart");
    expect(JSON.stringify(s.transcript!.messages)).toContain("press Resume to continue");
  });

  test("a Stop that hadn't taken effect before the restart: the turn isn't continued", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tether-p5-"));
    const a = setup({ dir });
    a.adapter.addStored("s1", []);
    await a.live.send("claude:s1", "one");
    // The harness never answers the Stop before the runner dies.
    a.driver().interrupt = async () => {};
    await a.live.interrupt("claude:s1");
    a.core.stop();
    const b = setup({ dir, prefsFile: a.prefsFile });
    b.adapter.addStored("s1", []);
    await b.live.rejoin();
    expect(b.adapter.drivers).toHaveLength(0);
    expect(b.prefs.get("claude:s1").unread).toBeUndefined();
  });

  test("a turn Tether continued, cut off again even long after, isn't continued a second time", async () => {
    const { a, b } = await cutOff();
    await b.live.rejoin();
    expect(b.driver().sent[0]).toBe(AUTO_CONTINUE_TEXT);
    // Much later, still the same continued turn.
    b.prefs.set("claude:s1", { autoContinuedAt: Date.now() - 60 * 60_000 });
    b.prefs.flush();
    b.core.stop();
    const c = setup({ dir: undefined as any, prefsFile: a.prefsFile });
    c.adapter.addStored("s1", []);
    await c.live.rejoin();
    expect(c.adapter.drivers).toHaveLength(0);
    expect(c.prefs.get("claude:s1").unread).toBe("failed");
  });

  test("two sessions cut off at once are both continued", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tether-p5-"));
    const a = setup({ dir });
    a.adapter.addStored("s1", []);
    a.adapter.addStored("s2", []);
    await a.live.send("claude:s1", "one");
    await a.live.send("claude:s2", "two");
    a.prefs.flush();
    a.core.stop();
    const b = setup({ dir, prefsFile: a.prefsFile });
    b.adapter.addStored("s1", []);
    b.adapter.addStored("s2", []);
    await b.live.rejoin();
    expect(b.adapter.drivers.map((d) => [d.nativeId, d.sent[0]]).sort()).toEqual([
      ["s1", AUTO_CONTINUE_TEXT],
      ["s2", AUTO_CONTINUE_TEXT],
    ]);
  });

  test("looking at a subagent reads its main session", async () => {
    const { adapter, live, core, bus, end } = setup();
    adapter.addStored("s1", []);
    adapter.addStored("s1/k", [], { parentSessionId: "claude:s1" });
    await live.send("claude:s1", "go");
    end();
    expect(core.book.get("claude:s1")?.unread).toBe("finished");
    await core.open("claude:s1/k");
    bus.emit("viewers", { sessions: { "claude:s1/k": ["phone"] } });
    expect(core.book.get("claude:s1")?.unread).toBeUndefined();
  });

  test("a turn you stopped isn't unread", async () => {
    const { adapter, live, core } = setup();
    adapter.addStored("s1", []);
    await live.send("claude:s1", "go");
    await live.interrupt("claude:s1");
    expect(core.book.get("claude:s1")?.unread).toBeUndefined();
  });
});
