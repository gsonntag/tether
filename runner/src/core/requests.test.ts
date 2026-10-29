import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capEvent } from "../../../shared/limits";
import type { RunnerToServer } from "../../../shared/protocol";
import { applySummary, emptySummary } from "../../../shared/summary";
import type { LiveState, SessionEvent, SessionSnapshot } from "../../../shared/transcript";
import { saveConfig } from "../config";
import { RESOLVED_ELSEWHERE } from "./adapter";
import { ALREADY_ANSWERED, DENIED, RequestBroker, type PolicyStep } from "./broker";
import { EventBus } from "./bus";
import type { CoreEvents } from "./events";
import { ask, askQuestion, FakeAdapter, idle, say, subagent, subagentEnds, toolCall } from "./fakeAdapter";
import { LiveControl } from "./live";
import { Prefs } from "./prefs";
import { restoredMessage } from "./requests";
import { SessionCore } from "./sessions";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((f) => f()));

const newPrefsFile = () => {
  const f = join(mkdtempSync(join(tmpdir(), "tether-req-")), "runner.json");
  saveConfig({ runnerId: "test" }, f);
  return f;
};

/** A runner's core as runner.ts assembles it, on a fake harness. */
function setup(o: { prefsFile?: string; adapter?: FakeAdapter; policy?: PolicyStep[] } = {}) {
  const adapter = o.adapter ?? new FakeAdapter();
  const bus = new EventBus<CoreEvents>();
  const frames: RunnerToServer[] = [];
  const prefsFile = o.prefsFile ?? newPrefsFile();
  const prefs = new Prefs(prefsFile);
  const core = new SessionCore({ adapters: [adapter], bus, send: (m) => (frames.push(m.t === "event" ? { ...m, event: capEvent(m.event) } : m), true), epoch: crypto.randomUUID(), prefs, evictMs: 20, log: () => {} });
  const broker = new RequestBroker(o.policy ?? [], { saved: prefs.requests(), closed: prefs.closedRequests(), persist: (l, c) => prefs.setRequests(l, c) });
  const live = new LiveControl(core, broker, { idleMs: 60_000 });
  cleanups.push(() => core.stop());
  const events = (id: string) => frames.filter((f): f is Extract<RunnerToServer, { t: "event" }> => f.t === "event" && f.sessionId === id);
  const rows = () => {
    let st = emptySummary();
    for (const f of frames) if (f.t === "summary") st = applySummary(st, f.summary).state;
    return st.sessions;
  };
  const closed: CoreEvents["requestClosed"][] = [];
  bus.on("requestClosed", (e) => closed.push(e));
  return { adapter, bus, core, live, frames, events, rows, prefsFile, closed };
}

/** A device watching one session: its snapshot, then events in order. */
class Device {
  state: LiveState;
  seq: number;
  constructor(snap: SessionSnapshot) {
    this.state = snap.state;
    this.seq = snap.seq;
  }
  apply(evs: { seq: number; event: SessionEvent }[]) {
    for (const e of evs) {
      if (e.seq <= this.seq) continue;
      if (e.seq !== this.seq + 1) throw new Error(`gap ${this.seq} -> ${e.seq}`);
      this.seq = e.seq;
      if (e.event.type === "state") this.state = { ...this.state, ...e.event.state };
    }
    return this;
  }
}

const tick = () => Bun.sleep(5);

