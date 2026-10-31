// The browser's end of a terminal (SPEC §8 Streaming): one attach per open terminal view. Output
// arrives as `term` frames for its attachId only; keys and resizes go back as rpcs.
//
// An attach lives only as long as its route through the relay. When the link drops, the runner
// restarts or the stream falls behind, the route is gone: the view clears and attaches again
// (`reattach`, so a TUI that exited meanwhile is never started again), and tmux redraws the
// screen. An attach whose terminal exited ends for good.

import type { OpArgs, OpName, OpResult, ServerToBrowser } from "../../shared/protocol";
import { decodeChunk, encodeChunk } from "../../shared/wire";

export type TermTarget = { sessionId: string } | { shellId: string };
export type TermStatus = "connecting" | "open" | "reconnecting" | "ended";

export interface TermDeps {
  rpc: <K extends OpName>(runnerId: string, op: K, args: OpArgs<K>) => Promise<OpResult<K>>;
  on: <T extends ServerToBrowser["t"]>(t: T, fn: (m: Extract<ServerToBrowser, { t: T }>) => void) => () => void;
  /** the link state now, and its changes */
  linkOpen: () => boolean;
  onLink: (fn: (open: boolean) => void) => () => void;
  /** whether the runner is connected now, and its (re)connects */
  runnerOnline: (runnerId: string) => boolean;
  onRunner: (fn: () => void) => () => void;
}

export interface TermCallbacks {
  data(bytes: Uint8Array): void;
  /** the screen is about to be drawn again from scratch (a reattach) */
  reset(): void;
  status(s: TermStatus, why?: string): void;
  /** a first attach that waited for the runner failed (the runner's message) */
  failed?(message: string): void;
}

interface Wiring {
  routes: Map<string, TermConn>;
  /** output that arrived before its openTerminal answer (the relay routes it from the start) */
  early: Map<string, { at: number; chunks: Uint8Array[] }>;
}
const wirings = new WeakMap<TermDeps, Wiring>();

/** One listener per connection routes every attach's frames. */
function wire(d: TermDeps): Wiring {
  let w = wirings.get(d);
  if (w) return w;
  const routes = new Map<string, TermConn>();
  const early = new Map<string, { at: number; chunks: Uint8Array[] }>();
  w = { routes, early };
  wirings.set(d, w);
  d.on("term", (m) => {
    const c = routes.get(m.attachId);
    if (c) return c.onData(decodeChunk(m.data));
    const now = Date.now();
    for (const [k, v] of early) if (now - v.at > 10_000) early.delete(k);
    const e = early.get(m.attachId) ?? { at: now, chunks: [] };
    if (e.chunks.length < 2000) e.chunks.push(decodeChunk(m.data));
    early.set(m.attachId, e);
  });
  d.on("termEnd", (m) => routes.get(m.attachId)?.onEnd(m.reason));
  return w;
}

/** Keys typed while a terminal reattaches: kept this long, and at most this much. */
const HELD_KEYS_MS = 5000;
const HELD_KEYS_MAX = 4096;

/** A line's text, then this long before its Enter, so a TUI doesn't take Enter as part of a paste. */
const LINE_ENTER_MS = 150;

/** Between tries to reattach after one failed: doubling, up to the last. */
const REATTACH_MS = [1000, 2000, 4000, 8000, 15_000];

/** What "exited" etc. mean to a person. */
const ENDED = new Set(["exited"]);

export class TermConn {
  attachId?: string;
  status: TermStatus = "connecting";
  private cols = 80;
  private rows = 24;
  private closed = false;
  /** attaching now (one at a time) */
  private attaching?: Promise<void>;
  private offs: (() => void)[] = [];
  private resizeTimer?: ReturnType<typeof setTimeout>;
  /** the first attach succeeded: later ones are reattaches */
  private attachedOnce = false;
  /** the first attach waits for the runner (it was offline when the view opened) */
  private first?: { stop: boolean };
  /** keys typed while the attach is away (a reattach): sent when it's back, if that's soon */
  private held: { at: number; text: string; leave?: boolean }[] = [];
  /** a line's Enter on its way: it goes to this terminal even if the view has moved on */
  private enter?: ReturnType<typeof setTimeout>;
  /** reattach tries that failed in a row, and the next try */
  private fails = 0;
  private again?: ReturnType<typeof setTimeout>;
  private w: Wiring;

