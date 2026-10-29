// Terminal mode on a fake harness, a fake tmux and fake PTYs: handoff both ways, the busy prompt's
// seam, held queued messages, typing into the TUI, hook status, TUIs that exit, readoption after
// a restart, the shared path (Codex, P4), and project shells.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TERMINAL_BUSY, type RunnerToServer } from "../../../shared/protocol";
import { applySummary, emptySummary } from "../../../shared/summary";
import type { HarnessCapabilities, LiveState } from "../../../shared/transcript";
import { saveConfig } from "../config";
import type { QuitStep, ScreenRead, TerminalOpts } from "../core/adapter";
import { RequestBroker } from "../core/broker";
import { EventBus } from "../core/bus";
import type { CoreEvents } from "../core/events";
import { ask, FakeAdapter, idle, say } from "../core/fakeAdapter";
import { LiveControl } from "../core/live";
import { Prefs } from "../core/prefs";
import { SessionCore } from "../core/sessions";
import { FakePty } from "./attach.test";
import { ANSWER_THERE, ASKED_MEANWHILE, NOT_AT_PROMPT, NOT_STARTED, NOT_TYPED, STILL_WORKING, TerminalControl } from "./control";
import { Tmux, type TmuxSession } from "./tmux";

/** tmux in memory: sessions, what was typed, keys pressed. A TUI "quits" on its quit text. */
class FakeTmux extends Tmux {
  sessions = new Map<string, TmuxSession & { argv: string[]; cols?: number; rows?: number }>();
  typed: [string, string][] = [];
  pressed: [string, string][] = [];
  /** the TUI quits when it sees this typed (null: it never does) */
  quitsOn: string | null = "/exit";
  constructor() {
    super({ socket: "fake", exec: async () => ({ code: 1, stdout: "", stderr: "fake" }) });
  }
  override async list() {
    return [...this.sessions.values()].map(({ argv: _a, cols: _c, rows: _r, ...t }) => t);
  }
  override async has(name: string) {
    return this.sessions.has(name);
  }
  override async create(o: { name: string; cwd: string; argv: string[]; cols?: number; rows?: number; tags: Record<string, string> }) {
    await Bun.sleep(1);
    if (this.sessions.has(o.name)) throw new Error(`duplicate session: ${o.name}`);
    this.sessions.set(o.name, { name: o.name, kind: o.tags.kind as any, sessionId: o.tags.session, projectPath: o.tags.project!, n: o.tags.n ? Number(o.tags.n) : undefined, argv: o.argv, cols: o.cols, rows: o.rows });
  }
  override async kill(name: string) {
    this.sessions.delete(name);
  }
  override async tag(name: string, key: string, value: string | undefined) {
    const t = this.sessions.get(name);
    if (!t) throw new Error(`no session ${name}`);
    if (key === "session") t.sessionId = value;
    if (key === "return") t.returnWhenIdle = value === "1" ? true : undefined;
    if (key === "launch") t.launchedFor = value;
  }
  /** what went in, in order */
  log: string[] = [];
  /** what capture-pane shows, per tmux session */
  screens = new Map<string, string>();
  override async capture(name: string) {
    return this.screens.get(name) ?? "";
  }
  override async keys(name: string, ...keys: string[]) {
    await Bun.sleep(1);
    for (const k of keys) this.pressed.push([name, k]), this.log.push(`key ${k}`);
  }
  /** runs after each typed text (a dialog opening just then, the text showing in the box) */
  afterType?: (name: string, text: string) => void;
  override async type(name: string, text: string) {
    await Bun.sleep(1);
    this.typed.push([name, text]);
    this.afterType?.(name, text);
    this.log.push(`type ${text}`);
    if (this.quitsOn !== null && text === this.quitsOn) this.sessions.delete(name);
  }
}

/**
 * The fake TUI's screen: IDLE (or nothing yet) at its prompt, ASK a dialog, ODD neither; anything
 * else working. "BOX:<text>" is what is typed at its prompt.
 */
const fakeScreen = (screen: string): ScreenRead => ({
  state: !screen || screen.includes("IDLE") ? "idle" : screen.includes("ASK") ? "asking" : screen.includes("ODD") ? "unknown" : "busy",
  body: screen,
  ...(screen.includes("BOX:") ? { input: screen.split("BOX:")[1] } : {}),
});

const QUIT: QuitStep[] = [{ keys: ["Escape"] }, { text: "/exit" }, { keys: ["Enter"] }];

/** Stored sessions' folder: it must exist for a terminal to open there. */
const PROJ = mkdtempSync(join(tmpdir(), "tether-p-"));

class TermAdapter extends FakeAdapter {
  launches: { nativeId: string; opts: TerminalOpts }[] = [];
  override addStored(nativeId: string, msgs: Parameters<FakeAdapter["addStored"]>[1], over: Parameters<FakeAdapter["addStored"]>[2] = {}) {
    return super.addStored(nativeId, msgs, { projectPath: PROJ, ...over });
  }
  constructor(caps?: Partial<HarnessCapabilities>) {
    super();
    if (caps) this.capabilities = { ...this.capabilities, ...caps };
  }
  override terminalCommand(nativeId: string, _p: string, opts: TerminalOpts) {
    this.launches.push({ nativeId, opts });
    return { argv: ["tui", opts.fresh ? "--session-id" : "--resume", nativeId], quit: QUIT, screen: fakeScreen };
  }
}

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((f) => f()));

function setup(o: { adapter?: TermAdapter; tmux?: FakeTmux; prefsFile?: string; hookSocket?: string; startWaitMs?: number; quietMs?: number; screenRetryMs?: number; typedWaitMs?: number; settleMs?: number; paste?: boolean } = {}) {
  const adapter = o.adapter ?? new TermAdapter();
  const tmux = o.tmux ?? new FakeTmux();
  const bus = new EventBus<CoreEvents>();
  const frames: RunnerToServer[] = [];
  const prefsFile = o.prefsFile ?? join(mkdtempSync(join(tmpdir(), "tether-term-")), "runner.json");
  if (!o.prefsFile) saveConfig({ runnerId: "test" }, prefsFile);
  const prefs = new Prefs(prefsFile);
  const send = (m: RunnerToServer) => (frames.push(m), true);
  const core = new SessionCore({ adapters: [adapter], bus, send, epoch: crypto.randomUUID(), prefs, evictMs: 20, log: () => {} });
  const broker = new RequestBroker([], { saved: prefs.requests(), persist: (l) => prefs.setRequests(l) });
  const live = new LiveControl(core, broker, { idleMs: 60_000 });
  const term = new TerminalControl({ core, live, tmux, send, buffered: () => 0, hookSocket: o.hookSocket ?? null, spawn: (argv, opts) => new FakePty(argv, opts), pollMs: 10, quitTimeoutMs: 200, shell: "sh", enterDelayMs: 0, startWaitMs: o.startWaitMs, quietMs: o.quietMs, screenRetryMs: o.screenRetryMs ?? 1, typedWaitMs: o.typedWaitMs ?? 100, settleMs: o.settleMs, log: () => {} });
  cleanups.push(() => (term.stop(), core.stop()));
  const modes: string[] = [];
  bus.on("modeChanged", (e) => modes.push(`${e.from}->${e.to}`));
  const ev: string[] = [];
  bus.on("turnStarted", () => ev.push("turnStarted"));
  bus.on("turnEnded", () => ev.push("turnEnded"));
  bus.on("attention", (e) => ev.push(`attention:${e.message}`));
  const rows = () => {
    let st = emptySummary();
    for (const f of frames) if (f.t === "summary") st = applySummary(st, f.summary).state;
    return st.sessions;
  };
  return { adapter, tmux, core, live, term, frames, modes, ev, rows, prefsFile, bus };
}

