# Bun PTY support (verified for P3)

Verified 2026-10-29 on Bun 1.4.2, Linux (aarch64), tmux 3.4. Probe: `runner/scripts/pty-probe.ts`;
wrapper: `runner/src/terminal/pty.ts` (with `pty.test.ts`).

**Verdict: usable. P3 uses `Bun.spawn(argv, { terminal })`; `node-pty` is not needed.**

## API

```ts
const proc = Bun.spawn(argv, { cwd, env, terminal: { cols, rows, name: "xterm-256color", data(term, bytes) {} } });
proc.terminal.write("ls\r");   // string or bytes; never short-writes (buffers, `drain` fires when flushed)
proc.terminal.resize(cols, rows);
await proc.exited;             // the process's exit code; proc.signalCode when killed
proc.terminal.close();
```

`new Bun.Terminal(opts)` also exists and can be reused across spawns; we don't need that.
With `terminal` set, `proc.stdin/stdout/stderr` are null and stdout and stderr both arrive
through `data`, as in a real terminal.

## What the probe checked

| Check | Result |
|---|---|
| Input and output through an interactive bash | ok |
| The child sees a real tty (`/dev/pts/N`), `stty size` = 24 80 | ok |
| `resize(132, 40)` reaches the kernel (`stty size`) and delivers SIGWINCH | ok |
| Ctrl-C (`\x03`) interrupts the foreground job (line discipline works) | ok |
| Throughput: 5.4 MB of output in ~150 ms | ok |
| `tmux -L <sock> attach -t <s>` inside the PTY mirrors the pane (text sent with `send-keys -l` shows up) | ok |
| Resizing the attach PTY resizes the tmux window (`window-size latest`; 70x20 PTY -> 70x19 window plus status line) | ok |
| Closing the attach (SIGHUP) leaves the tmux session running | ok |
| Exit code comes back (`exit 3` -> 3); killed -> `signalCode` set | ok |

## Caveats for P3

- **No read-side flow control.** There is no pause/resume for `data`; Bun reads as fast as the
  child writes. The runner must watch its socket's buffered amount and, if it falls far behind,
  end that attach (`termEnd`) rather than drop chunks. The relay follows the same rule
  (`shared/protocol.ts`, slow sockets): a socket whose send buffer passes 12 MB is closed, never
  fed partially. Either way the browser reattaches and tmux redraws the screen, so a terminal
  stream never has a silent gap.
- The `exit` callback in `TerminalOptions` reports PTY EOF (0 clean, 1 error), **not** the
  process's exit code. Use `proc.exited`.
- `data` chunks can split UTF-8 sequences. Send bytes (base64, `shared/wire.ts`) and let
  xterm.js decode; never decode per chunk on the runner.
- Input is bytes as typed: Enter is `\r` for an interactive program (the line discipline maps
  it), as xterm.js sends it.
- POSIX only (Linux, macOS), which is all the runner targets.
