// Codex (app-server): memory as developer instructions and in ~/.codex/AGENTS.md; `tether-context`
// as a thread `config` override and in ~/.codex/config.toml; skills run from a `skill` input item
// (codexInput turns `/name` into one).

import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { invocationText } from "../../../web/src/shared/skill";
import { upsertTomlBlock } from "../context/blocks";
import { mcpLaunch } from "../context/launch";
import { harness } from "../context/paths";
import { toEntry } from "../mcp/formats";
import { codexServers } from "../mcp/sources";
import { cap, repoDirs, slot } from "./shared";
import type { Connector, ExportContext, SessionCtx } from "./types";

/** `[mcp_servers.tether-context]` in a managed block of ~/.codex/config.toml. */
function registerCodexMcp(x: ExportContext) {
  const { out } = x;
  const path = harness.codexConfig();
  if (!existsSync(dirname(path))) return;
  const cur = x.readText(path);
  if (/^\s*\[mcp_servers\.("?)tether-context\1\]/m.test(cur.replace(/# tether:begin[\s\S]*?# tether:end/, ""))) {
    out.mcpConfigs.push(path); // the user registered it themselves
    return;
  }
  const l = mcpLaunch();
  const toml = [
    `[mcp_servers.tether-context]`,
    `command = ${JSON.stringify(l.command)}`,
    `args = [${l.args.map((a) => JSON.stringify(a)).join(", ")}]`,
    `default_tools_approval_mode = "approve"`,
    `[mcp_servers.tether-context.env]`,
    ...Object.entries(l.env).map(([k, v]) => `${k} = ${JSON.stringify(v)}`),
  ].join("\n");
  x.writeOwned(path, upsertTomlBlock(cur, toml));
  out.mcpConfigs.push(path);
}

/** Thread `config` overrides (`mcp_servers.<name>`): the registry's servers Codex can take, and `tether-context`. */
function codexMcp({ context, servers }: SessionCtx) {
  const config: Record<string, unknown> = {};
  for (const s of servers ?? []) {
    const e = toEntry(s.transport, "codex");
    if (e) config[`mcp_servers.${s.name}`] = e;
  }
  if (context)
    config["mcp_servers.tether-context"] = { command: context.mcp.command, args: context.mcp.args, env: context.mcp.env, default_tools_approval_mode: "approve" };
  return Object.keys(config).length ? { options: { config } } : undefined;
}

export const codexConnector: Connector = {
  id: "codex",
  memory: {
    capability: () => cap("native", "Developer instructions; also ~/.codex/AGENTS.md"),
    forSession: ({ context }) => (context ? { options: { developerInstructions: context.prompt } } : undefined),
    globalBlock: (_globalFile, digest) => [harness.codexAgentsMd(), digest],
  },
  mcp: {
    capability: () => cap("native", "Per-thread config override; ~/.codex/config.toml"),
    forSession: codexMcp,
    exportGlobal: registerCodexMcp,
    importGlobal: codexServers,
    native: () => codexServers().found,
    deliver: (t) => (t.type === "sse" ? { how: "none", note: "Codex connects only to streamable HTTP servers, not SSE" } : { how: "session", note: "Per session (thread config)" }),
    targets: () => [{ file: harness.codexConfig(), installed: existsSync(harness.codexDir()), format: "toml", flavor: "codex" }],
  },
  skills: {
    capability: () => cap("native", "Runs the skills it lists as skill items"),
    invoke: invocationText,
    dirs: (projectPath) => [
      ...repoDirs(projectPath, ".agents/skills"),
      ...repoDirs(projectPath, ".codex/skills"),
      { dir: harness.codexSkills(), source: "codex" },
      { dir: harness.agentsSkills(), source: "agents" },
    ],
    offline: true,
    installDirs: () => [{ harness: "codex", dir: harness.codexSkills(), install: false, skip: [] }],
  },
  commands: slot("native", "Custom commands in its config; not mapped yet"),
  agents: slot("native", "Subagents; not mapped yet"),
  hooks: slot("native", "Hooks in its config; not mapped yet"),
  env: slot("native", "Process environment; not mapped yet"),
};
