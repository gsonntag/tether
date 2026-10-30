// Terminal mode (SPEC §8): the harness's own TUI in tmux, mirrored to browsers, and the project's
// plain shells beside it.
//
// Handoff (capabilities.terminal = "handoff", Claude): two processes can't drive one session, so
// control moves. Opening the terminal stops the turn if asked to (the UI asks first), closes the
// driver (the harness flushes its store), cancels open requests (the TUI asks again), holds queued
// messages, and starts the TUI on the same session in tmux. The mode becomes `terminal`: the TUI
// drives and Tether doesn't follow its turns (no Working or idle, no turn pushes): the transcript is
// tailed from the store (read-only), messages sent meanwhile wait in Tether's queue for Back to
// Tether, and the one thing tracked is "Needs you", best-effort and add-only: set by Claude's hooks
// (PermissionRequest, Elicitation, Notification), cleared only on evidence (the TUI's screen shows
// its prompt again for a few seconds, no dialog) or by leaving the terminal. Back to Tether (the UI
// asks first) quits the TUI (/exit at an empty prompt, else Esc and Ctrl-C; killed after 5 s) and
// resumes the driver on the same session from the store: the mode becomes `live`. If the TUI exits
// by itself, `stored`.
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
import { TERMINAL_BUSY, TERMINAL_CLOSED, TERMINAL_TEXT_MAX, type RunnerToServer, type ShellInfo } from "../../../shared/protocol";
import type { LiveState, Msg } from "../../../shared/transcript";
import type { QuitStep, ScreenRead, TerminalOpts } from "../core/adapter";
import type { LiveControl } from "../core/live";
import type { Session } from "../core/session";
import type { SessionCore } from "../core/sessions";
import { Transcript } from "../core/transcript";
import { Attaches, type SpawnPty } from "./attach";
import { HookServer, type HookReport } from "./hooks";
import { tailBytes } from "../../../shared/shellRun";
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
  /** the pause before a screen that is neither at the prompt nor asking is looked at again */
  screenRetryMs?: number;
  /** how long the TUI's screen must show its prompt (no dialog) before Needs you clears */
  clearAfterMs?: number;
  log?: (line: string) => void;
}

/** Notification types that mean Claude waits on the person. */
const NEEDS_YOU = new Set(["permission_prompt", "elicitation_dialog"]);

/** A question on a readopted TUI's screen, before any hook says what it is. */
export const ASKING_THERE = "Claude needs you in the terminal.";
export const HANDING_OFF = "The session is moving to the terminal. Type there in a moment.";

