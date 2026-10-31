// tmux control for terminal mode (SPEC §8). Every terminal is its own tmux session on Tether's own
// socket (`tmux -L tether`, TETHER_TMUX_SOCKET in dev), so it outlives the runner: a restart lists
// the sessions and readopts them. Each session describes itself in tmux user options (@tether_*),
// so nothing about terminals has to be kept anywhere else.
//
// The server is configured for a browser client, not for a person at a real tmux: no prefix key
// (Ctrl-B belongs to the TUI), no status line, no escape delay, `window-size latest` (the device
// you type on sets the size), mouse on for scrolling, and focus events (Claude asks for them).
//
// Three keys of Tether's own (`user-keys`) reach tmux in the input stream itself, so they keep their
// order with what is typed around them, which a separate tmux command wouldn't: LEAVE_KEY quits
// copy mode, SCROLL_* move one line (a wheel notch moves five). tmux eats them: a program never sees
// them.
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
  /** tui: the session it was launched for, when /clear or /resume moved it on (its hooks still say that one) */
  launchedFor?: string;
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
const DROP_ENV = new Set(["INVOCATION_ID", "JOURNAL_STREAM", "SYSTEMD_EXEC_PID", "TMUX", "TMUX_PANE"]);

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

export const LEAVE_KEY = "\x1b[59990~";
const SCROLL_OLDER = "\x1b[59991~";
const SCROLL_NEWER = "\x1b[59992~";

/** A swipe's wheel notches (the browser's way to say it) as one line each. */
export const swipeKeys = (wheel: string) => wheel.replaceAll("\x1b[<64;1;1M", SCROLL_OLDER).replaceAll("\x1b[<65;1;1M", SCROLL_NEWER);

/** Outside copy mode: a program that takes the mouse gets a wheel notch, as with tmux's own wheel binding. */
const swipeBinding = (key: string, report: string, otherwise: string[]) => ["bind-key", "-T", "root", key, "if-shell", "-F", "#{mouse_any_flag}", `send-keys -l '${report}'`, ...otherwise];

/**
 * Whether keys are meant for the program, not for scrolling, so copy mode must not swallow them:
 * text, Enter, control keys, a paste, Alt with a key, Delete, Shift+Tab. Not Esc alone, which quits
 * copy mode by itself; not arrows and page keys, which scroll there; and not what a terminal says
 * by itself (mouse and focus reports, replies to tmux's queries).
 */
export function forProgram(b: Uint8Array): boolean {
  if (!b.length) return false;
  if (b[0] !== 0x1b) return true;
  if (b.length === 1) return false;
  const s = String.fromCharCode(...b.subarray(0, 6));
  return s.startsWith("\x1b[200~") || s === "\x1b[Z" || s === "\x1b[3~" || /^\x1b[^[\]OP_^X]/.test(s);
}

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
  // Keys that arrive together are still keys: tmux would take them for a paste and skip the bindings.
  ["set", "-g", "assume-paste-time", "0"],
  // tmux picks vi keys from $EDITOR, where Esc doesn't quit copy mode.
  ["set", "-wg", "mode-keys", "emacs"],
  ["set", "-s", "user-keys[0]", LEAVE_KEY],
  ["set", "-s", "user-keys[1]", SCROLL_OLDER],
  ["set", "-s", "user-keys[2]", SCROLL_NEWER],
  ["bind-key", "-T", "copy-mode", "User0", "send-keys", "-X", "cancel"],
  ["bind-key", "-T", "copy-mode", "User1", "send-keys", "-X", "scroll-up"],
  ["bind-key", "-T", "copy-mode", "User2", "send-keys", "-X", "scroll-down"],
  swipeBinding("User1", "\x1b[<64;1;1M", ["copy-mode -e"]),
  swipeBinding("User2", "\x1b[<65;1;1M", []),
];

const FORMAT = ["#{session_name}", "#{@tether_kind}", "#{@tether_session}", "#{@tether_project}", "#{@tether_n}", "#{pane_current_command}", "#{session_created}", "#{@tether_launch}"].join("\t");

/**
 * tmux reads an argument ending in ";" as a command separator and drops the ";". Written as "\;" it
 * stays (the backslash goes), so text and argv keep their trailing semicolons.
 */
