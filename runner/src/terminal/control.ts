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
// Shared (capabilities.terminal = "shared", Codex): the TUI joins the live thread beside Tether.
// The session goes live first if it isn't (Tether stays attached, so requests, status and the
// transcript keep working), nothing changes mode, and both can type; closing just detaches, and
// Back to Tether only quits the TUI.
//
// Every terminal is its own tmux session (tmux.ts), so it survives a runner restart: at start the
// runner lists them and readopts the TUIs. Each attached browser gets its own PTY (attach.ts).

import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { parseSessionId, sessionId as makeId } from "../../../shared/ids";
import { TERMINAL_BUSY, TERMINAL_CLOSED, type RunnerToServer, type ShellInfo } from "../../../shared/protocol";
import type { LiveState, Msg } from "../../../shared/transcript";
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
  /** how long without a hook before a busy TUI's screen is looked at */
  quietMs?: number;
  log?: (line: string) => void;
}

/** Notification types that mean Claude waits on the person. */
const NEEDS_YOU = new Set(["permission_prompt", "elicitation_dialog"]);

/** What the composer says while the TUI is asking something (the key bar still reaches it). */
export const ANSWER_THERE = "Claude is asking something in the terminal. Answer it there.";
/** A just-started TUI that never reported in: most likely Claude's "trust this folder" question. */
export const NOT_STARTED = "Claude Code hasn't started yet. If it asks whether to trust this folder, answer in the terminal.";
export const HANDING_OFF = "The session is moving to the terminal. Type there in a moment.";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The model family of a model id or alias ("claude-haiku-5-5" -> "haiku"). */
const family = (m?: string) => m?.match(/opus|sonnet|haiku|fable/i)?.[0].toLowerCase();

