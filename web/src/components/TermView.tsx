// One terminal on screen: xterm.js fed by an attach (terminal.ts). It fits its box, and the box's
// size is the PTY's size, so tmux (window-size latest) draws for whichever device was used last.

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { on, rpc } from "../connection";
import { useStore } from "../store";
import { TermConn, type TermDeps, type TermStatus, type TermTarget } from "../terminal";

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
  /** sends keys as typed (the phone's key bar, its input line) */
  input(data: string): void;
  focus(): void;
}

const narrow = () => typeof matchMedia === "function" && matchMedia("(max-width: 767px)").matches;

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
  }
>(function TermView({ runnerId, target, stop, onError, onStatus }, ref) {
  const box = useRef<HTMLDivElement>(null);
  const conn = useRef<TermConn>(null);
  const term = useRef<Terminal>(null);
  const [status, setStatus] = useState<{ s: TermStatus; why?: string }>({ s: "connecting" });
  const key = "sessionId" in target ? target.sessionId : target.shellId;

  useImperativeHandle(ref, () => ({
    input: (d) => conn.current?.input(d),
    focus: () => term.current?.focus(),
  }));

  useEffect(() => {
    const el = box.current!;
    const t = new Terminal({
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--t-mono").trim() || "ui-monospace, Menlo, monospace",
      fontSize: narrow() ? 11 : 13,
      cursorBlink: true,
      scrollback: 3000,
      allowProposedApi: true,
      macOptionIsMeta: true,
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
      },
      deps,
    );
    conn.current = c;
    const input = t.onData((d) => c.input(d));
    const binary = t.onBinary((d) => c.input(d));
    c.open(t.cols, t.rows, stop).then(
      () => !narrow() && t.focus(),
      (e: Error) => {
        setStatus({ s: "ended", why: e.message });
        onError?.(e.message);
      },
    );
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {}
      c.resize(t.cols, t.rows);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      input.dispose();
      binary.dispose();
      c.close();
      if (debugTerms?.get(key) === t) debugTerms.delete(key);
      t.dispose();
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
