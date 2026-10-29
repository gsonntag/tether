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
import type { QuitStep, TerminalOpts } from "../core/adapter";
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
    if (this.sessions.has(o.name)) throw new Error(`duplicate session: ${o.name}`);
    this.sessions.set(o.name, { name: o.name, kind: o.tags.kind as any, sessionId: o.tags.session, projectPath: o.tags.project!, n: o.tags.n ? Number(o.tags.n) : undefined, argv: o.argv, cols: o.cols, rows: o.rows });
  }
  override async kill(name: string) {
    this.sessions.delete(name);
  }
  override async keys(name: string, ...keys: string[]) {
    for (const k of keys) this.pressed.push([name, k]);
  }
  override async type(name: string, text: string) {
    this.typed.push([name, text]);
    if (this.quitsOn !== null && text === this.quitsOn) this.sessions.delete(name);
  }
}

const QUIT: QuitStep[] = [{ keys: ["Escape"] }, { text: "/exit" }, { keys: ["Enter"] }];

class TermAdapter extends FakeAdapter {
  launches: { nativeId: string; opts: TerminalOpts }[] = [];
  constructor(caps?: Partial<HarnessCapabilities>) {
    super();
    if (caps) this.capabilities = { ...this.capabilities, ...caps };
  }
  override terminalCommand(nativeId: string, _p: string, opts: TerminalOpts) {
    this.launches.push({ nativeId, opts });
    return { argv: ["tui", opts.fresh ? "--session-id" : "--resume", nativeId], quit: QUIT };
  }
}

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((f) => f()));

function setup(o: { adapter?: TermAdapter; tmux?: FakeTmux; prefsFile?: string; hookSocket?: string } = {}) {
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
  const term = new TerminalControl({ core, live, tmux, send, buffered: () => 0, hookSocket: o.hookSocket ?? null, spawn: (argv, opts) => new FakePty(argv, opts), pollMs: 10, quitTimeoutMs: 200, shell: "sh", enterDelayMs: 0, log: () => {} });
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
    expect(t).toMatchObject({ kind: "tui", sessionId: "claude:s1", projectPath: "/p" });
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

  test("subagents have no terminal of their own", async () => {
    const { adapter, term } = setup();
    adapter.addStored("s1/agent", [], { parentSessionId: "claude:s1" });
    await expect(term.open({ sessionId: "claude:s1/agent", attachId: "a1", cols: 80, rows: 24 })).rejects.toThrow(/main session/);
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
