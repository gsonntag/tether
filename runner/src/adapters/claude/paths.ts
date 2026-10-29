// Where Claude Code keeps sessions: ~/.claude/projects/<folder>/<session>.jsonl, the folder being
// the session's cwd with every non-alphanumeric replaced by "-". Subagents of a session are in
// <folder>/<session>/subagents/agent-<id>.jsonl, with a .meta.json beside each. Read-only.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
export const projectsDir = () => join(claudeDir(), "projects");

/** A subagent's native id is `<session>/<agent id>` (SPEC §6a): Tether's id stays `claude:<native>`. */
export function splitNative(nativeId: string): { session: string; agent?: string } {
  const i = nativeId.indexOf("/");
  return i < 0 ? { session: nativeId } : { session: nativeId.slice(0, i), agent: nativeId.slice(i + 1) };
}

const encode = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, "-");

/** The project folder holding a session's file: by its cwd, else by looking through all of them. */
export function sessionDir(session: string, cwd?: string): string | undefined {
  const base = projectsDir();
  if (cwd) {
    const direct = join(base, encode(cwd));
    if (existsSync(join(direct, `${session}.jsonl`))) return direct;
  }
  try {
    for (const d of readdirSync(base)) if (existsSync(join(base, d, `${session}.jsonl`))) return join(base, d);
  } catch {}
  return undefined;
}

export function sessionFile(session: string, cwd?: string): string | undefined {
  const dir = sessionDir(session, cwd);
  return dir && join(dir, `${session}.jsonl`);
}

export interface SubagentMeta {
  agentType?: string;
  description?: string;
  toolUseId?: string;
  model?: string;
}

/** A session's subagents on disk: id, meta, and its transcript file. */
export function storedSubagents(session: string, cwd?: string): { agentId: string; meta: SubagentMeta; file: string }[] {
  const dir = sessionDir(session, cwd);
  if (!dir) return [];
  const sub = join(dir, session, "subagents");
  let names: string[];
  try {
    names = readdirSync(sub);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.startsWith("agent-") && n.endsWith(".jsonl"))
    .map((n) => {
      const agentId = n.slice("agent-".length, -".jsonl".length);
      let meta: SubagentMeta = {};
      try {
        meta = JSON.parse(readFileSync(join(sub, `agent-${agentId}.meta.json`), "utf8"));
      } catch {}
      return { agentId, meta, file: join(sub, n) };
    });
}