export class TerminalControl {
  readonly attaches: Attaches;
  private hooks?: HookServer;
  /** sessions whose TUI runs in tmux, and its tmux session (a TUI moved on by /clear keeps its name) */
  private tuis = new Map<string, string>();
  /** Back to Tether under way, until the driver is live again */
  private returning = new Map<string, Promise<void>>();
  /** TUIs that never reported SessionStart in time (the trust question, most likely) */
  private unconfirmed = new Set<string>();
  /** a TUI's launch session -> the session it is on now (after /clear or /resume; hooks name the launch) */
  private moved = new Map<string, string>();
  /** when a hook last reported, per session; and how many checks in a row found its TUI idle */
  private heard = new Map<string, number>();
  private idleSeen = new Map<string, number>();
  /** messages being typed into a TUI, per session: each text goes in with its Enter */
  private typing = new Map<string, Promise<void>>();
  /** new shells are numbered one at a time */
  private shellLock: Promise<unknown> = Promise.resolve();
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
    o.live.terminal = {
      send: (s, t) => this.type(s, t),
      interrupt: (s) => this.interrupt(s),
      startIn: (s) => this.enter(s, { fresh: true }),
      settled: (s) => this.settled(s),
      blocked: (s) => this.blocked(s),
    };
    // The relay forgot every attach with the connection: their PTYs have nobody to draw for.
    o.core.o.bus.on("disconnected", () => this.attaches.closeAll());
    // Claude fires no Stop when a turn is interrupted: the store's marker says the turn is over.
    o.core.o.bus.on("message", ({ sessionId, msg }) => {
      if (msg.role !== "notice" || !/^Interrupted\b/.test((msg.parts[0] as any)?.text ?? "")) return;
      const s = o.core.sessions.get(sessionId);
      if (s) this.turnOver(s, "interrupted");
    });
  }

  private nameOf(id: string) {
    return this.tuis.get(id) ?? tuiName(id);
  }

  /** A handoff or Back to Tether under way finishes (it may fail: the caller looks at the mode). */
  settled(s: Session): Promise<void> | undefined {
    const a = this.entering.get(s.id);
    const b = this.returning.get(s.id);
    if (!a && !b) return undefined;
    return (async () => {
      await a?.catch(() => {});
      await b?.catch(() => {});
      // Back to Tether may have started while the handoff finished.
      await this.settled(s);
    })();
  }

  /** Why the SDK may not drive this session now: its TUI drives, or is about to. */
  blocked(s: Session): string | undefined {
    if (s.capabilities.terminal !== "handoff") return undefined;
    if (this.entering.has(s.id)) return HANDING_OFF;
    if (this.tuis.has(s.id)) return "The session is in the terminal. Type there, or go back to Tether first.";
    return undefined;
  }

  get tmux() {
    return this.o.tmux;
  }

  async start() {
    if (this.o.hookSocket) {
      try {
        this.hooks = new HookServer(this.o.hookSocket, (r) => this.report(r), this.log);
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
      target = this.nameOf(s.id);
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
      if (s.state.mode === "terminal" && !this.returning.has(s.id)) await this.backLive(s);
      return;
    }
    if (whenIdle && term.kind === "handoff" && s.state.status !== "idle") {
      s.setState({ terminal: { ...term, returnWhenIdle: true } });
      // Kept on the tmux session, so a runner restart meanwhile still goes back when it's done.
      await this.o.tmux.tag(this.nameOf(s.id), "return", "1").catch(() => {});
      return;
    }
    const going = this.returning.get(s.id);
    if (going) return going;
    const p = this.quit(s).finally(() => this.returning.delete(s.id));
    this.returning.set(s.id, p);
    return p;
  }

  private async quit(s: Session) {
    s.setState({ terminal: { ...s.state.terminal!, returning: true, returnWhenIdle: undefined } });
    const name = this.nameOf(s.id);
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
    await this.gone(s.id, true);
  }

  async listShells(projectPath: string): Promise<ShellInfo[]> {
    const path = this.o.core.folder(projectPath);
    return (await this.o.tmux.list())
      .filter((t) => t.kind === "shell" && t.projectPath === path)
      .map((t) => ({ id: t.name, projectPath: t.projectPath, n: t.n ?? 0, ...(t.command ? { command: t.command } : {}) }))
      .sort((a, b) => a.n - b.n);
  }

  /** A new shell, numbered after the project's others (one at a time; a name taken meanwhile, e.g. by another runner process, moves on). */
  newShell(projectPath: string, cols?: number, rows?: number): Promise<ShellInfo> {
    const p = this.shellLock.then(async () => {
      const path = this.o.core.folder(projectPath);
      const shell = this.o.shell ?? process.env.SHELL ?? "/bin/bash";
      for (let attempt = 0; ; attempt++) {
        const have = await this.listShells(path);
        const n = Math.max(0, ...have.map((s) => s.n)) + 1 + attempt;
        const name = shellName(projectKey(path), n);
        try {
          await this.o.tmux.create({ name, cwd: path, argv: [shell], cols, rows, tags: { kind: "shell", project: path, n: String(n) } });
          return { id: name, projectPath: path, n };
        } catch (e: any) {
          if (attempt < 4 && /duplicate session/i.test(e?.message ?? "")) continue;
          throw e;
        }
      }
    });
    this.shellLock = p.catch(() => {});
    return p;
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
    // Already there (another device opened it, or it outlived a runner restart): found by its tag,
    // since a TUI that /clear moved on keeps its old name.
    const all = await this.o.tmux.list();
    const mine = all.find((t) => t.kind === "tui" && t.sessionId === s.id);
    if (mine) return this.adopt(s, mine.name);
    // Its usual name may belong to the TUI another session moved on to.
    let name = tuiName(s.id);
    if (all.some((t) => t.name === name)) name = `${name}-${randomUUID().slice(0, 4)}`;
    // Checked before anything is handed over: tmux would start the TUI elsewhere.
    if (!existsSync(s.summary.projectPath)) throw new Error(`The session's folder ${s.summary.projectPath} doesn't exist any more.`);
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
    if (!handoff) {
      // Shared: Tether stays on the thread beside the TUI (requests, status and the transcript keep
      // coming through it), so it is live first; the harness gets the thread ready to be joined.
      const d = await this.o.live.resumeLive(s);
      await d.beforeTerminal?.();
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
    this.log(`${s.id}: started its TUI in tmux (${name})`);
    if (handoff && this.hooks) this.expectStart(s.id);
    this.adopt(s, name);
    // What waits in the queue waits for Back to Tether (SPEC §8).
    if (handoff) this.o.live.queue.hold(s, "terminal");
  }

  /** The session's TUI runs in tmux: its state says so. */
  private adopt(s: Session, name: string, returnWhenIdle = false) {
    this.tuis.set(s.id, name);
    if (s.capabilities.terminal === "handoff") {
      this.o.live.setMode(s, "terminal", { status: "idle", terminal: { kind: "handoff", ...(returnWhenIdle ? { returnWhenIdle } : {}) }, error: undefined, continuedIn: undefined });
      // The read-only transcript, tailed from the store while someone watches (SPEC §8).
      this.o.core.tail(s);
    } else {
      s.setState({ terminal: { kind: "shared" } });
      this.o.core.touch(s);
      // Readopted after a runner restart: Tether joins the thread again too.
      if (!s.driver && !s.starting) void this.o.live.resumeLive(s).catch((e) => this.log(`${s.id}: couldn't rejoin beside its terminal: ${e?.message ?? e}`));
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

  /** A session's TUI is gone from tmux (quit, exited, killed); `back`: Back to Tether quit it. */
  private async gone(id: string, back = false) {
    const name = this.tuis.get(id);
    if (!name) return;
    this.tuis.delete(id);
    this.unconfirmed.delete(id);
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
    await this.carryModel(s);
    s.setState({ terminal: undefined, status: "idle" });
    try {
      await this.o.live.resumeLive(s);
    } catch {
      // startDriver already made it stored with the error in its state and transcript.
    }
  }

  /**
   * A model picked in the TUI (/model) goes on with the session: the last answer's model, when it's
   * not what Tether had (another family, or another full id).
   */
  private async carryModel(s: Session) {
    const msgs = await this.o.core
      .adapter(s.summary.harness)
      .readHistory(s.summary.nativeId, s.summary.projectPath)
      .catch(() => [] as Msg[]);
    const used = [...msgs].reverse().find((m) => m.role === "assistant" && m.model?.startsWith("claude"))?.model;
    if (!used) return;
    const cur = s.state.modelResolved ?? s.state.model;
    const differs = family(cur) ? family(cur) !== family(used) : !!cur && cur !== "default" && cur !== used;
    if (!differs || cur === used) return;
    this.log(`${s.id}: the TUI used ${used}; the session goes on with it`);
    s.setState({ model: used, modelResolved: undefined });
    this.o.core.o.prefs.set(s.id, { projectPath: s.summary.projectPath, model: used });
  }

  private runQuit(name: string, steps: QuitStep[]) {
    return this.runSteps(name, steps, true);
  }

  private async runSteps(name: string, steps: QuitStep[], untilGone: boolean) {
    for (const [i, st] of steps.entries()) {
      // Quit already: the rest would go nowhere.
      if (untilGone && i > 0 && !("waitMs" in st) && !(await this.o.tmux.has(name))) return;
      if ("waitMs" in st && !st.waitMs) continue;
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
    const t = setTimeout(() => finish(false), this.o.startWaitMs ?? 8000);
    const finish = (started = true) => {
      clearTimeout(t);
      if (this.starting.get(id)?.ready !== ready) return;
      this.starting.delete(id);
      if (started) this.unconfirmed.delete(id);
      else this.unconfirmed.add(id);
      done();
    };
    this.starting.set(id, { ready, done: finish });
  }

  /** The composer in terminal mode: the text, then Enter (SPEC §8, §9), one message at a time. */
  private type(s: Session, text: string): Promise<void> {
    const prev = this.typing.get(s.id) ?? Promise.resolve();
    const p = prev.catch(() => {}).then(() => this.typeNow(s, text));
    const tail = p.catch(() => {});
    this.typing.set(s.id, tail);
    void tail.then(() => this.typing.get(s.id) === tail && this.typing.delete(s.id));
    return p;
  }

  private async typeNow(s: Session, text: string) {
    const name = this.nameOf(s.id);
    if (!this.tuis.has(s.id) || this.returning.has(s.id)) throw new Error("The terminal has closed.");
    // Text typed into a dialog answers it ("1" approves): the person answers it there instead.
    if (s.state.status === "waiting" || s.state.terminal?.attention) throw new Error(ANSWER_THERE);
    await this.starting.get(s.id)?.ready;
    if (this.unconfirmed.has(s.id)) throw new Error(NOT_STARTED);
    await this.o.tmux.type(name, text);
    // The harness says how to submit it (Claude: a beat, End, Enter); by default a beat and Enter.
    const submit = this.launch(s).submit ?? [{ waitMs: this.o.enterDelayMs ?? 150 }, { keys: ["Enter"] }];
    await this.runSteps(name, submit, false);
  }

  /** Stop in terminal mode: Esc in the TUI (Claude stops its turn; no hook says so). */
  private async interrupt(s: Session) {
    if (!this.tuis.has(s.id)) return;
    await this.o.tmux.keys(this.nameOf(s.id), "Escape");
    this.turnOver(s, "stopped from Tether");
  }

  /**
   * The TUI's turn is over though no Stop hook said so (an interrupt, a refused prompt): idle, the
   * question gone, and a Back to Tether that waited for it goes ahead.
   */
  private turnOver(s: Session, why: string) {
    const term = s.state.terminal;
    if (!this.tuis.has(s.id) || s.state.mode !== "terminal" || !term || s.state.status === "idle") return;
    this.log(`${s.id}: the TUI's turn is over (${why})`);
    this.status(s, "idle", { ...term, attention: undefined, returnWhenIdle: undefined });
    this.afterTurn(s, term);
  }

  /** A turn ended: Back to Tether, if it was waiting for that, goes now (and only once). */
  private afterTurn(s: Session, term: NonNullable<LiveState["terminal"]>) {
    if (!term.returnWhenIdle) return;
    void this.o.tmux.tag(this.nameOf(s.id), "return", undefined).catch(() => {});
    void this.end(s.id).catch((e) => this.log(`${s.id}: back to Tether failed: ${e?.message ?? e}`));
  }

  // ---------------- hooks: status in terminal mode ----------------

  report(r: HookReport) {
    // Hooks keep the URL of the launch; the payload says which session the TUI is on now (it moves
    // with /clear and /resume).
    const p = parseSessionId(r.sessionId);
    const now = p && r.nativeId ? makeId(p.harness, r.nativeId) : r.sessionId;
    let id = r.sessionId;
    for (let i = 0; i < 100 && this.moved.has(id); i++) id = this.moved.get(id)!;
    if (this.tuis.has(now) && this.tuis.get(now) === this.tuis.get(id)) id = now;
    const s = this.o.core.sessions.get(id);
    if (!s || !this.tuis.has(s.id) || s.state.mode !== "terminal" || !s.state.terminal) return;
    const term = s.state.terminal;
    this.heard.set(s.id, this.o.core.now());
    this.idleSeen.delete(s.id);
    // Only a real session id moves the terminal (it becomes a Tether session id and a file name).
    if (r.event === "SessionStart" && r.nativeId && r.nativeId !== s.summary.nativeId && UUID.test(r.nativeId)) {
      void this.rebind(s, r.nativeId, r.source).catch((e) => this.log(`${s.id}: couldn't follow the TUI to ${r.nativeId}: ${e?.message ?? e}`));
      return;
    }
    switch (r.event) {
      case "SessionStart":
        this.unconfirmed.delete(s.id);
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
        this.afterTurn(s, term);
        break;
    }
  }

  /**
   * The TUI moved to another session (/clear starts one, /resume opens one): the terminal, Tether's
   * view and Back to Tether follow it. The old session is left stored with a notice pointing on.
   */
  private async rebind(old: Session, nativeId: string, source?: string) {
    const name = this.nameOf(old.id);
    const core = this.o.core;
    const newId = makeId(old.summary.harness, nativeId);
    if (this.tuis.has(newId)) return;
    this.log(`${old.id}: the TUI moved to ${newId}${source ? ` (${source})` : ""}`);
    let n = await core.open(newId).catch(() => undefined);
    if (!n) {
      // /clear: nothing of it is stored until something is typed.
      n = core.create(old.summary.harness, nativeId, old.summary.projectPath, { model: old.state.model, effort: old.state.effort, permissionMode: old.state.permissionMode });
      n.transcript = new Transcript();
    } else if (n.driver || n.starting) await this.o.live.release(n);
    this.tuis.delete(old.id);
    this.unconfirmed.delete(old.id);
    // Its hooks go on naming the session it was launched for: remember where that is now.
    const launch = [...this.moved].find(([, v]) => v === old.id)?.[0] ?? old.id;
    this.moved.set(launch, newId);
    if (launch !== old.id) this.moved.delete(old.id);
    await this.o.tmux.tag(name, "launch", launch).catch(() => {});
    await this.o.tmux.tag(name, "session", newId).catch(() => {});
    // Back to Tether when it's done still holds: for the session the TUI is on now.
    this.adopt(n, name, !!old.state.terminal?.returnWhenIdle);
    await core.load(old).catch(() => {});
    const why = source === "clear" ? "after /clear" : source === "resume" ? "with /resume" : "";
    old.apply({ type: "msg", msg: { id: `n-${randomUUID()}`, role: "notice", level: "info", ts: core.now(), parts: [{ type: "text", text: `The terminal continued in another session${why ? ` ${why}` : ""}.` }], link: { sessionId: newId, label: "Open it" } } });
    this.o.live.setMode(old, "stored", { status: "idle", terminal: undefined, continuedIn: newId });
    core.tail(old);
    core.scheduleEvict(old);
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
      if (t.launchedFor && t.launchedFor !== s.id) this.moved.set(t.launchedFor, s.id);
      this.adopt(s, t.name, t.returnWhenIdle);
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
      for (const [id, name] of [...this.tuis]) if (!live.has(name) && !this.returning.has(id)) await this.gone(id);
      for (const [id, name] of [...this.tuis]) if (live.has(name)) await this.reconcile(id, name);
    } finally {
      this.polling = false;
    }
  }

  /**
   * A TUI said it was working or waiting, and no hook has spoken for a while: if its screen shows it
   * idle at its prompt on two checks in a row, the turn is over.
   */
  private async reconcile(id: string, name: string) {
    const s = this.o.core.sessions.get(id);
    if (!s || s.state.mode !== "terminal" || s.state.status === "idle" || this.returning.has(id)) return void this.idleSeen.delete(id);
    if (this.o.core.now() - (this.heard.get(id) ?? 0) < (this.o.quietMs ?? 15_000)) return;
    const idle = this.launch(s).idle;
    if (!idle) return;
    const screen = await this.o.tmux.capture(name).catch(() => "");
    if (!screen || !idle(screen)) return void this.idleSeen.delete(id);
    const n = (this.idleSeen.get(id) ?? 0) + 1;
    this.idleSeen.set(id, n);
    if (n >= 2) {
      this.idleSeen.delete(id);
      this.turnOver(s, "the TUI is idle at its prompt");
    }
  }

  /** An attach's PTY ended by itself: its tmux session may be gone. */
  private async attachExited(target: string) {
    if (await this.o.tmux.has(target)) return;
    const id = [...this.tuis].find(([, name]) => name === target)?.[0];
    if (id && !this.returning.has(id)) await this.gone(id);
  }
}