  constructor(
    readonly runnerId: string,
    readonly target: TermTarget,
    private cb: TermCallbacks,
    private d: TermDeps,
  ) {
    this.w = wire(d);
    this.offs.push(
      d.onLink((open) => {
        if (!open) this.lost("Reconnecting…");
        else this.retry();
      }),
      d.onRunner(() => this.retry()),
    );
  }

  /**
   * Attaches. The first attach of a session may hand it to its TUI; `stop` stops a running turn
   * first (the person said so). Rejects with the runner's error (TERMINAL_BUSY, …).
   */
  async open(cols: number, rows: number, stop = false): Promise<void> {
    this.cols = cols;
    this.rows = rows;
    // The runner (or the link) is away: attach when it's back rather than fail now.
    if (!this.d.linkOpen() || !this.d.runnerOnline(this.runnerId)) {
      this.first = { stop };
      this.set("reconnecting", "Waiting for the runner…");
      return;
    }
    await this.attach(stop, false);
  }

  private attach(stop: boolean, reattach: boolean): Promise<void> {
    this.attaching ??= (async () => {
      this.set(this.attachedOnce ? "reconnecting" : "connecting");
      try {
        const cols = this.cols;
        const rows = this.rows;
        const r = await this.d.rpc(this.runnerId, "openTerminal", { ...this.target, cols, rows, ...(stop ? { stop } : {}), ...(reattach ? { reattach } : {}) });
        if (this.closed) {
          void this.d.rpc(this.runnerId, "closeTerminal", { attachId: r.attachId }).catch(() => {});
          return;
        }
        if (this.attachedOnce) this.cb.reset();
        this.attachedOnce = true;
        this.attachId = r.attachId;
        this.w.routes.set(r.attachId, this);
        this.set("open");
        this.fails = 0;
        const now = Date.now();
        const keys = this.held.filter((k) => now - k.at < HELD_KEYS_MS);
        this.held = [];
        for (const k of keys) this.input(k.text, k.leave);
        const e = this.w.early.get(r.attachId);
        this.w.early.delete(r.attachId);
        for (const c of e?.chunks ?? []) this.cb.data(c);
        // Resized while the attach was on its way (the panel's first fit): that resize had no attach
        // to go to, and the PTY would keep the old size.
        if (this.cols !== cols || this.rows !== rows) {
          clearTimeout(this.resizeTimer);
          void this.d.rpc(this.runnerId, "terminalResize", { attachId: r.attachId, cols: this.cols, rows: this.rows }).catch(() => {});
        }
      } finally {
        this.attaching = undefined;
      }
    })();
    return this.attaching;
  }

  onData(bytes: Uint8Array) {
    if (!this.closed) this.cb.data(bytes);
  }

  onEnd(reason?: string) {
    if (this.attachId) this.w.routes.delete(this.attachId);
    this.attachId = undefined;
    if (this.closed) return;
    if (reason && ENDED.has(reason)) {
      this.set("ended", "The terminal has closed.");
      return;
    }
    // The route is gone but the terminal isn't (the runner reconnected, the stream fell behind).
    this.lost(reason);
    this.retry();
  }

  /** The route is gone; a retry attaches again when the link and runner are back. */
  private lost(why?: string) {
    if (this.closed || this.status === "ended") return;
    if (this.attachId) this.w.routes.delete(this.attachId);
    this.attachId = undefined;
    if (this.attachedOnce) this.set("reconnecting", why);
  }

