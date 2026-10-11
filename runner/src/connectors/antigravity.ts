// Antigravity (`agy` stream-json): memory as a first-message preamble and in ~/.gemini/GEMINI.md;
// `tether-context` and the MCP registry's global servers only through its global MCP config (no
// per-session servers; the registry also exports to Gemini CLI's ~/.gemini/settings.json); skills
// are always expanded by Tether.

import { existsSync } from "node:fs";
import { invocationText } from "../../../web/src/shared/skill";
import { harness } from "../context/paths";
import { antigravityServers, geminiServers, geminiSettings, merge } from "../mcp/sources";
import { cap, slot } from "./shared";
import type { Connector } from "./types";

export const antigravityConnector: Connector = {
  id: "antigravity",
  memory: {
    capability: () => cap("emulated", "First-message preamble; also ~/.gemini/GEMINI.md"),
    forSession: ({ context, resume }) => (context?.prompt && !resume ? { preamble: context.prompt } : undefined),
    globalBlock: (globalFile) => [harness.geminiMd(), `@${globalFile}`],
  },
  mcp: {
    capability: () => cap("native", "Global MCP config only, no per-session servers"),
    exportGlobal: (x) => x.registerJsonMcp(harness.agyMcp(), harness.agyDir()),
    importGlobal: () => merge(antigravityServers(), geminiServers()),
    native: () => antigravityServers().found,
    deliver: () => ({ how: "global", note: "No per-session servers: only through its global MCP config" }),
    targets: () => [
      { file: harness.agyMcp(), installed: existsSync(harness.agyDir()), format: "json", key: "mcpServers", flavor: "agy" },
      // Gemini CLI shares ~/.gemini; written only where it's set up (its settings file exists).
      { file: geminiSettings(), installed: existsSync(geminiSettings()), format: "json", key: "mcpServers", flavor: "gemini", jsonc: true },
    ],
  },
  skills: {
    capability: () => cap("emulated", "Tether expands the skill into the message"),
    invoke: invocationText,
    dirs: () => [
      { dir: harness.agySkills(), source: "antigravity" },
      { dir: harness.geminiSkills(), source: "gemini" },
    ],
    offline: false,
    installDirs: () => [
      { harness: "antigravity", dir: harness.agySkills(), install: true, skip: [] },
      { harness: "gemini", dir: harness.geminiSkills(), install: true, skip: [] },
    ],
  },
  commands: slot("native", "Slash commands; not mapped yet"),
  agents: slot("native", "Agents (--agent); not mapped yet"),
  hooks: slot("native", "Hooks (Tether's guard is a PreToolUse hook); not mapped yet"),
  env: slot("native", "Process environment; not mapped yet"),
  goal: slot("emulated", "Tether's goal loop; the goal tools only where its global tether-context passes the session through"),
  plan: slot("native", "Plan mode; Tether holds its first change until you approve the plan (headless agy would approve its own)"),
  todos: slot("emulated", "todo_set only where its global tether-context passes the session through"),
  ask_user: slot("emulated", "ask_user only where its global tether-context passes the session through"),
};
