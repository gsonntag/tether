// Loopback endpoint through which out-of-process gates (the pi extension, the Antigravity
// PreToolUse hook) ask the guard about a tool call. Each live session gets its own random key,
// passed to its agent process in the environment, so a call can only speak for its own session.

import { randomBytes } from "node:crypto";
import type { LiveSession } from "./session";

const TOKEN = randomBytes(24).toString("base64url");
const sessions = new Map<string, LiveSession>();

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 0, // "ask" mode waits for a person
  async fetch(req) {
    if (new URL(req.url).pathname !== "/guard" || req.method !== "POST") return new Response("not found", { status: 404 });
    if (req.headers.get("authorization") !== `Bearer ${TOKEN}`) return new Response("forbidden", { status: 403 });
    const body: any = await req.json().catch(() => ({}));
    const s = sessions.get(String(body.key ?? ""));
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

export function registerGuard(s: LiveSession): string {
  const key = randomBytes(16).toString("base64url");
  sessions.set(key, s);
  return key;
}

export function unregisterGuard(key: string) {
  sessions.delete(key);
}

/** Environment for an agent process whose gate calls back into the guard. */
export function guardEnv(key: string): Record<string, string> {
  return {
    TETHER_GUARD_URL: `http://127.0.0.1:${server.port}/guard`,
    TETHER_GUARD_TOKEN: TOKEN,
    TETHER_GUARD_KEY: key,
  };
}

/** The live session a guard key belongs to (ties MCP memory writes to their session). */
export function sessionForKey(key: string): LiveSession | undefined {
  return sessions.get(key);
}