/** What a PermissionRequest (or Elicitation) hook says Claude waits for. */
function askingFor(r: HookReport): string {
  if (r.event === "Elicitation") return "Claude needs you in the terminal.";
  if (r.toolName === "AskUserQuestion") return "Claude is asking you something.";
  if (r.toolName === "ExitPlanMode") return "Claude has a plan ready for you.";
  return r.toolName ? `Claude needs your permission to use ${r.toolName}` : "Claude needs your permission.";
}

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
  /** a TUI's launch session -> the session it is on now (after /clear or /resume; hooks name the launch) */
  private moved = new Map<string, string>();
  /** new shells are numbered one at a time */
  private shellLock: Promise<unknown> = Promise.resolve();
  private entering = new Map<string, Promise<void>>();
  /** sessions with Needs you whose TUI shows its prompt (no dialog), since when */
  private promptSince = new Map<string, number>();
  private poll?: ReturnType<typeof setInterval>;
  private polling = false;
  private readonly log: (line: string) => void;

  constructor(private o: TerminalOptions) {
    this.log = o.log ?? ((l) => console.log(l));
    this.attaches = new Attaches({ send: o.send, buffered: o.buffered }, { spawn: o.spawn, onExit: (target) => void this.attachExited(target) });
    o.live.terminal = {
      startIn: (s) => this.enter(s, { fresh: true }),
      settled: (s) => this.settled(s),
      blocked: (s) => this.blocked(s),
    };
    // The relay forgot every attach with the connection: their PTYs have nobody to draw for.
    o.core.o.bus.on("disconnected", () => this.attaches.closeAll());
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
    if (this.tuis.has(s.id)) return "The session is in the terminal. Go back to Tether first.";
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

  /**
   * What an attached terminal shows, scrollback included, as text (the panel's Copy): the newest
   * TERMINAL_TEXT_MAX bytes, so the answer always fits a frame.
   */
  async text(attachId: string): Promise<{ text: string; cut: boolean }> {
    const target = this.attaches.targetOf(attachId);
    if (!target) throw new Error(TERMINAL_CLOSED);
    const all = (await this.o.tmux.history(target)).replace(/\s+$/, "") + "\n";
    const text = tailBytes(all, TERMINAL_TEXT_MAX);
    // Cut here, or tmux itself let older lines go (it keeps history-limit rows).
    const full = await this.o.tmux.historyFull(target).catch(() => false);
    return { text, cut: text.length < all.length || full };
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

  /**
   * Back to Tether (SPEC §8): the UI has asked first ("…that turn stops and anything in its own input
   * queue is lost"). The TUI quits, the session resumes in Tether from the store.
   */
  async end(sessionId: string) {
    const s = await this.o.core.open(sessionId);
    const term = s.state.terminal;
    if (!this.tuis.has(s.id) || !term) {
      // Nothing runs any more (it exited a moment ago): a handoff session just goes live.
      if (s.state.mode === "terminal" && !this.returning.has(s.id)) await this.backLive(s);
      return;
    }
    const going = this.returning.get(s.id);
    if (going) return going;
    const p = this.quit(s).finally(() => this.returning.delete(s.id));
    this.returning.set(s.id, p);
    return p;
  }

  private async quit(s: Session) {
    s.setState({ terminal: { ...s.state.terminal!, returning: true } });
    const name = this.nameOf(s.id);
    try {
      // A clean exit where the TUI sits at its plain, empty prompt (/exit); else its keys to quit.
      const launch = this.launch(s);
      const seen = launch.quitAtPrompt ? await this.readScreen(s, name, 1) : undefined;
      const atPrompt = seen?.state === "idle" && seen.prompt === "normal" && !seen.input;
      await this.runQuit(name, (atPrompt ? launch.quitAtPrompt : launch.quit) ?? []);
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
    // A Stop below holds the queue as any Stop does; for a handoff that hold is the terminal's.
    const heldBefore = !!s.state.queueHeld;
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
    const launch = this.launch(s, { fresh: s.fresh, report: handoff && this.hooks ? { socketPath: this.hooks.socketPath, sessionId: s.id, tui: name } : undefined });
    try {
      await this.o.tmux.create({ name, cwd: s.summary.projectPath, argv: launch.argv, env: launch.env, cols: o.cols, rows: o.rows, tags: { kind: "tui", session: s.id, project: s.summary.projectPath } });
    } catch (e: any) {
      const error = `Couldn't open the terminal: ${e?.message ?? e}`;
      // Handed off already: it stays stored rather than pretending to be live.
      if (handoff && !s.live && s.state.mode === "live") this.o.live.setMode(s, "stored", { status: "idle", error });
      throw new Error(error);
    }
    this.log(`${s.id}: started its TUI in tmux (${name})`);
    this.adopt(s, name);
    // What waits in the queue waits for Back to Tether (SPEC §8).
    if (handoff) this.o.live.queue.hold(s, "terminal", { over: !heldBefore });
  }

  /** The session's TUI runs in tmux: its state says so. */
  private adopt(s: Session, name: string) {
    this.tuis.set(s.id, name);
    if (s.capabilities.terminal === "handoff") {
      // One state while the TUI drives: "Driving in the terminal" (idle, as far as Tether goes).
      this.o.live.setMode(s, "terminal", { status: "idle", terminal: { kind: "handoff" }, error: undefined, continuedIn: undefined });
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
    this.promptSince.delete(id);
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
    const own = this.o.core.adapter(s.summary.harness).ownModel ?? (() => true);
    const used = [...msgs].reverse().find((m) => m.role === "assistant" && m.model && own(m.model))?.model;
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

  /**
   * The TUI's screen as its harness reads it (undefined: the harness can't tell). A screen that isn't
   * at the prompt nor asking is looked at again for a moment (a redraw, a dialog closing).
   */
  private async readScreen(s: Session, name: string, tries = 4): Promise<ScreenRead | undefined> {
    const read = this.launch(s).screen;
    if (!read) return undefined;
    let r: ScreenRead = { state: "unknown", body: "" };
    for (let i = 0; i < tries; i++) {
      if (i) await Bun.sleep(this.o.screenRetryMs ?? 400);
      r = read(await this.o.tmux.capture(name).catch(() => ""));
      if (r.state !== "unknown") return r;
    }
    return r;
  }

  // ---------------- hooks: Needs you in terminal mode ----------------

  report(r: HookReport) {
    // Hooks keep the URL of the launch; the payload says which session the TUI is on now (it moves
    // with /clear and /resume).
    let id: string | undefined;
    if (r.tui) {
      // The TUI says which it is: whatever session it is on now (after /clear too), and only that.
      id = [...this.tuis].find(([, name]) => name === r.tui)?.[0];
      if (!id) return;
    } else {
      // TUIs started before hooks named their tmux session: by the launch, followed where it moved.
      const p = parseSessionId(r.sessionId);
      const now = p && r.nativeId ? makeId(p.harness, r.nativeId) : r.sessionId;
      id = r.sessionId;
      for (let i = 0; i < 100 && this.moved.has(id); i++) id = this.moved.get(id)!;
      if (this.tuis.has(now) && this.tuis.get(now) === this.tuis.get(id)) id = now;
    }
    const s = this.o.core.sessions.get(id);
    if (!s || !this.tuis.has(s.id) || s.state.mode !== "terminal" || !s.state.terminal) return;
    const term = s.state.terminal;
    // The mode the TUI runs in now (Shift+Tab there changes it): shown, and kept for Back to Tether.
    if (r.permissionMode && r.permissionMode !== s.state.permissionMode) {
      s.setState({ permissionMode: r.permissionMode });
      this.o.core.o.prefs.set(s.id, { projectPath: s.summary.projectPath, permissionMode: r.permissionMode });
      this.o.core.touch(s);
    }
    // Only a real session id moves the terminal (it becomes a Tether session id and a file name).
    if (r.event === "SessionStart" && r.nativeId && r.nativeId !== s.summary.nativeId && UUID.test(r.nativeId)) {
      void this.rebind(s, r.nativeId, r.source).catch((e) => this.log(`${s.id}: couldn't follow the TUI to ${r.nativeId}: ${e?.message ?? e}`));
      return;
    }
    // Tether doesn't follow the TUI's turns (SPEC §8): only Needs you, set here and never cleared by
    // a hook (a subagent's hooks come while the main agent's question is still open).
    switch (r.event) {
      case "UserPromptSubmit":
        // Something was typed: the store has the session from here on.
        s.fresh = false;
        break;
      case "PermissionRequest":
      case "Elicitation":
        // The prompt or question shows now (Notification says so seconds later).
        this.needsYou(s, term, askingFor(r));
        break;
      case "Notification":
        if (!NEEDS_YOU.has(r.notificationType ?? "") && !(r.notificationType === undefined && /permission|approv/i.test(r.message ?? ""))) break;
        // PermissionRequest said it first, and more precisely ("…asking you something"): kept.
        if (term.attention) break;
        this.needsYou(s, term, r.message ?? "Claude needs you in the terminal.");
        break;
    }
  }

  /** Claude waits on the person: Needs you (announced once, however many hooks say so). */
  private needsYou(s: Session, term: NonNullable<LiveState["terminal"]>, message: string, push = true) {
    const already = !!term.attention;
    this.promptSince.delete(s.id);
    s.setState({ status: "waiting", terminal: { ...term, attention: message } });
    this.o.core.touch(s, { updatedAt: this.o.core.now() });
    if (!already && push) this.o.core.o.bus.emit("attention", { sessionId: s.id, message });
  }

  /** Needs you is over: the TUI showed its prompt (no dialog) for a while, or it is being left. */
  private answered(s: Session) {
    const term = s.state.terminal;
    this.promptSince.delete(s.id);
    if (!term?.attention && s.state.status !== "waiting") return;
    s.setState({ status: "idle", terminal: { ...term!, attention: undefined } });
    this.o.core.touch(s);
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
    this.promptSince.delete(old.id);
    // Its hooks go on naming the session it was launched for: remember where that is now.
    const launch = [...this.moved].find(([, v]) => v === old.id)?.[0] ?? old.id;
    this.moved.set(launch, newId);
    if (launch !== old.id) this.moved.delete(old.id);
    await this.o.tmux.tag(name, "launch", launch).catch(() => {});
    await this.o.tmux.tag(name, "session", newId).catch(() => {});
    this.adopt(n, name);
    await core.load(old).catch(() => {});
    const why = source === "clear" ? "after /clear" : source === "resume" ? "with /resume" : "";
    old.apply({ type: "msg", msg: { id: `n-${randomUUID()}`, role: "notice", level: "info", ts: core.now(), parts: [{ type: "text", text: `The terminal continued in another session${why ? ` ${why}` : ""}.` }], link: { sessionId: newId, label: "Open it" } } });
    this.o.live.setMode(old, "stored", { status: "idle", terminal: undefined, continuedIn: newId });
    core.tail(old);
    core.scheduleEvict(old);
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
      this.adopt(s, t.name);
      this.log(`readopted the terminal of ${s.id}`);
      // No status is inferred; a question on its screen is Needs you (no push: it was announced).
      if (s.capabilities.terminal === "handoff" && (await this.readScreen(s, t.name))?.state === "asking") {
        const term = s.state.terminal;
        if (term) this.needsYou(s, term, ASKING_THERE, false);
      }
    }
  }

  private startPoll() {
    if (this.poll) return;
    this.poll = setInterval(() => void this.check(), this.o.pollMs ?? 1000);
    this.poll.unref?.();
  }

  /** Looks for TUIs that are gone, and for Needs you whose dialog is gone. */
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
      for (const [id, name] of [...this.tuis]) if (live.has(name)) await this.checkAnswered(id, name);
    } finally {
      this.polling = false;
    }
  }

  /**
   * Needs you clears only on evidence: the TUI's screen shows its prompt box (no dialog, which would
   * replace it) on every check for a while. Hooks never clear it.
   */
  private async checkAnswered(id: string, name: string) {
    const s = this.o.core.sessions.get(id);
    if (!s || s.state.mode !== "terminal" || !s.state.terminal?.attention || this.returning.has(id)) return void this.promptSince.delete(id);
    const seen = await this.readScreen(s, name, 1);
    if (!seen || (seen.state !== "idle" && seen.state !== "busy")) return void this.promptSince.delete(id);
    const since = this.promptSince.get(id) ?? this.o.core.now();
    this.promptSince.set(id, since);
    if (this.o.core.now() - since >= (this.o.clearAfterMs ?? 3000)) {
      this.log(`${s.id}: its question was answered in the terminal`);
      this.answered(s);
    }
  }

  /** An attach's PTY ended by itself: its tmux session may be gone. */
  private async attachExited(target: string) {
    if (await this.o.tmux.has(target)) return;
    const id = [...this.tuis].find(([, name]) => name === target)?.[0];
    if (id && !this.returning.has(id)) await this.gone(id);
  }
}
