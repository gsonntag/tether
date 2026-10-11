// ACP harnesses (opencode, Kiro): memory as a first-message preamble (ACP has no system-prompt
// hook) plus their global files; `tether-context` and the MCP registry's servers in
// newSession/loadSession `mcpServers` (HTTP and SSE ones only when the agent's mcpCapabilities say
// so); skills run as `/name` when the agent lists them as commands, else Tether expands them.

import { existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { invocationText } from "../../../web/src/shared/skill";
import { isTetherOwned, OWNED_MARK } from "../context/blocks";
import { opencodeConfigPath, registerOpencodeMcp } from "../context/globalMcp";
import type { SessionContext } from "../context/inject";
import { harness, tilde } from "../context/paths";
import { cwdless } from "../mcp/formats";
import { kiroServers, opencodeServers } from "../mcp/sources";
import { cap, repoDirs, slot, upward } from "./shared";
import type { Connector, ExportContext, McpRoute, MemorySlot, SessionCtx, SessionServer } from "./types";

const pairs = (m: Record<string, string>) => Object.entries(m).map(([name, value]) => ({ name, value }));

/** ACP wants the executable's absolute path (McpServerStdio.command). */
function absolute(command: string): string {
  if (isAbsolute(command)) return command;
  return Bun.which(command) ?? command;
}

/**
 * ACP's McpServer list: the registry's servers (stdio always; http/sse when the agent advertises
 * them) and `tether-context`.
 */
export function acpMcpServers(ctx: SessionContext | undefined, servers: SessionServer[] = [], caps: SessionCtx["mcpCapabilities"] = {}) {
  const out: Record<string, unknown>[] = [];
  for (const { name, transport } of servers) {
    const t = cwdless(transport); // ACP v1's McpServerStdio has no cwd
    if (t.type === "stdio") out.push({ name, command: absolute(t.command), args: t.args, env: pairs(t.env) });
    else if (caps?.[t.type]) out.push({ type: t.type, name, url: t.url, headers: pairs(t.headers) });
  }
  if (ctx) out.push({ name: "tether-context", command: ctx.mcp.command, args: ctx.mcp.args, env: pairs(ctx.mcp.env) });
  return out;
}

const acpRoute = (t: SessionServer["transport"]): McpRoute =>
  t.type === "stdio" ? { how: "session", note: "Per session (ACP)" } : { how: "session", note: `Per session when the agent supports ${t.type.toUpperCase()} servers` };

/** Shared memory ahead of a new session's first message (a resumed one already had it). */
const preamble = ({ context, resume }: SessionCtx) => (context?.prompt && !resume ? { preamble: context.prompt } : undefined);

/** mcpServers is always sent (an empty list without the context), as newSession requires it. */
const acpMcp = ({ context, servers, mcpCapabilities }: SessionCtx) => ({ options: { mcpServers: acpMcpServers(context, servers, mcpCapabilities) } });

/** opencode and Kiro aren't installed on the box this was built on: what they do is from their docs, not checked. */
const UNVERIFIED = " (unverified: not checked against an installed CLI)";

const commandSkills = cap("native", "Runs the skills it lists as commands; others are expanded" + UNVERIFIED);

export const opencodeConnector: Connector = {
  id: "opencode",
  memory: {
    capability: () => cap("emulated", "First-message preamble; also ~/.config/opencode/AGENTS.md" + UNVERIFIED),
    forSession: preamble,
    globalBlock: (_globalFile, digest) => [harness.opencodeAgentsMd(), digest],
  },
  mcp: {
    capability: () => cap("native", "ACP session MCP servers; registry servers also written to its config on every change (tether-context on import)" + UNVERIFIED),
    forSession: acpMcp,
    sharedConfig: true,
    exportGlobal: (x) => registerOpencodeMcp(x.out, (p) => x.remember(p)),
    importGlobal: () => opencodeServers(),
    native: (projectPath) => opencodeServers(projectPath).found,
    deliver: acpRoute,
    targets: () => [{ file: opencodeConfigPath(), installed: existsSync(harness.opencodeDir()), format: "json", key: "mcp", flavor: "opencode", jsonc: true }],
  },
  skills: {
    capability: () => commandSkills,
    invoke: invocationText,
    dirs: (projectPath) => [
      ...repoDirs(projectPath, ".opencode/skills"),
      ...repoDirs(projectPath, ".claude/skills"),
      ...repoDirs(projectPath, ".agents/skills"),
      { dir: harness.opencodeSkills(), source: "opencode" },
      { dir: harness.claudeSkills(), source: "claude" },
      { dir: harness.agentsSkills(), source: "agents" },
    ],
    offline: false,
    installDirs: () => [{ harness: "opencode", dir: harness.opencodeSkills(), install: false, skip: [] }],
  },
  commands: slot("native", "Custom commands (command/ dir and config); not mapped yet" + UNVERIFIED),
  agents: slot("native", "Agents in its config; not mapped yet" + UNVERIFIED),
  hooks: slot("native", "Plugins; not mapped yet" + UNVERIFIED),
  env: slot("native", "Process environment; not mapped yet"),
  goal: slot("emulated", "Tether's goal loop and goal tools (tether-context)"),
  plan: slot("emulated", "Its plan agent has no review step: Tether's review card when a plan-mode turn ends (plan_set, else its reply), and changes wait for approval; Approve switches to Build" + UNVERIFIED),
  todos: slot("native", "Its ACP plan checklist, kept as the session's todo list; todo_set also works" + UNVERIFIED),
  ask_user: slot("emulated", "ask_user (tether-context) as a question card" + UNVERIFIED),
};

// ---------------- Kiro ----------------

export const kiroFile = () => join(harness.kiroSteering(), "tether.md");
/** Ours: the mark, or (exports before the mark) exactly the shape we used to write. */
export const isKiroOwned = (text: string) => isTetherOwned(text) || /^---\ninclusion: always\n---\n\n# Shared memory \(Tether\)\n/.test(text);

/** ~/.kiro/steering/tether.md, Tether's own steering file (inclusion: always), once Kiro is set up. */
function kiroSteering(x: ExportContext) {
  if (!existsSync(dirname(harness.kiroSteering()))) return;
  const cur = existsSync(kiroFile()) ? x.readText(kiroFile()) : undefined;
  if (cur !== undefined && !isKiroOwned(cur)) x.out.warnings.push(`${tilde(kiroFile())} is the user's own; left alone.`);
  else {
    if (!x.out.dryRun) mkdirSync(harness.kiroSteering(), { recursive: true });
    x.writeOwned(kiroFile(), `---\ninclusion: always\n${OWNED_MARK}\n---\n\n${x.digest}`);
  }
}

const kiroMemory: MemorySlot = {
  capability: () => cap("emulated", "First-message preamble; also a steering file (~/.kiro/steering)" + UNVERIFIED),
  forSession: preamble,
  exportGlobal: kiroSteering,
};

export const kiroConnector: Connector = {
  id: "kiro",
  memory: kiroMemory,
  mcp: {
    capability: () => cap("native", "ACP session MCP servers; ~/.kiro/settings/mcp.json" + UNVERIFIED),
    forSession: acpMcp,
    exportGlobal: (x) => x.registerJsonMcp(harness.kiroMcp(), dirname(harness.kiroMcp())),
    importGlobal: () => kiroServers(),
    native: (projectPath) => kiroServers(projectPath).found,
    deliver: acpRoute,
    targets: () => [{ file: harness.kiroMcp(), installed: existsSync(harness.kiroDir()), format: "json", key: "mcpServers", flavor: "plain" }],
  },
  skills: {
    capability: () => commandSkills,
    invoke: invocationText,
    dirs: (projectPath) => {
      const up = upward(projectPath);
      return [{ dir: join(projectPath, ".kiro/skills"), source: "repo", root: up[up.length - 1] }, { dir: harness.kiroSkills(), source: "kiro" }];
    },
    offline: false,
    // Kiro reads only its own dir; installed into once Kiro is set up (~/.kiro exists), like its steering export.
    installDirs: () => [{ harness: "kiro", dir: harness.kiroSkills(), install: existsSync(harness.kiroDir()), skip: [] }],
  },
  commands: slot("unsupported", "No custom commands over ACP" + UNVERIFIED),
  agents: slot("native", "Custom agents in ~/.kiro/agents; not mapped yet" + UNVERIFIED),
  hooks: slot("native", "Hooks in its agent config; not mapped yet" + UNVERIFIED),
  env: slot("native", "Process environment; not mapped yet"),
  goal: slot("emulated", "Tether's goal loop and goal tools (tether-context)"),
  plan: slot("emulated", "Where it offers a plan mode: Tether's review card when a plan-mode turn ends or it leaves plan mode by itself, and changes wait for approval" + UNVERIFIED),
  todos: slot("emulated", "todo_set; its ACP plan checklist too, if it sends one" + UNVERIFIED),
  ask_user: slot("emulated", "ask_user (tether-context) as a question card" + UNVERIFIED),
};
