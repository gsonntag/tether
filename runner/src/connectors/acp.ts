// ACP harnesses (opencode, Kiro): memory as a first-message preamble (ACP has no system-prompt
// hook) plus their global files; `tether-context` in newSession/loadSession `mcpServers`; skills
// run as `/name` when the agent lists them as commands, else Tether expands them.

import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { invocationText } from "../../../web/src/shared/skill";
import { isTetherOwned, OWNED_MARK } from "../context/blocks";
import { registerOpencodeMcp } from "../context/globalMcp";
import type { SessionContext } from "../context/inject";
import { harness, tilde } from "../context/paths";
import { cap, repoDirs, slot, upward } from "./shared";
import type { Connector, ExportContext, MemorySlot, SessionCtx } from "./types";

/** ACP's McpServerStdio shape. */
export function acpMcpServers(ctx: SessionContext | undefined) {
  if (!ctx) return [];
  return [{ name: "tether-context", command: ctx.mcp.command, args: ctx.mcp.args, env: Object.entries(ctx.mcp.env).map(([name, value]) => ({ name, value })) }];
}

/** Shared memory ahead of a new session's first message (a resumed one already had it). */
const preamble = ({ context, resume }: SessionCtx) => (context && !resume ? { preamble: context.prompt } : undefined);

/** mcpServers is always sent (an empty list without the context), as newSession requires it. */
const acpMcp = ({ context }: SessionCtx) => ({ options: { mcpServers: acpMcpServers(context) } });

const commandSkills = cap("native", "Runs the skills it lists as commands; others are expanded");

export const opencodeConnector: Connector = {
  id: "opencode",
  memory: {
    capability: () => cap("emulated", "First-message preamble; also ~/.config/opencode/AGENTS.md"),
    forSession: preamble,
    globalBlock: (_globalFile, digest) => [harness.opencodeAgentsMd(), digest],
  },
  mcp: {
    capability: () => cap("native", "ACP session MCP servers; opencode config on import"),
    forSession: acpMcp,
    sharedConfig: true,
    exportGlobal: (x) => registerOpencodeMcp(x.out, (p) => x.remember(p)),
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
  commands: slot("native", "Custom commands in its config; not mapped yet"),
  agents: slot("native", "Agents in its config; not mapped yet"),
  hooks: slot("native", "Plugins; not mapped yet"),
  env: slot("native", "Process environment; not mapped yet"),
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
  capability: () => cap("emulated", "First-message preamble; also a steering file"),
  forSession: preamble,
  exportGlobal: kiroSteering,
};

export const kiroConnector: Connector = {
  id: "kiro",
  memory: kiroMemory,
  mcp: {
    capability: () => cap("native", "ACP session MCP servers; ~/.kiro/settings/mcp.json"),
    forSession: acpMcp,
    exportGlobal: (x) => x.registerJsonMcp(harness.kiroMcp(), dirname(harness.kiroMcp())),
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
  commands: slot("unsupported", "No custom commands over ACP"),
  agents: slot("native", "Custom agents in ~/.kiro/agents; not mapped yet"),
  hooks: slot("native", "Hooks in its agent config; not mapped yet"),
  env: slot("native", "Process environment; not mapped yet"),
};