describe("requests in sessions", () => {
  test("an approval reaches every device; answering on one clears it on all; a second answer is too late", async () => {
    const { adapter, core, live, events, rows, closed } = setup();
    adapter.addStored("s1", []);
    adapter.script = () => [ask("Write", { file_path: "/p/notes.txt", content: "hi" }), say("a1", "done"), idle];
    const desktop = new Device(await core.subscribe("claude:s1"));
    const sending = live.send("claude:s1", "write notes");
    await tick();
    const phone = new Device(await core.subscribe("claude:s1"));
    desktop.apply(events("claude:s1"));
    expect(desktop.state.requests).toHaveLength(1);
    expect(phone.state.requests).toEqual(desktop.state.requests);
    const r = phone.state.requests[0]!;
    expect(r).toMatchObject({ sessionId: "claude:s1", kind: "approval", tool: "Write" });
    expect(rows()["claude:s1"]!.requests).toBe(1);

    await live.answerRequest("claude:s1", r.id, { allow: true });
    await sending;
    expect(adapter.drivers[0]!.lastDecision).toEqual({ allow: true });
    desktop.apply(events("claude:s1"));
    phone.apply(events("claude:s1"));
    expect(desktop.state.requests).toEqual([]);
    expect(phone.state.requests).toEqual([]);
    expect(rows()["claude:s1"]!.requests).toBeUndefined();
    await expect(live.answerRequest("claude:s1", r.id, { allow: false })).rejects.toThrow(ALREADY_ANSWERED);
    expect(closed).toEqual([{ sessionId: "claude:s1", requestId: r.id, outcome: "allowed", source: "person" }]);
  });

  test("deny with a reason, a plain deny, and a question answered from its options", async () => {
    const { adapter, core, live } = setup();
    adapter.addStored("s1", []);
    adapter.script = () => [ask("Bash", { command: "rm -rf build" }), ask("Bash", { command: "ls" }), askQuestion("Which color?", ["Red", "Blue"]), idle];
    await core.subscribe("claude:s1");
    const sending = live.send("claude:s1", "go");
    const s = await core.open("claude:s1");
    const next = async () => {
      await tick();
      return s.state.requests[0]!;
    };
    await live.answerRequest("claude:s1", (await next()).id, { allow: false, reason: "keep build" });
    await live.answerRequest("claude:s1", (await next()).id, { allow: false });
    const q = await next();
    expect(q).toMatchObject({ kind: "question", question: "Which color?", options: ["Red", "Blue"] });
    await live.answerRequest("claude:s1", q.id, { allow: true, answers: ["Blue"] });
    await sending;
    expect(adapter.drivers[0]!.decisions).toEqual([
      { allow: false, reason: "The user denied this request and said: keep build" },
      { allow: false, reason: DENIED, interrupt: true },
      { allow: true, answers: ["Blue"] },
    ]);
  });

  test("a subagent's request shows in its view and its parent's; answering clears both", async () => {
    const { adapter, core, live, events, rows } = setup();
    adapter.addStored("s1", []);
    adapter.script = () => [subagent("s1/a1", "t1", [ask("Write", { file_path: "/p/x" })]), subagentEnds("s1/a1"), idle];
    await core.subscribe("claude:s1");
    const sending = live.send("claude:s1", "delegate");
    await tick();
    const child = new Device(await core.subscribe("claude:s1/a1"));
    const parent = await core.open("claude:s1");
    expect(child.state.requests).toHaveLength(1);
    expect(parent.state.requests).toEqual(child.state.requests);
    expect(child.state.requests[0]).toMatchObject({ sessionId: "claude:s1/a1", agent: "Count lines" });
    expect(rows()["claude:s1"]!.requests).toBe(1);
    await live.answerRequest("claude:s1", child.state.requests[0]!.id, { allow: true });
    await sending;
    child.apply(events("claude:s1/a1"));
    expect(child.state.requests).toEqual([]);
    expect(parent.state.requests).toEqual([]);
  });

  test("Stop cancels what is open; a harness that says it was answered elsewhere closes it too", async () => {
    const { adapter, core, live, closed } = setup();
    adapter.addStored("s1", []);
    const elsewhere = new AbortController();
    adapter.script = (t) => (t === "a" ? [ask("Bash", { command: "ls" }), idle] : [ask("Bash", { command: "pwd" }, elsewhere.signal), idle]);
    await core.subscribe("claude:s1");
    const s = await core.open("claude:s1");
    const a = live.send("claude:s1", "a");
    await tick();
    const id = s.state.requests[0]!.id;
    await live.interrupt("claude:s1");
    await a;
    expect(s.state.requests).toEqual([]);
    expect(adapter.drivers[0]!.lastDecision).toMatchObject({ allow: false });
    await expect(live.answerRequest("claude:s1", id, { allow: true })).rejects.toThrow("no longer open");
    const b = live.send("claude:s1", "b");
    await tick();
    expect(s.state.requests).toHaveLength(1);
    elsewhere.abort(RESOLVED_ELSEWHERE);
    await b;
    expect(s.state.requests).toEqual([]);
    expect(closed.map((c) => c.outcome)).toEqual(["cancelled", "elsewhere"]);
  });

  test("a plan approved leaves plan mode: the harness's new mode is kept for the next start", async () => {
    const { adapter, core, live } = setup();
    adapter.addStored("s1", []);
    await live.setPermissionMode("claude:s1", "plan");
    adapter.script = () => [ask("ExitPlanMode", { plan: "x" }), (sink) => sink.state({ permissionMode: "acceptEdits" }), idle];
    const sending = live.send("claude:s1", "plan it");
    await tick();
    const s = await core.open("claude:s1");
    await live.answerRequest("claude:s1", s.state.requests[0]!.id, { allow: true });
    await sending;
    expect(s.state.permissionMode).toBe("acceptEdits");
    expect(core.o.prefs.get("claude:s1").permissionMode).toBe("acceptEdits");
  });

  test("a driver that exits takes its requests with it", async () => {
    const { adapter, core, live } = setup();
    adapter.addStored("s1", []);
    adapter.script = () => [ask("Bash", { command: "ls" })];
    await core.subscribe("claude:s1");
    void live.send("claude:s1", "go");
    await tick();
    const s = await core.open("claude:s1");
    expect(s.state.requests).toHaveLength(1);
    adapter.drivers[0]!.onExit?.("crashed");
    expect(s.state.requests).toEqual([]);
  });

  test("a policy step decides without asking anyone, and says so in the transcript", async () => {
    const rule: PolicyStep = (r) => ((r.input as any)?.command === "ls" ? { verdict: "allow", source: "rule", reason: "ls is harmless" } : { verdict: "undecided" });
    const { adapter, core, live } = setup({ policy: [rule] });
    adapter.addStored("s1", []);
    adapter.script = () => [ask("Bash", { command: "ls" }), idle];
    await core.subscribe("claude:s1");
    await live.send("claude:s1", "go");
    expect(adapter.drivers[0]!.lastDecision).toEqual({ allow: true });
    const n = (await core.open("claude:s1")).transcript!.messages.at(-1)!;
    expect(n).toMatchObject({ role: "notice", level: "info" });
    expect((n.parts[0] as any).text).toBe("A rule allowed Claude Code's request to run `ls`: ls is harmless");
  });
});

