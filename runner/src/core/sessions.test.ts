import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capEvent } from "../../../shared/limits";
import type { RunnerToServer, SummaryUpdate } from "../../../shared/protocol";
import { applySummary, emptySummary } from "../../../shared/summary";
import type { Msg, SessionEvent, SessionSnapshot } from "../../../shared/transcript";
import { applyToWindow, prependPage, type TranscriptWindow } from "../../../shared/window";
import { NO_APPROVALS_YET, RequestBroker } from "./broker";
import { EventBus } from "./bus";
import type { CoreEvents } from "./events";
import { ask, FakeAdapter, idle, say, stream, subagent, subagentEnds, toolCall, toolDone } from "./fakeAdapter";
import { LiveControl } from "./live";
import { Prefs } from "./prefs";
import { saveConfig } from "../config";
import { SessionCore } from "./sessions";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((f) => f()));

const user = (id: string, text = id): Msg => ({ id, role: "user", ts: 0, parts: [{ type: "text", text }] });

function setup(opts: { idleMs?: number; evictMs?: number } = {}) {
  const adapter = new FakeAdapter();
  const bus = new EventBus<CoreEvents>();
  const frames: RunnerToServer[] = [];
  const prefsFile = join(mkdtempSync(join(tmpdir(), "tether-core-")), "runner.json");
  saveConfig({ runnerId: "test" }, prefsFile);
  const core = new SessionCore({ adapters: [adapter], bus, send: (m) => (frames.push(m.t === "event" ? { ...m, event: capEvent(m.event) } : m), true), epoch: "e1", prefs: new Prefs(prefsFile), evictMs: opts.evictMs ?? 50, log: () => {} });
  const live = new LiveControl(core, new RequestBroker(), { idleMs: opts.idleMs ?? 60_000 });
  cleanups.push(() => core.stop());
  const events = (sessionId: string) => frames.filter((f): f is Extract<RunnerToServer, { t: "event" }> => f.t === "event" && f.sessionId === sessionId);
  const summaries = () => frames.filter((f): f is Extract<RunnerToServer, { t: "summary" }> => f.t === "summary").map((f) => f.summary);
  return { adapter, bus, core, live, frames, events, summaries };
}

/** A browser's copy of one session: a snapshot, then events applied by the one sync rule. */
class Viewer {
  w: TranscriptWindow = { messages: [], hasOlder: false };
  seq = 0;
  state: any;
  constructor(snap: SessionSnapshot) {
    this.w = { messages: snap.messages, hasOlder: snap.hasOlder };
    this.seq = snap.seq;
    this.state = snap.state;
  }
  apply(evs: { seq: number; event: SessionEvent }[]) {
    for (const e of evs) {
      if (e.seq <= this.seq) continue;
      if (e.seq !== this.seq + 1) throw new Error(`gap: ${this.seq} -> ${e.seq}`);
      this.seq = e.seq;
      this.w = applyToWindow(this.w, e.event);
      if (e.event.type === "state") this.state = { ...this.state, ...e.event.state };
    }
  }
}