  private retry() {
    clearTimeout(this.again);
    this.again = undefined;
    if (this.closed || this.status === "ended" || this.attachId || this.attaching) return;
    if (!this.d.linkOpen() || !this.d.runnerOnline(this.runnerId)) return;
    if (this.first) {
      const { stop } = this.first;
      this.first = undefined;
      this.attach(stop, false).catch((e: Error) => {
        this.set("ended", e.message);
        this.cb.failed?.(e.message);
      });
      return;
    }
    if (!this.attachedOnce) return;
    this.attach(false, true).catch((e: Error) => {
      // Gone for good (exited meanwhile) or the runner can't: say so; a later reconnect tries again.
      if (/closed/i.test(e.message)) return this.set("ended", "The terminal has closed.");
      this.set("reconnecting", e.message);
      this.again = setTimeout(() => this.retry(), REATTACH_MS[Math.min(this.fails++, REATTACH_MS.length - 1)]);
    });
  }

  /**
   * Keys as typed (xterm's onData: a string of characters and escape sequences). `leave`: out of
   * tmux's copy mode first, whatever the keys (else the runner goes by what they are).
   */
  input(text: string, leave?: boolean) {
    if (!text || this.closed || this.status === "ended") return;
    this.send(text, leave);
  }

  private send(text: string, leave?: boolean) {
    if (!this.attachId) {
      // Reattaching: kept a moment, not dropped.
      if (this.held.reduce((n, k) => n + k.text.length, 0) + text.length <= HELD_KEYS_MAX) this.held.push({ at: Date.now(), text, ...(leave === undefined ? {} : { leave }) });
      return;
    }
    void this.d.rpc(this.runnerId, "terminalInput", { attachId: this.attachId, data: encodeChunk(new TextEncoder().encode(text)), ...(leave === undefined ? {} : { leave }) }).catch(() => {});
  }

  /** A line as a keyboard would type it: the text, then Enter, both to this terminal. */
  line(text: string) {
    if (this.closed || this.status === "ended") return;
    this.flushEnter();
    this.input(text, true);
    this.enter = setTimeout(() => {
      this.flushEnter();
      // Closing the attach ends its tmux client, which may not have read the Enter yet.
      if (this.closed) setTimeout(() => this.detach(), LINE_ENTER_MS);
    }, LINE_ENTER_MS);
  }

  private flushEnter() {
    if (!this.enter) return;
    clearTimeout(this.enter);
    this.enter = undefined;
    this.send("\r", true);
  }

  /** Lines a swipe moved: as wheel notches, which the runner makes one line each. */
  swipe(lines: number) {
    if (!lines || !this.attachId || this.closed) return;
    const data = encodeChunk(new TextEncoder().encode(wheelSeq(lines > 0, Math.abs(lines))));
    void this.d.rpc(this.runnerId, "terminalInput", { attachId: this.attachId, data, swipe: true }).catch(() => {});
  }

  resize(cols: number, rows: number) {
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      if (this.attachId) void this.d.rpc(this.runnerId, "terminalResize", { attachId: this.attachId, cols: this.cols, rows: this.rows }).catch(() => {});
    }, 60);
  }

  /** Detaches (the panel closed or the tab changed); the terminal goes on in tmux. */
  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.resizeTimer);
    clearTimeout(this.again);
    this.offs.forEach((f) => f());
    if (!this.enter) this.detach();
  }

  private detach() {
    if (!this.attachId) return;
    this.w.routes.delete(this.attachId);
    void this.d.rpc(this.runnerId, "closeTerminal", { attachId: this.attachId }).catch(() => {});
    this.attachId = undefined;
  }

  private set(s: TermStatus, why?: string) {
    this.status = s;
    this.cb.status(s, why);
  }
}