describe("requests across a runner restart", () => {
  test("an open request survives: same id after the restart, and answering resumes the session", async () => {
    const prefsFile = newPrefsFile();
    const before = setup({ prefsFile });
    before.adapter.addStored("s1", []);
    before.adapter.script = () => [ask("Write", { file_path: "/p/notes.txt", content: "hi" }), idle];
    await before.core.subscribe("claude:s1");
    void before.live.send("claude:s1", "write notes");
    await tick();
    const id = (await before.core.open("claude:s1")).state.requests[0]!.id;
    // The runner stops: drivers close, the request stays saved.
    await before.live.closeAll();
    before.core.o.prefs.flush();
    const saved = JSON.parse(readFileSync(prefsFile, "utf8"));
    expect(saved.requests.map((r: any) => r.request.id)).toEqual([id]);
    expect(saved.sessions["claude:s1"].running).toBe(true);

    // A new runner process on the same runner.json and store.
    const adapter = new FakeAdapter();
    adapter.addStored("s1", [{ id: "u1", role: "user", ts: 1, parts: [{ type: "text", text: "write notes" }] }]);
    const after = setup({ prefsFile, adapter });
    await after.live.desk.restore();
    expect(after.rows()["claude:s1"]!.requests).toBe(1);
    const snap = await after.core.subscribe("claude:s1");
    expect(snap.state.requests.map((r) => r.id)).toEqual([id]);
    expect(snap.state.status).toBe("idle");
    const cut = snap.messages.at(-1)!;
    expect((cut.parts[0] as any).text).toContain("waiting for you");
    // It stays in memory while it waits, watched or not.
    after.core.unwatch("claude:s1");
    await Bun.sleep(40);
    expect(after.core.sessions.has("claude:s1")).toBe(true);

    // Answered: the session resumes with a message saying so, and the harness asking the same
    // again gets that answer at once, under the same id.
    adapter.script = () => [ask("Write", { content: "hi", file_path: "/p/notes.txt" }), idle];
    await after.live.answerRequest("claude:s1", id, { allow: true });
    await Bun.sleep(30);
    const d = adapter.drivers[0]!;
    expect(d.sent).toEqual(["[From Tether] The user approved your request to use Write on /p/notes.txt. Go ahead."]);
    expect(d.lastDecision).toEqual({ allow: true });
    expect(after.closed).toEqual([{ sessionId: "claude:s1", requestId: id, outcome: "allowed", source: "person" }]);
    await expect(after.live.answerRequest("claude:s1", id, { allow: true })).rejects.toThrow(ALREADY_ANSWERED);
    expect(JSON.parse(readFileSync(prefsFile, "utf8")).requests).toBeUndefined();
  });

  test("a restored request a person stops, or that the next turn passes by, closes", async () => {
    const prefsFile = newPrefsFile();
    const before = setup({ prefsFile });
    before.adapter.addStored("s1", []);
    before.adapter.script = () => [ask("Bash", { command: "ls" }), ask("Bash", { command: "pwd" })];
    void before.live.send("claude:s1", "go");
    await tick();
    await before.live.answerRequest("claude:s1", (await before.core.open("claude:s1")).state.requests[0]!.id, { allow: true });
    await tick();
    await before.live.closeAll();

    const adapter = new FakeAdapter();
    adapter.addStored("s1", []);
    const after = setup({ prefsFile, adapter });
    await after.live.desk.restore();
    const s = await after.core.open("claude:s1");
    expect(s.state.requests).toHaveLength(1);
    // The person types something else instead; Claude does something else and the turn ends.
    await after.live.send("claude:s1", "never mind");
    expect(s.state.requests).toEqual([]);
    expect(after.closed.map((c) => c.outcome)).toEqual(["cancelled"]);
  });

  test("a plain deny after a restart sends nothing and keeps nothing: the same ask later is asked again", async () => {
    const prefsFile = newPrefsFile();
    const before = setup({ prefsFile });
    before.adapter.addStored("s1", []);
    before.adapter.script = () => [ask("Bash", { command: "rm x" })];
    void before.live.send("claude:s1", "go");
    await tick();
    const id = (await before.core.open("claude:s1")).state.requests[0]!.id;
    await before.live.closeAll();

    const adapter = new FakeAdapter();
    adapter.addStored("s1", []);
    const after = setup({ prefsFile, adapter });
    await after.live.desk.restore();
    await after.live.answerRequest("claude:s1", id, { allow: false });
    await tick();
    expect(adapter.drivers).toHaveLength(0);
    const s = await after.core.open("claude:s1");
    expect((s.transcript ?? (await after.core.load(s))).messages.some((m) => (m.parts[0] as any)?.text === "You denied Claude Code's request to run `rm x`.")).toBe(true);
    // Later the person asks for the same thing: it is asked, not denied unseen.
    adapter.script = () => [ask("Bash", { command: "rm x" }), idle];
    const sending = after.live.send("claude:s1", "remove x after all");
    await tick();
    expect(s.state.requests).toHaveLength(1);
    await after.live.answerRequest("claude:s1", s.state.requests[0]!.id, { allow: true });
    await sending;
    expect(adapter.drivers[0]!.lastDecision).toEqual({ allow: true });
  });

  test("a turn you start yourself after answering a restored request drops the kept answer", async () => {
    const prefsFile = newPrefsFile();
    const before = setup({ prefsFile });
    before.adapter.addStored("s1", []);
    before.adapter.script = () => [ask("Bash", { command: "ls" })];
    void before.live.send("claude:s1", "go");
    await tick();
    const id = (await before.core.open("claude:s1")).state.requests[0]!.id;
    await before.live.closeAll();

    const adapter = new FakeAdapter();
    adapter.addStored("s1", []);
    const after = setup({ prefsFile, adapter });
    await after.live.desk.restore();
    // The resume message's turn asks nothing; then you start a turn that asks the same.
    adapter.script = (t) => (t.startsWith("[From Tether]") ? [idle] : [ask("Bash", { command: "ls" }), idle]);
    await after.live.answerRequest("claude:s1", id, { allow: true });
    await Bun.sleep(30);
    expect(adapter.drivers[0]!.sent[0]).toStartWith("[From Tether]");
    const s = await after.core.open("claude:s1");
    const sending = after.live.send("claude:s1", "now list it");
    await tick();
    expect(s.state.requests).toHaveLength(1);
    await after.live.answerRequest("claude:s1", s.state.requests[0]!.id, { allow: false, reason: "no" });
    await sending;
  });

  test("closed ids are saved, so an answer after a restart is still told Already answered", async () => {
    const prefsFile = newPrefsFile();
    const before = setup({ prefsFile });
    before.adapter.addStored("s1", []);
    before.adapter.script = () => [ask("Bash", { command: "ls" }), idle];
    const sending = before.live.send("claude:s1", "go");
    await tick();
    const id = (await before.core.open("claude:s1")).state.requests[0]!.id;
    await before.live.answerRequest("claude:s1", id, { allow: true });
    await sending;
    await before.live.closeAll();
    expect(JSON.parse(readFileSync(prefsFile, "utf8")).closedRequests.map((c: any) => c.id)).toEqual([id]);
    const after = setup({ prefsFile });
    await expect(after.live.answerRequest("claude:s1", id, { allow: true })).rejects.toThrow(ALREADY_ANSWERED);
  });

  test("an answer to a restored request while a turn runs goes out when that turn ends; two in a row, one per turn", async () => {
    const prefsFile = newPrefsFile();
    const before = setup({ prefsFile });
    before.adapter.addStored("s1", []);
    before.adapter.script = () => [ask("Bash", { command: "a" }), ask("Bash", { command: "b" })];
    void before.live.send("claude:s1", "go");
    await tick();
    const s0 = await before.core.open("claude:s1");
    // Two restored requests: one asked, then (after the first was taken over by a restart) another.
    const first = s0.state.requests[0]!.id;
    await before.live.closeAll();
    const p = new Prefs(prefsFile);
    const saved = p.requests();
    p.setRequests([...saved, { ...saved[0]!, request: { ...saved[0]!.request, id: "second", input: { command: "b" } }, key: (await import("./broker")).requestKey("Bash", { command: "b" }) }]);

    const adapter = new FakeAdapter();
    adapter.addStored("s1", []);
    const after = setup({ prefsFile, adapter });
    await after.live.desk.restore();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    adapter.script = (t) => (t === "busy" ? [async () => gate, idle] : t.includes("`a`") ? [ask("Bash", { command: "a" }), idle] : [ask("Bash", { command: "b" }), idle]);
    const busy = after.live.send("claude:s1", "busy");
    await tick();
    await after.live.answerRequest("claude:s1", first, { allow: true });
    await after.live.answerRequest("claude:s1", "second", { allow: true });
    await tick();
    const d = adapter.drivers[0]!;
    expect(d.sent).toEqual(["busy"]);
    release();
    await busy;
    await Bun.sleep(50);
    expect(d.sent).toEqual(["busy", "[From Tether] The user approved your request to run `a`. Go ahead.", "[From Tether] The user approved your request to run `b`. Go ahead."]);
    // Each re-ask was decided at once with the person's answer.
    expect(d.decisions).toEqual([{ allow: true }, { allow: true }]);
  });

  test("Stop drops answers held for the running turn: nothing is sent on your behalf", async () => {
    const prefsFile = newPrefsFile();
    const before = setup({ prefsFile });
    before.adapter.addStored("s1", []);
    before.adapter.script = () => [ask("Bash", { command: "a" })];
    void before.live.send("claude:s1", "go");
    await tick();
    const id = (await before.core.open("claude:s1")).state.requests[0]!.id;
    await before.live.closeAll();

    const adapter = new FakeAdapter();
    adapter.addStored("s1", []);
    const after = setup({ prefsFile, adapter });
    await after.live.desk.restore();
    adapter.script = () => [async () => new Promise<void>(() => {})];
    void after.live.send("claude:s1", "busy");
    await tick();
    await after.live.answerRequest("claude:s1", id, { allow: true });
    await after.live.interrupt("claude:s1");
    await Bun.sleep(50);
    expect(adapter.drivers[0]!.sent).toEqual(["busy"]);
    const s = await after.core.open("claude:s1");
    expect(s.transcript!.messages.some((m) => (m.parts[0] as any)?.text === "Stopped; your answer wasn't sent.")).toBe(true);
  });

  test("a process that dies leaves no tool spinning, live or read back from the store", async () => {
    const { adapter, core, live } = setup();
    adapter.addStored("s1", []);
    adapter.script = () => [toolCall("m1", "t1")];
    await core.subscribe("claude:s1");
    await live.send("claude:s1", "go");
    adapter.drivers[0]!.onExit?.("Claude Code stopped: killed");
    const s = await core.open("claude:s1");
    expect((s.transcript!.get("m1")!.parts[0] as any).status).toBe("error");
    // Read back from the store (the tool left running there), with the stop notice laid over it.
    const { settleStopped, withOverlay } = await import("./notices");
    const stored = [{ id: "m1", role: "assistant" as const, ts: 1, parts: [{ type: "tool" as const, id: "t1", name: "Bash", kind: "shell" as const, input: {}, status: "running" as const }] }];
    expect((settleStopped(withOverlay(stored, s.overlay))[0]!.parts[0] as any).status).toBe("error");
    expect((settleStopped(stored)[0]!.parts[0] as any).status).toBe("running");
  });

  test("requests of a session that no longer exists are dropped at start", async () => {
    const prefsFile = newPrefsFile();
    const p = new Prefs(prefsFile);
    p.setRequests([{ request: { id: "r1", sessionId: "claude:gone", kind: "approval", tool: "Bash", openedAt: 1 }, key: "k", chain: ["claude:gone"] }]);
    const after = setup({ prefsFile });
    await after.live.desk.restore();
    expect(after.live.desk.broker.sessions()).toEqual([]);
    expect(JSON.parse(readFileSync(prefsFile, "utf8")).requests).toBeUndefined();
  });

  test("the message a resumed session gets", () => {
    const base = { id: "r", sessionId: "s", openedAt: 1 };
    expect(restoredMessage({ ...base, kind: "approval", tool: "Bash", command: "ls" }, { allow: false, reason: "use dir" })).toBe("[From Tether] The user denied your request to run `ls` and said: use dir");
    expect(restoredMessage({ ...base, kind: "approval", tool: "Bash", command: "ls" }, { allow: false })).toBeUndefined();
    expect(restoredMessage({ ...base, kind: "approval", tool: "ExitPlanMode", plan: "x" }, { allow: true })).toBe("[From Tether] The user approved your plan. Go ahead.");
    expect(restoredMessage({ ...base, kind: "question", question: "Color?", questions: [{ question: "Color?", options: [] }] }, { allow: true, answers: ["Blue"] })).toBe('[From Tether] The user answered "Color?": Blue');
    expect(
      restoredMessage({ ...base, kind: "question", questions: [{ question: "A?", options: [] }, { question: "B?", options: [] }] }, { allow: true, answers: ["1", "2"] }),
    ).toBe("[From Tether] The user answered:\n- A? 1\n- B? 2");
  });
});

