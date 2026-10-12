// What a session launch adds for its harness: the master context's memory and `tether-context`
// MCP server, and the MCP registry's servers, shaped by the harness's connector. Kept out of
// index.ts, which export.ts imports: sessionContext() comes from inject.ts, which imports export.ts.

import type { HarnessId } from "../../../web/src/shared/protocol";
import { sessionContext } from "../context/inject";
import { mcpLaunch } from "../context/launch";
import { sessionMcp } from "../mcp/registry";
import { connectorFor } from "./index";
import { mergeLaunch } from "./shared";
import { SLOTS, type SessionCtx, type SessionLaunch } from "./types";

/**
 * Every slot's contribution for this session, in slot order. While the master context is off a
 * session with a guard key still gets `tether-context`, serving only the session tools (goal, plan,
 * todos, ask_user: a goal can be set at any time, and a harness reads its MCP servers at launch). `mcpAuth`: registry servers
 * that still need an OAuth sign-in.
 */
export async function sessionLaunch(h: HarnessId, ctx: Omit<SessionCtx, "context" | "servers">): Promise<SessionLaunch> {
  const [found, mcp] = await Promise.all([
    sessionContext(ctx.projectPath, ctx.session),
    sessionMcp(h, ctx.projectPath).catch((e: any) => {
      console.error(`mcp: no registry servers for ${ctx.projectPath}: ${e?.message ?? e}`);
      return { servers: [], auth: [] };
    }),
  ]);
  const context = found ?? (ctx.session?.key ? { mcp: mcpLaunch(ctx.session, { goalOnly: true }) } : undefined);
  const launch = launchWith(h, { ...ctx, context, servers: mcp.servers });
  return mcp.auth.length ? { ...launch, mcpAuth: mcp.auth } : launch;
}

/** The same with the context already resolved (tests, and callers that have it). */
export function launchWith(h: HarnessId, ctx: SessionCtx): SessionLaunch {
  const c = connectorFor(h);
  // Memory first: pi's --append-system-prompt has always gone ahead of --mcp-config.
  const order = ["memory", ...SLOTS.filter((s) => s !== "memory")] as const;
  return mergeLaunch(order.map((s) => c[s].forSession?.(ctx)));
}

/**
 * What a harness process needs before it starts (ACP agents are spawned before their session's
 * launch): the environment every slot adds (your secrets), and opencode's inline config additions
 * (your subagents and commands, merged into OPENCODE_CONFIG_CONTENT).
 */
export function processLaunch(h: HarnessId, projectPath: string): { env: Record<string, string>; opencodeConfig?: Record<string, unknown> } {
  const c = connectorFor(h);
  const l = mergeLaunch([c.env, c.agents, c.commands].map((s) => s.forSession?.({ projectPath })));
  return { env: l.env, ...(l.options.opencodeConfig ? { opencodeConfig: l.options.opencodeConfig } : {}) };
}
