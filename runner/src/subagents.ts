// Tether's subagent library (docs/harness-platform.md, Phase 2 "later slots"): your subagent
// definitions, imported read-only from every harness that has them, and handed to each harness
// that can run custom subagents in its own format:
//
//   Claude Code   per session, SDK `agents` (description, prompt, tools, model)
//   Codex         per session, a role file in the runner's config dir and the thread config
//                 `agents.<name> = { description, config_file }` (codex-cli 0.162 agent roles)
//   opencode      per session, OPENCODE_CONFIG_CONTENT `agent.<name>` with mode "subagent" (a tools
//                 list as permission rules: the tools "ask", everything else "deny")
//   pi            with the pi-subagents package only: Tether's own folder ~/.pi/agent/agents/tether/
//                 (pi-subagents reads ~/.pi/agent/agents/**/*.md; there is no per-session path)
//   Kiro, Antigravity: no custom subagents Tether can hand them.
//
// Read from: ~/.claude/agents/**/*.md, ~/.codex/agents/*.toml, opencode's agent(s)/ dirs and config
// `agent` map (subagents only), pi-subagents' ~/.pi/agent/agents/**/*.md. A harness that already has
// an agent of that name keeps its own. A tools list is never dropped: an agent none of whose tools
// a harness has isn't handed to it (it would get every tool). Kept in the runner's config dir (subagents.json, mode 600).

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parse } from "jsonc-parser";
import type { HarnessId, SubagentFindResult, SubagentView } from "../../web/src/shared/protocol";
import { piHasPackage } from "./connectors/shared";
import { splitFrontMatter } from "./context/format";
import { opencodeConfigPath } from "./context/globalMcp";
import { configDir, harness, home, tilde } from "./context/paths";
import { writeAtomic } from "./context/store";
import { isEntryName, Library, mdFiles, type LibraryEntry } from "./library";

export interface StoredAgent extends LibraryEntry {
  /** its system prompt */
  prompt: string;
  /** the tools it may use, in the naming of the harness it came from (`toolsFrom`); absent: all */
  tools?: string[];
  toolsFrom?: "claude" | "pi";
  /** the model its file asked for, as written there */
  model?: string;
}

type Found = Omit<StoredAgent, "id" | "enabled" | "addedAt">;

export const subagentsFile = () => join(configDir(), "subagents.json");
const valid = (v: any): v is StoredAgent => !!v && typeof v.name === "string" && typeof v.prompt === "string" && typeof v.id === "string";
export const agentLib = new Library<StoredAgent>(subagentsFile, "agent", valid);

export const libraryAgents = (): StoredAgent[] => agentLib.load().items.filter((a) => a.enabled);

// ---------------- reading definitions ----------------

const read = (p: string) => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return undefined;
  }
};

const list = (v: unknown): string[] | undefined => {
  const items = Array.isArray(v) ? v.map(String) : typeof v === "string" ? v.split(",") : undefined;
  const out = items?.map((s) => s.trim()).filter(Boolean);
  return out?.length ? out : undefined;
};

/** A markdown agent (Claude Code's and pi-subagents' shape: name, description, tools, model; the body is the prompt). */
export function parseAgentMd(text: string, fallbackName: string, source: string, toolsFrom?: "claude" | "pi"): Found | undefined {
  const { fm, body } = splitFrontMatter(text);
  const name = (typeof fm.name === "string" && fm.name.trim()) || fallbackName;
  if (!isEntryName(name) || !body.trim()) return undefined;
  const description = typeof fm.description === "string" ? fm.description.trim().slice(0, 1000) : "";
  const tools = toolsFrom ? list(fm.tools) : undefined;
  const model = typeof fm.model === "string" && fm.model.trim() ? fm.model.trim() : undefined;
  return { name, description, prompt: body, sources: [source], ...(tools ? { tools, toolsFrom } : {}), ...(model ? { model } : {}) };
}