describe("stored sessions", () => {
  test("opening a stored session reads its store, starts no process, and pages from the newest", async () => {
    const { adapter, core } = setup();
    adapter.addStored("s1", Array.from({ length: 120 }, (_, i) => user(`m${i}`)));
    const snap = await core.subscribe("claude:s1");
    expect(adapter.drivers).toHaveLength(0);
    expect(snap.state).toMatchObject({ mode: "stored", status: "idle", model: "default" });
    expect(snap.messages.map((m) => m.id)).toEqual(Array.from({ length: 50 }, (_, i) => `m${70 + i}`));
    expect(snap.hasOlder).toBe(true);
    expect(snap.capabilities.subagents.view).toBe(true);
    const s = await core.open("claude:s1");
    let w: TranscriptWindow = { messages: snap.messages, hasOlder: snap.hasOlder };
    while (w.hasOlder) w = prependPage(w, core.history(s, w.messages[0]!.id, 50));
    expect(w.messages.map((m) => m.id)).toEqual(Array.from({ length: 120 }, (_, i) => `m${i}`));
  });

  test("a stored session that changes in its store (a terminal) updates its watchers", async () => {
    const { adapter, core, events } = setup();
    adapter.addStored("s1", [user("m0")]);
    const v = new Viewer(await core.subscribe("claude:s1"));
    adapter.write("s1", [user("m0"), user("m1", "from the terminal")]);
    adapter.write("s1", [user("m0", "edited"), user("m1", "from the terminal")]);
    v.apply(events("claude:s1"));
    expect(v.w.messages.map((m) => (m.parts[0] as any).text)).toEqual(["edited", "from the terminal"]);
    // A rewrite that drops messages is a reset.
    adapter.write("s1", [user("x9")]);
    v.apply(events("claude:s1"));
    expect(v.w.messages.map((m) => m.id)).toEqual(["x9"]);
    // Unwatched: no more tailing.
    core.unwatch("claude:s1");
    expect(adapter.watchers.size).toBe(0);
  });

  test("an unwatched stored session leaves memory, and its numbering goes on when reopened", async () => {
    const { adapter, core } = setup({ evictMs: 10 });
    adapter.addStored("s1", [user("m0")]);
    await core.subscribe("claude:s1");
    adapter.write("s1", [user("m0"), user("m1")]);
    const seq = (await core.open("claude:s1")).seq;
    expect(seq).toBeGreaterThan(0);
    core.unwatch("claude:s1");
    await Bun.sleep(30);
    expect(core.sessions.has("claude:s1")).toBe(false);
    const again = await core.subscribe("claude:s1");
    expect(again.seq).toBe(seq);
    expect(again.messages).toHaveLength(2);
  });

  test("an unknown session is an error and leaves nothing watched", async () => {
    const { core } = setup();
    await expect(core.subscribe("claude:nope")).rejects.toThrow("isn't on this runner");
    await expect(core.subscribe("bogus")).rejects.toThrow();
    expect(core.watched.size).toBe(0);
  });
});

