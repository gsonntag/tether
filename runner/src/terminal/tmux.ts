// tmux control for terminal mode (SPEC §8). Every terminal is its own tmux session on Tether's own
// socket (`tmux -L tether`, TETHER_TMUX_SOCKET in dev), so it outlives the runner: a restart lists
// the sessions and readopts them. Each session describes itself in tmux user options (@tether_*),
// so nothing about terminals has to be kept anywhere else.
//
// The server is configured for a browser client, not for a person at a real tmux: no prefix key
// (Ctrl-B belongs to the TUI), no status line, no escape delay, `window-size latest` (the device
// you type on sets the size), mouse on for scrolling, and focus events (Claude asks for them).
//
// Commands run with Tether's secrets removed from the environment: the tmux server keeps the
// environment of the process that started it, and every shell in it inherits that.

export type TermKind = "tui" | "shell";

/** A tmux session Tether started, as its @tether_* options describe it. */
export interface TmuxSession {
  name: string;
  kind: TermKind;
  /** tui: the Tether session it runs (`claude:<id>`) */
  sessionId?: string;
  /** the folder it started in (shells: the project they belong to) */
  projectPath: string;
  /** shells: their number within the project (Shell 1, Shell 2, …) */
  n?: number;
  /** what runs in it now (`bash`, `python3`, `claude`) */
  command?: string;
  createdAt?: number;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Exec = (argv: string[], opts?: { input?: string }) => Promise<ExecResult>;

/** The socket Tether's terminals live on. */
export const TMUX_SOCKET = process.env.TETHER_TMUX_SOCKET || "tether";

/** systemd's per-unit markers, and tmux's own (a runner started inside tmux must not look nested). */
const DROP_ENV = new Set(["INVOCATION_ID", "JOURNAL_STREAM", "TMUX", "TMUX_PANE"]);

/** The environment for tmux (and so for everything in it): the runner's, minus Tether's secrets. */
export function cleanEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !k.startsWith("TETHER_") && !DROP_ENV.has(k)) out[k] = v;
  return out;
}

