// The Home agent's extras for Claude sessions in one folder (core/adapter.ts AgentSetup): Tether's
// tools as an in-process MCP server, instructions appended to Claude Code's system prompt.

import { createSdkMcpServer, tool, type McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { AgentSetup } from "../../core/adapter";

const byFolder = new Map<string, (nativeId: string) => AgentSetup>();

export function setClaudeSetup(folder: string, make: (nativeId: string) => AgentSetup): () => void {
  byFolder.set(folder, make);
  return () => {
    if (byFolder.get(folder) === make) byFolder.delete(folder);
  };
}

/** The query options a session in `folder` adds, if any. A fresh MCP server per process. */
export function claudeSetupFor(folder: string, nativeId: string): { mcpServers: Record<string, McpServerConfig>; allow: string[]; deny: string[]; append: string } | undefined {
  const make = byFolder.get(folder);
  if (!make) return undefined;
  const s = make(nativeId);
  const server = createSdkMcpServer({
    name: s.server,
    version: "1.0.0",
    tools: s.tools.map((t) =>
      tool(t.name, t.description, t.input as any, async (args: any) => {
        try {
          return { content: [{ type: "text" as const, text: await t.run(args) }] };
        } catch (e) {
          return { content: [{ type: "text" as const, text: (e as Error)?.message ?? String(e) }], isError: true };
        }
      }),
    ),
  });
  return { mcpServers: { [s.server]: server }, allow: [`mcp__${s.server}__*`, ...(s.allow ?? [])], deny: s.deny ?? [], append: s.instructions };
}