describe("live sessions", () => {
  test("send takes a stored session live; two viewers end with identical transcripts", async () => {
    const { adapter, core, live, events } = setup();
    adapter.addStored("s1", [user("m0")]);
    adapter.script = (t) => [stream(`a-${t}`, ["Hel", "lo"]), toolCall("t-msg", "t1"), toolDone("t-msg", "t1", "a.ts"), say("a2", "done"), idle];
    const a = new Viewer(await core.subscribe("claude:s1"));
    await live.send("claude:s1", "hi");
    // A second device opens mid-way (here: after), from a fresh snapshot.
    const b = new Viewer(await core.subscribe("claude:s1"));
    a.apply(events("claude:s1"));
    b.apply(events("claude:s1"));
    expect(a.w).toEqual(b.w);
    expect(a.w.messages.map((m) => m.id)).toEqual(["m0", "u1", "a-hi", "t-msg", "a2"]);
    expect((a.w.messages[2]!.parts[0] as any).text).toBe("Hello");
    expect(a.w.messages[3]!.parts[0]).toMatchObject({ status: "done", output: "a.ts" });
    expect(a.state).toMatchObject({ mode: "live", status: "idle" });
    // Seqs are contiguous from 1.
    expect(events("claude:s1").map((e) => e.seq)).toEqual(events("claude:s1").map((_, i) => i + 1));
  });

  test("a viewer that joins mid-turn sees the rest stream in", async () => {
    const { adapter, core, live, events } = setup();
    adapter.addStored("s1", []);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    adapter.script = () => [stream("a1", ["one "]), async () => gate, (s) => s.event({ type: "delta", msgId: "a1", part: 0, text: "two" }), idle];
    await core.subscribe("claude:s1");
    const sending = live.send("claude:s1", "go");
    await Bun.sleep(5);
    const late = new Viewer(await core.subscribe("claude:s1"));
    expect(late.state.status).toBe("running");
    const at = late.seq;
    release();
    await sending;
    late.apply(events("claude:s1").filter((e) => e.seq > at));
    expect((late.w.messages.find((m) => m.id === "a1")!.parts[0] as any).text).toBe("one two");
    expect(late.state.status).toBe("idle");
  });

  test("send while running is refused; interrupt reaches the driver", async () => {
    const { adapter, core, live } = setup();
    adapter.addStored("s1", []);
    adapter.script = () => [say("a1", "working")];
    await live.send("claude:s1", "go");
    await expect(live.send("claude:s1", "again")).rejects.toThrow("still working");
    await live.interrupt("claude:s1");
    expect(adapter.drivers[0]!.interrupted).toBe(1);
    expect((await core.open("claude:s1")).state.status).toBe("idle");
  });

  test("model, effort and permission mode: saved while stored, applied at start and live", async () => {
    const { adapter, core, live } = setup();
    adapter.addStored("s1", []);
    await live.setModel("claude:s1", "haiku");
    await live.setPermissionMode("claude:s1", "acceptEdits");
    expect((await core.open("claude:s1")).state).toMatchObject({ mode: "stored", model: "haiku", permissionMode: "acceptEdits" });
    await live.send("claude:s1", "go");
    expect(adapter.drivers[0]!.opts).toMatchObject({ model: "haiku", permissionMode: "acceptEdits" });
    await live.setEffort("claude:s1", "high");
    expect(adapter.drivers[0]!.settings.effort).toBe("high");
    expect((await core.open("claude:s1")).state.effort).toBe("high");
  });

  test("idle close: back to stored after the idle time, never while background work runs", async () => {
    const { adapter, core, live, bus } = setup({ idleMs: 30 });
    adapter.addStored("s1", []);
    const modes: string[] = [];
    bus.on("modeChanged", (e) => modes.push(`${e.from}>${e.to}`));
    await core.subscribe("claude:s1");
    await live.send("claude:s1", "go");
    const d = adapter.drivers[0]!;
    d.isBusy = true;
    await Bun.sleep(80);
    expect(d.closed).toBe(false);
    d.isBusy = false;
    await Bun.sleep(80);
    expect(d.closed).toBe(true);
    expect(modes).toEqual(["stored>live", "live>stored"]);
    const s = await core.open("claude:s1");
    expect(s.state.mode).toBe("stored");
    // Watched again from the store.
    expect(adapter.watchers.has("s1")).toBe(true);
  });

  test("a process that dies says why and the session goes stored", async () => {
    const { adapter, core, live } = setup();
    adapter.addStored("s1", []);
    await core.subscribe("claude:s1");
    await live.send("claude:s1", "go");
    adapter.drivers[0]!.onExit?.("Claude Code exited (code 1).");
    const s = await core.open("claude:s1");
    expect(s.state).toMatchObject({ mode: "stored", status: "idle", error: "Claude Code exited (code 1)." });
    expect(s.transcript!.messages.at(-1)).toMatchObject({ role: "notice", level: "error" });
  });

  test("a harness that can't start: the error is in the state and the transcript", async () => {
    const { adapter, core, live } = setup();
    adapter.addStored("s1", []);
    adapter.startError = "Claude Code isn't signed in. Run `claude` on the runner machine and log in.";
    await expect(live.send("claude:s1", "go")).rejects.toThrow("signed in");
    const s = await core.open("claude:s1");
    expect(s.state.error).toContain("signed in");
    expect(s.state.mode).toBe("stored");
  });

  test("a permission request is denied with a clear notice (no approvals in P1)", async () => {
    const { adapter, core, live } = setup();
    adapter.addStored("s1", []);
    adapter.script = () => [ask("Bash", { command: "rm -rf build" }), idle];
    await core.subscribe("claude:s1");
    await live.send("claude:s1", "clean");
    expect(adapter.drivers[0]!.lastDecision).toEqual({ allow: false, reason: NO_APPROVALS_YET, source: "tether" } as any);
    const n = (await core.open("claude:s1")).transcript!.messages.at(-1)!;
    expect(n).toMatchObject({ role: "notice", level: "warning" });
    expect((n.parts[0] as any).text).toContain("run `rm -rf build`");
  });
});

