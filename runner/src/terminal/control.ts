// Terminal mode (SPEC §8): the harness's own TUI in tmux, mirrored to browsers, and the project's
// plain shells beside it.
//
// Handoff (capabilities.terminal = "handoff", Claude): two processes can't drive one session, so
// control moves. Opening the terminal stops the turn if asked to (the UI asks first), closes the
// driver (the harness flushes its store), cancels open requests (the TUI asks again), holds queued
// messages, and starts the TUI on the same session in tmux. The mode becomes `terminal`: the TUI
// drives, the transcript is tailed from the store (read-only), and hooks report turn ends and
// "needs you" (hooks.ts). Back to Tether asks the TUI to quit (killed after 5 s) and resumes the
// driver on the same session: the mode becomes `live`. If the TUI exits by itself, `stored`.
//
// Shared (capabilities.terminal = "shared", Codex in P4): the TUI joins the live thread beside
// Tether. Nothing changes mode and the driver keeps going; closing just detaches, and Back to
// Tether only quits the TUI. The seam is here; the Codex adapter supplies the launch in P4.
//
// Every terminal is its own tmux session (tmux.ts), so it survives a runner restart: at start the
// runner lists them and readopts the TUIs. Each attached browser gets its own PTY (attach.ts).

import { parseSessionId } from "../../../shared/ids";
import { TERMINAL_BUSY, TERMINAL_CLOSED, type RunnerToServer, type ShellInfo } from "../../../shared/protocol";
import type { LiveState } from "../../../shared/transcript";
import type { QuitStep, TerminalOpts } from "../core/adapter";
import type { LiveControl } from "../core/live";
import type { Session } from "../core/session";
import type { SessionCore } from "../core/sessions";
import { Transcript } from "../core/transcript";
import { Attaches, type SpawnPty } from "./attach";
import { HookServer, type HookReport } from "./hooks";
import { cleanEnv, projectKey, shellName, Tmux, tuiName } from "./tmux";

export interface TerminalOptions {
  core: SessionCore;
  live: LiveControl;
  tmux: Tmux;
  /** sends to the app; false when disconnected */
  send: (m: RunnerToServer) => boolean;
  /** bytes waiting in the connection's send buffer */
  buffered: () => number;
  /** the Unix socket hooks report to (null: no hooks, e.g. tests) */
  hookSocket: string | null;
  spawn?: SpawnPty;
  /** how often tmux is checked for TUIs that exited */
  pollMs?: number;
  /** how long a TUI gets to quit before it is killed */
  quitTimeoutMs?: number;
  /** the shell a project shell runs */
  shell?: string;
  /** the pause between typed text and its Enter */
  enterDelayMs?: number;
  /** how long typing waits for a new TUI's SessionStart */
  startWaitMs?: number;
  log?: (line: string) => void;
}

/** Notification types that mean Claude waits on the person. */
const NEEDS_YOU = new Set(["permission_prompt", "elicitation_dialog"]);

export class TerminalControl {
  readonly attaches: Attaches;
  private hooks?: HookServer;
  /** sessions whose TUI runs in tmux */
  private tuis = new Set<string>();
  /** Back to Tether under way */
  private returning = new Set<string>();
  private entering = new Map<string, Promise<void>>();
  /**
   * TUIs just started: typing waits until they report SessionStart (or a few seconds pass). Text
   * that arrives before the TUI puts its terminal in raw mode comes through as a pasted line, and
   * its Enter as a newline.
   */
  private starting = new Map<string, { ready: Promise<void>; done: () => void }>();
  private poll?: ReturnType<typeof setInterval>;
  private polling = false;
  private readonly log: (line: string) => void;

  constructor(private o: TerminalOptions) {
    this.log = o.log ?? ((l) => console.log(l));
    this.attaches = new Attaches({ send: o.send, buffered: o.buffered }, { spawn: o.spawn, onExit: (target) => void this.attachExited(target) });
    o.live.terminal = { send: (s, t) => this.type(s, t), interrupt: (s) => this.interrupt(s), startIn: (s) => this.enter(s, { fresh: true }) };
  }

