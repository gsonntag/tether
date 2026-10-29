// Claude Code hooks for terminal mode (SPEC §8 "Requests and notifications in terminal mode"). In a
// handoff the TUI drives, so Tether learns what it does from hooks added for that launch only
// (`claude --settings <json>`, never the person's own settings): a prompt was submitted (running),
// Claude needs you (a permission prompt or a question: waiting), a tool finished (running again),
// the turn ended (idle), the TUI is exiting.
//
// Hooks report to the runner over a Unix socket in its config directory (private to the user).
// The socket's path doesn't change across runner restarts, so a TUI that outlives the runner still
// reaches the next one.

import { chmodSync, existsSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A Unix socket's path must fit sun_path: 104 bytes on macOS, 108 on Linux, with the NUL. */
export const SOCKET_PATH_MAX = 103;

/**
 * Where the hooks socket goes: the wanted path, or, when that is too long for a Unix socket, a short
 * one in the user's runtime dir (stable for the same wanted path, so TUIs find it after a restart).
 */
export function hookSocketPath(wanted: string, log: (l: string) => void = console.error): string {
  if (Buffer.byteLength(wanted) <= SOCKET_PATH_MAX) return wanted;
  const base = process.env.XDG_RUNTIME_DIR || join(tmpdir(), `tether-${process.getuid?.() ?? "u"}`);
  try {
    mkdirSync(base, { recursive: true, mode: 0o700 });
  } catch {}
  // A shared place (/tmp): only a directory of our own, private and not a link, will do.
  const st = lstatSync(base, { throwIfNoEntry: false });
  const uid = process.getuid?.();
  if (!st || st.isSymbolicLink() || !st.isDirectory() || (uid !== undefined && st.uid !== uid) || (st.mode & 0o077) !== 0)
    throw new Error(`${base} isn't a private directory of this user (owner, mode or a link); the hooks socket can't go there`);
  const short = join(base, `tether-${new Bun.CryptoHasher("sha256").update(wanted).digest("hex").slice(0, 12)}.sock`);
  log(`WARNING: the hooks socket path ${wanted} is too long for a Unix socket (${Buffer.byteLength(wanted)} bytes, at most ${SOCKET_PATH_MAX}); using ${short} instead`);
  return short;
}

/** What a hook reported, for one Tether session. */
export interface HookReport {
  /** the Tether session the TUI was launched for */
  sessionId: string;
  /** the tmux session of the TUI that reported (exact even after /clear moved it on) */
  tui?: string;
  /** Claude's hook event: UserPromptSubmit, Notification, PostToolUse, Stop, SessionStart, SessionEnd */
  event: string;
  /** the session id Claude reports (it changes with /clear) */
  nativeId?: string;
  /** Notification: permission_prompt, idle_prompt, elicitation_dialog, … */
  notificationType?: string;
  message?: string;
  /** SessionStart: startup, resume, clear, compact; SessionEnd: why */
  source?: string;
  /** the TUI's permission mode as it is now (every hook carries it; Shift+Tab changes it) */
  permissionMode?: string;
}

export const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "Notification", "PostToolUse", "Stop", "StopFailure", "SessionEnd"] as const;

/** A string as one shell word. */
export const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The shell command a hook runs: POST its stdin to the runner's socket, never failing the hook. */
export function hookCommand(socketPath: string, sessionId: string, curl = Bun.which("curl"), tui?: string): string {
  const url = `http://tether/hook?s=${encodeURIComponent(sessionId)}${tui ? `&t=${encodeURIComponent(tui)}` : ""}`;
  if (curl) return `${shq(curl)} -s -m 3 --unix-socket ${shq(socketPath)} -X POST -H 'content-type: application/json' --data-binary @- ${shq(url)} >/dev/null 2>&1; exit 0`;
  // No curl: Bun itself (the runner's own binary) does the same.
  const js = `await fetch(${JSON.stringify(url)},{method:"POST",unix:${JSON.stringify(socketPath)},body:await Bun.stdin.text()}).catch(()=>{})`;
  return `${shq(process.execPath)} -e ${shq(js)} >/dev/null 2>&1; exit 0`;
}

/**
 * How long Claude lets a hook run, in seconds. The POST itself is capped at 3 s (curl -m 3) and is
 * instant when the runner is up or gone; the rest is room for starting the process on a loaded
 * machine, where 5 s was seen to run out and lose a SessionStart (Tether then missed a /clear).
 */
export const HOOK_TIMEOUT_S = 15;

/** The `--settings` JSON that adds Tether's hooks to one launch. */
export function hookSettings(socketPath: string, sessionId: string, curl?: string | null, tui?: string): string {
  const command = hookCommand(socketPath, sessionId, curl === undefined ? Bun.which("curl") : curl, tui);
  const hooks = Object.fromEntries(HOOK_EVENTS.map((e) => [e, [{ hooks: [{ type: "command", command, timeout: HOOK_TIMEOUT_S }] }]]));
  return JSON.stringify({ hooks });
}

/** Reads a hook's POST into a report (null: not one). */
export function parseHook(sessionId: string | null, body: unknown, tui?: string | null): HookReport | null {
  if (!sessionId || typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v ? v.slice(0, 2000) : undefined);
  const event = str(b.hook_event_name);
  if (!event) return null;
  const r: HookReport = { sessionId, event };
  if (tui) r.tui = tui;
  const nativeId = str(b.session_id);
  if (nativeId) r.nativeId = nativeId;
  const nt = str(b.notification_type);
  if (nt) r.notificationType = nt;
  const message = str(b.message) ?? str(b.error);
  if (message) r.message = message;
  const source = str(b.source) ?? str(b.reason);
  if (source) r.source = source;
  const mode = str(b.permission_mode);
  if (mode && /^[A-Za-z-]{1,40}$/.test(mode)) r.permissionMode = mode;
  return r;
}

export class HookServer {
  private server?: ReturnType<typeof Bun.serve>;

  readonly socketPath: string;

  constructor(
    wanted: string,
    private onReport: (r: HookReport) => void,
    log?: (l: string) => void,
  ) {
    this.socketPath = hookSocketPath(wanted, log);
  }

  start() {
    // A socket left behind by a runner that didn't stop cleanly.
    if (existsSync(this.socketPath)) {
      try {
        unlinkSync(this.socketPath);
      } catch {}
    }
    this.server = Bun.serve({
      unix: this.socketPath,
      fetch: async (req) => {
        const url = new URL(req.url);
        if (req.method !== "POST" || url.pathname !== "/hook") return new Response("not found", { status: 404 });
        const body = await req.json().catch(() => null);
        const r = parseHook(url.searchParams.get("s"), body, url.searchParams.get("t"));
        if (r) {
          try {
            this.onReport(r);
          } catch (e) {
            console.error("hook report failed:", e);
          }
        }
        return new Response("", { status: 204 });
      },
    });
    // Only this user may report (the directory is private too).
    chmodSync(this.socketPath, 0o600);
  }

  stop() {
    this.server?.stop(true);
    this.server = undefined;
  }

  settings(sessionId: string) {
    return hookSettings(this.socketPath, sessionId);
  }
}