export const tmuxArg = (a: string) => (a.endsWith(";") ? `${a.slice(0, -1)}\\;` : a);

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
  log?: (line: string) => void;
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
  private logLine: (line: string) => void;
  private configured = false;
  /** starting the server is serialized: two first sessions at once must not start two */
  private starting?: Promise<unknown>;

  constructor(o: TmuxOptions = {}) {
    this.socket = o.socket ?? TMUX_SOCKET;
    this.exec = o.exec ?? defaultExec;
    this.wrapStart = o.wrapStart;
    this.logLine = o.log ?? ((l) => console.log(l));
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

  /** The server is up. `show-options` never starts one (only start-server, new-session and attach do). */
  async running(): Promise<boolean> {
    return (await this.run(["show-options", "-gv", "exit-empty"])).code === 0;
  }

  /**
   * The server's settings: Tether's options and no systemd markers in the environment shells
   * inherit. `exit-empty off` (the server never exits between sessions, so no later command has to
   * start one) goes with start-server itself.
   */
  private setupCommands(): string[][] {
    return [...SERVER_OPTIONS, ...[...DROP_ENV].map((k) => ["set-environment", "-g", "-u", k])];
  }

  /**
   * Applies the settings: in one round trip, or, if tmux refuses one (an option this version
   * doesn't know), one at a time, the refused ones skipped and logged. A terminal without one of
   * them still works.
   */
  private async configure() {
    const cmds = this.setupCommands();
    const all = await this.run(cmds.flatMap((o, i) => (i ? [";", ...o] : o)));
    if (all.code !== 0) {
      for (const c of cmds) {
        const r = await this.run(c);
        if (r.code !== 0) this.logLine(`tmux refused \`${c.join(" ")}\` (${(r.stderr || r.stdout).trim() || `exit ${r.code}`}); going on without it`);
      }
    }
    this.configured = true;
  }

  /**
   * Makes sure the server runs, started on its own (`start-server`, under systemd in a scope of its
   * own so stopping the runner's unit leaves it) and configured. Every other command is then only a
   * client: new-session or attach never get to start a server inside the runner's cgroup. Its
   * process title is this start-server command, so nothing matching "claude" kills it.
   */
  ensureServer(): Promise<void> {
    const prev = this.starting;
    const mine = (async () => {
      await prev?.catch(() => {});
      if (!(await this.running())) {
        const argv = this.argv("start-server", ";", "set", "-g", "exit-empty", "off");
        const r = await this.exec(this.wrapStart ? this.wrapStart(argv) : argv);
        if (r.code !== 0) throw new Error(`tmux start-server: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}`);
        this.configured = false;
      }
      // Up already (it outlived the runner, or an older runner started it): configured once.
      if (!this.configured) await this.configure();
    })();
    this.starting = mine;
    return mine;
  }

  /** Tether's sessions on the socket (others there are ignored). */
  async list(): Promise<TmuxSession[]> {
    const r = await this.run(["list-sessions", "-F", FORMAT]);
    // No server (nothing running yet) is an empty list, not an error.
    if (r.code !== 0) return [];
    const out: TmuxSession[] = [];
    for (const line of r.stdout.split("\n")) {
      if (!line.trim()) continue;
      const [name, kind, sessionId, projectPath, n, command, created, launch] = line.split("\t");
      if (kind !== "tui" && kind !== "shell") continue;
      out.push({
        name: name!,
        kind,
        ...(sessionId ? { sessionId } : {}),
        projectPath: projectPath ?? "",
        ...(n ? { n: Number(n) } : {}),
        ...(command ? { command } : {}),
        ...(created ? { createdAt: Number(created) * 1000 } : {}),
        ...(launch ? { launchedFor: launch } : {}),
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
    const args = ["new-session", "-d", "-s", o.name, "-c", tmuxArg(o.cwd), "-x", String(clamp(o.cols, 80)), "-y", String(clamp(o.rows, 24))];
    for (const [k, v] of Object.entries(o.env ?? {})) args.push("-e", tmuxArg(`${k}=${v}`));
    args.push("--", ...o.argv.map(tmuxArg));
    // Tagged in the same invocation, so a list never sees it untagged.
    for (const [k, v] of Object.entries(o.tags)) args.push(";", "set-option", "-t", `=${o.name}:`, `@tether_${k}`, tmuxArg(v));
    await this.ensureServer();
    await this.must(args);
  }

  /** Sets (or with undefined, clears) one of a session's @tether_* tags. */
  async tag(name: string, key: string, value: string | undefined) {
    await this.must(value === undefined ? ["set-option", "-u", "-t", `=${name}:`, `@tether_${key}`] : ["set-option", "-t", `=${name}:`, `@tether_${key}`, tmuxArg(value)]);
  }

  async kill(name: string) {
    await this.run(["kill-session", "-t", `=${name}`]);
  }

  /** Keys by tmux name (`Enter`, `Escape`, `C-c`), each one a separate key press. */
  async keys(name: string, ...keys: string[]) {
    if (keys.length) await this.must(["send-keys", "-t", `=${name}:`, ...keys]);
  }

  /** Text typed as is (one line). */
  async type(name: string, text: string): Promise<void> {
    if (text) await this.must(["send-keys", "-t", `=${name}:`, "-l", "--", tmuxArg(text)]);
  }

  /** Leaves tmux's copy mode, if the pane is in it (scrolled back): keys reach the program again. */
  async leaveCopyMode(name: string) {
    await this.run(["send-keys", "-t", `=${name}:`, "-X", "cancel"]);
  }

  /** A pane's whole history and screen as text, wrapped lines joined (copying from a terminal). */
  async history(name: string): Promise<string> {
    return this.must(["capture-pane", "-p", "-J", "-S", "-", "-E", "-", "-t", `=${name}:`]);
  }

  /** tmux's history of a pane is full (it keeps history-limit rows): older lines are gone. */
  async historyFull(name: string): Promise<boolean> {
    const [size, limit] = (await this.must(["display", "-p", "-t", `=${name}:`, "#{history_size} #{history_limit}"])).trim().split(" ").map(Number);
    // Past the limit tmux drops a tenth of it at once, so a full history sits between 90% and 100%.
    return !!limit && (size ?? 0) >= Math.floor(limit * 0.9);
  }

  /** The text on screen now (for tests and diagnostics). */
  async capture(name: string): Promise<string> {
    return this.must(["capture-pane", "-p", "-t", `=${name}:`]);
  }

  /** Stops the whole server (tests and dev cleanup only). */
  async killServer() {
    await this.run(["kill-server"]);
    this.starting = undefined;
    this.configured = false;
  }
}

const clamp = (v: number | undefined, d: number) => Math.max(10, Math.min(500, Math.floor(v ?? d) || d));

