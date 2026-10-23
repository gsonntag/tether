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

/** The credential plugins' homes (credentials/registry.ts homeFor), set by the registry when it loads. */
let homeResolver: ((credId: string, harness: "claude-code" | "codex") => string | undefined) | undefined;
export const setHarnessHomeResolver = (fn: typeof homeResolver) => (homeResolver = fn);

/**
 * Claude Code's and Codex's homes: the machine's own (~/.claude, ~/.codex), or with a session's
 * credential the account home its plugin keeps (CLAUDE_CONFIG_DIR / CODEX_HOME), when it has one.
 */
export const claudeHome = (credential?: string) => (credential && homeResolver?.(credential, "claude-code")) || join(home(), ".claude");
export const codexHome = (credential?: string) => (credential && homeResolver?.(credential, "codex")) || join(home(), ".codex");

/** Harness-owned locations. `credential`: a session's, for its account home (claudeHome / codexHome). */
export const harness = {
  claudeDir: (credential?: string) => claudeHome(credential),
  /** Claude Code's own state file, user-scope MCP servers included ($CLAUDE_CONFIG_DIR moves it) */
  claudeJson: () => (process.env.CLAUDE_CONFIG_DIR ? join(process.env.CLAUDE_CONFIG_DIR, ".claude.json") : join(home(), ".claude.json")),
  claudeMd: () => join(home(), ".claude", "CLAUDE.md"),
  claudeProjects: (credential?: string) => join(claudeHome(credential), "projects"),
  claudeSkills: () => join(home(), ".claude", "skills"),
  codexDir: (credential?: string) => codexHome(credential),
  codexAgentsMd: (credential?: string) => join(codexHome(credential), "AGENTS.md"),
  codexMemories: (credential?: string) => join(codexHome(credential), "memories"),
  codexMemoriesDb: (credential?: string) => join(codexHome(credential), "memories_1.sqlite"),
  codexSkills: () => join(home(), ".codex", "skills"),
  codexConfig: (credential?: string) => join(codexHome(credential), "config.toml"),
  piAgentsMd: () => join(home(), ".pi", "agent", "AGENTS.md"),
  piSkills: () => join(home(), ".pi", "agent", "skills"),
  piMcp: () => join(home(), ".pi", "agent", "mcp.json"),
  piMcpAdapter: () => join(home(), ".pi", "agent", "mcp-adapter.json"),
  piSettings: () => join(home(), ".pi", "agent", "settings.json"),
  opencodeDir: () => join(home(), ".config", "opencode"),
  opencodeAgentsMd: () => join(home(), ".config", "opencode", "AGENTS.md"),
  opencodeSkills: () => join(home(), ".config", "opencode", "skills"),
  kiroSteering: () => join(home(), ".kiro", "steering"),
  kiroMcp: () => join(home(), ".kiro", "settings", "mcp.json"),
  kiroDir: () => join(home(), ".kiro"),
  kiroSkills: () => join(home(), ".kiro", "skills"),
  geminiMd: () => join(home(), ".gemini", "GEMINI.md"),
  geminiSkills: () => join(home(), ".gemini", "skills"),
  agyKnowledge: () => join(home(), ".gemini", "antigravity", "knowledge"),
  agySkills: () => join(home(), ".gemini", "antigravity", "skills"),
  /** agy's global MCP config (it migrated here from ~/.gemini/antigravity/mcp_config.json) */
  agyMcp: () => join(home(), ".gemini", "config", "mcp_config.json"),
  agyMcpLegacy: () => join(home(), ".gemini", "antigravity", "mcp_config.json"),
  agyDir: () => join(home(), ".gemini", "antigravity"),
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
