// How harnesses launch the `tether-context` MCP server (runner/src/context/mcp.ts): over stdio,
// with the store's location in the environment.

import { contextDir } from "./paths";

export const MCP_SCRIPT = new URL("./mcp.ts", import.meta.url).pathname;

export interface McpLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * The stdio launcher. `sessionKey` (the session's guard key) lets the runner tie a memory_write
 * to the Tether session that made it, even before the harness has assigned a session id.
 */
export function mcpLaunch(session?: { id?: string; key?: string }): McpLaunch {
  const env: Record<string, string> = { TETHER_CONTEXT_DIR: contextDir() };
  if (session?.id && !session.id.includes(":pending-")) env.TETHER_SESSION_ID = session.id;
  if (session?.key) env.TETHER_SESSION_KEY = session.key;
  return { command: process.execPath, args: [MCP_SCRIPT], env };
}