describe("new sessions", () => {
  test("a new session starts its harness at once, lists, and vanishes if never used", async () => {
    const { adapter, core, live, summaries } = setup({ idleMs: 20, evictMs: 10 });
    const { sessionId } = await live.newSession({ harness: "claude", projectPath: tmpdir(), model: "haiku", permissionMode: "bypassPermissions" });
    expect(sessionId).toBe("claude:new-1");
    expect(adapter.drivers[0]!.opts).toMatchObject({ model: "haiku", permissionMode: "bypassPermissions" });
    let list = emptySummary();
    for (const u of summaries()) list = applySummary(list, u).state;
    expect(list.sessions[sessionId]).toMatchObject({ mode: "live", projectPath: tmpdir() });
    await Bun.sleep(60);
    expect(core.sessions.has(sessionId)).toBe(false);
    for (const u of summaries()) list = applySummary(list, u).state;
    expect(list.sessions[sessionId]).toBeUndefined();
  });

  test("a folder that isn't there is refused", async () => {
    const { live } = setup();
    await expect(live.newSession({ harness: "claude", projectPath: "/no/such/folder" })).rejects.toThrow("no folder");
    await expect(live.newSession({ harness: "codex", projectPath: tmpdir() })).rejects.toThrow("can't drive codex");
  });
});

describe("subagents", () => {
  test("a subagent is a child session: linked from the parent's tool card, live, stoppable", async () => {
    const { adapter, core, live, events, summaries } = setup();
    adapter.addStored("s1", []);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    adapter.script = () => [
      toolCall("m-agent", "toolu_A", "Agent", { description: "Count lines", prompt: "Count the lines" }),
      subagent("s1/agent1", "toolu_A", [say("sub-a1", "Running wc"), toolCall("sub-a2", "toolu_wc"), toolDone("sub-a2", "toolu_wc", "4 total")]),
      say("a-main", "Started a subagent"),
      idle,
      async () => gate,
    ];
    const parent = new Viewer(await core.subscribe("claude:s1"));
    const sending = live.send("claude:s1", "count");
    await Bun.sleep(5);
    parent.apply(events("claude:s1"));
    const card = parent.w.messages.find((m) => m.id === "m-agent")!.parts[0] as any;
    expect(card.childSessionId).toBe("claude:s1/agent1");
    // The child is listed as a running session of its own.
    let list = emptySummary();
    for (const u of summaries()) list = applySummary(list, u).state;
    expect(list.sessions["claude:s1/agent1"]).toMatchObject({ parentSessionId: "claude:s1", parentToolId: "toolu_A", status: "running", mode: "live", agentType: "general-purpose" });
    // Its view shows its exact turns.
    const child = new Viewer(await core.subscribe("claude:s1/agent1"));
    expect(child.w.messages.map((m) => m.id)).toEqual(["s1/agent1:prompt", "sub-a1", "sub-a2"]);
    expect(child.w.messages[2]!.parts[0]).toMatchObject({ status: "done", output: "4 total" });
    // The parent's turn is over but its subagent runs: busy, not idle-closed.
    expect((await core.open("claude:s1/agent1")).childRunning).toBe(true);
    // Stop works on the child.
    await live.interrupt("claude:s1/agent1");
    expect(adapter.drivers[0]!.stopped).toEqual(["s1/agent1"]);
    child.apply(events("claude:s1/agent1"));
    expect(child.state).toMatchObject({ status: "idle", mode: "stored" });
    await expect(live.send("claude:s1/agent1", "hi")).rejects.toThrow("Subagents can't take messages");
    expect((await core.listSessions({ parentSessionId: "claude:s1" })).sessions.map((s) => s.id)).toEqual(["claude:s1/agent1"]);
    release();
    await sending;
  });

  test("when the parent's process ends, its running subagents end too", async () => {
    const { adapter, core, live } = setup();
    adapter.addStored("s1", []);
    adapter.script = () => [toolCall("m", "toolu_A", "Agent"), subagent("s1/a", "toolu_A"), idle];
    await live.send("claude:s1", "go");
    expect((await core.open("claude:s1/a")).childRunning).toBe(true);
    adapter.drivers[0]!.onExit?.();
    expect((await core.open("claude:s1/a")).state).toMatchObject({ status: "idle", mode: "stored" });
  });

  test("a subagent that finishes by itself ends", async () => {
    const { adapter, core, live } = setup();
    adapter.addStored("s1", []);
    adapter.script = () => [toolCall("m", "toolu_A", "Agent"), subagent("s1/a", "toolu_A", [say("x", "hi")]), subagentEnds("s1/a"), idle];
    await live.send("claude:s1", "go");
    const c = await core.open("claude:s1/a");
    expect(c.childRunning).toBe(false);
    expect(c.state.status).toBe("idle");
  });
});