export const defaultExec: Exec = async (argv, opts) => {
  const p = Bun.spawn(argv, { env: cleanEnv(), stdin: opts?.input !== undefined ? new TextEncoder().encode(opts.input) : "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, stdout, stderr };
};

/** Options set on Tether's tmux server (see the header). */
export const SERVER_OPTIONS: string[][] = [
  ["set", "-g", "prefix", "None"],
  ["set", "-g", "prefix2", "None"],
  ["set", "-g", "status", "off"],
  ["set", "-g", "escape-time", "0"],
  ["set", "-g", "window-size", "latest"],
  ["set", "-g", "aggressive-resize", "on"],
  ["set", "-g", "mouse", "on"],
  ["set", "-g", "focus-events", "on"],
  ["set", "-g", "history-limit", "20000"],
  ["set", "-g", "default-terminal", "tmux-256color"],
  ["set", "-ga", "terminal-overrides", ",xterm-256color:RGB"],
  ["set", "-g", "set-clipboard", "off"],
  ["set", "-g", "detach-on-destroy", "on"],
  // A bigger device than the one typing sees the window plain, with blank space around it (not dots).
  ["set", "-wg", "fill-character", " "],
];

const FORMAT = ["#{session_name}", "#{@tether_kind}", "#{@tether_session}", "#{@tether_project}", "#{@tether_n}", "#{pane_current_command}", "#{session_created}"].join("\t");

/** tmux session names can't hold ":" or "."; Tether's are `t-<harness>-<id>` and `sh-<project>-<n>`. */
export const tuiName = (sessionId: string) => `t-${sessionId.replace(/[^A-Za-z0-9_-]/g, "-")}`;
export const shellName = (projectKey: string, n: number) => `sh-${projectKey}-${n}`;

/** A short stable key for a project folder. */
export function projectKey(path: string): string {
  return new Bun.CryptoHasher("sha256").update(path).digest("hex").slice(0, 10);
}

export interface TmuxOptions {
  socket?: string;
  exec?: Exec;
  /**
   * Runs the command that starts the tmux server somewhere it survives the runner. Under systemd
   * (KillMode=mixed kills the unit's whole cgroup on stop) that's a scope of its own.
   */
  wrapStart?: (argv: string[]) => string[];
}

/** Under a systemd unit, start the tmux server in its own scope so stopping the runner leaves it. */
export function systemdScopeWrap(socket: string): ((argv: string[]) => string[]) | undefined {
  if (!process.env.INVOCATION_ID || !Bun.which("systemd-run")) return undefined;
  return (argv) => ["systemd-run", "--user", "--scope", "--quiet", "--collect", `--unit=tether-tmux-${socket.replace(/[^A-Za-z0-9_-]/g, "-")}-${Date.now()}`, ...argv];
}

export class Tmux {
  readonly socket: string;
  private exec: Exec;
  private wrapStart?: (argv: string[]) => string[];
  private configured = false;
  /** starting the server is serialized: two first sessions at once must not start two */
  private starting?: Promise<unknown>;

  constructor(o: TmuxOptions = {}) {
    this.socket = o.socket ?? TMUX_SOCKET;
    this.exec = o.exec ?? defaultExec;
    this.wrapStart = o.wrapStart;
  }

  /** argv for a tmux command on Tether's socket (also used to attach a PTY). */
  argv(...args: string[]): string[] {
    return ["tmux", "-L", this.socket, "-f", "/dev/null", ...args];
  }

  private async run(args: string[], input?: string): Promise<ExecResult> {
    return this.exec(this.argv(...args), input !== undefined ? { input } : undefined);
  }

  private async must(args: string[], input?: string): Promise<string> {
    const r = await this.run(args, input);
    if (r.code !== 0) throw new Error(`tmux ${args[0]}: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}`);
    return r.stdout;
  }

  /** The server is up (it has at least one session). */
  async running(): Promise<boolean> {
    return (await this.run(["list-sessions", "-F", "#{session_name}"])).code === 0;
  }

  private async configure() {
    if (this.configured) return;
    // One round trip: tmux runs ";"-separated commands in order.
    const args = SERVER_OPTIONS.flatMap((o, i) => (i ? [";", ...o] : o));
    await this.must(args);
    this.configured = true;
  }

  /** Tether's sessions on the socket (others there are ignored). */
  async list(): Promise<TmuxSession[]> {
    const r = await this.run(["list-sessions", "-F", FORMAT]);
    // No server (nothing running yet) is an empty list, not an error.
    if (r.code !== 0) return [];
    const out: TmuxSession[] = [];
    for (const line of r.stdout.split("\n")) {
      if (!line.trim()) continue;
      const [name, kind, sessionId, projectPath, n, command, created] = line.split("\t");
      if (kind !== "tui" && kind !== "shell") continue;
      out.push({
        name: name!,
        kind,
        ...(sessionId ? { sessionId } : {}),
        projectPath: projectPath ?? "",
        ...(n ? { n: Number(n) } : {}),
        ...(command ? { command } : {}),
        ...(created ? { createdAt: Number(created) * 1000 } : {}),
      });
    }
    return out;
  }

  async has(name: string): Promise<boolean> {
    return (await this.run(["has-session", "-t", `=${name}`])).code === 0;
  }

  /**
   * Starts a detached session running `argv` in `cwd` at the given size, tagged with Tether's
   * options. The first one starts (and configures) the server.
   */
  async create(o: { name: string; cwd: string; argv: string[]; env?: Record<string, string>; cols?: number; rows?: number; tags: Record<string, string> }) {
    const args = ["new-session", "-d", "-s", o.name, "-c", o.cwd, "-x", String(clamp(o.cols, 80)), "-y", String(clamp(o.rows, 24))];
    for (const [k, v] of Object.entries(o.env ?? {})) args.push("-e", `${k}=${v}`);
    args.push("--", ...o.argv);
    // Tagged in the same invocation, so a list never sees it untagged.
    for (const [k, v] of Object.entries(o.tags)) args.push(";", "set-option", "-t", o.name, `@tether_${k}`, v);
    const start = async () => {
      const up = await this.running();
      const argv = this.argv(...args);
      const r = await this.exec(!up && this.wrapStart ? this.wrapStart(argv) : argv);
      if (r.code !== 0) throw new Error(`tmux new-session: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}`);
      if (!up) this.configured = false;
    };
    const prev = this.starting;
    const mine = (async () => {
      await prev?.catch(() => {});
      await start();
    })();
    this.starting = mine;
    await mine;
    await this.configure();
  }

  async kill(name: string) {
    await this.run(["kill-session", "-t", `=${name}`]);
  }

  /** Keys by tmux name (`Enter`, `Escape`, `C-c`), each one a separate key press. */
  async keys(name: string, ...keys: string[]) {
    if (keys.length) await this.must(["send-keys", "-t", `=${name}:`, ...keys]);
  }

  /** Text typed as is: one line with send-keys -l; several as a bracketed paste. */
  async type(name: string, text: string): Promise<void> {
    if (!text) return;
    if (!text.includes("\n")) {
      await this.must(["send-keys", "-t", `=${name}:`, "-l", "--", text]);
      return;
    }
    const buf = `tether-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    await this.must(["load-buffer", "-b", buf, "-"], text);
    await this.must(["paste-buffer", "-p", "-d", "-b", buf, "-t", `=${name}:`]);
  }

  /** The text on screen now (for tests and diagnostics). */
  async capture(name: string): Promise<string> {
    return this.must(["capture-pane", "-p", "-t", `=${name}:`]);
  }

  /** Stops the whole server (tests and dev cleanup only). */
  async killServer() {
    await this.run(["kill-server"]);
    this.configured = false;
  }
}

const clamp = (v: number | undefined, d: number) => Math.max(10, Math.min(500, Math.floor(v ?? d) || d));

