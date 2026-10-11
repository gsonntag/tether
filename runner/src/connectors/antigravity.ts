// Antigravity (`agy` stream-json): memory as a first-message preamble and in ~/.gemini/GEMINI.md;
// `tether-context` only through its global MCP config (no per-session servers); skills are always
// expanded by Tether.

import { invocationText } from "../../../web/src/shared/skill";
import { harness } from "../context/paths";
import { cap, slot } from "./shared";
import type { Connector } from "./types";

export const antigravityConnector: Connector = {
  id: "antigravity",
  memory: {
    capability: () => cap("emulated", "First-message preamble; also ~/.gemini/GEMINI.md"),
    forSession: ({ context, resume }) => (context && !resume ? { preamble: context.prompt } : undefined),
    globalBlock: (globalFile) => [harness.geminiMd(), `@${globalFile}`],
  },
  mcp: {
    capability: () => cap("native", "Global MCP config only, no per-session servers"),
    exportGlobal: (x) => x.registerJsonMcp(harness.agyMcp(), harness.agyDir()),
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
};
