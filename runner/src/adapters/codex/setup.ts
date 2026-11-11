// The Home agent's extras for Codex threads in one folder (core/adapter.ts AgentSetup): Tether's
// tools as the app-server's dynamic tools (experimental: `dynamicTools` on thread/start, called back
// as the server request `item/tool/call`), the instructions as the thread's developer instructions,
// and Codex's own shell, patch, web, apps and subagent tools switched off by config.
//
// Checked on codex 0.164: the dynamic tools and developer instructions are written to the rollout
// (session_meta and the first turn's context), so they survive thread/resume; `config` isn't, so a
// resume passes it again.

import { z } from "zod";
import type { AgentSetup } from "../../core/adapter";

const byFolder = new Map<string, (nativeId: string) => AgentSetup>();

export function setCodexSetup(folder: string, make: (nativeId: string) => AgentSetup): () => void {
  byFolder.set(folder, make);
  return () => {
    if (byFolder.get(folder) === make) byFolder.delete(folder);
  };
}

/** What the agent has to do without: the work is the sessions' it starts. */
export const AGENT_CONFIG = {
  "features.shell_tool": false,
  "features.apps": false,
  "features.multi_agent": false,
  include_apply_patch_tool: false,
  web_search: "disabled",
} as const;

/** What thread/start adds for a thread in `folder`, if anything. */
export function codexStartExtras(folder: string): Record<string, unknown> {
  const make = byFolder.get(folder);
  if (!make) return {};
  const s = make("");
  return {
    developerInstructions: s.instructions,
    config: AGENT_CONFIG,
    dynamicTools: s.tools.map((t) => ({ type: "function", name: t.name, description: t.description, inputSchema: z.toJSONSchema(z.object(t.input as z.ZodRawShape)) })),
  };
}

/** What thread/resume adds for a thread in `folder`: the config (the rest is in its rollout). */
export function codexResumeExtras(folder: string): Record<string, unknown> {
  return byFolder.has(folder) ? { config: AGENT_CONFIG } : {};
}

/** A dynamic tool call's answer (DynamicToolCallResponse), or undefined when the folder has no setup. */
export async function codexToolCall(folder: string, nativeId: string, p: { tool?: string; arguments?: unknown }): Promise<{ contentItems: { type: "inputText"; text: string }[]; success: boolean } | undefined> {
  const make = byFolder.get(folder);
  if (!make) return undefined;
  const t = make(nativeId).tools.find((x) => x.name === p.tool);
  const answer = (text: string, success: boolean) => ({ contentItems: [{ type: "inputText" as const, text }], success });
  if (!t) return answer(`There's no tool ${p.tool}.`, false);
  const args = z.object(t.input as z.ZodRawShape).safeParse(p.arguments ?? {});
  if (!args.success) return answer(`Bad arguments: ${args.error.message}`, false);
  try {
    return answer(await t.run(args.data), true);
  } catch (e) {
    return answer((e as Error)?.message ?? String(e), false);
  }
}