describe("summaries and discovery", () => {
  test("discovery lists recent stored sessions, keeps live rows its own, and drops what's gone", async () => {
    const { adapter, core, live, summaries } = setup();
    adapter.addStored("old", [], { updatedAt: Date.now() - 10 * 24 * 3600_000 });
    adapter.addStored("s1", []);
    adapter.addStored("s2", []);
    await core.discover();
    let list = emptySummary();
    const fold = () => {
      for (const u of summaries()) list = applySummary(list, u).state;
      return Object.keys(list.sessions).sort();
    };
    expect(fold()).toEqual(["claude:s1", "claude:s2"]);
    await live.send("claude:s1", "go");
    adapter.stored.delete("s2");
    await core.discover();
    expect(fold()).toEqual(["claude:s1"]);
    expect(list.sessions["claude:s1"]!.mode).toBe("live");
    // A session started outside Tether shows up on the next pass.
    adapter.addStored("cli", [], { title: "From the terminal" });
    await core.discover();
    expect(fold()).toEqual(["claude:cli", "claude:s1"]);
    // listSessions without filters is the same list, with its epoch and seq.
    const all = await core.listSessions({});
    expect(all.epoch).toBe("e1");
    expect(all.sessions.map((s) => s.id).sort()).toEqual(["claude:cli", "claude:s1"]);
    // Search finds old ones too.
    expect((await core.listSessions({ query: "session old" })).sessions.map((s) => s.id)).toEqual(["claude:old"]);
  });

  test("events go out only for watched sessions; a disconnect forgets every watch", async () => {
    const { adapter, core, live, bus, events } = setup();
    adapter.addStored("s1", []);
    await live.send("claude:s1", "go");
    expect(events("claude:s1")).toHaveLength(0);
    await core.subscribe("claude:s1");
    bus.emit("disconnected", {});
    expect(core.watched.size).toBe(0);
  });

  test("a turn's end refreshes the title the harness gave it", async () => {
    const { adapter, core, live } = setup();
    adapter.addStored("s1", [], { title: "Untitled" });
    adapter.script = () => [
      (s) => {
        adapter.stored.get("s1")!.summary.title = "Fix the build";
        s.event({ type: "msg", msg: { id: "a", role: "assistant", ts: 1, parts: [] } });
      },
      idle,
    ];
    await live.send("claude:s1", "go");
    await Bun.sleep(5);
    expect((await core.open("claude:s1")).summary.title).toBe("Fix the build");
  });
});

test("SummaryUpdate frames carry the runner's epoch", () => {
  const { core, summaries } = setup();
  core.book.announce();
  expect(summaries().every((u: SummaryUpdate) => u.epoch === "e1")).toBe(true);
});

test("a turn cut off by a runner restart is reported when the session reopens", async () => {
  const first = setup();
  first.adapter.addStored("s1", [user("m0")]);
  first.adapter.script = () => [say("a1", "working…")];
  await first.live.send("claude:s1", "go");
  first.core.o.prefs.flush();
  // A new runner process on the same runner.json.
  const file = (first.core.o.prefs as any).file as string;
  const adapter = new FakeAdapter();
  adapter.addStored("s1", [user("m0"), user("u1", "go")]);
  const core = new SessionCore({ adapters: [adapter], bus: new EventBus<CoreEvents>(), send: () => true, epoch: "e2", prefs: new Prefs(file), log: () => {} });
  cleanups.push(() => core.stop());
  const snap = await core.subscribe("claude:s1");
  expect(snap.messages.at(-1)).toMatchObject({ role: "notice", level: "warning" });
  expect((snap.messages.at(-1)!.parts[0] as any).text).toContain("runner restarted");
});