  get tmux() {
    return this.o.tmux;
  }

  async start() {
    if (this.o.hookSocket) {
      this.hooks = new HookServer(this.o.hookSocket, (r) => this.report(r));
      try {
        this.hooks.start();
      } catch (e: any) {
        this.log(`terminal hooks are off: can't listen on ${this.o.hookSocket}: ${e?.message ?? e}`);
        this.hooks = undefined;
      }
    }
    await this.readopt().catch((e) => this.log(`couldn't readopt terminals: ${e?.message ?? e}`));
  }

  /** The runner stops: browsers' PTYs close; the tmux sessions go on without it. */
  stop() {
    clearInterval(this.poll);
    this.poll = undefined;
    this.attaches.closeAll();
    this.hooks?.stop();
  }

  // ---------------- ops ----------------

  async open(a: { sessionId?: string; shellId?: string; attachId: string; cols: number; rows: number; stop?: boolean; reattach?: boolean }): Promise<{ attachId: string; target: string }> {
    let target: string;
    if (a.shellId) {
      const sh = (await this.o.tmux.list()).find((t) => t.kind === "shell" && t.name === a.shellId);
      if (!sh) throw new Error(TERMINAL_CLOSED);
      target = sh.name;
    } else if (a.sessionId) {
      const s = await this.o.core.open(a.sessionId);
      if (s.summary.parentSessionId) throw new Error("A subagent runs inside its main session. Open the main session's terminal.");
      if (a.reattach && (!this.tuis.has(s.id) || this.returning.has(s.id))) throw new Error(TERMINAL_CLOSED);
      await this.enter(s, { stop: a.stop, cols: a.cols, rows: a.rows });
      target = tuiName(s.id);
    } else throw new Error("Say which terminal to open.");
    this.attaches.open(a.attachId, target, this.o.tmux.argv("attach-session", "-t", `=${target}`), a.cols, a.rows, { ...cleanEnv(), TERM: "xterm-256color" });
    return { attachId: a.attachId, target };
  }

  input(attachId: string, data: string) {
    this.attaches.input(attachId, data);
  }

  resize(attachId: string, cols: number, rows: number) {
    this.attaches.resize(attachId, cols, rows);
  }

  /** The browser closed the panel (closeTerminal) or went away (detach). */
  detach(attachIds: string[]) {
    for (const id of attachIds) this.attaches.close(id);
  }

  /** Back to Tether (SPEC §8). */
  async end(sessionId: string, whenIdle = false) {
    const s = await this.o.core.open(sessionId);
    const term = s.state.terminal;
    if (!this.tuis.has(s.id) || !term) {
      // Nothing runs any more (it exited a moment ago): a handoff session just goes live.
      if (s.state.mode === "terminal") await this.backLive(s);
      return;
    }
    if (whenIdle && term.kind === "handoff" && s.state.status !== "idle") {
      s.setState({ terminal: { ...term, returnWhenIdle: true } });
      return;
    }
    if (this.returning.has(s.id)) return;
    this.returning.add(s.id);
    s.setState({ terminal: { ...term, returning: true, returnWhenIdle: undefined } });
    const name = tuiName(s.id);
    try {
      await this.runQuit(name, this.launch(s).quit ?? []);
      const until = Date.now() + (this.o.quitTimeoutMs ?? 5000);
      while (Date.now() < until && (await this.o.tmux.has(name))) await Bun.sleep(150);
      if (await this.o.tmux.has(name)) {
        this.log(`${s.id}: the TUI didn't quit; killing it`);
        await this.o.tmux.kill(name);
      }
    } catch (e: any) {
      this.log(`${s.id}: quitting the TUI failed (${e?.message ?? e}); killing it`);
      await this.o.tmux.kill(name).catch(() => {});
    }
    await this.gone(s.id);
  }

