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
import { LiveControl } from "./live";
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

  test("a turn you stopped isn't unread", async () => {
    const { adapter, live, core } = setup();
    adapter.addStored("s1", []);
    await live.send("claude:s1", "go");
    await live.interrupt("claude:s1");
    expect(core.book.get("claude:s1")?.unread).toBeUndefined();
  });
});