describe("persistent harnesses (capabilities.persistent): the harness asks again itself", () => {
  /** A request open when the runner stopped, on a harness that keeps its turns going. */
  async function restartedWithRequest() {
    const prefsFile = newPrefsFile();
    const caps = { ...new FakeAdapter().capabilities, persistent: true };
    const first = new FakeAdapter();
    first.capabilities = caps;
    const before = setup({ prefsFile, adapter: first });
    before.adapter.addStored("s1", []);
    before.adapter.script = () => [ask("Bash", { command: "rm build" })];
    void before.live.send("claude:s1", "go");
    await tick();
    const id = (await before.core.open("claude:s1")).state.requests[0]!.id;
    await before.live.closeAll();
    before.core.o.prefs.flush();
    const adapter = new FakeAdapter();
    adapter.capabilities = caps;
    adapter.addStored("s1", [{ id: "u1", role: "user", ts: 1, parts: [{ type: "text", text: "go" }] }]);
    const after = setup({ prefsFile, adapter });
    after.live.reaskMs = 30;
    await after.live.desk.restore();
    return { after, adapter, id };
  }

  test("rejoined, the harness asks again: the same request, answered straight to it, no message", async () => {
    const { after, adapter, id } = await restartedWithRequest();
    const rejoining = after.live.rejoin();
    await tick();
    const d = adapter.drivers[0]!;
    void ask("Bash", { command: "rm build" })(d.sink, d);
    await tick();
    expect((await after.core.open("claude:s1")).state.requests.map((r) => r.id)).toEqual([id]);
    await after.live.answerRequest("claude:s1", id, { allow: true });
    await tick();
    expect(d.decisions).toEqual([{ allow: true }]);
    expect(d.sent).toEqual([]);
    await rejoining;
    expect(after.closed.map((c) => c.outcome)).toEqual(["allowed"]);
  });

  test("not asked again (answered in the harness's own TUI meanwhile): it closes as answered elsewhere, and says so", async () => {
    const { after, adapter, id } = await restartedWithRequest();
    await after.live.rejoin();
    expect(after.closed).toEqual([{ sessionId: "claude:s1", requestId: id, outcome: "elsewhere", source: "tether" }]);
    const s = await after.core.open("claude:s1");
    expect(s.transcript!.messages.at(-1)!.parts[0]).toMatchObject({ text: "A request was answered elsewhere while Tether was away." });
    await expect(after.live.answerRequest("claude:s1", id, { allow: true })).rejects.toThrow("no longer open");
    expect(adapter.drivers[0]!.sent).toEqual([]);
  });

  test("answered before the harness asks again: never sent as a message; the ask gets the answer at once", async () => {
    const { after, adapter, id } = await restartedWithRequest();
    await after.live.answerRequest("claude:s1", id, { allow: true });
    const rejoining = after.live.rejoin();
    await tick();
    const d = adapter.drivers[0]!;
    await ask("Bash", { command: "rm build" })(d.sink, d);
    expect(d.decisions).toEqual([{ allow: true }]);
    expect(d.sent).toEqual([]);
    await rejoining;
  });
});

test("an answer passed on after a restart isn't also sent as a message once the harness used it", async () => {
  const prefsFile = newPrefsFile();
  const before = setup({ prefsFile });
  before.adapter.addStored("s1", []);
  before.adapter.script = () => [ask("Bash", { command: "a" })];
  void before.live.send("claude:s1", "go");
  await tick();
  const id = (await before.core.open("claude:s1")).state.requests[0]!.id;
  await before.live.closeAll();

  const adapter = new FakeAdapter();
  adapter.addStored("s1", []);
  const after = setup({ prefsFile, adapter });
  await after.live.desk.restore();
  // A turn runs (the person sent something else); the answer waits for it to end…
  let release!: () => void;
  adapter.script = () => [async () => new Promise<void>((r) => (release = r)), ask("Bash", { command: "a" }), idle];
  const sending = after.live.send("claude:s1", "busy");
  await tick();
  await after.live.answerRequest("claude:s1", id, { allow: true });
  // …but the harness asks the same within this turn and gets it there.
  release();
  await sending;
  await Bun.sleep(50);
  const d = adapter.drivers[0]!;
  expect(d.decisions).toEqual([{ allow: true }]);
  expect(d.sent).toEqual(["busy"]);
});
