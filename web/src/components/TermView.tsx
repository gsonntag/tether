// One terminal on screen: xterm.js fed by an attach (terminal.ts). It fits its box, and the box's
// size is the PTY's size, so tmux (window-size latest) draws for whichever device was used last.

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { on, rpc } from "../connection";
import { useStore } from "../store";
import { Swipe, TermConn, type TermDeps, type TermStatus, type TermTarget } from "../terminal";
import { copyable, plainDragSelects } from "../termSelect";

const deps: TermDeps = {
  rpc,
  on,
  linkOpen: () => useStore.getState().link === "open",
  onLink: (fn) => {
    let was = useStore.getState().link === "open";
    return useStore.subscribe((s) => {
      const open = s.link === "open";
      if (open !== was) fn((was = open));
    });
  },
  runnerOnline: (id) => !!useStore.getState().runners.find((r) => r.id === id)?.online,
  onRunner: (fn) => {
    let was = JSON.stringify(useStore.getState().runners.map((r) => [r.id, r.online, r.connectedAt]));
    return useStore.subscribe((s) => {
      const now = JSON.stringify(s.runners.map((r) => [r.id, r.online, r.connectedAt]));
      if (now !== was) (was = now), fn();
    });
  },
};

/** Dev builds: terminals by target, for the end-to-end scripts. */
const debugTerms: Map<string, Terminal> | undefined = import.meta.env?.DEV ? ((globalThis as any).__tetherTerms ??= new Map()) : undefined;

export interface TermViewHandle {
  /** sends keys as typed (the phone's key bar); `leave`: out of copy mode first, whatever the keys */
  input(data: string, leave?: boolean): void;
  /** a whole line, then Enter, to this terminal (the phone's line) */
  line(text: string): void;
  /** the attach now (for the panel's Copy), if attached */
  attachId(): string | undefined;
  focus(): void;
}

const narrow = () => typeof matchMedia === "function" && matchMedia("(max-width: 767px)").matches;
const fontSize = () => (narrow() ? 11 : 13);
/** A panel over the chat on a touch screen: focus there would raise the keyboard over the terminal, unasked. */
export const raisesKeyboard = (cover: boolean) => cover && typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

export const TermView = forwardRef<
  TermViewHandle,
  {
    runnerId: string;
    target: TermTarget;
    /** stop a running turn on the first attach (the person said so) */
    stop?: boolean;
    /** the first attach failed (the runner's message) */
    onError?: (message: string) => void;
    onStatus?: (s: TermStatus) => void;
    /** the panel covers the chat (useTermCover) */
    cover: boolean;
  }
