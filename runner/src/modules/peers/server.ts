// The runner's side of the peer tools (SPEC §9a): a Unix socket, private to the user, that each
// agent's MCP server (mcp.ts) posts its calls to. Like the terminal hooks' socket (terminal/hooks.ts)
// its path doesn't change across restarts, so an MCP server Codex's daemon keeps running reaches
// the next runner.
//
// Identity: the MCP server carries its session's id and a token, HMAC(secret, id), from the
// environment Tether gave it; the secret stays in this module's folder, so a restarted runner still
// knows the tokens. Codex starts a thread before its id is known, so its servers carry
// "codex:*" and the thread comes from the call's `_meta` (the daemon puts it there, not the model).
// Anything running as this user could still forge a call: the token keeps sessions apart, it isn't
// a security boundary.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hookSocketPath } from "../../terminal/hooks";

/** A tool call from an agent: who (a session id), which tool, its arguments. */
export interface PeerCall {
  from: string;
  tool: string;
  args: Record<string, unknown>;
  /** the agent stopped waiting (its call was cancelled) */
  signal: AbortSignal;
}

export type PeerAnswer = { text: string; isError?: boolean };

/** The secret tokens are made from, kept in `dir` (made once), readable only by the user. */
export function peerSecret(dir: string): string {
  const file = join(dir, "secret");
  try {
    const s = readFileSync(file, "utf8").trim();
    if (/^[0-9a-f]{64}$/.test(s)) {
      // One made (or copied) with looser permissions is made private.
      if ((statSync(file).mode & 0o077) !== 0) chmodSync(file, 0o600);
      return s;
    }
  } catch {}
  const s = randomBytes(32).toString("hex");
  // `mode` only applies to a new file: one that was there keeps its own until chmod.
  writeFileSync(file, s + "\n", { mode: 0o600 });
  chmodSync(file, 0o600);
  return s;
}

export const peerToken = (secret: string, id: string) => createHmac("sha256", secret).update(id).digest("hex");

/** The session a call is from, or undefined when its token doesn't match. */
export function callerOf(secret: string, body: any): string | undefined {
  const id = typeof body?.id === "string" ? body.id : "";
  const token = typeof body?.token === "string" ? body.token : "";
  if (!/^[a-z]+:\S+$/.test(id) || !/^[0-9a-f]{64}$/.test(token)) return undefined;
  const want = Buffer.from(peerToken(secret, id), "hex");
  if (!timingSafeEqual(want, Buffer.from(token, "hex"))) return undefined;
  if (!id.endsWith(":*")) return id;
  // The harness names its thread itself.
  const thread = body?.meta?.threadId ?? body?.meta?.["x-codex-turn-metadata"]?.thread_id;
  return typeof thread === "string" && /^[\w.-]{1,200}$/.test(thread) ? `${id.slice(0, -1)}${thread}` : undefined;
}

export class PeerSocket {
  readonly socketPath: string;
  private server?: ReturnType<typeof Bun.serve>;

  constructor(
    wanted: string,
    private secret: string,
    private run: (c: PeerCall) => Promise<PeerAnswer>,
    log?: (l: string) => void,
  ) {
    this.socketPath = hookSocketPath(wanted, log);
  }

  start() {
    if (existsSync(this.socketPath)) {
      try {
        unlinkSync(this.socketPath);
      } catch {}
    }
    this.server = Bun.serve({
      unix: this.socketPath,
      // An ask holds its request open until the answer comes. (Bun's types leave this out for a
      // Unix socket, but it applies: without it a request is cut after 10 s.)
      ...({ idleTimeout: 0 } as {}),
      fetch: async (req) => {
        if (req.method !== "POST" || new URL(req.url).pathname !== "/call") return new Response("not found", { status: 404 });
        const body = await req.json().catch(() => null);
        const from = callerOf(this.secret, body);
        const answer = (a: PeerAnswer) => Response.json(a);
        if (!from) return answer({ text: "Tether doesn't know which session this is, so nothing was sent.", isError: true });
        const args = body?.args && typeof body.args === "object" ? body.args : {};
        try {
          return answer(await this.run({ from, tool: String(body?.tool ?? ""), args, signal: req.signal }));
        } catch (e) {
          return answer({ text: (e as Error)?.message ?? String(e), isError: true });
        }
      },
    });
    chmodSync(this.socketPath, 0o600);
  }

  stop() {
    this.server?.stop(true);
    this.server = undefined;
  }
}