/** Keys for the phone's key bar (SPEC §8): what each sends. tmux reads them, whatever the app's mode. */
export const KEYS: { label: string; aria: string; data: string }[] = [
  { label: "Esc", aria: "Escape", data: "\x1b" },
  { label: "Tab", aria: "Tab", data: "\t" },
  { label: "⇧Tab", aria: "Shift Tab", data: "\x1b[Z" },
  { label: "↑", aria: "Up", data: "\x1b[A" },
  { label: "↓", aria: "Down", data: "\x1b[B" },
  { label: "←", aria: "Left", data: "\x1b[D" },
  { label: "→", aria: "Right", data: "\x1b[C" },
  { label: "^C", aria: "Control C", data: "\x03" },
  { label: "^D", aria: "Control D", data: "\x04" },
  { label: "⏎", aria: "Enter", data: "\r" },
];

/** A wheel notch as a terminal mouse report (SGR), at cell 1;1. `up`: towards older lines. */
export const wheelSeq = (up: boolean, n = 1) => `\x1b[<${up ? 64 : 65};1;1M`.repeat(n);

/** A finger's travel before it counts as a swipe, not a tap. */
const SWIPE_SLOP = 10;

/**
 * A swipe on a terminal, as wheel notches. tmux has the mouse, so the terminal's own touch scrolling
 * stands aside: a drag becomes wheel input for tmux. Lines: positive towards older (the finger
 * going down). `release` gives the speed for the glide, in lines a millisecond.
 */
export class Swipe {
  private lastY = 0;
  private lastAt = 0;
  private carry = 0;
  private speed = 0;
  active = false;

  constructor(private lineHeight: number) {}

  start(y: number, at: number) {
    this.lastY = y;
    this.lastAt = at;
    this.carry = 0;
    this.speed = 0;
    this.active = false;
  }

  /** The finger moved: whole lines to scroll now. */
  move(y: number, at: number): number {
    const dy = y - this.lastY;
    if (!this.active && Math.abs(dy) < SWIPE_SLOP) return 0;
    this.active = true;
    const dt = Math.max(1, at - this.lastAt);
    this.speed = dy / this.lineHeight / dt;
    this.lastY = y;
    this.lastAt = at;
    this.carry += dy / this.lineHeight;
    const lines = Math.trunc(this.carry);
    this.carry -= lines;
    return lines;
  }

  /** The finger left: lines a millisecond to glide at (0: it stopped first). */
  release(at: number): number {
    return this.active && at - this.lastAt < 80 ? this.speed : 0;
  }
}

/** The tab to open on for "Shell": the project's first shell, or a new one when it has none. */
export const SHELL_TAB = "shell";

/**
 * The panel once a new shell exists: it comes to the front, unless it is the one ❯_ opened by itself
 * (`auto`) and you have moved on while it started (to the agent's entry, on a slow runner).
 */
export function shellOpened<T extends { tab: string }>(panel: T | null, shellId: string, auto: boolean): T | null {
  if (!panel || (auto && panel.tab !== SHELL_TAB)) return panel;
  return { ...panel, tab: shellId };
}

/**
 * The question before opening the terminal (SPEC §8 handoff), or none when it opens right away.
 * `paused`: the queue is already held (after Stop, a failed turn, a restart): it stays so, nothing
 * new waits on the terminal.
 */
export function handoffPrompt(running: boolean, queued: number, paused = false): { text: string; confirm: string } | null {
  if (paused) {
    const p = queued === 1 ? "The queued message stays paused." : `The ${queued} queued messages stay paused.`;
    return running ? { text: `Stop this turn and open the terminal? ${p}`, confirm: "Stop and open terminal" } : null;
  }
  const q = queued === 1 ? "1 queued message will wait until you're back." : `${queued} queued messages will wait until you're back.`;
  if (running) return { text: queued ? `Stop this turn and open the terminal? ${q}` : "Stop this turn and open the terminal?", confirm: "Stop and open terminal" };
  if (queued) return { text: `Open the terminal? ${q}`, confirm: "Open terminal" };
  return null;
}
