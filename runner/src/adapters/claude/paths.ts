// Where Claude Code keeps sessions: ~/.claude/projects/<folder>/<session>.jsonl, the folder being
// the session's cwd with every non-alphanumeric replaced by "-". Subagents of a session are in
// <folder>/<session>/subagents/agent-<id>.jsonl, with a .meta.json beside each. Read-only.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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

export interface StoredSubagent {
  /** its file's name without `agent-` and `.jsonl`; a workflow's agent is `<run id>/<agent>` */
  agentId: string;
  meta: SubagentMeta;
  file: string;
}

/** Agent files and their metas by directory, kept while the directory's mtime holds (a watched session asks every second). */
const dirCache = new Map<string, { mtime: number; list: StoredSubagent[] }>();
const DIR_CACHE_MAX = 500;

function mtimeOf(dir: string): number | undefined {
  try {
    return statSync(dir).mtimeMs;
  } catch {
    return undefined;
  }
}

/** The agent-*.jsonl files in one directory, ids prefixed with `prefix`. */
function agentsIn(dir: string, prefix: string): StoredSubagent[] {
  const mtime = mtimeOf(dir);
  if (mtime === undefined) return (dirCache.delete(dir), []);
  const hit = dirCache.get(dir);
  if (hit && hit.mtime === mtime) return hit.list;
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {}
  const list = names
    .filter((n) => n.startsWith("agent-") && n.endsWith(".jsonl"))
    .map((n) => {
      const id = n.slice("agent-".length, -".jsonl".length);
      let meta: SubagentMeta = {};
      try {
        meta = JSON.parse(readFileSync(join(dir, `agent-${id}.meta.json`), "utf8"));
      } catch {}
      return { agentId: prefix + id, meta, file: join(dir, n) };
    });
  dirCache.delete(dir);
  dirCache.set(dir, { mtime, list });
  if (dirCache.size > DIR_CACHE_MAX) dirCache.delete(dirCache.keys().next().value!);
  return list;
}

/**
 * A session's subagents on disk: id, meta, and its transcript file. A workflow's agents are in
 * subagents/workflows/<run id>/ (their meta has no tool call: the Workflow card doesn't link them).
 */
export function storedSubagents(session: string, cwd?: string): StoredSubagent[] {
  const dir = sessionDir(session, cwd);
  if (!dir) return [];
  const sub = join(dir, session, "subagents");
  const out = agentsIn(sub, "");
  const wf = join(sub, "workflows");
  if (mtimeOf(wf) === undefined) return out;
  let runs: string[] = [];
  try {
    runs = readdirSync(wf).filter((n) => n.startsWith("wf_"));
  } catch {}
  return runs.length ? [...out, ...runs.flatMap((r) => agentsIn(join(wf, r), `${r}/`))] : out;
}