const until = async (f: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(5);
  }
};

const state = (core: SessionCore, id: string): LiveState => core.sessions.get(id)!.state;

describe("handoff (Claude)", () => {
  test("idle: the driver closes, the TUI resumes the same session in tmux, the mode is terminal", async () => {
    const { adapter, tmux, core, live, term, modes, frames } = setup();
    adapter.addStored("s1", [{ id: "m1", role: "user", ts: 1, parts: [{ type: "text", text: "hi" }] }]);
    await core.subscribe("claude:s1");
    await live.send("claude:s1", "hello");
    const d = adapter.drivers[0]!;
    expect(state(core, "claude:s1").mode).toBe("live");

    const r = await term.open({ sessionId: "claude:s1", attachId: "a1", cols: 120, rows: 40 });
    expect(r).toEqual({ attachId: "a1", target: "t-claude-s1" });
    expect(d.closed).toBe(true);
    const t = tmux.sessions.get("t-claude-s1")!;
    expect(t.argv).toEqual(["tui", "--resume", "s1"]);
    expect([t.cols, t.rows]).toEqual([120, 40]);
    expect(t).toMatchObject({ kind: "tui", sessionId: "claude:s1", projectPath: PROJ });
    expect(state(core, "claude:s1")).toMatchObject({ mode: "terminal", status: "idle", terminal: { kind: "handoff" } });
    expect(modes).toEqual(["stored->live", "live->terminal"]);
    // The browser's PTY attaches to that tmux session.
    expect(FakePty.all.at(-1)!.argv).toEqual(["tmux", "-L", "fake", "-f", "/dev/null", "attach-session", "-t", "=t-claude-s1"]);
    // Its row says terminal.
    expect(frames.some((f) => f.t === "summary" && f.summary.kind !== "remove" && f.summary.sessions.some((s) => s.id === "claude:s1" && s.mode === "terminal"))).toBe(true);
  });

  test("a running turn: refused unless stop is set (the UI asks first); stop ends the turn, cancels requests, holds the queue", async () => {
    const { adapter, core, live, term, tmux } = setup();
    adapter.addStored("s1", []);
    adapter.script = () => [ask("Write", { file_path: "/p/a" }), say("a1", "ok"), idle];
    await core.subscribe("claude:s1");
    void live.send("claude:s1", "write it").catch(() => {});
    await until(() => state(core, "claude:s1").requests.length === 1);
    core.sessions.get("claude:s1")!.setState({ queue: [{ id: "q1", text: "later", queuedAt: 1 }] });

    await expect(term.open({ sessionId: "claude:s1", attachId: "a1", cols: 80, rows: 24 })).rejects.toThrow(TERMINAL_BUSY);
    expect(tmux.sessions.size).toBe(0);
    expect(state(core, "claude:s1").mode).toBe("live");

    await term.open({ sessionId: "claude:s1", attachId: "a1", cols: 80, rows: 24, stop: true });
    const st = state(core, "claude:s1");
    expect(st.mode).toBe("terminal");
    expect(st.requests).toEqual([]);
    expect(adapter.drivers[0]!.interrupted).toBe(1);
    expect(adapter.drivers[0]!.closed).toBe(true);
    // Held, not discarded.
    expect(st.queue.map((q) => q.text)).toEqual(["later"]);
    expect(st.queueHeld).toBe(true);
    expect(st.queueHeldBy).toBe("terminal");
  });

  test("a stored session opens straight into the terminal; a second device attaches to the same TUI", async () => {
    const { adapter, core, term, tmux } = setup();
    adapter.addStored("s1", []);
    await term.open({ sessionId: "claude:s1", attachId: "a1", cols: 120, rows: 40 });
    await term.open({ sessionId: "claude:s1", attachId: "a2", cols: 45, rows: 30 });
    expect(tmux.sessions.size).toBe(1);
    expect(adapter.drivers.length).toBe(0);
    expect(term.attaches.of("t-claude-s1")).toEqual(["a1", "a2"]);
    expect(state(core, "claude:s1").mode).toBe("terminal");
  });

  test("in terminal mode the composer types into the TUI, Stop presses Esc, and the transcript is read-only from the store", async () => {
    const { adapter, core, live, term, tmux, frames } = setup();
    adapter.addStored("s1", [{ id: "m1", role: "user", ts: 1, parts: [{ type: "text", text: "hi" }] }]);
    await core.subscribe("claude:s1");
    await term.open({ sessionId: "claude:s1", attachId: "a1", cols: 80, rows: 24 });
    await live.send("claude:s1", "use /model");
    expect(tmux.typed).toEqual([["t-claude-s1", "use /model"]]);
    expect(tmux.pressed).toEqual([["t-claude-s1", "Enter"]]);
    expect(adapter.drivers.length).toBe(0);
    await live.interrupt("claude:s1");
    expect(tmux.pressed.at(-1)).toEqual(["t-claude-s1", "Escape"]);
    // The TUI writes to the store: the transcript follows.
    adapter.write("s1", [
      { id: "m1", role: "user", ts: 1, parts: [{ type: "text", text: "hi" }] },
      { id: "m2", role: "assistant", ts: 2, parts: [{ type: "text", text: "from the TUI" }] },
    ]);
    expect(frames.some((f) => f.t === "event" && f.event.type === "msg" && f.event.msg.id === "m2")).toBe(true);
  });

  test("typing into a TUI that just started waits for its SessionStart", async () => {
    const { adapter, live, term, tmux } = setup({ hookSocket: join(mkdtempSync(join(tmpdir(), "tether-hk-")), "hooks.sock") });
    await term.start();
    adapter.addStored("s1", []);
    await term.open({ sessionId: "claude:s1", attachId: "a1", cols: 80, rows: 24 });
    const typing = live.send("claude:s1", "hello");
    await Bun.sleep(30);
    expect(tmux.typed).toEqual([]);
    term.report({ sessionId: "claude:s1", event: "SessionStart", source: "resume" });
    await typing;
    expect(tmux.typed).toEqual([["t-claude-s1", "hello"]]);
    // Later messages don't wait.
    await live.send("claude:s1", "again");
    expect(tmux.typed.length).toBe(2);
  });

  test("hooks: a prompt runs, a permission prompt needs you, a tool resumes, Stop ends the turn", async () => {
    const { adapter, core, term, ev, rows } = setup();
    adapter.addStored("s1", []);
    await term.open({ sessionId: "claude:s1", attachId: "a1", cols: 80, rows: 24 });
    term.report({ sessionId: "claude:s1", event: "UserPromptSubmit", nativeId: "s1" });
    expect(state(core, "claude:s1").status).toBe("running");
    term.report({ sessionId: "claude:s1", event: "Notification", notificationType: "permission_prompt", message: "Claude needs your permission to use Bash" });
    expect(state(core, "claude:s1")).toMatchObject({ status: "waiting", terminal: { kind: "handoff", attention: "Claude needs your permission to use Bash" } });
    expect(rows()["claude:s1"]?.status).toBe("waiting");
    // Idle reminders aren't "needs you".
    term.report({ sessionId: "claude:s1", event: "Notification", notificationType: "idle_prompt", message: "Claude is waiting for your input" });
    expect(state(core, "claude:s1").terminal?.attention).toBe("Claude needs your permission to use Bash");
    term.report({ sessionId: "claude:s1", event: "PostToolUse" });
    expect(state(core, "claude:s1")).toMatchObject({ status: "running", terminal: { kind: "handoff" } });
    expect(state(core, "claude:s1").terminal?.attention).toBeUndefined();
    term.report({ sessionId: "claude:s1", event: "Stop" });
    expect(state(core, "claude:s1").status).toBe("idle");
    expect(ev).toEqual(["turnStarted", "attention:Claude needs your permission to use Bash", "turnEnded"]);
    // Reports for sessions not in a terminal are ignored.
    term.report({ sessionId: "claude:other", event: "UserPromptSubmit" });
  });

  test("Back to Tether: the TUI is asked to quit, the driver resumes the same session, the next message continues it", async () => {
    const { adapter, core, live, term, tmux, modes, frames } = setup();
    adapter.addStored("s1", []);
    await term.open({ sessionId: "claude:s1", attachId: "a1", cols: 80, rows: 24 });
    await term.end("claude:s1");
    // It quit on /exit: the steps after it (Enter) were skipped.
    expect(tmux.pressed).toEqual([["t-claude-s1", "Escape"]]);
    expect(tmux.typed).toEqual([["t-claude-s1", "/exit"]]);
    expect(tmux.sessions.size).toBe(0);
    // A device coming back after a reconnect doesn't start it again.
    await expect(term.open({ sessionId: "claude:s1", attachId: "a9", cols: 80, rows: 24, reattach: true })).rejects.toThrow(/closed/);
    const st = state(core, "claude:s1");
    expect(st.mode).toBe("live");
    expect(st.terminal).toBeUndefined();
    expect(modes).toEqual(["stored->terminal", "terminal->live"]);
    // Resumed, not started fresh, on the same id.
    expect(adapter.drivers.length).toBe(1);
    expect(adapter.drivers[0]!.nativeId).toBe("s1");
    // The browser's attach was told.
    expect(frames).toContainEqual({ t: "termEnd", attachId: "a1", reason: "exited" });
    await live.send("claude:s1", "continue");
    expect(adapter.drivers[0]!.sent).toEqual(["continue"]);
  });

  test("Back to Tether kills a TUI that doesn't quit", async () => {
    const tmux = new FakeTmux();
    tmux.quitsOn = null;
    const { adapter, core, term } = setup({ tmux });
    adapter.addStored("s1", []);
    await term.open({ sessionId: "claude:s1", attachId: "a1", cols: 80, rows: 24 });
    await term.end("claude:s1");
    expect(tmux.sessions.size).toBe(0);
    expect(state(core, "claude:s1").mode).toBe("live");
  });

  test("Back to Tether while the TUI works can wait for the turn to end", async () => {
    const { adapter, core, term, tmux } = setup();
    adapter.addStored("s1", []);
    await term.open({ sessionId: "claude:s1", attachId: "a1", cols: 80, rows: 24 });
    term.report({ sessionId: "claude:s1", event: "UserPromptSubmit" });
    await term.end("claude:s1", true);
    expect(state(core, "claude:s1")).toMatchObject({ mode: "terminal", terminal: { returnWhenIdle: true } });
    expect(tmux.sessions.size).toBe(1);
    term.report({ sessionId: "claude:s1", event: "Stop" });
    await until(() => state(core, "claude:s1").mode === "live");
    expect(tmux.sessions.size).toBe(0);
  });

  test("a TUI that exits by itself leaves the session stored", async () => {
    const { adapter, core, term, tmux, modes, frames } = setup();
    adapter.addStored("s1", []);
    await term.open({ sessionId: "claude:s1", attachId: "a1", cols: 80, rows: 24 });
    tmux.sessions.clear();
    await until(() => state(core, "claude:s1").mode === "stored");
    expect(state(core, "claude:s1").terminal).toBeUndefined();
    expect(modes).toEqual(["stored->terminal", "terminal->stored"]);
    expect(adapter.drivers.length).toBe(0);
    expect(frames).toContainEqual({ t: "termEnd", attachId: "a1", reason: "exited" });
    // It can be opened again.
    await term.open({ sessionId: "claude:s1", attachId: "a2", cols: 80, rows: 24 });
    expect(state(core, "claude:s1").mode).toBe("terminal");
  });

  test("a new session can start in the terminal under its own id", async () => {
    const { adapter, core, live, tmux, term, rows } = setup();
    const dir = mkdtempSync(join(tmpdir(), "tether-proj-"));
    const { sessionId } = await live.newSession({ harness: "claude", projectPath: dir, model: "haiku", terminal: true });
    expect(sessionId).toBe("claude:new-1");
    expect(adapter.drivers.length).toBe(0);
    expect(tmux.sessions.get("t-claude-new-1")!.argv).toEqual(["tui", "--session-id", "new-1"]);
    expect(adapter.launches[0]!.opts).toMatchObject({ fresh: true, model: "haiku" });
    expect(state(core, sessionId)).toMatchObject({ mode: "terminal", terminal: { kind: "handoff" } });
    expect(rows()[sessionId]?.mode).toBe("terminal");
    // Quit before anything was typed: nothing of it is anywhere.
    tmux.sessions.clear();
    await until(() => !core.sessions.has(sessionId));
    expect(rows()[sessionId]).toBeUndefined();
    void term;
  });

  test("a new terminal session that got a message goes live on its id afterwards (resumed)", async () => {
    const { adapter, core, live, term } = setup();
    const dir = mkdtempSync(join(tmpdir(), "tether-proj-"));
    const { sessionId } = await live.newSession({ harness: "claude", projectPath: dir, terminal: true });
    term.report({ sessionId, event: "UserPromptSubmit" });
    adapter.addStored("new-1", [{ id: "m1", role: "user", ts: 1, parts: [{ type: "text", text: "hi" }] }], { projectPath: dir });
    await term.end(sessionId);
    expect(state(core, sessionId).mode).toBe("live");
    expect(adapter.drivers.length).toBe(1);
  });

  test("a session whose folder is gone isn't handed over", async () => {
    const { adapter, core, live, term, tmux } = setup();
    adapter.addStored("s1", [], { projectPath: "/nonexistent/tether-test" });
    await live.send("claude:s1", "hi");
    await expect(term.open({ sessionId: "claude:s1", attachId: "a1", cols: 80, rows: 24 })).rejects.toThrow(/doesn't exist/);
    expect(tmux.sessions.size).toBe(0);
    expect(adapter.drivers[0]!.closed).toBe(false);
    expect(state(core, "claude:s1").mode).toBe("live");
  });

  test("subagents have no terminal of their own", async () => {
    const { adapter, term } = setup();
    adapter.addStored("s1/agent", [], { parentSessionId: "claude:s1" });
    await expect(term.open({ sessionId: "claude:s1/agent", attachId: "a1", cols: 80, rows: 24 })).rejects.toThrow(/main session/);
  });
});

describe("review round 1", () => {
  test("a send while the session is being handed to the TUI never starts an SDK process beside it", async () => {
    const tmux = new FakeTmux();
    const { adapter, core, live, term } = setup({ tmux });
    adapter.addStored("s1", []);
    await live.send("claude:s1", "first");
    // The driver is slow to close: the handoff is mid-way when the sends arrive.
    const d = adapter.drivers[0]!;
    let release!: () => void;
    d.close = () => ((d.closed = true), new Promise<void>((r) => (release = r)));
    const opening = term.open({ sessionId: "claude:s1", attachId: "a1", cols: 80, rows: 24 });
    const sends = [8, 12, 20].map((ms) => Bun.sleep(ms).then(() => live.send("claude:s1", `late ${ms}`)));
    await Bun.sleep(30);
    release();
    await opening;
    await Promise.all(sends);
    expect(adapter.drivers.length).toBe(1);
    expect(state(core, "claude:s1").mode).toBe("terminal");
    // They went to the TUI in order, each text followed by its own Enter.
    expect(tmux.typed.map(([, t]) => t)).toEqual(["late 8", "late 12", "late 20"]);
    expect(tmux.log).toEqual(["type late 8", "key Enter", "type late 12", "key Enter", "type late 20", "key Enter"]);
  });

  test("a send during Back to Tether goes to the driver once it's live", async () => {
    const { adapter, live, term, tmux } = setup();
    adapter.addStored("s1", []);
    await term.open({ sessionId: "claude:s1", attachId: "a1", cols: 80, rows: 24 });
    const back = term.end("claude:s1");
    const sent = live.send("claude:s1", "after");
    await back;
    await sent;
    expect(tmux.typed.filter(([, t]) => t === "after")).toEqual([]);
    expect(adapter.drivers[0]!.sent).toEqual(["after"]);
  });

  test("while the TUI asks something, the composer is refused (the key bar still reaches it)", async () => {
    const { adapter, live, term, tmux } = setup();
    adapter.addStored("s1", []);
    await term.open({ sessionId: "claude:s1", attachId: "a1", cols: 80, rows: 24 });
    term.report({ sessionId: "claude:s1", event: "Notification", notificationType: "permission_prompt", message: "Claude needs your permission to use Bash" });
    await expect(live.send("claude:s1", "1")).rejects.toThrow(ANSWER_THERE);
    expect(tmux.typed).toEqual([]);
    term.input("a1", btoa("1"));
    expect(FakePty.all.at(-1)!.written).toEqual(["1"]);
  });

  test("a TUI that never reports in (Claude's trust question) isn't typed into", async () => {
    const tmux = new FakeTmux();
    const { adapter, live, term } = setup({ tmux, hookSocket: join(mkdtempSync(join(tmpdir(), "tether-hk-")), "hooks.sock"), startWaitMs: 30 });
    await term.start();
    adapter.addStored("s1", []);
    await term.open({ sessionId: "claude:s1", attachId: "a1", cols: 80, rows: 24 });
    // The trust question: a numbered choice, no prompt box.
    tmux.screens.set("t-claude-s1", "ASK");
    await expect(live.send("claude:s1", "hello")).rejects.toThrow(NOT_STARTED);
    expect(tmux.typed).toEqual([]);
    tmux.screens.set("t-claude-s1", "IDLE");
    term.report({ sessionId: "claude:s1", event: "SessionStart", nativeId: "s1", source: "resume" });
    await live.send("claude:s1", "hello");
    expect(tmux.typed).toEqual([["t-claude-s1", "hello"]]);
  });

  test("attaches end when the runner's link drops (the relay forgot them)", async () => {
    const { adapter, term, bus } = setup();
    adapter.addStored("s1", []);
    await term.open({ sessionId: "claude:s1", attachId: "a1", cols: 80, rows: 24 });
    const pty = FakePty.all.at(-1)!;
    bus.emit("disconnected", {});
    expect(pty.closed).toBe(true);
    expect(term.attaches.size).toBe(0);
  });

  test("/clear in the TUI: the terminal, the view and Back to Tether follow the new session", async () => {
    const { adapter, core, live, term, tmux, frames } = setup();
    adapter.addStored("s1", [{ id: "m1", role: "user", ts: 1, parts: [{ type: "text", text: "hi" }] }]);
    await core.subscribe("claude:s1");
    await term.open({ sessionId: "claude:s1", attachId: "a1", cols: 80, rows: 24 });
    // Something that isn't a session id never moves it.
    term.report({ sessionId: "claude:s1", event: "SessionStart", nativeId: "../../etc", source: "clear" });
    await Bun.sleep(5);
    expect(state(core, "claude:s1").mode).toBe("terminal");
    // The hook URL still names claude:s1; the payload names the new session.
    term.report({ sessionId: "claude:s1", event: "SessionStart", nativeId: "00000002-0000-4000-8000-000000000000", source: "clear" });
    await until(() => core.sessions.get("claude:00000002-0000-4000-8000-000000000000")?.state.mode === "terminal");
    expect(tmux.sessions.get("t-claude-s1")!.sessionId).toBe("claude:00000002-0000-4000-8000-000000000000");
    const old = state(core, "claude:s1");
    expect(old).toMatchObject({ mode: "stored", continuedIn: "claude:00000002-0000-4000-8000-000000000000" });
    const n = frames.find((f) => f.t === "event" && f.sessionId === "claude:s1" && f.event.type === "msg" && (f.event.msg as any).link);
    expect((n as any).event.msg.link).toEqual({ sessionId: "claude:00000002-0000-4000-8000-000000000000", label: "Open it" });
    // Hooks keep arriving under the old URL: they go to the new session.
    term.report({ sessionId: "claude:s1", event: "UserPromptSubmit", nativeId: "00000002-0000-4000-8000-000000000000" });
    expect(state(core, "claude:00000002-0000-4000-8000-000000000000").status).toBe("running");
    term.report({ sessionId: "claude:s1", event: "Stop", nativeId: "00000002-0000-4000-8000-000000000000" });
    // Typing reaches the same tmux session; a send to the old one never reaches its old context.
    await live.send("claude:00000002-0000-4000-8000-000000000000", "on the new one");
    expect(tmux.typed.at(-1)).toEqual(["t-claude-s1", "on the new one"]);
    adapter.addStored("00000002-0000-4000-8000-000000000000", [{ id: "x", role: "user", ts: 1, parts: [{ type: "text", text: "on the new one" }] }]);
    // Opening the old session's terminal starts a TUI of its own, never the moved one.
    await term.open({ sessionId: "claude:s1", attachId: "a2", cols: 80, rows: 24 });
    expect(state(core, "claude:s1").mode).toBe("terminal");
    const own = [...tmux.sessions.values()].find((t) => t.sessionId === "claude:s1")!;
    expect(own.name).toMatch(/^t-claude-s1-/);
    expect(own.argv).toEqual(["tui", "--resume", "s1"]);
    await term.end("claude:s1");
    // A second /clear (its hooks still name claude:s1), and a runner restart: still followed.
    term.report({ sessionId: "claude:s1", event: "SessionStart", nativeId: "00000003-0000-4000-8000-000000000000", source: "clear" });
    await until(() => core.sessions.get("claude:00000003-0000-4000-8000-000000000000")?.state.mode === "terminal");
    expect(state(core, "claude:00000002-0000-4000-8000-000000000000")).toMatchObject({ mode: "stored", continuedIn: "claude:00000003-0000-4000-8000-000000000000" });
    expect(tmux.sessions.get("t-claude-s1")).toMatchObject({ sessionId: "claude:00000003-0000-4000-8000-000000000000", launchedFor: "claude:s1" });
    const second = setup({ tmux, adapter, prefsFile: undefined });
    await second.term.readopt();
    second.term.report({ sessionId: "claude:s1", event: "SessionStart", nativeId: "00000004-0000-4000-8000-000000000000", source: "clear" });
    await until(() => second.core.sessions.get("claude:00000004-0000-4000-8000-000000000000")?.state.mode === "terminal");
    second.term.report({ sessionId: "claude:s1", event: "UserPromptSubmit", nativeId: "00000004-0000-4000-8000-000000000000" });
    expect(state(second.core, "claude:00000004-0000-4000-8000-000000000000").status).toBe("running");
    // Back to Tether resumes the session the TUI is on now.
    second.term.report({ sessionId: "claude:s1", event: "Stop", nativeId: "00000004-0000-4000-8000-000000000000" });
    adapter.addStored("00000004-0000-4000-8000-000000000000", [{ id: "y", role: "user", ts: 1, parts: [{ type: "text", text: "x" }] }]);
    await second.term.end("claude:00000004-0000-4000-8000-000000000000");
    expect(state(second.core, "claude:00000004-0000-4000-8000-000000000000").mode).toBe("live");
    expect(adapter.drivers.at(-1)!.nativeId).toBe("00000004-0000-4000-8000-000000000000");
  });

  test("Back to Tether waiting for the turn survives a runner restart", async () => {
    const tmux = new FakeTmux();
    const first = setup({ tmux });
    first.adapter.addStored("s1", []);
    await first.term.open({ sessionId: "claude:s1", attachId: "a1", cols: 80, rows: 24 });
    first.term.report({ sessionId: "claude:s1", event: "UserPromptSubmit" });
    await first.term.end("claude:s1", true);
    first.term.stop();
    first.core.stop();
    const adapter = new TermAdapter();
    adapter.addStored("s1", []);
    const second = setup({ tmux, adapter, prefsFile: first.prefsFile });
    await second.term.readopt();
    expect(state(second.core, "claude:s1").terminal?.returnWhenIdle).toBe(true);
    second.term.report({ sessionId: "claude:s1", event: "Stop" });
    await until(() => state(second.core, "claude:s1").mode === "live");
  });

  test("a model picked in the TUI goes on with the session after Back to Tether", async () => {
    const { adapter, core, term, prefsFile } = setup();
    adapter.addStored("s1", []);
    await core.open("claude:s1");
    core.sessions.get("claude:s1")!.setState({ model: "haiku" });
    await term.open({ sessionId: "claude:s1", attachId: "a1", cols: 80, rows: 24 });
    adapter.write("s1", [{ id: "a", role: "assistant", ts: 2, model: "claude-sonnet-5-5", parts: [{ type: "text", text: "hi" }] }]);
    await term.end("claude:s1");
    expect(state(core, "claude:s1").model).toBe("claude-sonnet-5-5");
    expect(adapter.drivers[0]!.opts.model).toBe("claude-sonnet-5-5");
    void prefsFile;
  });

  test("the same family keeps Tether's alias", async () => {
    const { adapter, core, term } = setup();
    adapter.addStored("s1", [{ id: "a", role: "assistant", ts: 2, model: "claude-haiku-5-5", parts: [{ type: "text", text: "hi" }] }]);
    await core.open("claude:s1");
    core.sessions.get("claude:s1")!.setState({ model: "haiku" });
    await term.open({ sessionId: "claude:s1", attachId: "a1", cols: 80, rows: 24 });
    await term.end("claude:s1");
    expect(state(core, "claude:s1").model).toBe("haiku");
  });

  test("two new shells at once get two numbers", async () => {
    const { term } = setup();
    const dir = mkdtempSync(join(tmpdir(), "tether-proj-"));
    const [a, b] = await Promise.all([term.newShell(dir), term.newShell(dir)]);
    expect([a.n, b.n].sort()).toEqual([1, 2]);
  });
});

describe("review round 2: turns that end without a Stop hook", () => {
  test("the store's interrupt marker ends the turn, clears the question, and a waiting Back to Tether goes", async () => {
    const { adapter, core, term } = setup();
    adapter.addStored("s1", [{ id: "m1", role: "user", ts: 1, parts: [{ type: "text", text: "hi" }] }]);
    await core.subscribe("claude:s1");
    await term.open({ sessionId: "claude:s1", attachId: "a1", cols: 80, rows: 24 });
    term.report({ sessionId: "claude:s1", event: "UserPromptSubmit" });
    term.report({ sessionId: "claude:s1", event: "Notification", notificationType: "permission_prompt", message: "Claude needs your permission to use Bash" });
    await term.end("claude:s1", true);
    expect(state(core, "claude:s1").terminal?.returnWhenIdle).toBe(true);
    // Refused in the TUI: Claude writes the marker, and no hook comes.
    adapter.write("s1", [
      { id: "m1", role: "user", ts: 1, parts: [{ type: "text", text: "hi" }] },
      { id: "m2", role: "notice", ts: 2, parts: [{ type: "text", text: "Interrupted" }] },
    ]);
    await until(() => state(core, "claude:s1").mode === "live");
    expect(state(core, "claude:s1").terminal).toBeUndefined();
  });

  test("Stop from Tether clears the question and the status at once", async () => {
    const { adapter, core, live, term, tmux } = setup();
    adapter.addStored("s1", []);
    await term.open({ sessionId: "claude:s1", attachId: "a1", cols: 80, rows: 24 });
    term.report({ sessionId: "claude:s1", event: "UserPromptSubmit" });
    term.report({ sessionId: "claude:s1", event: "Notification", notificationType: "permission_prompt", message: "Claude needs your permission to use Bash" });
    await live.interrupt("claude:s1");
    expect(tmux.pressed.at(-1)).toEqual(["t-claude-s1", "Escape"]);
    expect(state(core, "claude:s1")).toMatchObject({ status: "idle", terminal: { kind: "handoff" } });
    expect(state(core, "claude:s1").terminal?.attention).toBeUndefined();
  });

  test("no hook for a while and the screen shows the idle prompt twice: the turn is over", async () => {
    const { adapter, core, term, tmux } = setup({ quietMs: 0 });
    adapter.addStored("s1", []);
    await term.open({ sessionId: "claude:s1", attachId: "a1", cols: 80, rows: 24 });
    term.report({ sessionId: "claude:s1", event: "UserPromptSubmit" });
    tmux.screens.set("t-claude-s1", "working…");
    await Bun.sleep(60);
    expect(state(core, "claude:s1").status).toBe("running");
    tmux.screens.set("t-claude-s1", "IDLE ❯");
    await until(() => state(core, "claude:s1").status === "idle");
  });

  test("a hook resets the clock: a busy TUI that just reported isn't second-guessed", async () => {
    const { adapter, core, term, tmux } = setup({ quietMs: 10_000 });
    adapter.addStored("s1", []);
    await term.open({ sessionId: "claude:s1", attachId: "a1", cols: 80, rows: 24 });
    term.report({ sessionId: "claude:s1", event: "UserPromptSubmit" });
    tmux.screens.set("t-claude-s1", "IDLE ❯");
    await Bun.sleep(60);
    expect(state(core, "claude:s1").status).toBe("running");
  });

  test("a Back to Tether that already went doesn't fire again on a later turn", async () => {
    const { adapter, core, term } = setup();
    adapter.addStored("s1", []);
    await term.open({ sessionId: "claude:s1", attachId: "a1", cols: 80, rows: 24 });
    term.report({ sessionId: "claude:s1", event: "UserPromptSubmit" });
    await term.end("claude:s1", true);
    term.report({ sessionId: "claude:s1", event: "Stop" });
    await until(() => state(core, "claude:s1").mode === "live");
    await term.open({ sessionId: "claude:s1", attachId: "a2", cols: 80, rows: 24 });
    expect(state(core, "claude:s1").terminal?.returnWhenIdle).toBeUndefined();
    term.report({ sessionId: "claude:s1", event: "UserPromptSubmit" });
    term.report({ sessionId: "claude:s1", event: "Stop" });
    await Bun.sleep(30);
    expect(state(core, "claude:s1").mode).toBe("terminal");
  });
});

describe("review round 3", () => {
  test("a spinner or a hook running is never idle; idle needs a still screen on two checks", async () => {
    const { adapter, core, term, tmux } = setup({ quietMs: 0 });
    adapter.addStored("s1", []);
    await term.open({ sessionId: "claude:s1", attachId: "a1", cols: 80, rows: 24 });
    term.report({ sessionId: "claude:s1", event: "UserPromptSubmit" });
    tmux.screens.set("t-claude-s1", "running PreToolUse hook");
    await Bun.sleep(80);
    expect(state(core, "claude:s1").status).toBe("running");
    // A screen that keeps changing (a timer) isn't taken for idle.
    let n = 0;
    const tick = setInterval(() => tmux.screens.set("t-claude-s1", `IDLE ${n++}`), 3);
    await Bun.sleep(80);
    clearInterval(tick);
    expect(state(core, "claude:s1").status).toBe("running");
    tmux.screens.set("t-claude-s1", "IDLE");
    await until(() => state(core, "claude:s1").status === "idle");
  });

  test("a dialog (plan approval) is never idle, and the composer doesn't type into it", async () => {
    const { adapter, core, live, term, tmux } = setup({ quietMs: 0 });
    adapter.addStored("s1", []);
    await term.open({ sessionId: "claude:s1", attachId: "a1", cols: 80, rows: 24 });
    term.report({ sessionId: "claude:s1", event: "UserPromptSubmit" });
    tmux.screens.set("t-claude-s1", "ASK");
    await Bun.sleep(80);
    // Needs you at once, from the screen (Claude's own Notification comes seconds later).
    expect(state(core, "claude:s1")).toMatchObject({ status: "waiting", terminal: { attention: "Claude needs you in the terminal." } });
    await expect(live.send("claude:s1", "3")).rejects.toThrow(ANSWER_THERE);
    expect(tmux.typed).toEqual([]);
  });

  test("a screen that is neither the prompt nor a question isn't typed into", async () => {
    const { adapter, core, live, term, tmux } = setup({ screenRetryMs: 1 });
    adapter.addStored("s1", []);
    await term.open({ sessionId: "claude:s1", attachId: "a1", cols: 80, rows: 24 });
    void core;
    tmux.screens.set("t-claude-s1", "ODD");
    await expect(live.send("claude:s1", "hi")).rejects.toThrow(NOT_AT_PROMPT);
    expect(tmux.typed).toEqual([]);
  });

  test("Needs you clears when the dialog was answered in the TUI (it went away), not before it showed", async () => {
    const { adapter, core, term, tmux } = setup({ quietMs: 60_000 });
    adapter.addStored("s1", []);
    await term.open({ sessionId: "claude:s1", attachId: "a1", cols: 80, rows: 24 });
    term.report({ sessionId: "claude:s1", event: "UserPromptSubmit" });
    // The hook came before the dialog is drawn: still waiting.
    term.report({ sessionId: "claude:s1", event: "Notification", notificationType: "permission_prompt", message: "Claude needs your permission to use Bash" });
    tmux.screens.set("t-claude-s1", "working");
    await Bun.sleep(60);
    expect(state(core, "claude:s1").status).toBe("waiting");
    tmux.screens.set("t-claude-s1", "ASK");
    await Bun.sleep(40);
    expect(state(core, "claude:s1").status).toBe("waiting");
    // Approved in the TUI: the tool runs (a long one: no hook for a while).
    tmux.screens.set("t-claude-s1", "working");
    await until(() => state(core, "claude:s1").status === "running");
    expect(state(core, "claude:s1").terminal?.attention).toBeUndefined();
  });

  test("after /clear, the old session's own TUI gets its own hooks (each TUI names itself)", async () => {
    const { adapter, core, term } = setup({ hookSocket: join(mkdtempSync(join(tmpdir(), "tether-hk-")), "hooks.sock"), startWaitMs: 5 });
    await term.start();
    adapter.addStored("s1", [{ id: "m1", role: "user", ts: 1, parts: [{ type: "text", text: "hi" }] }]);
    await core.subscribe("claude:s1");
    await term.open({ sessionId: "claude:s1", attachId: "a1", cols: 80, rows: 24 });
    const B = "9b0c7c1e-2f0a-4a55-9d0e-111111111111";
    term.report({ sessionId: "claude:s1", tui: "t-claude-s1", event: "SessionStart", nativeId: B, source: "clear" });
    await until(() => state(core, "claude:s1").mode === "stored");
    // A's terminal again: a TUI of its own, under another tmux name.
    await term.open({ sessionId: "claude:s1", attachId: "a2", cols: 80, rows: 24 });
    const own = (adapter.launches.at(-1)!.opts.report as any).tui as string;
    expect(own).toStartWith("t-claude-s1-");
    expect(state(core, "claude:s1").mode).toBe("terminal");
    // A's TUI reports (its hooks name the launch session A): A runs, B doesn't.
    term.report({ sessionId: "claude:s1", tui: own, event: "UserPromptSubmit", nativeId: "s1" });
    expect(state(core, "claude:s1").status).toBe("running");
    expect(state(core, `claude:${B}`).status).toBe("idle");
    // B's TUI (launched for A too) still reports to B.
    term.report({ sessionId: "claude:s1", tui: "t-claude-s1", event: "Notification", notificationType: "permission_prompt", message: "x", nativeId: B });
    expect(state(core, `claude:${B}`).status).toBe("waiting");
    expect(state(core, "claude:s1").status).toBe("running");
  });

  test("a lost SessionStart: a later hook, or the prompt on screen, lets typing through", async () => {
    const tmux = new FakeTmux();
    const { adapter, live, term } = setup({ tmux, hookSocket: join(mkdtempSync(join(tmpdir(), "tether-hk-")), "hooks.sock"), startWaitMs: 20 });
    await term.start();
    adapter.addStored("s1", []);
    await term.open({ sessionId: "claude:s1", attachId: "a1", cols: 80, rows: 24 });
    tmux.screens.set("t-claude-s1", "IDLE");
    await live.send("claude:s1", "hello");
    expect(tmux.typed).toEqual([["t-claude-s1", "hello"]]);
    adapter.addStored("s2", []);
    await term.open({ sessionId: "claude:s2", attachId: "a2", cols: 80, rows: 24 });
    tmux.screens.set("t-claude-s2", "ASK");
    await expect(live.send("claude:s2", "x")).rejects.toThrow(NOT_STARTED);
    term.report({ sessionId: "claude:s2", tui: "t-claude-s2", event: "UserPromptSubmit" });
    term.report({ sessionId: "claude:s2", tui: "t-claude-s2", event: "Stop" });
    tmux.screens.set("t-claude-s2", "IDLE");
    await live.send("claude:s2", "x");
    expect(tmux.typed.at(-1)).toEqual(["t-claude-s2", "x"]);
  });

  test("Back when done, pending over a restart, goes if the TUI is at its prompt now", async () => {
    const tmux = new FakeTmux();
    const first = setup({ tmux });
    first.adapter.addStored("s1", []);
    await first.term.open({ sessionId: "claude:s1", attachId: "a1", cols: 80, rows: 24 });
    first.term.report({ sessionId: "claude:s1", event: "UserPromptSubmit" });
    await first.term.end("claude:s1", true);
    first.term.stop();
    first.core.stop();
    // The turn ended while no runner listened.
    tmux.screens.set("t-claude-s1", "IDLE");
    const adapter = new TermAdapter();
    adapter.addStored("s1", []);
    const second = setup({ tmux, adapter, prefsFile: first.prefsFile });
    await second.term.readopt();
    await until(() => state(second.core, "claude:s1").mode === "live");
  });

  test("Back when done, pending over a restart, with the turn still running: it goes when the turn ends", async () => {
    const tmux = new FakeTmux();
    const first = setup({ tmux });
    first.adapter.addStored("s1", []);
    await first.term.open({ sessionId: "claude:s1", attachId: "a1", cols: 80, rows: 24 });
    first.term.report({ sessionId: "claude:s1", event: "UserPromptSubmit" });
    await first.term.end("claude:s1", true);
    first.term.stop();
    first.core.stop();
    tmux.screens.set("t-claude-s1", "working");
    const adapter = new TermAdapter();
    adapter.addStored("s1", []);
    const second = setup({ tmux, adapter, prefsFile: first.prefsFile, quietMs: 0 });
    await second.term.readopt();
    expect(state(second.core, "claude:s1")).toMatchObject({ mode: "terminal", status: "running", terminal: { returnWhenIdle: true } });
    tmux.screens.set("t-claude-s1", "IDLE");
    await until(() => state(second.core, "claude:s1").mode === "live");
  });
});

describe("review round 4", () => {
  test("a dialog that opens between typing and Enter: no key reaches it, nothing is sent, the composer says so", async () => {
    const { adapter, live, term, tmux } = setup();
    adapter.addStored("s1", []);
    await term.open({ sessionId: "claude:s1", attachId: "a1", cols: 80, rows: 24 });
    tmux.afterType = (name) => tmux.screens.set(name, "ASK");
    await expect(live.send("claude:s1", "also say hi")).rejects.toThrow(ASKED_MEANWHILE);
    expect(tmux.pressed).toEqual([]);
  });

  test("Enter goes only once the text shows in the prompt's box", async () => {
    const { adapter, live, term, tmux } = setup({ typedWaitMs: 300 });
    adapter.addStored("s1", []);
    await term.open({ sessionId: "claude:s1", attachId: "a1", cols: 80, rows: 24 });
    tmux.screens.set("t-claude-s1", "IDLE BOX:");
    tmux.afterType = (name, text) => setTimeout(() => tmux.screens.set(name, `IDLE BOX:${text.replace(/ /g, "\n ")}`), 60);
    await live.send("claude:s1", "hello there");
    expect(tmux.pressed).toEqual([["t-claude-s1", "Enter"]]);
    // Text that never shows: no Enter.
    tmux.afterType = undefined;
    tmux.screens.set("t-claude-s1", "IDLE BOX:something else");
    await expect(live.send("claude:s1", "lost")).rejects.toThrow(NOT_TYPED);
    expect(tmux.pressed.length).toBe(1);
  });

  test("after a runner restart the screen says what a readopted TUI does: asking, working, unsure, idle", async () => {
    const tmux = new FakeTmux();
    const first = setup({ tmux });
    for (const id of ["s1", "s2", "s3", "s4"]) {
      first.adapter.addStored(id, []);
      await first.term.open({ sessionId: `claude:${id}`, attachId: `a-${id}`, cols: 80, rows: 24 });
    }
    first.term.stop();
    first.core.stop();
    tmux.screens.set("t-claude-s1", "ASK");
    tmux.screens.set("t-claude-s2", "working");
    tmux.screens.set("t-claude-s3", "ODD");
    tmux.screens.set("t-claude-s4", "IDLE");
    const adapter = new TermAdapter();
    for (const id of ["s1", "s2", "s3", "s4"]) adapter.addStored(id, []);
    const second = setup({ tmux, adapter, prefsFile: first.prefsFile });
    await second.term.readopt();
    expect(state(second.core, "claude:s1")).toMatchObject({ status: "waiting", terminal: { attention: "Claude needs you in the terminal." } });
    expect(state(second.core, "claude:s2").status).toBe("running");
    expect(state(second.core, "claude:s3").status).toBe("running");
    expect(state(second.core, "claude:s4").status).toBe("idle");
    // Back to Tether on the working one asks first (the web asks for any status but idle).
    await expect(second.term.end("claude:s2", true)).resolves.toBeUndefined();
    expect(state(second.core, "claude:s2").terminal?.returnWhenIdle).toBe(true);
    expect(tmux.sessions.has("t-claude-s2")).toBe(true);
  });

  test("a turn Claude starts by itself shows as working; Back to Tether then asks instead of killing it", async () => {
    const { adapter, core, term, tmux } = setup({ settleMs: 0, quietMs: 60_000 });
    adapter.addStored("s1", []);
    await term.open({ sessionId: "claude:s1", attachId: "a1", cols: 80, rows: 24 });
    expect(state(core, "claude:s1").status).toBe("idle");
    tmux.screens.set("t-claude-s1", "working");
    await until(() => state(core, "claude:s1").status === "running");
  });

  test("Back to Tether on an idle status whose screen shows work: refused with 'still working', the TUI lives", async () => {
    const { adapter, core, term, tmux } = setup({ settleMs: 60_000 });
    adapter.addStored("s1", []);
    await term.open({ sessionId: "claude:s1", attachId: "a1", cols: 80, rows: 24 });
    tmux.screens.set("t-claude-s1", "working");
    await expect(term.end("claude:s1")).rejects.toThrow(STILL_WORKING);
    expect(state(core, "claude:s1")).toMatchObject({ mode: "terminal", status: "running" });
    expect(tmux.sessions.has("t-claude-s1")).toBe(true);
  });
});

describe("a runner restart", () => {
  test("terminals outlive the runner and the next one readopts them, new sessions included", async () => {
    const tmux = new FakeTmux();
    const first = setup({ tmux });
    first.adapter.addStored("s1", []);
    await first.term.open({ sessionId: "claude:s1", attachId: "a1", cols: 80, rows: 24 });
    const dir = mkdtempSync(join(tmpdir(), "tether-proj-"));
    await first.live.newSession({ harness: "claude", projectPath: dir, terminal: true });
    first.term.stop();
    first.core.stop();
    expect(FakePty.all.at(-1)!.closed).toBe(true); // browsers' PTYs end with the runner
    expect(tmux.sessions.size).toBe(2); // the TUIs don't

    const adapter = new TermAdapter();
    adapter.addStored("s1", []);
    const second = setup({ tmux, adapter, prefsFile: first.prefsFile });
    await second.term.readopt();
    expect(state(second.core, "claude:s1")).toMatchObject({ mode: "terminal", terminal: { kind: "handoff" } });
    expect(state(second.core, "claude:new-1")).toMatchObject({ mode: "terminal" });
    // Hooks keep working, and Back to Tether too.
    second.term.report({ sessionId: "claude:s1", event: "UserPromptSubmit" });
    expect(state(second.core, "claude:s1").status).toBe("running");
    second.term.report({ sessionId: "claude:s1", event: "Stop" });
    await second.term.end("claude:s1");
    expect(state(second.core, "claude:s1").mode).toBe("live");
  });
});

describe("shared (Codex, P4 seam)", () => {
  test("the TUI joins the live thread: nothing changes mode, the driver keeps going, Back only quits the TUI", async () => {
    const adapter = new TermAdapter({ terminal: "shared", canSteer: true });
    const { core, live, term, tmux, modes } = setup({ adapter });
    adapter.addStored("s1", []);
    // A stored session: opening the shared TUI makes it live first (it joins the live thread).
    await term.open({ sessionId: "claude:s1", attachId: "a0", cols: 80, rows: 24 });
    expect(state(core, "claude:s1").mode).toBe("live");
    expect(adapter.drivers.length).toBe(1);
    term.detach(["a0"]);
    await live.send("claude:s1", "hello");
    adapter.script = () => [say("a2", "still going")];
    void live.send("claude:s1", "more").catch(() => {});
    await term.open({ sessionId: "claude:s1", attachId: "a1", cols: 80, rows: 24 });
    expect(adapter.drivers[0]!.closed).toBe(false);
    expect(state(core, "claude:s1")).toMatchObject({ mode: "live", terminal: { kind: "shared" } });
    expect(adapter.launches[0]!.opts.report).toBeUndefined();
    // Hooks don't drive a shared session's status (the driver does).
    term.report({ sessionId: "claude:s1", event: "Stop" });
    expect(state(core, "claude:s1").status).toBe("running");
    // Detaching leaves it running.
    term.detach(["a1"]);
    expect(tmux.sessions.size).toBe(1);
    await term.end("claude:s1");
    expect(tmux.sessions.size).toBe(0);
    expect(state(core, "claude:s1").terminal).toBeUndefined();
    expect(state(core, "claude:s1").mode).toBe("live");
    expect(modes).toEqual(["stored->live"]);
  });
});

describe("project shells", () => {
  test("shells belong to the project, number up, persist without viewers, and close", async () => {
    const { term, tmux } = setup();
    const dir = mkdtempSync(join(tmpdir(), "tether-proj-"));
    const a = await term.newShell(dir, 100, 30);
    const b = await term.newShell(dir);
    expect([a.n, b.n]).toEqual([1, 2]);
    expect(tmux.sessions.get(a.id)).toMatchObject({ kind: "shell", projectPath: dir, argv: ["sh"], cols: 100, rows: 30 });
    expect((await term.listShells(dir)).map((s) => s.id)).toEqual([a.id, b.id]);
    expect(await term.listShells(mkdtempSync(join(tmpdir(), "tether-other-")))).toEqual([]);
    await term.open({ shellId: a.id, attachId: "x1", cols: 80, rows: 24 });
    term.detach(["x1"]);
    expect(tmux.sessions.has(a.id)).toBe(true);
    await term.closeShell(a.id);
    expect((await term.listShells(dir)).map((s) => s.n)).toEqual([2]);
    await expect(term.open({ shellId: a.id, attachId: "x2", cols: 80, rows: 24 })).rejects.toThrow(/closed/);
    // The next one takes the next number.
    expect((await term.newShell(dir)).n).toBe(3);
  });
});
