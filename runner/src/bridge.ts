// Loopback endpoint through which out-of-process gates (the pi extension, the Antigravity
// PreToolUse hook) ask the guard about a tool call, and the `tether-context` session tools (goal,
// plan, todos, ask_user, the agent_* tools) reach their session (/session; /goal for older
// tether-context processes). Each live session gets its own random key, and a token derived from
// it with a secret only the runner holds: a call must carry both, and the token is good for its
// own key only. A key is easy to see (Claude Code's MCP command line, a process environment); the
// token is passed in a file only that session's MCP server is pointed at (mode 600, under the
// runner's config dir, which the guard keeps agents off), or in the environment of the gate
// processes that need it (pi's extension, Antigravity's hook). So one agent can't speak for
// another session (start subagents as it with a looser guard, answer its questions).

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { bridgeFile, sessionBridgeFile } from "./context/launch";
import { writeAtomic } from "./context/store";
import type { LiveSession } from "./session";

const SECRET = randomBytes(32);
const sessions = new Map<string, LiveSession>();

/** The token that goes with a session key. */
export const tokenFor = (key: string) => createHmac("sha256", SECRET).update(key).digest("base64url");

function authorized(header: string | null, key: string): boolean {
  if (!key || !header?.startsWith("Bearer ")) return false;
  const got = Buffer.from(header.slice(7));
  const want = Buffer.from(tokenFor(key));
  return got.length === want.length && timingSafeEqual(got, want);
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 0, // "ask" mode waits for a person
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if ((path !== "/guard" && path !== "/goal" && path !== "/session") || req.method !== "POST") return new Response("not found", { status: 404 });
    const body: any = await req.json().catch(() => ({}));
    const key = String(body.key ?? "");
    if (!authorized(req.headers.get("authorization"), key)) return new Response("forbidden", { status: 403 });
    const s = sessions.get(key);
    if (path === "/session") {
      if (!s || s.closed) return Response.json({ ok: false, text: "This Tether session is no longer running." });
      try {
        // ask_user waits for the user; the request's signal ends it if the tool call is given up.
        return Response.json(await s.sessionTool(String(body.tool ?? ""), body.args && typeof body.args === "object" ? body.args : {}, req.signal));
      } catch (e: any) {
        return Response.json({ ok: false, text: `Tether: ${e?.message ?? e}` });
      }
    }
    if (path === "/goal") {
      if (!s || s.closed) return Response.json({ ok: false, text: "This Tether session is no longer running." });
      try {
        return Response.json(s.goalTool(String(body.action ?? "get"), body.args ?? {}));
      } catch (e: any) {
        return Response.json({ ok: false, text: `Tether: ${e?.message ?? e}` });
      }
    }
    if (!s || s.closed) return Response.json({ allow: false, reason: "Tether: unknown session" });
    const meta = body.meta && typeof body.meta === "object" ? body.meta : undefined;
    // A lifecycle ping from a gate (the Antigravity hook before each model request), not a tool call.
    if (body.event !== undefined) {
      s.gateEvent(String(body.event), meta ?? {});
      return Response.json({});
    }
    try {
      return Response.json(await s.checkTool(String(body.tool ?? "unknown"), body.input ?? {}, body.toolId ? String(body.toolId) : undefined, meta));
    } catch (e: any) {
      return Response.json({ allow: false, reason: `Tether guard error: ${e?.message ?? e}` });
    }
  },
});

const url = () => `http://127.0.0.1:${server.port}`;

/**
 * Leaves the address (no token) where a `tether-context` without a session file finds it (a global
 * registration, Antigravity: its token comes from TETHER_GUARD_TOKEN), when it isn't there already.
 */
function publish() {
  const file = bridgeFile();
  const text = JSON.stringify({ url: url() });
  try {
    if (existsSync(file) && readFileSync(file, "utf8") === text) return;
    writeAtomic(file, text, 0o600);
  } catch (e: any) {
    console.error(`bridge: could not write ${file}: ${e?.message ?? e}`);
  }
}

export function registerGuard(s: LiveSession): string {
  publish();
  const key = randomBytes(16).toString("base64url");
  sessions.set(key, s);
  // The session's own address and token, for its tether-context (context/launch.ts sessionBridgeFile).
  try {
    writeAtomic(sessionBridgeFile(key), JSON.stringify({ url: url(), token: tokenFor(key) }), 0o600);
  } catch (e: any) {
    console.error(`bridge: could not write the session's bridge file: ${e?.message ?? e}`);
  }
  return key;
}

export function unregisterGuard(key: string) {
  sessions.delete(key);
  rmSync(sessionBridgeFile(key), { force: true });
}

/** Environment for an agent process whose gate calls back into the guard (its token only works for its key). */
export function guardEnv(key: string): Record<string, string> {
  return {
    TETHER_GUARD_URL: `${url()}/guard`,
    TETHER_GUARD_TOKEN: tokenFor(key),
    TETHER_GUARD_KEY: key,
  };
}

/** The live session a guard key belongs to (ties MCP memory writes to their session). */
export function sessionForKey(key: string): LiveSession | undefined {
  return sessions.get(key);
}
