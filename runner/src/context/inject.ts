// Session injection: what a Tether session is told about the master context when it starts.
// Adapters ask sessionContext() for
//   prompt  the global digest + this repo's memory, for the system prompt (Claude append, pi
//           --append-system-prompt, Codex developerInstructions) or a first-message preamble
//           (ACP, Antigravity)
//   mcp     how to launch the `tether-context` MCP server for this session
// Both are undefined until the context feature has been turned on by the first import.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "jsonc-parser";
import { sha } from "./format";
import { configDir, contextDir, harness } from "./paths";
import { mcpLaunch, type McpLaunch } from "./launch";
import { repoKey } from "./repokey";
import { Store, writeAtomic } from "./store";
import { globalDigest, repoDigest } from "./export";

let enabled = false;
/** Set by the context service from runner config (off until the first import). */
export function setInjectionEnabled(on: boolean) {
  enabled = on;
}

export interface SessionContext {
  prompt: string;
  mcp: McpLaunch;
}

const INSTRUCTIONS = `You share a long-term memory with the user's other coding agents through Tether.
- Before relying on assumptions about the user or this repository, check the memory below; search for more with the tether-context memory_search tool.
- When you learn something durable (a user preference, a correction to how you work, a non-obvious project fact), save it with memory_write: one fact per call, written so it stands alone. Don't save secrets or things obvious from the code.
- Shared skills are listed by skill_list and read with skill_get.`;

export async function sessionContext(projectPath: string, session?: { id?: string; key?: string }): Promise<SessionContext | undefined> {
  if (!enabled) return undefined;
  try {
    const dir = contextDir();
    if (!existsSync(join(dir, ".git"))) return undefined;
    const store = new Store(dir);
    const key = await repoKey(projectPath);
    const parts = [INSTRUCTIONS, globalDigest(store)];
    const repo = repoDigest(store, key);
    if (repo) parts.push(repo);
    return { prompt: `<tether-memory>\n${parts.join("\n\n").trim()}\n</tether-memory>`, mcp: mcpLaunch(session) };
  } catch (e: any) {
    console.error(`context: no session memory for ${projectPath}: ${e?.message ?? e}`);
    return undefined;
  }
}

/** First-message preamble for harnesses without a system-prompt hook (ACP, Antigravity). */
export function withPreamble(preamble: string | undefined, text: string): string {
  return preamble ? `${preamble}\n\n${text}` : text;
}

/** ACP's McpServerStdio shape. */
export function acpMcpServers(ctx: SessionContext | undefined) {
  if (!ctx) return [];
  return [{ name: "tether-context", command: ctx.mcp.command, args: ctx.mcp.args, env: Object.entries(ctx.mcp.env).map(([name, value]) => ({ name, value })) }];
}

/** pi-mcp-adapter is one of pi's packages (it owns the `--mcp-config` flag). */
export function piMcpAdapterInstalled(): boolean {
  try {
    const settings = JSON.parse(readFileSync(harness.piSettings(), "utf8"));
    return (settings.packages ?? []).some((p: unknown) => {
      const src = typeof p === "string" ? p : (p as any)?.source;
      return typeof src === "string" && /(^|[:/])pi-mcp-adapter(@|$|\/|\.git)/.test(src);
    });
  } catch {
    return false;
  }
}

/**
 * pi's per-session MCP: a copy of the user's pi-mcp-adapter config (~/.pi/agent/mcp-adapter.json)
 * plus this session's `tether-context`, for `--mcp-config` (which stands in for that file during
 * the run; shared configs like ~/.config/mcp/mcp.json still load). Undefined without the adapter,
 * in which case pi's own MCP reads the global ~/.pi/agent/mcp.json registration from the export.
 */
export function piMcpConfig(ctx: SessionContext | undefined, sessionKey?: string): string | undefined {
  if (!ctx || !piMcpAdapterInstalled()) return undefined;
  let base: any = {};
  try {
    base = parse(readFileSync(harness.piMcpAdapter(), "utf8"), [], { allowTrailingComma: true }) ?? {};
  } catch {}
  if (!base || typeof base !== "object" || Array.isArray(base)) base = {};
  const cfg = {
    ...base,
    mcpServers: { ...(base.mcpServers ?? {}), "tether-context": { command: ctx.mcp.command, args: ctx.mcp.args, env: ctx.mcp.env } },
  };
  const path = join(configDir(), "run", `pi-mcp-${sha(sessionKey ?? JSON.stringify(ctx.mcp.env))}.json`);
  writeAtomic(path, JSON.stringify(cfg, null, 2) + "\n");
  return path;
}