  async listShells(projectPath: string): Promise<ShellInfo[]> {
    const path = this.o.core.folder(projectPath);
    return (await this.o.tmux.list())
      .filter((t) => t.kind === "shell" && t.projectPath === path)
      .map((t) => ({ id: t.name, projectPath: t.projectPath, n: t.n ?? 0, ...(t.command ? { command: t.command } : {}) }))
      .sort((a, b) => a.n - b.n);
  }

  async newShell(projectPath: string, cols?: number, rows?: number): Promise<ShellInfo> {
    const path = this.o.core.folder(projectPath);
    const have = await this.listShells(path);
    const n = Math.max(0, ...have.map((s) => s.n)) + 1;
    const name = shellName(projectKey(path), n);
    const shell = this.o.shell ?? process.env.SHELL ?? "/bin/bash";
    await this.o.tmux.create({ name, cwd: path, argv: [shell], cols, rows, tags: { kind: "shell", project: path, n: String(n) } });
    return { id: name, projectPath: path, n };
  }

  async closeShell(shellId: string) {
    const sh = (await this.o.tmux.list()).find((t) => t.kind === "shell" && t.name === shellId);
    if (!sh) return;
    await this.o.tmux.kill(sh.name);
    this.attaches.endTarget(sh.name, "exited");
  }

  // ---------------- handoff ----------------

  /** Puts a session's TUI in tmux, handing the session over when the harness needs that. */
  enter(s: Session, o: { stop?: boolean; cols?: number; rows?: number; fresh?: boolean }): Promise<void> {
    if (this.tuis.has(s.id) && !this.returning.has(s.id)) return Promise.resolve();
    let p = this.entering.get(s.id);
    if (!p) {
      p = this.doEnter(s, o).finally(() => this.entering.delete(s.id));
      this.entering.set(s.id, p);
    }
    return p;
  }

  private async doEnter(s: Session, o: { stop?: boolean; cols?: number; rows?: number; fresh?: boolean }) {
    if (this.returning.has(s.id)) throw new Error("The terminal is closing. Try again in a moment.");
    const name = tuiName(s.id);
    // Already there (another device opened it, or it outlived a runner restart).
    if (await this.o.tmux.has(name)) return this.adopt(s);
    const handoff = s.capabilities.terminal === "handoff";
    if (handoff && !o.fresh) {
      const busy = s.state.status !== "idle" || !!s.sending;
      if (busy && !o.stop) throw new Error(TERMINAL_BUSY);
      if (busy) {
        await this.o.live.interrupt(s.id).catch(() => {});
        const until = Date.now() + 10_000;
        while (s.state.status !== "idle" && Date.now() < until) await Bun.sleep(100);
      }
      await this.o.live.release(s);
    }
    // A new session that has nothing in the store yet starts under its id; anything else resumes.
    if (s.fresh && (await this.stored(s))) s.fresh = false;
    const launch = this.launch(s, { fresh: s.fresh, report: handoff && this.hooks ? { socketPath: this.hooks.socketPath, sessionId: s.id } : undefined });
    try {
      await this.o.tmux.create({ name, cwd: s.summary.projectPath, argv: launch.argv, env: launch.env, cols: o.cols, rows: o.rows, tags: { kind: "tui", session: s.id, project: s.summary.projectPath } });
    } catch (e: any) {
      const error = `Couldn't open the terminal: ${e?.message ?? e}`;
      // Handed off already: it stays stored rather than pretending to be live.
      if (handoff && !s.live && s.state.mode === "live") this.o.live.setMode(s, "stored", { status: "idle", error });
      throw new Error(error);
    }
    if (handoff && this.hooks) this.expectStart(s.id);
    this.adopt(s);
    if (handoff && s.state.queue.length) s.setState({ queueHeld: true });
  }

  /** The session's TUI runs in tmux: its state says so. */
  private adopt(s: Session) {
    this.tuis.add(s.id);
    if (s.capabilities.terminal === "handoff") {
      this.o.live.setMode(s, "terminal", { status: "idle", terminal: { kind: "handoff" }, error: undefined });
      // The read-only transcript, tailed from the store while someone watches (SPEC §8).
      this.o.core.tail(s);
    } else {
      s.setState({ terminal: { kind: "shared" } });
      this.o.core.touch(s);
    }
    this.startPoll();
  }