export const claudeAgentsDir = () => join(harness.claudeDir(), "agents");
export const codexAgentsDir = () => join(harness.codexDir(), "agents");
export const piAgentsDir = () => join(home(), ".pi", "agent", "agents");
/** Tether's own folder in pi-subagents' user dir. */
export const piTetherAgentsDir = () => join(piAgentsDir(), "tether");
export const opencodeAgentDirs = () => [join(harness.opencodeDir(), "agent"), join(harness.opencodeDir(), "agents")];

const OWNED = ".tether-owned";

function claudeAgents(dir = claudeAgentsDir(), source = "claude"): Found[] {
  return mdFiles(dir, 2).flatMap((f) => {
    const text = read(f);
    const a = text !== undefined ? parseAgentMd(text, basename(f, ".md"), `${source}:${tilde(f)}`, "claude") : undefined;
    return a ? [a] : [];
  });
}

/** Codex role files: `name`, `description`, `developer_instructions` (TOML). */
function codexAgents(): Found[] {
  let names: string[];
  try {
    names = readdirSync(codexAgentsDir()).filter((n) => n.endsWith(".toml")).sort();
  } catch {
    return [];
  }
  const out: Found[] = [];
  for (const n of names) {
    const f = join(codexAgentsDir(), n);
    try {
      const t = Bun.TOML.parse(read(f) ?? "") as any;
      const name = typeof t.name === "string" ? t.name : basename(n, ".toml");
      if (!isEntryName(name) || typeof t.developer_instructions !== "string" || !t.developer_instructions.trim()) continue;
      out.push({ name, description: typeof t.description === "string" ? t.description : "", prompt: t.developer_instructions.trim(), sources: [`codex:${tilde(f)}`], ...(typeof t.model === "string" ? { model: t.model } : {}) });
    } catch {}
  }
  return out;
}

