// How harnesses launch the `tether-context` MCP server (runner/src/context/mcp.ts): over stdio,
// with the store's location in the environment.

import { join } from "node:path";
import { configDir, contextDir } from "./paths";

export const MCP_SCRIPT = new URL("./mcp.ts", import.meta.url).pathname;

/**
 * Where the runner leaves the loopback bridge's address and token (runner/src/bridge.ts, mode 600):
 * the goal tools reach their session through it. A file, not the environment, because Claude Code
 * gets its MCP servers on its command line, which any local user can read.
 */
export const bridgeFile = () => join(configDir(), "bridge.json");

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
 * is off, so only the session tools.
 */
export function mcpLaunch(session?: { id?: string; key?: string }, opts: { goalOnly?: boolean } = {}): McpLaunch {
  const env: Record<string, string> = { TETHER_CONTEXT_DIR: contextDir() };
  if (session?.id && !session.id.includes(":pending-")) env.TETHER_SESSION_ID = session.id;
  if (session?.key) {
    env.TETHER_SESSION_KEY = session.key;
    env.TETHER_BRIDGE_FILE = bridgeFile();
  }
  if (opts.goalOnly) env.TETHER_CONTEXT_TOOLS = "goal";
  return { command: process.execPath, args: [MCP_SCRIPT], env };
}