  private launch(s: Session, extra: Pick<TerminalOpts, "fresh" | "report"> = {}) {
    const st = s.state;
    return this.o.core.adapter(s.summary.harness).terminalCommand(s.summary.nativeId, s.summary.projectPath, { model: st.model, effort: st.effort, permissionMode: st.permissionMode, ...extra });
  }

  private async stored(s: Session) {
    return !!(await this.o.core.adapter(s.summary.harness).sessionInfo(s.summary.nativeId, s.summary.projectPath).catch(() => undefined));
  }

  /** A session's TUI is gone from tmux (quit, exited, killed). */
  private async gone(id: string) {
    if (!this.tuis.delete(id)) return;
    const back = this.returning.delete(id);
    const name = tuiName(id);
    this.attaches.endTarget(name, "exited");
    const s = this.o.core.sessions.get(id);
    if (!s) return;
    if (s.capabilities.terminal === "shared") {
      s.setState({ terminal: undefined });
      this.o.core.touch(s);
      return;
    }
    if (s.fresh && (await this.stored(s))) s.fresh = false;
    if (back) return this.backLive(s);
    // It exited by itself (/exit): stored (SPEC §8).
    await this.o.core.syncFromStore(s);
    this.o.live.setMode(s, "stored", { status: "idle", terminal: undefined });
    if (s.fresh) {
      // Nothing was ever typed: nothing of it is in any store.
      this.o.core.book.remove([s.id]);
      this.o.core.sessions.delete(s.id);
      return;
    }
    this.o.core.tail(s);
    this.o.core.scheduleEvict(s);
  }

  /** Back to Tether: the driver resumes on the same session (a new one that never got a message starts). */
  private async backLive(s: Session) {
    await this.o.core.syncFromStore(s);
    s.setState({ terminal: undefined, status: "idle" });
    try {
      await this.o.live.resumeLive(s);
    } catch {
      // startDriver already made it stored with the error in its state and transcript.
    }
  }

  private async runQuit(name: string, steps: QuitStep[]) {
    for (const [i, st] of steps.entries()) {
      // Quit already: the rest would go nowhere.
      if (i > 0 && !("waitMs" in st) && !(await this.o.tmux.has(name))) return;
      if ("waitMs" in st) await Bun.sleep(st.waitMs);
      else if ("keys" in st) await this.o.tmux.keys(name, ...st.keys);
      else await this.o.tmux.type(name, st.text);
    }
  }

  // ---------------- typing into the TUI ----------------

  /** Typing waits for this TUI to report that it started (SessionStart), at most a few seconds. */
  private expectStart(id: string) {
    let done!: () => void;
    const ready = new Promise<void>((r) => (done = r));
    const t = setTimeout(() => finish(), this.o.startWaitMs ?? 8000);
    const finish = () => {
      clearTimeout(t);
      if (this.starting.get(id)?.ready === ready) this.starting.delete(id);
      done();
    };
    this.starting.set(id, { ready, done: finish });
  }

  /** The composer in terminal mode: the text, then Enter (SPEC §8, §9). */
  private async type(s: Session, text: string) {
    const name = tuiName(s.id);
    if (!this.tuis.has(s.id)) throw new Error("The terminal has closed.");
    await this.starting.get(s.id)?.ready;
    await this.o.tmux.type(name, text);
    // A beat between the text and Enter: a TUI that reads a burst as a paste (Claude) would take
    // the Enter as a newline, and one still starting up may drop it.
    await Bun.sleep(this.o.enterDelayMs ?? 150);
    await this.o.tmux.keys(name, "Enter");
  }

  /** Stop in terminal mode: Esc in the TUI (Claude stops its turn). */
  private async interrupt(s: Session) {
    if (this.tuis.has(s.id)) await this.o.tmux.keys(tuiName(s.id), "Escape");
  }

  // ---------------- hooks: status in terminal mode ----------------