/** opencode's subagents: agent(s)/*.md (mode subagent or all) and its config's `agent` map. */
function opencodeAgents(): Found[] {
  const out: Found[] = [];
  for (const d of opencodeAgentDirs())
    for (const f of mdFiles(d)) {
      const text = read(f);
      if (text === undefined) continue;
      const mode = splitFrontMatter(text).fm.mode;
      if (mode === "primary") continue;
      const a = parseAgentMd(text, basename(f, ".md"), `opencode:${tilde(f)}`);
      if (a) out.push({ ...a, name: basename(f, ".md") });
    }
  const path = opencodeConfigPath();
  const cfg = read(path) ? parse(read(path)!, [], { allowTrailingComma: true }) : undefined;
  for (const [name, a] of Object.entries((cfg?.agent ?? {}) as Record<string, any>)) {
    if (!isEntryName(name) || !a || typeof a !== "object" || a.mode === "primary" || OPENCODE_BUILTIN.has(name)) continue;
    // `{file:./x.md}` prompts are opencode's own indirection: not followed.
    if (typeof a.prompt !== "string" || !a.prompt.trim() || /^\{file:/.test(a.prompt.trim())) continue;
    out.push({ name, description: typeof a.description === "string" ? a.description : "", prompt: a.prompt.trim(), sources: [`opencode:${tilde(path)}`], ...(typeof a.model === "string" ? { model: a.model } : {}) });
  }
  return out;
}

/** pi-subagents' user agents (not Tether's own folder). */
function piAgents(): Found[] {
  const own = piTetherAgentsDir();
  return mdFiles(piAgentsDir(), 3).flatMap((f) => {
    if (f.startsWith(own + "/") || f.endsWith(".chain.md")) return [];
    const text = read(f);
    const a = text !== undefined ? parseAgentMd(text, basename(f, ".md"), `pi:${tilde(f)}`, "pi") : undefined;
    return a ? [a] : [];
  });
}

export function scanAgents(): Found[] {
  return [...claudeAgents(), ...codexAgents(), ...opencodeAgents(), ...piAgents()];
}

// ---------------- per harness ----------------

const CLAUDE_MODEL = /^(inherit|sonnet|opus|haiku|fable|claude-[\w.-]+)$/i;

/** Agents Claude Code loads itself here: ~/.claude/agents and the project's .claude/agents. */
const claudeNative = (projectPath: string) => new Set([...claudeAgents(), ...claudeAgents(join(projectPath, ".claude", "agents"), "repo")].map((a) => a.name));

/** SDK `agents` for a Claude Code session. */
export function claudeAgentDefs(projectPath: string): Record<string, { description: string; prompt: string; tools?: string[]; model?: string }> {
  const native = claudeNative(projectPath);
  const out: Record<string, { description: string; prompt: string; tools?: string[]; model?: string }> = {};
  for (const a of libraryAgents()) {
    if (native.has(a.name)) continue;
    const tools = claudeTools(a);
    if (tools === null) continue;
    out[a.name] = {
      description: a.description || `Use the ${a.name} agent when its instructions fit the task.`,
      prompt: a.prompt,
      ...(tools?.length ? { tools } : {}),
      ...(a.model && CLAUDE_MODEL.test(a.model) ? { model: a.model } : {}),
    };
  }
  return out;
}

/** Codex's own agent roles: its agents/ dir and `[agents.<name>]` in config.toml. */
function codexNative(): Set<string> {
  const names = new Set(codexAgents().map((a) => a.name));
  try {
    const t = Bun.TOML.parse(read(harness.codexConfig()) ?? "") as any;
    for (const k of Object.keys(t?.agents ?? {})) if (t.agents[k] && typeof t.agents[k] === "object") names.add(k);
  } catch {}
  return names;
}

const tomlStr = (s: string) => JSON.stringify(s);

/**
 * Codex thread config for a session: `agents.<name> = { description, config_file }`, each role file
 * (name, description, developer_instructions) written in the runner's config dir. Its tools and
 * model aren't carried: Codex roles take Codex settings.
 */
export function codexAgentConfig(): Record<string, { description: string; config_file: string }> {
  const native = codexNative();
  const dir = join(configDir(), "run", "codex-agents");
  const out: Record<string, { description: string; config_file: string }> = {};
  for (const a of libraryAgents()) {
    // A dot would split the config override's key path.
    if (native.has(a.name) || /[.:]/.test(a.name)) continue;
    const file = join(dir, `${a.name}.toml`);
    const description = a.description || `The ${a.name} agent`;
    try {
      writeAtomic(file, `name = ${tomlStr(a.name)}\ndescription = ${tomlStr(description)}\ndeveloper_instructions = ${tomlStr(a.prompt)}\n`, 0o600);
      out[`agents.${a.name}`] = { description, config_file: file };
    } catch (e: any) {
      console.error(`subagents: couldn't write Codex's role file for ${a.name}: ${e?.message ?? e}`);
    }
  }
  return out;
}

/** opencode's built-in agents: a library agent with one of these names isn't handed over. */
const OPENCODE_BUILTIN = new Set(["build", "plan", "general", "explore", "title", "summary", "compaction"]);

/** opencode's inline `agent` map: your subagents it doesn't have (mode "subagent"; a `provider/model` model kept). */
export function opencodeAgentConfig(): Record<string, { description: string; prompt: string; mode: "subagent"; model?: string; permission?: Record<string, "ask" | "deny"> }> {
  const own = new Set(opencodeAgents().map((a) => a.name));
  const out: Record<string, { description: string; prompt: string; mode: "subagent"; model?: string; permission?: Record<string, "ask" | "deny"> }> = {};
  for (const a of libraryAgents()) {
    if (own.has(a.name) || OPENCODE_BUILTIN.has(a.name)) continue;
    const permission = opencodePermission(a);
    out[a.name] = { description: a.description || `The ${a.name} agent`, prompt: a.prompt, mode: "subagent", ...(a.model?.includes("/") ? { model: a.model } : {}), ...(permission ? { permission } : {}) };
  }
  return out;
}

/**
 * A restricted agent's tools as opencode permission rules, the way its own explore agent is
 * restricted (opencode 1.18.35: `{"*": "deny", grep: "allow", …}`, the agent's rules merged last).
 * Its tools are "ask", not "allow", so they still go through Tether's guard (OPENCODE_PERMISSION).
 */
function opencodePermission(a: StoredAgent): Record<string, "ask" | "deny"> | undefined {
  if (!a.tools?.length) return undefined;
  const map = a.toolsFrom === "pi" ? PI_TO_OPENCODE : CLAUDE_TO_OPENCODE;
  const out: Record<string, "ask" | "deny"> = { "*": "deny" };
  for (const t of a.tools) {
    const o = map[a.toolsFrom === "pi" ? t.toLowerCase() : t];
    if (o) out[o] = "ask";
  }
  return out;
}

const PI_TO_CLAUDE: Record<string, string> = { read: "Read", grep: "Grep", find: "Glob", ls: "LS", bash: "Bash", edit: "Edit", write: "Write" };
const CLAUDE_TO_PI: Record<string, string> = { Read: "read", Grep: "grep", Glob: "find", LS: "ls", Bash: "bash", Edit: "edit", MultiEdit: "edit", Write: "write" };
// opencode 1.18.35's permission keys (edit covers its write and patch tools).
const CLAUDE_TO_OPENCODE: Record<string, string> = { Read: "read", Grep: "grep", Glob: "glob", LS: "list", Bash: "bash", Edit: "edit", MultiEdit: "edit", Write: "edit", NotebookEdit: "edit", WebFetch: "webfetch", WebSearch: "websearch", TodoWrite: "todowrite", Task: "task" };
const PI_TO_OPENCODE: Record<string, string> = { read: "read", grep: "grep", find: "glob", ls: "list", bash: "bash", edit: "edit", write: "edit" };

/**
 * An agent's tools in Claude Code's names: undefined when it isn't restricted, null when it is but
 * none of its tools are Claude Code's (handing it over without them would widen it to every tool).
 */
function claudeTools(a: StoredAgent): string[] | undefined | null {
  if (!a.tools?.length) return undefined;
  if (a.toolsFrom !== "pi") return a.tools;
  const t = [...new Set(a.tools.map((t) => PI_TO_CLAUDE[t.toLowerCase()]).filter((t): t is string => !!t))];
  return t.length ? t : null;
}

/** The same in pi's names (see claudeTools). */
function piTools(a: StoredAgent): string[] | undefined | null {
  if (!a.tools?.length) return undefined;
  if (a.toolsFrom === "pi") return a.tools;
  const t = [...new Set(a.tools.map((t) => CLAUDE_TO_PI[t]).filter((t): t is string => !!t))];
  return t.length ? t : null;
}

export const piSubagentsInstalled = () => piHasPackage("pi-subagents");

/**
 * pi-subagents: Tether's folder ~/.pi/agent/agents/tether/ holds one file per library agent pi
 * doesn't have, rewritten to match the library (only a folder Tether made, marked with
 * .tether-owned, is ever changed). Removed when pi-subagents isn't installed. Returns the warning,
 * if any.
 */
export function syncPiAgents(): string | undefined {
  const dir = piTetherAgentsDir();
  const ours = existsSync(join(dir, OWNED));
  if (existsSync(dir) && !ours) return `${tilde(dir)} isn't Tether's; left alone, so pi gets no agents from Tether.`;
  const want = new Map<string, string>();
  if (piSubagentsInstalled()) {
    const own = new Set(piAgents().map((a) => a.name));
    for (const a of libraryAgents()) {
      const tools = piTools(a);
      if (own.has(a.name) || tools === null) continue;
      const fm = [`name: ${JSON.stringify(a.name)}`, `description: ${JSON.stringify(a.description || `The ${a.name} agent`)}`, ...(tools?.length ? [`tools: ${tools.join(", ")}`] : []), ...(a.toolsFrom === "pi" && a.model ? [`model: ${a.model}`] : [])];
      want.set(`${a.name}.md`, `---\n${fm.join("\n")}\n---\n\n${a.prompt}\n`);
    }
  }
  if (!want.size) {
    if (ours) rmSync(dir, { recursive: true, force: true });
    return undefined;
  }
  mkdirSync(dir, { recursive: true });
  if (!ours) writeFileSync(join(dir, OWNED), "Tether writes the agents in this folder from its subagent library; edits are overwritten.\n");
  for (const n of readdirSync(dir)) if (n !== OWNED && !want.has(n)) rmSync(join(dir, n), { force: true });
  for (const [n, text] of want) if (read(join(dir, n)) !== text) writeAtomic(join(dir, n), text);
  return undefined;
}

// ---------------- the web app ----------------

/** Where each harness gets an agent, for the list. */
function delivery(a: StoredAgent, natives: Record<string, Set<string>>): SubagentView["delivery"] {
  const d = (harness: HarnessId, how: "session" | "native" | "global" | "none", note: string) => ({ harness, how, note });
  if (!a.enabled) return [];
  return [
    natives.claude!.has(a.name) ? d("claude-code", "native", "In ~/.claude/agents") : claudeTools(a) === null ? d("claude-code", "none", "None of its tools are Claude Code's") : d("claude-code", "session", "Per session"),
    natives.codex!.has(a.name) ? d("codex", "native", "One of its own agent roles") : d("codex", "session", "Per session, as an agent role"),
    !piSubagentsInstalled() ? d("pi", "none", "Needs the pi-subagents package") : natives.pi!.has(a.name) ? d("pi", "native", "In ~/.pi/agent/agents") : piTools(a) === null ? d("pi", "none", "None of its tools are pi's") : d("pi", "global", "In ~/.pi/agent/agents/tether"),
    natives.opencode!.has(a.name) || OPENCODE_BUILTIN.has(a.name) ? d("opencode", "native", "One of its own agents") : d("opencode", "session", "Per session, as a subagent"),
    d("kiro", "none", "Not available"),
    d("antigravity", "none", "Not available"),
  ];
}

function view(a: StoredAgent, natives: Record<string, Set<string>>): SubagentView {
  return {
    id: a.id,
    name: a.name,
    description: a.description,
    prompt: a.prompt,
    ...(a.tools ? { tools: a.tools } : {}),
    ...(a.model ? { model: a.model } : {}),
    enabled: a.enabled,
    sources: a.sources,
    delivery: delivery(a, natives),
  };
}

export function listSubagents(): SubagentView[] {
  const natives = {
    claude: new Set(claudeAgents().map((a) => a.name)),
    codex: codexNative(),
    pi: new Set(piAgents().map((a) => a.name)),
    opencode: new Set(opencodeAgents().map((a) => a.name)),
  };
  return agentLib
    .load()
    .items.map((a) => view(a, natives))
    .sort((a, b) => a.name.localeCompare(b.name));
}

const same = (a: StoredAgent, b: Found) => a.prompt.trim() === b.prompt.trim();

function afterChange(warnings: string[] = []) {
  try {
    const w = syncPiAgents();
    if (w) warnings.push(w);
  } catch (e: any) {
    warnings.push(`pi's agents weren't updated: ${e?.message ?? e}`);
  }
  return warnings;
}

/** "Find subagents" and the master context's Import: every harness's agent definitions, read only. */
export async function importSubagents(): Promise<SubagentFindResult> {
  const warnings: string[] = [];
  const found = scanAgents();
  const added = found.length ? await agentLib.mutate((d) => agentLib.merge(d, found, same, false, warnings)) : [];
  afterChange(warnings);
  return { agents: listSubagents(), added, warnings };
}

/** A subagent you add or edit: a Claude Code agent file (front matter with name and description, then the prompt). */
export async function addSubagent(text: string, name?: string): Promise<SubagentView[]> {
  const a = parseAgentMd(text, name?.trim() ?? "", "you", "claude");
  if (!a) throw new Error("Paste an agent file: front matter with a name and a description, then its instructions.");
  await agentLib.mutate((d) => agentLib.merge(d, [a], same, true, []));
  afterChange();
  return listSubagents();
}

export async function setSubagent(id: string, change: { enabled?: boolean; remove?: boolean }): Promise<SubagentView[]> {
  await agentLib.set(id, change);
  afterChange();
  return listSubagents();
}
