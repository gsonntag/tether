// How harnesses launch the `tether-context` MCP server (runner/src/context/mcp.ts): over stdio,
// with the store's location in the environment.

import { createHash } from "node:crypto";
import { join } from "node:path";
import { configDir, contextDir } from "./paths";

export const MCP_SCRIPT = new URL("./mcp.ts", import.meta.url).pathname;

/**
 * Where the runner leaves the loopback bridge's address and token (runner/src/bridge.ts, mode 600):
 * the goal tools reach their session through it. A file, not the environment, because Claude Code
 * gets its MCP servers on its command line, which any local user can read.
 */
export const bridgeFile = () => join(configDir(), "bridge.json");

/** One session's bridge address and token (bridge.ts registerGuard), named after a hash of its key. */
export const sessionBridgeFile = (key: string) => join(configDir(), "run", "bridge", `${createHash("sha256").update(key).digest("hex").slice(0, 24)}.json`);

/**
 * How long a harness lets one `tether-context` call run: ask_user waits for the user (Tether ends
 * it after 15 minutes only when nobody is meant to be watching). Harness defaults are far shorter:
 * Codex 60 s (`tool_timeout_sec`), pi-mcp-adapter 60 s (`timeout`, reset by progress), Claude Code
 * 30 min of silence on stdio (`timeout` raises it).
 */
export const SESSION_TOOL_TIMEOUT_S = 24 * 60 * 60;

export interface McpLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * The stdio launcher. `sessionKey` (the session's guard key) lets the runner tie a memory_write
 * to the Tether session that made it, even before the harness has assigned a session id, and the
 * session tools (goal, plan, todos, ask_user) act on that session. `goalOnly`: the master context
 * is off, so only the session tools. `review`: a review session (/review), which reports with review_report.
 * `leader`: the leader agent, with the session_* tools.
 */
export function mcpLaunch(session?: { id?: string; key?: string; review?: boolean; leader?: boolean }, opts: { goalOnly?: boolean } = {}): McpLaunch {
  const env: Record<string, string> = { TETHER_CONTEXT_DIR: contextDir() };
  if (session?.id && !session.id.includes(":pending-")) env.TETHER_SESSION_ID = session.id;
  if (session?.key) {
    env.TETHER_SESSION_KEY = session.key;
    env.TETHER_BRIDGE_FILE = sessionBridgeFile(session.key);
  }
  if (opts.goalOnly) env.TETHER_CONTEXT_TOOLS = "goal";
  // A review session (/review) also gets review_report.
  if (session?.key && session.review) env.TETHER_CONTEXT_REVIEW = "1";
  // The leader agent (runner/src/leader.ts) also gets the session_* tools.
  if (session?.key && session.leader) env.TETHER_CONTEXT_LEADER = "1";
  return { command: process.execPath, args: [MCP_SCRIPT], env };
}
