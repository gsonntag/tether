// What a session launch adds for its harness: the master context's memory and `tether-context`
// MCP server, shaped by the harness's connector. Kept out of index.ts, which export.ts imports:
// sessionContext() comes from inject.ts, which imports export.ts.

import type { HarnessId } from "../../../web/src/shared/protocol";
import { sessionContext } from "../context/inject";
import { connectorFor } from "./index";
import { mergeLaunch } from "./shared";
import { SLOTS, type SessionCtx, type SessionLaunch } from "./types";

/** Every slot's contribution for this session, in slot order. Empty while the master context is off. */
export async function sessionLaunch(h: HarnessId, ctx: Omit<SessionCtx, "context">): Promise<SessionLaunch> {
  const context = await sessionContext(ctx.projectPath, ctx.session);
  return launchWith(h, { ...ctx, context });
}

/** The same with the context already resolved (tests, and callers that have it). */
export function launchWith(h: HarnessId, ctx: SessionCtx): SessionLaunch {
  const c = connectorFor(h);
  // Memory first: pi's --append-system-prompt has always gone ahead of --mcp-config.
  const order = ["memory", ...SLOTS.filter((s) => s !== "memory")] as const;
  return mergeLaunch(order.map((s) => c[s].forSession?.(ctx)));
}
