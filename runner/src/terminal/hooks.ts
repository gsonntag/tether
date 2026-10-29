// Claude Code hooks for terminal mode (SPEC §8 "Requests and notifications in terminal mode"). In a
// handoff the TUI drives, so Tether learns what it does from hooks added for that launch only
// (`claude --settings <json>`, never the person's own settings): a prompt was submitted (running),
// Claude needs you (a permission prompt or a question: waiting), a tool finished (running again),
// the turn ended (idle), the TUI is exiting.
//
// Hooks report to the runner over a Unix socket in its config directory (private to the user).
// The socket's path doesn't change across runner restarts, so a TUI that outlives the runner still
// reaches the next one.

import { existsSync, unlinkSync } from "node:fs";

/** What a hook reported, for one Tether session. */
export interface HookReport {
  /** the Tether session the TUI was launched for */
  sessionId: string;
  /** Claude's hook event: UserPromptSubmit, Notification, PostToolUse, Stop, SessionStart, SessionEnd */
  event: string;
  /** the session id Claude reports (it changes with /clear) */
  nativeId?: string;
  /** Notification: permission_prompt, idle_prompt, elicitation_dialog, … */
  notificationType?: string;
  message?: string;
  /** SessionStart: startup, resume, clear, compact; SessionEnd: why */
  source?: string;
}

export const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "Notification", "PostToolUse", "Stop", "StopFailure", "SessionEnd"] as const;

/** A string as one shell word. */
export const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The shell command a hook runs: POST its stdin to the runner's socket, never failing the hook. */
export function hookCommand(socketPath: string, sessionId: string, curl = Bun.which("curl")): string {
  const url = `http://tether/hook?s=${encodeURIComponent(sessionId)}`;
  if (curl) return `${shq(curl)} -s -m 3 --unix-socket ${shq(socketPath)} -X POST -H 'content-type: application/json' --data-binary @- ${shq(url)} >/dev/null 2>&1; exit 0`;
  // No curl: Bun itself (the runner's own binary) does the same.
  const js = `await fetch(${JSON.stringify(url)},{method:"POST",unix:${JSON.stringify(socketPath)},body:await Bun.stdin.text()}).catch(()=>{})`;
  return `${shq(process.execPath)} -e ${shq(js)} >/dev/null 2>&1; exit 0`;
}

/** The `--settings` JSON that adds Tether's hooks to one launch. */
export function hookSettings(socketPath: string, sessionId: string, curl?: string | null): string {
  const command = hookCommand(socketPath, sessionId, curl === undefined ? Bun.which("curl") : curl);
  const hooks = Object.fromEntries(HOOK_EVENTS.map((e) => [e, [{ hooks: [{ type: "command", command, timeout: 5 }] }]]));
  return JSON.stringify({ hooks });
}

/** Reads a hook's POST into a report (null: not one). */
export function parseHook(sessionId: string | null, body: unknown): HookReport | null {
  if (!sessionId || typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v ? v.slice(0, 2000) : undefined);
  const event = str(b.hook_event_name);
  if (!event) return null;
  const r: HookReport = { sessionId, event };
  const nativeId = str(b.session_id);
  if (nativeId) r.nativeId = nativeId;
  const nt = str(b.notification_type);
  if (nt) r.notificationType = nt;
  const message = str(b.message) ?? str(b.error);
  if (message) r.message = message;
  const source = str(b.source) ?? str(b.reason);
  if (source) r.source = source;
  return r;
}

export class HookServer {
  private server?: ReturnType<typeof Bun.serve>;

  constructor(
    readonly socketPath: string,
    private onReport: (r: HookReport) => void,
  ) {}

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
        const r = parseHook(url.searchParams.get("s"), body);
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
  }

  stop() {
    this.server?.stop(true);
    this.server = undefined;
  }

  settings(sessionId: string) {
    return hookSettings(this.socketPath, sessionId);
  }
}
