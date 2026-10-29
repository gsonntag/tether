// A PTY running one process, on Bun's built-in terminal support (Bun.spawn with `terminal`).
// P3 attaches each browser through one of these running `tmux attach` (SPEC §8). Findings and
// caveats: docs/notes/pty.md.

export interface PtyOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  cols?: number;
  rows?: number;
  onData: (bytes: Uint8Array) => void;
  /** the process exited; `code` is its exit code (null when killed by a signal) */
  onExit?: (code: number | null) => void;
}

export interface Pty {
  readonly pid: number;
  write(data: string | Uint8Array): void;
  resize(cols: number, rows: number): void;
  /** ends the process (SIGHUP, as a closing terminal would) and the PTY */
  close(): void;
  readonly exited: Promise<number | null>;
}

export function spawnPty(argv: string[], opts: PtyOptions): Pty {
  const proc = Bun.spawn(argv, {
    cwd: opts.cwd,
    env: { TERM: "xterm-256color", ...(opts.env ?? process.env) } as Record<string, string>,
    terminal: {
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
      name: "xterm-256color",
      data: (_t, bytes) => opts.onData(bytes),
    },
  });
  const term = proc.terminal!;
  const exited = proc.exited.then((code) => {
    if (!term.closed) term.close();
    const result = proc.signalCode ? null : code;
    opts.onExit?.(result);
    return result;
  });
  return {
    pid: proc.pid,
    write: (data) => void (term.closed || term.write(data)),
    resize: (cols, rows) => term.closed || term.resize(Math.max(1, cols | 0), Math.max(1, rows | 0)),
    close: () => {
      if (proc.exitCode === null && !proc.signalCode) proc.kill("SIGHUP");
    },
    exited,
  };
}
