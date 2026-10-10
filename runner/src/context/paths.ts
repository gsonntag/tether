// Every path the master context reads or writes, derived from $HOME and $TETHER_CONFIG_DIR at call
// time (never at import), so tests and dry runs can point the whole feature at a scratch home.

import { join } from "node:path";

export const home = () => process.env.HOME || "/nonexistent-home";
export const configDir = () => process.env.TETHER_CONFIG_DIR ?? join(home(), ".config", "tether");
export const contextDir = () => process.env.TETHER_CONTEXT_DIR ?? join(configDir(), "context");

/** Paths inside the store. */
export const store = {
  memory: () => join(contextDir(), "memory"),
  skills: () => join(contextDir(), "skills"),
  sources: () => join(contextDir(), "sources.json"),
  activity: () => join(contextDir(), "activity.jsonl"),
  conflicts: () => join(contextDir(), "conflicts.json"),
  backup: () => join(contextDir(), "backup"),
  exports: () => join(contextDir(), "exports"),
  /** memory_write calls from MCP servers wait here for the runner's merge pass */
  inbox: () => join(contextDir(), "inbox"),
};

/** Harness-owned locations. */
export const harness = {
  claudeDir: () => join(home(), ".claude"),
  claudeMd: () => join(home(), ".claude", "CLAUDE.md"),
  claudeProjects: () => join(home(), ".claude", "projects"),
  claudeSkills: () => join(home(), ".claude", "skills"),
  codexDir: () => join(home(), ".codex"),
  codexAgentsMd: () => join(home(), ".codex", "AGENTS.md"),
  codexMemories: () => join(home(), ".codex", "memories"),
  codexMemoriesDb: () => join(home(), ".codex", "memories_1.sqlite"),
  codexSkills: () => join(home(), ".codex", "skills"),
  codexConfig: () => join(home(), ".codex", "config.toml"),
  piAgentsMd: () => join(home(), ".pi", "agent", "AGENTS.md"),
  piSkills: () => join(home(), ".pi", "agent", "skills"),
  piMcp: () => join(home(), ".pi", "agent", "mcp.json"),
  opencodeAgentsMd: () => join(home(), ".config", "opencode", "AGENTS.md"),
  opencodeSkills: () => join(home(), ".config", "opencode", "skills"),
  kiroSteering: () => join(home(), ".kiro", "steering"),
  kiroMcp: () => join(home(), ".kiro", "settings", "mcp.json"),
  geminiMd: () => join(home(), ".gemini", "GEMINI.md"),
  geminiSkills: () => join(home(), ".gemini", "skills"),
  agyKnowledge: () => join(home(), ".gemini", "antigravity", "knowledge"),
  agySkills: () => join(home(), ".gemini", "antigravity", "skills"),
  agyMcp: () => join(home(), ".gemini", "antigravity", "mcp_config.json"),
  agentsSkills: () => join(home(), ".agents", "skills"),
};

/** `~/…` for display and provenance, so sources read the same on every machine. */
export function tilde(p: string): string {
  const h = home();
  return p === h ? "~" : p.startsWith(h + "/") ? "~" + p.slice(h.length) : p;
}

export function untilde(p: string): string {
  return p.replace(/^~(?=$|\/)/, home());
}