>(function TermView({ runnerId, target, stop, onError, onStatus, cover }, ref) {
  const box = useRef<HTMLDivElement>(null);
  const conn = useRef<TermConn>(null);
  const term = useRef<Terminal>(null);
  const coverNow = useRef(cover);
  coverNow.current = cover;
  const stopGlide = useRef(() => {});
  const [status, setStatus] = useState<{ s: TermStatus; why?: string }>({ s: "connecting" });
  const key = "sessionId" in target ? target.sessionId : target.shellId;

  useImperativeHandle(ref, () => ({
    input: (d, leave) => {
      stopGlide.current();
      conn.current?.input(d, leave);
    },
    line: (text) => {
      stopGlide.current();
      conn.current?.line(text);
    },
    attachId: () => conn.current?.attachId,
    focus: () => term.current?.focus(),
  }));

  useEffect(() => {
    const el = box.current!;
    const t = new Terminal({
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--t-mono").trim() || "ui-monospace, Menlo, monospace",
      fontSize: fontSize(),
      cursorBlink: true,
      scrollback: 3000,
      allowProposedApi: true,
      macOptionIsMeta: true,
      // Shift-drag, or Option-drag on a Mac, selects whatever takes the mouse (a plain drag: termSelect.ts).
      macOptionClickForcesSelection: true,
      rightClickSelectsWord: true,
      theme: { background: "#16171a", foreground: "#e6e6e6", cursor: "#e6e6e6", selectionBackground: "#3a3d45" },
    });
    const fit = new FitAddon();
    t.loadAddon(fit);
    t.open(el);
    term.current = t;
    debugTerms?.set(key, t);
    try {
      fit.fit();
    } catch {}
    const c = new TermConn(
      runnerId,
      target,
      {
        data: (b) => t.write(b),
        reset: () => t.reset(),
        status: (s, why) => {
          setStatus({ s, why });
          onStatus?.(s);
        },
        failed: (m) => onError?.(m),
      },
      deps,
    );
    conn.current = c;
    // Copy: with text selected, Ctrl/Cmd+C (and Ctrl+Shift+C) copies it and never reaches the
    // terminal as ^C. Without a selection Ctrl+C is ^C, as always.
    t.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown" || e.key.toLowerCase() !== "c" || !(e.ctrlKey || e.metaKey) || !t.hasSelection()) return true;
      const text = t.getSelection();
      e.preventDefault();
      // The selection goes only once it is surely copied (a failed copy leaves it to try again).
      const done = () => t.clearSelection();
      if (window.isSecureContext && navigator.clipboard?.writeText) void navigator.clipboard.writeText(text).then(done, () => copyByCommand(text) && done());
      else if (copyByCommand(text)) done();
      t.focus();
      return false;
    });
    // A mouse selects: a plain drag too, and a finished selection goes to the clipboard at once and
    // stays on screen. On the window, so xterm has finished with this mouseup; still in the gesture,
    // which browsers ask of a clipboard write.
    const mouse = !matchMedia("(pointer: coarse)").matches;
    const undoDrag = mouse ? plainDragSelects(el, () => t.modes.mouseTrackingMode !== "none", () => t.focus()) : undefined;
    let pressed = false;
    const press = (e: MouseEvent) => {
      if (e.button === 0) pressed = true;
    };
    const released = () => {
      if (!pressed) return;
      pressed = false;
      const text = copyable(t.getSelection());
      if (text) void copyText(text);
    };
    if (mouse) {
      el.addEventListener("mousedown", press, true);
      window.addEventListener("mouseup", released);
    }
    // A swipe scrolls: tmux has the mouse, so xterm's own touch scrolling stands aside, and a drag
    // goes to tmux line by line, with the finger (a tap stays a tap: it focuses the terminal).
    const scroll = (lines: number) => {
      if (!lines) return;
      if (t.modes.mouseTrackingMode === "none") t.scrollLines(-lines);
      else c.swipe(Math.max(-30, Math.min(30, lines)));
    };
    const swipe = new Swipe(Math.max(8, el.clientHeight / Math.max(1, t.rows)));
    let glide = 0;
    stopGlide.current = () => cancelAnimationFrame(glide);
    const touchStart = (e: TouchEvent) => {
      cancelAnimationFrame(glide);
      if (e.touches.length === 1) swipe.start(e.touches[0]!.clientY, e.timeStamp);
    };
    const touchMove = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const lines = swipe.move(e.touches[0]!.clientY, e.timeStamp);
      if (swipe.active) e.preventDefault();
      scroll(lines);
    };
    const touchEnd = (e: TouchEvent) => {
      let speed = swipe.release(e.timeStamp);
      if (!speed) return;
      // The glide: slows to a stop within about a second.
      let carry = 0;
      let last = performance.now();
      const step = (now: number) => {
        const dt = now - last;
        last = now;
        carry += speed * dt;
        speed *= Math.pow(0.996, dt);
        const lines = Math.trunc(carry);
        carry -= lines;
        scroll(lines);
        if (Math.abs(speed) > 0.005) glide = requestAnimationFrame(step);
      };
      glide = requestAnimationFrame(step);
    };
    el.addEventListener("touchstart", touchStart, { passive: true, capture: true });
    el.addEventListener("touchmove", touchMove, { passive: false, capture: true });
    el.addEventListener("touchend", touchEnd, { passive: true, capture: true });
    // Typing ends a glide: its next notch would scroll back away from what was typed.
    const input = t.onData((d) => {
      if (d[0] !== "\x1b") cancelAnimationFrame(glide);
      c.input(d);
    });
    const binary = t.onBinary((d) => c.input(d));
    c.open(t.cols, t.rows, stop).then(
      () => !raisesKeyboard(coverNow.current) && t.focus(),
      (e: Error) => {
        setStatus({ s: "ended", why: e.message });
        onError?.(e.message);
      },
    );
    const ro = new ResizeObserver(() => {
      // Hidden (a phone showing the chat): the PTY keeps its size until it shows again.
      if (!el.clientWidth || !el.clientHeight) return;
      // Rotated: a phone upright gets the smaller font, on its side the larger.
      if (t.options.fontSize !== fontSize()) t.options.fontSize = fontSize();
      try {
        fit.fit();
      } catch {}
      c.resize(t.cols, t.rows);
    });
    ro.observe(el);
    return () => {
      undoDrag?.();
      el.removeEventListener("mousedown", press, true);
      window.removeEventListener("mouseup", released);
      cancelAnimationFrame(glide);
      el.removeEventListener("touchstart", touchStart, true);
      el.removeEventListener("touchmove", touchMove, true);
      el.removeEventListener("touchend", touchEnd, true);
      ro.disconnect();
      input.dispose();
      binary.dispose();
      c.close();
      if (debugTerms?.get(key) === t) debugTerms.delete(key);
      // xterm's viewport syncs in a timer set when it opens: a view gone at once (the TUI just exited)
      // must let that run first, or it throws on the disposed terminal.
      setTimeout(() => t.dispose(), 0);
    };
  }, [runnerId, key]);

  return (
    <div className="t-term-view">
      <div ref={box} className="t-term-box" />
      {status.s !== "open" && (
        <div className={`t-term-status${status.s === "ended" ? " ended" : ""}`} role="status">
          {status.s === "connecting" ? "Connecting…" : status.s === "reconnecting" ? (status.why ?? "Reconnecting…") : (status.why ?? "The terminal has closed.")}
        </div>
      )}
    </div>
  );
});

/** To the clipboard, whichever way this page can (the selection isn't touched). */
async function copyText(text: string) {
  if (window.isSecureContext && navigator.clipboard?.writeText) await navigator.clipboard.writeText(text).catch(() => copyByCommand(text));
  else copyByCommand(text);
}

/** Copies through the browser's own copy command (plain http, no Clipboard API). */
function copyByCommand(text: string): boolean {
  // Answering the copy event keeps focus in the terminal: moving it would send tmux focus reports.
  let answered = false;
  const answer = (e: ClipboardEvent) => {
    e.clipboardData?.setData("text/plain", text);
    e.preventDefault();
    e.stopImmediatePropagation();
    answered = true;
  };
  document.addEventListener("copy", answer, true);
  try {
    document.execCommand("copy");
  } catch {}
  document.removeEventListener("copy", answer, true);
  if (answered) return true;
  // Some browsers fire no copy event without a selection: a hidden text box then.
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {}
  ta.remove();
  return ok;
}