  report(r: HookReport) {
    const s = this.o.core.sessions.get(r.sessionId);
    if (!s || !this.tuis.has(s.id) || s.state.mode !== "terminal" || !s.state.terminal) return;
    const term = s.state.terminal;
    if (r.nativeId && r.nativeId !== s.summary.nativeId && r.event !== "SessionEnd") this.log(`${s.id}: the TUI is now on session ${r.nativeId} (${r.event}${r.source ? ` ${r.source}` : ""})`);
    switch (r.event) {
      case "SessionStart":
        // Its input is live a moment after it says it started.
        setTimeout(() => this.starting.get(s.id)?.done(), 300);
        break;
      case "UserPromptSubmit":
        // Something was typed: the store has the session from here on.
        s.fresh = false;
        this.status(s, "running", { ...term, attention: undefined });
        break;
      case "PostToolUse":
        if (s.state.status === "waiting") this.status(s, "running", { ...term, attention: undefined });
        break;
      case "Notification":
        if (!NEEDS_YOU.has(r.notificationType ?? "") && !(r.notificationType === undefined && /permission|approv/i.test(r.message ?? ""))) break;
        this.status(s, "waiting", { ...term, attention: r.message ?? "Claude needs you in the terminal." });
        this.o.core.o.bus.emit("attention", { sessionId: s.id, message: r.message });
        break;
      case "Stop":
      case "StopFailure":
        this.status(s, "idle", { ...term, attention: undefined, returnWhenIdle: undefined });
        if (term.returnWhenIdle) void this.end(s.id).catch((e) => this.log(`${s.id}: back to Tether failed: ${e?.message ?? e}`));
        break;
    }
  }

  private status(s: Session, status: LiveState["status"], terminal: NonNullable<LiveState["terminal"]>) {
    const before = s.state.status;
    s.setState({ status, terminal });
    if (status === before) return void this.o.core.touch(s);
    const bus = this.o.core.o.bus;
    if (status === "running" && before === "idle") bus.emit("turnStarted", { sessionId: s.id });
    if (status === "idle") bus.emit("turnEnded", { sessionId: s.id });
    this.o.core.touch(s, { updatedAt: this.o.core.now() });
  }

  // ---------------- tmux ----------------

  /** At start: TUIs that outlived the last runner are this runner's again (SPEC §8). */
  async readopt() {
    for (const t of await this.o.tmux.list()) {
      if (t.kind !== "tui" || !t.sessionId) continue;
      let s = await this.o.core.open(t.sessionId).catch(() => undefined);
      if (!s) {
        // A new session nothing was typed into yet: the store doesn't know it.
        const p = parseSessionId(t.sessionId);
        if (!p) continue;
        try {
          const prefs = this.o.core.o.prefs.get(t.sessionId);
          s = this.o.core.create(p.harness, p.nativeId, t.projectPath, { model: prefs.model, effort: prefs.effort, permissionMode: prefs.permissionMode });
          s.transcript = new Transcript();
        } catch {
          continue;
        }
      }
      this.adopt(s);
      this.log(`readopted the terminal of ${s.id}`);
    }
  }

  private startPoll() {
    if (this.poll) return;
    this.poll = setInterval(() => void this.check(), this.o.pollMs ?? 1000);
    this.poll.unref?.();
  }

  /** Looks for TUIs that are gone. */
  private async check() {
    if (this.polling) return;
    this.polling = true;
    try {
      if (!this.tuis.size) {
        clearInterval(this.poll);
        this.poll = undefined;
        return;
      }
      const live = new Set((await this.o.tmux.list()).map((t) => t.name));
      for (const id of [...this.tuis]) if (!live.has(tuiName(id)) && !this.returning.has(id)) await this.gone(id);
    } finally {
      this.polling = false;
    }
  }

  /** An attach's PTY ended by itself: its tmux session may be gone. */
  private async attachExited(target: string) {
    if (await this.o.tmux.has(target)) return;
    const id = [...this.tuis].find((x) => tuiName(x) === target);
    if (id && !this.returning.has(id)) await this.gone(id);
  }
}
