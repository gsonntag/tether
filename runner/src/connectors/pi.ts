// pi (RPC mode): memory through --append-system-prompt and in ~/.pi/agent/AGENTS.md;
// `tether-context` and the MCP registry's servers through pi-mcp-adapter's --mcp-config (else
// only the global ~/.pi/agent/mcp.json, which pi's built-in MCP reads); skills run as `/skill:name`.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse } from "jsonc-parser";
import { sha } from "../context/format";
import type { SessionContext } from "../context/inject";
import { configDir, harness } from "../context/paths";
import { writeAtomic } from "../context/store";
import { toEntry } from "../mcp/formats";
import { piServers } from "../mcp/sources";
import { cap, repoDirs, slot, upward } from "./shared";
import type { Connector, SessionServer } from "./types";

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
 * plus this session's registry servers and `tether-context`, for `--mcp-config` (which stands in
 * for that file during the run; shared configs like ~/.config/mcp/mcp.json still load). Undefined
 * without the adapter, in which case pi's own MCP reads the global ~/.pi/agent/mcp.json (the
 * context and registry exports write there).
 */
export function piMcpConfig(ctx: SessionContext | undefined, sessionKey?: string, servers: SessionServer[] = []): string | undefined {
  if ((!ctx && !servers.length) || !piMcpAdapterInstalled()) return undefined;
  let base: any = {};
  try {
    base = parse(readFileSync(harness.piMcpAdapter(), "utf8"), [], { allowTrailingComma: true }) ?? {};
  } catch {}
  if (!base || typeof base !== "object" || Array.isArray(base)) base = {};
  const mcpServers: Record<string, unknown> = { ...(base.mcpServers ?? {}) };
  for (const s of servers) mcpServers[s.name] = toEntry(s.transport, "plain");
  if (ctx) mcpServers["tether-context"] = { command: ctx.mcp.command, args: ctx.mcp.args, env: ctx.mcp.env };
  const cfg = { ...base, mcpServers };
  const path = join(configDir(), "run", `pi-mcp-${sha(sessionKey ?? JSON.stringify(ctx?.mcp.env ?? servers.map((s) => s.name)))}.json`);
  // The registry's env and headers can hold secrets: only this user reads the file.
  writeAtomic(path, JSON.stringify(cfg, null, 2) + "\n", 0o600);
  return path;
}

export const piConnector: Connector = {
  id: "pi",
  memory: {
    capability: () => cap("native", "Appended to the system prompt; also ~/.pi/agent/AGENTS.md"),
    forSession: ({ context }) => (context ? { args: ["--append-system-prompt", context.prompt] } : undefined),
    globalBlock: (_globalFile, digest) => [harness.piAgentsMd(), digest],
  },
  mcp: {
    capability: () =>
      piMcpAdapterInstalled()
        ? cap("native", "Per session with pi-mcp-adapter (--mcp-config)")
        : cap("unsupported", "No per-session MCP without pi-mcp-adapter; servers reach pi only through ~/.pi/agent/mcp.json"),
    forSession: ({ context, session, servers }) => {
      const path = piMcpConfig(context, session?.key, servers);
      return path ? { args: ["--mcp-config", path] } : undefined;
    },
    exportGlobal: (x) => x.registerJsonMcp(harness.piMcp(), dirname(harness.piMcp())),
    importGlobal: () => piServers(),
    native: (projectPath) => piServers(projectPath).found,
    deliver: () =>
      piMcpAdapterInstalled()
        ? { how: "session", note: "Per session (pi-mcp-adapter)" }
        : { how: "global", note: "Only through ~/.pi/agent/mcp.json: per-session servers need pi-mcp-adapter" },
    targets: () => [{ file: harness.piMcp(), installed: existsSync(dirname(harness.piMcp())), format: "json", key: "mcpServers", flavor: "plain" }],
  },
  skills: {
    capability: () => cap("native", "Runs skills as /skill:name"),
    // pi expands `/skill:name args` itself, in the same block shape Tether uses.
    invoke: (name, args) => (args ? `/skill:${name} ${args}` : `/skill:${name}`),
    dirs: (projectPath) => {
      const up = upward(projectPath);
      return [
        { dir: join(projectPath, ".pi/skills"), source: "repo", root: up[up.length - 1] },
        ...repoDirs(projectPath, ".agents/skills"),
        { dir: harness.piSkills(), source: "pi" },
        { dir: harness.agentsSkills(), source: "agents" },
      ];
    },
    offline: true,
    installDirs: () => [{ harness: "pi", dir: harness.piSkills(), install: false, skip: [] }],
  },
  commands: slot("native", "Prompt templates; not mapped yet"),
  agents: slot("unsupported", "No built-in subagents (the pi-subagents package adds them)"),
  hooks: slot("native", "Extensions (Tether's guard is one); not mapped yet"),
  env: slot("native", "Process environment; not mapped yet"),
};
