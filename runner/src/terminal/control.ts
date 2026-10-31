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
import type { QuitStep, ScreenRead, TerminalLaunch, TerminalOpts } from "../core/adapter";
import type { LiveControl } from "../core/live";
import type { Session } from "../core/session";
import type { SessionCore } from "../core/sessions";
import { MessageQueue } from "../core/queue";
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
export const HANDING_OFF = "The session is moving to the terminal.";

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

/** Permission modes, tightest first; `default` is what's left when the mode can't be established. */
const TIGHTEST_FIRST = ["plan", "default", "dontAsk", "acceptEdits", "auto", "bypassPermissions"];
const looseness = (m: string) => (TIGHTEST_FIRST.indexOf(m) < 0 ? TIGHTEST_FIRST.length : TIGHTEST_FIRST.indexOf(m));
const tighter = (a: string, b: string) => (looseness(a) <= looseness(b) ? a : b);

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
  /** sessions whose TUI has shown its permission mode since it started (status line or a hook) */
  private modeShown = new Set<string>();
  /** how each harness reads its TUI's screen */
  private readers = new Map<string, TerminalLaunch["screen"]>();
  /** the mode entries a session's store had when its TUI started: only later ones are this TUI's (saved too: prefs `tui`) */
  private modeEntries = new Map<string, number>();
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
      // Scrolled back in the terminal (tmux's copy mode): keys go to the TUI again.
      await this.o.tmux.leaveCopyMode(name);
      // A clean exit where the TUI sits at its plain, empty prompt (/exit); else its keys to quit.
      const launch = this.launch(s);
      const seen = await this.readScreen(s, name, 1);
      if (seen?.mode) this.seenMode(s, seen.mode);
      const atPrompt = seen?.state === "idle" && seen.prompt === "normal" && !seen.input;
      await this.runSteps(name, (atPrompt && launch.quitAtPrompt ? launch.quitAtPrompt : launch.quit) ?? []);
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
      this.o.core.pin(s);
      p = this.doEnter(s, o).finally(() => {
        this.entering.delete(s.id);
        this.o.core.unpin(s);
      });
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
    if (handoff) await this.markEntries(s);
    const launch = this.launch(s, { fresh: s.fresh, report: handoff && this.hooks ? { socketPath: this.hooks.socketPath, sessionId: s.id, tui: name } : undefined });
    try {
      await this.o.tmux.create({ name, cwd: s.summary.projectPath, argv: launch.argv, env: launch.env, cols: o.cols, rows: o.rows, tags: { kind: "tui", session: s.id, project: s.summary.projectPath } });
    } catch (e: any) {
      const error = `Couldn't open the terminal: ${e?.message ?? e}`;
      // Handed off already: it stays stored rather than pretending to be live.
      if (handoff && !s.live && s.state.mode === "live") this.o.live.setMode(s, "stored", { status: "idle", error });
      this.o.core.o.prefs.set(s.id, { tui: undefined });
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
    return this.o.core.adapter(s.summary.harness).terminalCommand(s.summary.nativeId, s.summary.projectPath, { ...this.o.live.chosen(s), ...extra });
  }

  /**
   * From here on the store's mode entries are this TUI's. Saved at once, with the mark that it runs:
   * a TUI that quits while no runner is there leaves nothing else behind (settleMissed).
   */
  private async markEntries(s: Session) {
    const seen = await this.o.core.adapter(s.summary.harness).storedMode?.(s.summary.nativeId, s.summary.projectPath).catch(() => undefined);
    this.modeShown.delete(s.id);
    if (seen) this.modeEntries.set(s.id, seen.entries);
    this.o.core.o.prefs.set(s.id, { tui: { ...(seen ? { entries: seen.entries } : {}) } });
    this.o.core.o.prefs.flush();
  }

  private async stored(s: Session) {
    return !!(await this.o.core.adapter(s.summary.harness).sessionInfo(s.summary.nativeId, s.summary.projectPath).catch(() => undefined));
  }

  /** Its store holds no conversation, only local commands (a TUI nobody used, then /exit or /clear). */
  private async neverStarted(s: Session) {
    return !!(await this.o.core.adapter(s.summary.harness).neverStarted?.(s.summary.nativeId, s.summary.projectPath).catch(() => false));
  }

  /**
   * A new session's TUI is gone. Fresh only while its store doesn't have it (a prompt typed there
   * needn't have reached it): once it does, even with only local commands in it, the harness
   * refuses its id for a new session and anything sent resumes. True: nothing was ever typed.
   */
  private async settleFresh(s: Session) {
    if (!s.fresh) return false;
    if (!(await this.stored(s))) return true;
    s.fresh = false;
    return this.neverStarted(s);
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
    await this.carryMode(s);
    this.o.core.o.prefs.set(s.id, { tui: undefined });
    const unused = await this.settleFresh(s);
    if (back) return this.backLive(s);
    // It exited by itself (/exit): stored (SPEC §8).
    await this.o.core.syncFromStore(s);
    this.o.live.setMode(s, "stored", { status: "idle", terminal: undefined });
    if (unused) {
      // Messages wait in its queue: it stays, to go on when you send.
      if (s.state.queue.length) return;
      // Nothing was ever typed: nothing of it is in any store, or only local commands (/exit).
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
    // Still going back: every view says so, with no buttons, until the mode changes (setMode).
    s.setState({ terminal: { kind: "handoff", returning: true }, status: "idle" });
    // On failure startDriver has made it stored with the error in its state and transcript, and what
    // waited for the terminal is paused, with Resume.
    await this.o.live.resumeLive(s).catch(() => {});
    if (s.state.mode === "terminal") this.o.live.setMode(s, s.driver ? "live" : "stored", { status: "idle" });
  }

  /** What the TUI shows now (status line or a hook): the mode as last seen, and kept. */
  private seenMode(s: Session, mode: string) {
    this.modeShown.add(s.id);
    this.setMode(s, mode);
  }

  private setMode(s: Session, mode: string) {
    if (mode === s.state.permissionMode) return;
    s.setState({ permissionMode: mode });
    this.o.core.o.prefs.set(s.id, { projectPath: s.summary.projectPath, permissionMode: mode });
    this.o.core.touch(s);
  }

  /**
   * The mode a TUI that's gone leaves the session in: never looser than it last showed. Shift+Tab
   * fires no hook and reaches the store only when Claude exits, so a killed TUI may never write it.
   * The screen and the store agreeing is the usual case; if they differ, the tighter (a hung TUI's
   * entry is older than its screen). With neither, it can't be established: at most `default`.
   */
  private async carryMode(s: Session) {
    const shown = this.modeShown.delete(s.id) ? s.state.permissionMode : undefined;
    const before = this.modeEntries.get(s.id);
    this.modeEntries.delete(s.id);
    const stored = await this.o.core.adapter(s.summary.harness).storedMode?.(s.summary.nativeId, s.summary.projectPath).catch(() => undefined);
    const entry = stored?.mode && before !== undefined && stored.entries > before ? stored.mode : undefined;
    const mode = shown && entry ? tighter(shown, entry) : (shown ?? entry);
    if (mode) return this.setMode(s, mode);
    this.log(`${s.id}: couldn't tell the mode the TUI ended in`);
    this.setMode(s, tighter(s.state.permissionMode ?? "default", "default"));
  }

  /**
   * A TUI that was gone when the runner came back: it may have quit tighter than last seen (Shift+Tab
   * to manual, /exit), and nothing but the store says so. Never looser than the store's newest
   * entry; with none from that TUI the mode can't be established: at most `default` too.
   */
  private async settleMissed(id: string, tui: { entries?: number }) {
    const prefs = this.o.core.o.prefs;
    const s = await this.o.core.open(id).catch(() => undefined);
    if (!s) {
      // Not in any store: nothing ran, but it may be started later, under what is saved here.
      const m = prefs.get(id).permissionMode;
      prefs.set(id, { tui: undefined, ...(m ? { permissionMode: tighter(m, "default") } : {}) });
      return;
    }
    const stored = await this.o.core.adapter(s.summary.harness).storedMode?.(s.summary.nativeId, s.summary.projectPath).catch(() => undefined);
    const ours = !!stored?.mode && tui.entries !== undefined && stored.entries > tui.entries;
    let mode = tighter(s.state.permissionMode ?? "default", stored?.mode ?? "default");
    if (!ours) mode = tighter(mode, "default");
    this.setMode(s, mode);
    // Pinned even when it's what was shown: a resume mustn't go by what the store last kept.
    prefs.set(s.id, { projectPath: s.summary.projectPath, permissionMode: mode, tui: undefined });
    this.log(`${s.id}: its TUI went while the runner was away; going on in ${mode}${ours ? "" : " (it left no mode)"}`);
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

  private async runSteps(name: string, steps: QuitStep[]) {
    for (const [i, st] of steps.entries()) {
      // Quit already: the rest would go nowhere.
      if (i > 0 && !("waitMs" in st) && !(await this.o.tmux.has(name))) return;
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
    const h = s.summary.harness;
    if (!this.readers.has(h)) this.readers.set(h, this.launch(s).screen);
    const read = this.readers.get(h);
    if (!read) return undefined;
    let r: ScreenRead = { state: "unknown" };
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
    // (A subagent's hook carries the subagent's own mode.)
    if (r.permissionMode && !r.agentId) this.seenMode(s, r.permissionMode);
    // Only a real session id moves the terminal (it becomes a Tether session id and a file name).
    if (r.event === "SessionStart" && r.nativeId && r.nativeId !== s.summary.nativeId && UUID.test(r.nativeId)) {
      void this.rebind(s, r.nativeId, r.source).catch((e) => this.log(`${s.id}: couldn't follow the TUI to ${r.nativeId}: ${e?.message ?? e}`));
      return;
    }
    // Tether doesn't follow the TUI's turns (SPEC §8): only Needs you, set here and never cleared by
    // a hook (a subagent's hooks come while the main agent's question is still open).
    switch (r.event) {
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
    }
    core.pin(n);
    try {
      // What waits there waits for Back to Tether, as in any handoff (held first: the driver's end
      // would send it).
      this.o.live.queue.hold(n, "terminal");
      if (n.driver || n.starting) await this.o.live.release(n);
      // The TUI goes on with the model and mode it runs in, on any session it moves to.
      const { model, effort, permissionMode, modelResolved } = old.state;
      n.setState({ model, effort, permissionMode, modelResolved });
      await this.markEntries(n);
      if (this.modeShown.delete(old.id)) this.modeShown.add(n.id);
      this.modeEntries.delete(old.id);
      core.o.prefs.set(old.id, { tui: undefined });
      core.o.prefs.set(n.id, { projectPath: n.summary.projectPath, model, effort, permissionMode });
      this.tuis.delete(old.id);
      this.promptSince.delete(old.id);
      // Its hooks go on naming the session it was launched for: remember where that is now.
      const launch = [...this.moved].find(([, v]) => v === old.id)?.[0] ?? old.id;
      this.moved.set(launch, newId);
      if (launch !== old.id) this.moved.delete(old.id);
      await this.o.tmux.tag(name, "launch", launch).catch(() => {});
      await this.o.tmux.tag(name, "session", newId).catch(() => {});
      this.adopt(n, name);
      // Queued meanwhile, before the mode said terminal.
      this.o.live.queue.hold(n, "terminal");
    } finally {
      core.unpin(n);
    }
    await core.load(old).catch(() => {});
    const why = source === "clear" ? "after /clear" : source === "resume" ? "with /resume" : "";
    old.apply({ type: "msg", msg: { id: `n-${randomUUID()}`, role: "notice", level: "info", ts: core.now(), parts: [{ type: "text", text: `The terminal continued in another session${why ? ` ${why}` : ""}.` }], link: { sessionId: newId, label: "Open it" } } });
    this.o.live.setMode(old, "stored", { status: "idle", terminal: undefined, continuedIn: newId });
    // A TUI nobody used, then /clear: the old session never started (views follow continuedIn).
    if ((await this.settleFresh(old)) && !old.state.queue.length) {
      core.book.remove([old.id]);
      core.sessions.delete(old.id);
      return;
    }
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
          // What waited for this terminal is still waiting.
          s.setState(MessageQueue.saved(prefs));
        } catch {
          continue;
        }
      }
      if (t.launchedFor && t.launchedFor !== s.id) this.moved.set(t.launchedFor, s.id);
      this.adopt(s, t.name);
      // The baseline from its start stands: what it wrote since is its own.
      const saved = this.o.core.o.prefs.get(s.id).tui?.entries;
      if (saved !== undefined) this.modeEntries.set(s.id, saved);
      else if (s.capabilities.terminal === "handoff") await this.markEntries(s);
      this.log(`readopted the terminal of ${s.id}`);
      // No status is inferred; a question on its screen is Needs you (no push: it was announced).
      if (s.capabilities.terminal === "handoff" && (await this.readScreen(s, t.name))?.state === "asking") {
        const term = s.state.terminal;
        if (term) this.needsYou(s, term, ASKING_THERE, false);
      }
    }
    for (const [id, tui] of this.o.core.o.prefs.inTerminal()) if (!this.tuis.has(id)) await this.settleMissed(id, tui);
    this.o.core.o.prefs.flush();
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
      for (const [id, name] of [...this.tuis]) if (live.has(name)) await this.checkScreen(id, name);
    } finally {
      this.polling = false;
    }
  }

  /**
   * What the TUI's screen says each round: the mode and background shells on its status line (Shift+Tab
   * fires no hook), and Needs you clearing, only on evidence: the screen shows its prompt box (no
   * dialog, which would replace it) on every check for a while. Hooks never clear it.
   */
  private async checkScreen(id: string, name: string) {
    const s = this.o.core.sessions.get(id);
    if (!s || s.state.mode !== "terminal" || !s.state.terminal || this.returning.has(id)) return void this.promptSince.delete(id);
    const seen = await this.readScreen(s, name, 1);
    // Asked or moved on meanwhile: what was read isn't this session's any more.
    if (this.tuis.get(id) !== name || this.returning.has(id) || !s.state.terminal) return;
    if (seen?.mode) this.seenMode(s, seen.mode);
    if (seen && seen.state !== "unknown" && seen.state !== "picker" && seen.state !== "asking" && !!seen.background !== !!s.state.terminal.background) s.setState({ terminal: { ...s.state.terminal, background: seen.background } });
    if (!s.state.terminal.attention) return void this.promptSince.delete(id);
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
