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
import { TerminalControl } from "./control";
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
    if (key === "launch") t.launchedFor = value;
  }
  /** sessions copy mode was left in */
  left: string[] = [];
  override async leaveCopyMode(name: string) {
    this.left.push(name);
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
 * The fake TUI's screen: IDLE (or nothing yet) at its prompt, ASK a question, PICK a menu, ODD neither; anything
 * else working. "BOX:<text>" is what is typed at its prompt; SHELL and HIST its prompt's mode.
 */
const fakeScreen = (screen: string): ScreenRead => ({
  ...(screen.includes("MODE:") ? { mode: screen.split("MODE:")[1]!.split(" ")[0] } : {}),
  ...(screen.includes("BG") ? { background: true } : {}),
  state: !screen || screen.includes("IDLE") ? "idle" : screen.includes("ASK") ? "asking" : screen.includes("PICK") ? "picker" : screen.includes("ODD") ? "unknown" : "busy",
  prompt: screen.includes("SHELL") ? ("shell" as const) : screen.includes("HIST") ? ("history" as const) : screen.includes("VIM") ? ("vim" as const) : ("normal" as const),
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
  /** how the fake TUI quits at its empty prompt (unset: the keys only) */
  quitAtPrompt?: QuitStep[];
  storedMode?: (nativeId: string, projectPath: string) => Promise<{ mode?: string; entries: number }>;
  override terminalCommand(nativeId: string, _p: string, opts: TerminalOpts) {
    this.launches.push({ nativeId, opts });
    return { argv: ["tui", opts.fresh ? "--session-id" : "--resume", nativeId], quit: QUIT, quitAtPrompt: this.quitAtPrompt, screen: fakeScreen };
  }
}

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((f) => f()));

function setup(o: { adapter?: TermAdapter; tmux?: FakeTmux; prefsFile?: string; hookSocket?: string; screenRetryMs?: number; clearAfterMs?: number } = {}) {
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
  const term = new TerminalControl({ core, live, tmux, send, buffered: () => 0, hookSocket: o.hookSocket ?? null, spawn: (argv, opts) => new FakePty(argv, opts), pollMs: 10, quitTimeoutMs: 200, shell: "sh", screenRetryMs: o.screenRetryMs ?? 1, clearAfterMs: o.clearAfterMs ?? 30, log: () => {} });
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

  test("while the TUI drives nothing is typed into it: a send waits in the queue for Back to Tether, Stop does nothing; the transcript follows the store", async () => {
    const { adapter, core, live, term, tmux, frames } = setup();
    adapter.addStored("s1", [{ id: "m1", role: "user", ts: 1, parts: [{ type: "text", text: "hi" }] }]);
    await core.subscribe("claude:s1");
    await term.open({ sessionId: "claude:s1", attachId: "a1", cols: 80, rows: 24 });
    await live.send("claude:s1", "use /model");
    expect(tmux.typed).toEqual([]);
    expect(state(core, "claude:s1")).toMatchObject({ queue: [{ text: "use /model" }], queueHeld: true, queueHeldBy: "terminal" });
    expect(adapter.drivers.length).toBe(0);
    await live.interrupt("claude:s1");
    expect(tmux.pressed).toEqual([]);
    // The TUI writes to the store: the transcript follows.
    adapter.write("s1", [
      { id: "m1", role: "user", ts: 1, parts: [{ type: "text", text: "hi" }] },
      { id: "m2", role: "assistant", ts: 2, parts: [{ type: "text", text: "from the TUI" }] },
    ]);
    expect(frames.some((f) => f.t === "event" && f.event.type === "msg" && f.event.msg.id === "m2")).toBe(true);
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
    // They wait in the queue, in order, held for Back to Tether; nothing is typed into the TUI.
    expect(tmux.typed).toEqual([]);
    expect(state(core, "claude:s1").queue.map((m) => m.text)).toEqual(["late 8", "late 12", "late 20"]);
    expect(state(core, "claude:s1").queueHeldBy).toBe("terminal");
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

  test("a session isn't evicted while its terminal opens (Back to Tether and sends find the same one)", async () => {
    const { adapter, core, live, term, tmux } = setup();
    adapter.addStored("s1", []);
    // Opening arms the eviction (20 ms here): tmux is slower, and the session isn't in terminal mode yet.
    const create = tmux.create.bind(tmux);
    tmux.create = async (o) => (await Bun.sleep(60), create(o));
    await term.open({ sessionId: "claude:s1", attachId: "a1", cols: 80, rows: 24 });
    expect(core.sessions.get("claude:s1")?.state.mode).toBe("terminal");
    const back = term.end("claude:s1");
    const sent = live.send("claude:s1", "after");
    await back;
    await sent;
    expect(tmux.sessions.size).toBe(0);
    expect(adapter.drivers[0]!.sent).toEqual(["after"]);
  });

  test("a terminal that couldn't open leaves its session to be evicted as usual", async () => {
    const { adapter, core, term, tmux } = setup();
    adapter.addStored("s1", []);
    tmux.create = async () => (await Bun.sleep(40), Promise.reject(new Error("no tmux")));
    await expect(term.open({ sessionId: "claude:s1", attachId: "a1", cols: 80, rows: 24 })).rejects.toThrow("no tmux");
    await until(() => !core.sessions.has("claude:s1"));
  });

  test("a stored session the TUI moves to isn't evicted on the way", async () => {
    const { adapter, core, term, tmux } = setup();
    const next = "00000003-0000-4000-8000-000000000000";
    adapter.addStored("s1", [{ id: "m1", role: "user", ts: 1, parts: [{ type: "text", text: "hi" }] }]);
    adapter.addStored(next, [{ id: "m2", role: "user", ts: 1, parts: [{ type: "text", text: "there" }] }]);
    await core.subscribe("claude:s1");
    await term.open({ sessionId: "claude:s1", attachId: "a1", cols: 80, rows: 24 });
    const tag = tmux.tag.bind(tmux);
    tmux.tag = async (n, k, v) => (await Bun.sleep(60), tag(n, k, v));
    term.report({ sessionId: "claude:s1", event: "SessionStart", nativeId: next, source: "resume" });
    await until(() => state(core, "claude:s1").mode === "stored");
    expect(core.sessions.get(`claude:${next}`)?.state.mode).toBe("terminal");
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
    term.report({ sessionId: "claude:s1", event: "PermissionRequest", toolName: "Write", nativeId: "00000002-0000-4000-8000-000000000000" });
    expect(state(core, "claude:00000002-0000-4000-8000-000000000000").terminal?.attention).toBe("Claude needs your permission to use Write");
    void live;
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
    second.term.report({ sessionId: "claude:s1", event: "Elicitation", nativeId: "00000004-0000-4000-8000-000000000000" });
    expect(state(second.core, "claude:00000004-0000-4000-8000-000000000000").status).toBe("waiting");
    // Back to Tether resumes the session the TUI is on now.
    adapter.addStored("00000004-0000-4000-8000-000000000000", [{ id: "y", role: "user", ts: 1, parts: [{ type: "text", text: "x" }] }]);
    await second.term.end("claude:00000004-0000-4000-8000-000000000000");
    expect(state(second.core, "claude:00000004-0000-4000-8000-000000000000").mode).toBe("live");
    expect(adapter.drivers.at(-1)!.nativeId).toBe("00000004-0000-4000-8000-000000000000");
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

describe("review round 3", () => {
  test("after /clear, the old session's own TUI gets its own hooks (each TUI names itself)", async () => {
    const { adapter, core, term } = setup({ hookSocket: join(mkdtempSync(join(tmpdir(), "tether-hk-")), "hooks.sock") });
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
    // A's TUI reports (its hooks name the launch session A): A needs you, B doesn't.
    term.report({ sessionId: "claude:s1", tui: own, event: "PermissionRequest", toolName: "Bash", nativeId: "s1" });
    expect(state(core, "claude:s1").status).toBe("waiting");
    expect(state(core, `claude:${B}`).status).toBe("idle");
    // B's TUI (launched for A too) still reports to B.
    term.report({ sessionId: "claude:s1", tui: "t-claude-s1", event: "Notification", notificationType: "permission_prompt", message: "x", nativeId: B });
    expect(state(core, `claude:${B}`).status).toBe("waiting");
  });

});

describe("review round 7: while the TUI drives, only Needs you is tracked", () => {
  test("no Working or idle: prompts, tools, Stop, the interrupt marker change nothing, and no turn events", async () => {
    const { adapter, core, term, ev } = setup();
    adapter.addStored("s1", [{ id: "u", role: "user", ts: 1, parts: [{ type: "text", text: "hi" }] }]);
    await core.subscribe("claude:s1");
    await term.open({ sessionId: "claude:s1", attachId: "a1", cols: 80, rows: 24 });
    for (const event of ["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "StopFailure"]) {
      term.report({ sessionId: "claude:s1", event });
      expect(state(core, "claude:s1")).toMatchObject({ mode: "terminal", status: "idle" });
    }
    adapter.write("s1", [
      { id: "u", role: "user", ts: 1, parts: [{ type: "text", text: "hi" }] },
      { id: "n", role: "notice", ts: 2, parts: [{ type: "text", text: "Interrupted" }] },
    ]);
    await Bun.sleep(30);
    expect(state(core, "claude:s1").status).toBe("idle");
    expect(ev.filter((e) => e === "turnStarted" || e === "turnEnded")).toEqual([]);
  });

  test("Needs you: set by PermissionRequest, Elicitation or Notification, pushed once, never cleared by a hook (a subagent's tools)", async () => {
    const { adapter, core, term, tmux, ev } = setup({ clearAfterMs: 60_000 });
    adapter.addStored("s1", []);
    await term.open({ sessionId: "claude:s1", attachId: "a1", cols: 80, rows: 24 });
    tmux.screens.set("t-claude-s1", "ASK");
    term.report({ sessionId: "claude:s1", event: "PermissionRequest", toolName: "AskUserQuestion" });
    expect(state(core, "claude:s1")).toMatchObject({ status: "waiting", terminal: { attention: "Claude is asking you something." } });
    term.report({ sessionId: "claude:s1", event: "Notification", notificationType: "permission_prompt", message: "Claude needs your permission" });
    expect(state(core, "claude:s1").terminal?.attention).toBe("Claude is asking you something.");
    for (const event of ["PreToolUse", "PostToolUse", "Stop", "UserPromptSubmit"]) term.report({ sessionId: "claude:s1", event, toolName: "Bash" });
    await Bun.sleep(60);
    expect(state(core, "claude:s1").status).toBe("waiting");
    expect(ev.filter((e) => e.startsWith("attention:"))).toEqual(["attention:Claude is asking you something."]);
  });

  test("Needs you clears once the TUI's prompt shows (no dialog) for a while, not on a passing glimpse", async () => {
    const { adapter, core, term, tmux } = setup({ clearAfterMs: 80 });
    adapter.addStored("s1", []);
    await term.open({ sessionId: "claude:s1", attachId: "a1", cols: 80, rows: 24 });
    tmux.screens.set("t-claude-s1", "ASK");
    term.report({ sessionId: "claude:s1", event: "PermissionRequest", toolName: "Write" });
    // The prompt flashes between two dialogs: not long enough.
    tmux.screens.set("t-claude-s1", "IDLE");
    await Bun.sleep(30);
    tmux.screens.set("t-claude-s1", "ASK");
    await Bun.sleep(100);
    expect(state(core, "claude:s1").status).toBe("waiting");
    // A menu or an unreadable screen isn't evidence either.
    tmux.screens.set("t-claude-s1", "PICK");
    await Bun.sleep(120);
    expect(state(core, "claude:s1").status).toBe("waiting");
    tmux.screens.set("t-claude-s1", "working");
    await until(() => state(core, "claude:s1").status === "idle");
    expect(state(core, "claude:s1").terminal?.attention).toBeUndefined();
  });

  test("Back to Tether quits with /exit at an empty prompt, else Esc and Ctrl-C; Needs you goes with it", async () => {
    const tmux = new FakeTmux();
    const adapter = new TermAdapter();
    adapter.quitAtPrompt = [{ text: "/bye" }];
    const { core, term } = setup({ tmux, adapter });
    tmux.quitsOn = "/bye";
    adapter.addStored("s1", []);
    adapter.addStored("s2", []);
    await term.open({ sessionId: "claude:s1", attachId: "a1", cols: 80, rows: 24 });
    tmux.screens.set("t-claude-s1", "IDLE BOX:");
    await term.end("claude:s1");
    expect(tmux.typed).toEqual([["t-claude-s1", "/bye"]]);
    expect(state(core, "claude:s1").mode).toBe("live");
    // Something typed in its box (or a dialog): the keys instead, never /exit into it.
    await term.open({ sessionId: "claude:s2", attachId: "a2", cols: 80, rows: 24 });
    term.report({ sessionId: "claude:s2", event: "PermissionRequest", toolName: "Write" });
    tmux.screens.set("t-claude-s2", "IDLE BOX:a draft");
    tmux.quitsOn = "/exit";
    await term.end("claude:s2");
    expect(tmux.pressed.filter(([n]) => n === "t-claude-s2")[0]).toEqual(["t-claude-s2", "Escape"]);
    expect(state(core, "claude:s2")).toMatchObject({ mode: "live", status: "idle" });
    expect(state(core, "claude:s2").terminal).toBeUndefined();
  });

  test("after a restart: Driving in the terminal, no status inferred; a question on screen is Needs you (no new push)", async () => {
    const tmux = new FakeTmux();
    const first = setup({ tmux });
    for (const id of ["s1", "s2"]) {
      first.adapter.addStored(id, []);
      await first.term.open({ sessionId: `claude:${id}`, attachId: `a-${id}`, cols: 80, rows: 24 });
    }
    first.term.stop();
    first.core.stop();
    tmux.screens.set("t-claude-s1", "working");
    tmux.screens.set("t-claude-s2", "ASK");
    const adapter = new TermAdapter();
    adapter.addStored("s1", [{ id: "u", role: "user", ts: 1, parts: [{ type: "text", text: "count" }] }]);
    adapter.addStored("s2", []);
    const second = setup({ tmux, adapter, prefsFile: first.prefsFile, clearAfterMs: 60_000 });
    await second.term.readopt();
    expect(state(second.core, "claude:s1")).toMatchObject({ mode: "terminal", status: "idle" });
    expect(state(second.core, "claude:s2")).toMatchObject({ status: "waiting", terminal: { attention: "Claude needs you in the terminal." } });
    expect(second.ev.filter((e) => e.startsWith("attention:"))).toEqual([]);
  });
});

describe("review round 8: the edges of the simple model", () => {
  const BNEW = "9b0c7c1e-2f0a-4a55-9d0e-222222222222";
  const prompt = (id: string, text = "hi") => ({ id, role: "user" as const, ts: 1, parts: [{ type: "text" as const, text }] });

  test("/clear or /resume onto a stored session carries the TUI's model and mode, for Back to Tether too", async () => {
    const { adapter, core, term } = setup();
    adapter.addStored("s1", [prompt("m1")]);
    adapter.addStored(BNEW, [prompt("m2")]);
    await core.open("claude:s1");
    core.sessions.get("claude:s1")!.setState({ model: "haiku", effort: "low", permissionMode: "acceptEdits" });
    await term.open({ sessionId: "claude:s1", attachId: "a1", cols: 80, rows: 24 });
    term.report({ sessionId: "claude:s1", event: "SessionStart", nativeId: BNEW, source: "resume" });
    await until(() => core.sessions.get(`claude:${BNEW}`)?.state.mode === "terminal");
    term.report({ sessionId: "claude:s1", event: "PreToolUse", permissionMode: "acceptEdits" });
    expect(state(core, `claude:${BNEW}`)).toMatchObject({ model: "haiku", effort: "low", permissionMode: "acceptEdits" });
    expect(core.o.prefs.get(`claude:${BNEW}`)).toMatchObject({ model: "haiku", effort: "low", permissionMode: "acceptEdits" });
    await term.end(`claude:${BNEW}`);
    expect(adapter.drivers.at(-1)!.opts).toMatchObject({ model: "haiku", effort: "low", permissionMode: "acceptEdits" });
  });

  test("a queue held for a terminal that is gone after a restart waits for Resume, not for ever", async () => {
    const tmux = new FakeTmux();
    const first = setup({ tmux });
    first.adapter.addStored("s1", [prompt("m1")]);
    await first.term.open({ sessionId: "claude:s1", attachId: "a1", cols: 80, rows: 24 });
    await first.live.send("claude:s1", "waits");
    first.term.stop();
    first.core.stop();
    first.core.o.prefs.flush();
    tmux.sessions.clear(); // the TUI died while the runner was away
    const adapter = new TermAdapter();
    adapter.addStored("s1", [prompt("m1")]);
    const second = setup({ tmux, adapter, prefsFile: first.prefsFile });
    await second.term.readopt();
    await second.live.queue.restore();
    expect(state(second.core, "claude:s1")).toMatchObject({ queueHeld: true, queueHeldBy: "restart" });
    await second.live.queue.resume("claude:s1");
    await until(() => adapter.drivers[0]?.sent.includes("waits") === true);
  });

  test("a queue on a TUI that outlived the restart stays held for it; an untouched new session's queue too", async () => {
    const tmux = new FakeTmux();
    const first = setup({ tmux });
    const dir = mkdtempSync(join(tmpdir(), "tether-proj-"));
    const { sessionId } = await first.live.newSession({ harness: "claude", projectPath: dir, model: "haiku", terminal: true });
    await first.live.send(sessionId, "first words");
    first.term.stop();
    first.core.stop();
    first.core.o.prefs.flush();
    const second = setup({ tmux, adapter: new TermAdapter(), prefsFile: first.prefsFile });
    await second.term.readopt();
    await second.live.queue.restore();
    expect(state(second.core, sessionId)).toMatchObject({ mode: "terminal", queueHeld: true, queueHeldBy: "terminal", queue: [{ text: "first words" }] });
  });

  test("a prompt typed in a new TUI that never reached the store: Back to Tether starts the session, it doesn't resume nothing", async () => {
    const { adapter, core, live, term } = setup();
    const dir = mkdtempSync(join(tmpdir(), "tether-proj-"));
    const { sessionId } = await live.newSession({ harness: "claude", projectPath: dir, terminal: true });
    term.report({ sessionId, event: "UserPromptSubmit" });
    await term.end(sessionId);
    expect(state(core, sessionId).mode).toBe("live");
    expect(adapter.drivers.length).toBe(1);
    expect(adapter.resumed).toEqual([]);
  });

  test("/exit typed in a TUI nobody used: its store holds only that, so the session never was", async () => {
    const { adapter, core, live, tmux } = setup();
    const dir = mkdtempSync(join(tmpdir(), "tether-proj-"));
    const { sessionId } = await live.newSession({ harness: "claude", projectPath: dir, terminal: true });
    adapter.addStored("new-1", [prompt("m1", "/exit")], { projectPath: dir });
    adapter.neverStarted = async () => true;
    tmux.sessions.clear();
    await until(() => !core.sessions.has(sessionId));
  });

  test("a new TUI that exits with a message waiting stays, to start when you send", async () => {
    const { core, live, tmux } = setup();
    const dir = mkdtempSync(join(tmpdir(), "tether-proj-"));
    const { sessionId } = await live.newSession({ harness: "claude", projectPath: dir, terminal: true });
    await live.send(sessionId, "keep me");
    tmux.sessions.clear();
    await until(() => state(core, sessionId).mode === "stored");
    await Bun.sleep(40);
    expect(core.sessions.has(sessionId)).toBe(true);
    expect(state(core, sessionId).queue.map((m) => m.text)).toEqual(["keep me"]);
  });

  test("a subagent's hook doesn't change the session's mode", async () => {
    const { adapter, core, term } = setup();
    adapter.addStored("s1", []);
    await term.open({ sessionId: "claude:s1", attachId: "a1", cols: 80, rows: 24 });
    const before = state(core, "claude:s1").permissionMode;
    term.report({ sessionId: "claude:s1", event: "PreToolUse", permissionMode: "bypassPermissions", agentId: "ag1" });
    expect(state(core, "claude:s1").permissionMode).toBe(before);
    term.report({ sessionId: "claude:s1", event: "PreToolUse", permissionMode: "plan" });
    expect(state(core, "claude:s1").permissionMode).toBe("plan");
  });

  test("a queued message going out as a handoff takes over goes back to the front, as it was", async () => {
    const { adapter, core, live, term } = setup();
    adapter.addStored("s1", []);
    await term.open({ sessionId: "claude:s1", attachId: "a1", cols: 80, rows: 24 });
    await expect(live.send("claude:s1", "one", [], { queued: true })).rejects.toThrow(/terminal is driving/);
    expect(state(core, "claude:s1").queue).toEqual([]);
  });

  test("Back to Tether leaves copy mode first, and vim's NORMAL mode gets the keys, not /exit", async () => {
    const tmux = new FakeTmux();
    const adapter = new TermAdapter();
    adapter.quitAtPrompt = [{ text: "/bye" }];
    const { term } = setup({ tmux, adapter });
    adapter.addStored("s1", []);
    await term.open({ sessionId: "claude:s1", attachId: "a1", cols: 80, rows: 24 });
    tmux.screens.set("t-claude-s1", "IDLE VIM BOX:");
    await term.end("claude:s1");
    expect(tmux.left).toEqual(["t-claude-s1"]);
    expect(tmux.typed.map(([, t]) => t)).toEqual(["/exit"]);
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
    // No status inferred: "Driving in the terminal". Hooks keep working, and Back to Tether too.
    expect(state(second.core, "claude:s1").status).toBe("idle");
    second.term.report({ sessionId: "claude:s1", event: "PermissionRequest", toolName: "Write" });
    expect(state(second.core, "claude:s1").status).toBe("waiting");
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

test("the TUI's permission mode (Shift+Tab there) comes with every hook: shown, refused from Tether, kept for Back to Tether", async () => {
  const { adapter, core, live, term } = setup();
  adapter.addStored("s1", []);
  await term.open({ sessionId: "claude:s1", attachId: "a1", cols: 80, rows: 24 });
  term.report({ sessionId: "claude:s1", event: "UserPromptSubmit", nativeId: "s1", permissionMode: "acceptEdits" });
  expect(state(core, "claude:s1").permissionMode).toBe("acceptEdits");
  expect(core.o.prefs.get("claude:s1").permissionMode).toBe("acceptEdits");
  await expect(live.setPermissionMode("claude:s1", "default")).rejects.toThrow("terminal is driving");
  expect(state(core, "claude:s1").permissionMode).toBe("acceptEdits");
});

describe("review round 9", () => {
  const S = "claude:s1";
  /** a stored session with its TUI up, in `mode`, and a fake store of mode entries */
  const inTui = async (mode: string, entries: { mode?: string; entries: number } = { entries: 3, mode }) => {
    const x = setup();
    const store = { ...entries };
    x.adapter.storedMode = async () => store;
    x.adapter.addStored("s1", []);
    await x.core.subscribe(S);
    await x.live.setPermissionMode(S, mode);
    await x.term.open({ sessionId: S, attachId: "a1", cols: 80, rows: 24 });
    return { ...x, store };
  };

  test("Shift+Tab with no hook after it: the mode on the status line goes with Back, and shows before it", async () => {
    const { adapter, core, term, tmux } = await inTui("acceptEdits");
    tmux.screens.set("t-claude-s1", "IDLE MODE:default");
    await until(() => state(core, S).permissionMode === "default");
    expect(core.o.prefs.get(S).permissionMode).toBe("default");
    await term.end(S);
    expect(adapter.drivers.at(-1)!.opts.permissionMode).toBe("default");
  });

  test("Shift+Tab just before Back: read off the screen as it quits", async () => {
    const { adapter, term, tmux } = await inTui("acceptEdits");
    tmux.screens.set("t-claude-s1", "IDLE MODE:default");
    await term.end(S);
    expect(adapter.drivers.at(-1)!.opts.permissionMode).toBe("default");
  });

  test("the entry Claude wrote as it exited counts, one from before this TUI doesn't", async () => {
    const a = await inTui("default", { entries: 3, mode: "acceptEdits" });
    a.term.report({ sessionId: S, event: "PreToolUse", permissionMode: "default" });
    await a.term.end(S);
    expect(a.adapter.drivers.at(-1)!.opts.permissionMode).toBe("default");
    const b = await inTui("acceptEdits");
    Object.assign(b.store, { entries: 4, mode: "plan" });
    await b.term.end(S);
    expect(b.adapter.drivers.at(-1)!.opts.permissionMode).toBe("plan");
  });

  test("screen and store differ: the tighter", async () => {
    const { adapter, term, tmux, store } = await inTui("acceptEdits");
    tmux.screens.set("t-claude-s1", "ODD MODE:default");
    term.report({ sessionId: S, event: "PreToolUse", permissionMode: "default" });
    Object.assign(store, { entries: 4, mode: "acceptEdits" });
    await term.end(S);
    expect(adapter.drivers.at(-1)!.opts.permissionMode).toBe("default");
  });

  test("a killed TUI, neither screen nor store knows: at most default; plan stays", async () => {
    for (const [from, to] of [["bypassPermissions", "default"], ["acceptEdits", "default"], ["plan", "plan"]] as const) {
      const { core, tmux } = await inTui(from);
      tmux.sessions.clear();
      await until(() => state(core, S).mode === "stored");
      expect(state(core, S).permissionMode).toBe(to);
      expect(core.o.prefs.get(S).permissionMode).toBe(to);
    }
  });

  test("background shells on the status line reach the state, for the question", async () => {
    const { core, tmux } = await inTui("default");
    tmux.screens.set("t-claude-s1", "IDLE BG");
    await until(() => state(core, S).terminal?.background === true);
    tmux.screens.set("t-claude-s1", "IDLE");
    await until(() => !state(core, S).terminal?.background);
  });

  test("/clear in a session started in the terminal: once its store has it, a message resumes it", async () => {
    const { adapter, core, live, term } = setup();
    const dir = mkdtempSync(join(tmpdir(), "tether-proj-"));
    const { sessionId } = await live.newSession({ harness: "claude", projectPath: dir, terminal: true });
    adapter.addStored("new-1", [{ id: "m1", role: "user", ts: 1, parts: [{ type: "text", text: "hello" }] }], { projectPath: dir });
    const next = "00000009-0000-4000-8000-000000000000";
    term.report({ sessionId, event: "SessionStart", nativeId: next, source: "clear" });
    await until(() => state(core, sessionId).mode === "stored");
    await until(() => !core.sessions.get(sessionId)!.fresh);
    await live.send(sessionId, "still there?");
    expect(adapter.resumed).toContain("new-1");
  });

  test("a resume that fails on Back to Tether leaves the queue paused, with Resume", async () => {
    const { adapter, core, live, term } = await inTui("default");
    await live.send(S, "later");
    adapter.startError = "boom";
    await term.end(S);
    expect(state(core, S)).toMatchObject({ mode: "stored", error: "boom", queueHeld: true, queueHeldBy: "stopped" });
    adapter.startError = undefined;
    await live.queue.resume(S);
    await until(() => state(core, S).queue.length === 0);
    expect(adapter.drivers.length).toBe(1);
  });
});
