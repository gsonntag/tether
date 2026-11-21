// Tether's MCP server for Claude sessions (core/adapter.ts ToolServer): the query options it adds,
// its instructions appended to Claude Code's system prompt.

import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { ToolServerSlot } from "../toolServer";

/** Tether's MCP server for every Claude session (the peers module). */
export const claudeTools = new ToolServerSlot();

/** The query options Tether's MCP server adds to one session, if any. */
export function claudeToolServerFor(folder: string, nativeId: string): { mcpServers: Record<string, McpServerConfig>; allow: string[]; append?: string } | undefined {
  const s = claudeTools.for(folder);
  if (!s) return undefined;
  // `timeout`: Claude Code's own cap on one call (ms), so an ask can wait for its answer.
  const server = { type: "stdio", command: s.command, args: s.args, env: s.env(`claude:${nativeId}`), timeout: s.timeoutMs } as McpServerConfig;
  const append = s.instructions?.();
  return { mcpServers: { [s.name]: server }, allow: [`mcp__${s.name}__*`], ...(append ? { append } : {}) };
}
