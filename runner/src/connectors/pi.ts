// pi (RPC mode): memory through --append-system-prompt and in ~/.pi/agent/AGENTS.md;
// `tether-context` and the MCP registry's servers through pi-mcp-adapter's --mcp-config (else
// only the global ~/.pi/agent/mcp.json, which pi's built-in MCP reads); skills run as `/skill:name`.

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "jsonc-parser";
import { sha } from "../context/format";
import type { SessionContext } from "../context/inject";
import { configDir, harness } from "../context/paths";
import { writeAtomic } from "../context/store";
import { SESSION_TOOL_TIMEOUT_S } from "../context/launch";
import { toEntry } from "../mcp/formats";
import { piServers } from "../mcp/sources";
import { piPromptTemplates } from "../commands";
import { piSubagentsInstalled, syncPiAgents } from "../subagents";
import { cap, envSlot, piHasPackage, repoDirs, slot, upward } from "./shared";
import type { Connector, SessionServer } from "./types";

/** pi-mcp-adapter is one of pi's packages (it owns the `--mcp-config` flag). */
export const piMcpAdapterInstalled = () => piHasPackage("pi-mcp-adapter");

/**
 * pi's per-session MCP: a copy of the user's pi-mcp-adapter config (~/.pi/agent/mcp-adapter.json)
 * plus this session's registry servers and `tether-context`, for `--mcp-config` (which stands in
 * for that file during the run; shared configs like ~/.config/mcp/mcp.json still load). Undefined
 * without the adapter, in which case pi's own MCP reads the global ~/.pi/agent/mcp.json (the
 * context and registry exports write there).
 */
export function piMcpConfig(ctx: SessionContext | undefined, sessionKey?: string, servers: SessionServer[] = []): string | undefined {
  if ((!ctx && !servers.length) || !piMcpAdapterInstalled()) return undefined;
  let base: any = {};
  try {
    base = parse(readFileSync(harness.piMcpAdapter(), "utf8"), [], { allowTrailingComma: true }) ?? {};
  } catch {}
  if (!base || typeof base !== "object" || Array.isArray(base)) base = {};
  const mcpServers: Record<string, unknown> = { ...(base.mcpServers ?? {}) };
  for (const s of servers) mcpServers[s.name] = toEntry(s.transport, "plain");
  // `timeout` (seconds): ask_user waits for the user; pi-mcp-adapter's default is the MCP SDK's 60 s.
  if (ctx) mcpServers["tether-context"] = { command: ctx.mcp.command, args: ctx.mcp.args, env: ctx.mcp.env, timeout: SESSION_TOOL_TIMEOUT_S };
  const cfg = { ...base, mcpServers };
  const path = join(configDir(), "run", `pi-mcp-${sha(sessionKey ?? JSON.stringify(ctx?.mcp.env ?? servers.map((s) => s.name)))}.json`);
  // The registry's env and headers can hold secrets: only this user reads the file.
  writeAtomic(path, JSON.stringify(cfg, null, 2) + "\n", 0o600);
  return path;
}

// ---------------- pi's own goal extension (Phase 3: not used in Tether sessions) ----------------

/** A goal package or extension: `npm:pi-goal-x`, `pi-goals`, `extensions/goal.ts`, … */
export const isGoalExtension = (s: string) => /(^|[\/:@_-])goals?([\/._@-]|$)/i.test(s);

const RESOLVE_SCRIPT = fileURLToPath(new URL("./piResolve.ts", import.meta.url));
const PI_BIN = () => process.env.PI_BIN ?? "pi";

/** pi's package dir (`@earendil-works/pi-coding-agent`), from the `pi` on PATH. */
function piRoot(): string | undefined {
  const bin = Bun.which(PI_BIN());
  if (!bin) return undefined;
  let d = dirname(realpathSync(bin));
  for (let i = 0; i < 6; i++, d = dirname(d)) {
    try {
      if (/pi-coding-agent$/.test(JSON.parse(readFileSync(join(d, "package.json"), "utf8")).name ?? "")) return d;
    } catch {}
  }
  return undefined;
}

const mtime = (p: string) => statSync(p, { throwIfNoEntry: false })?.mtimeMs ?? 0;

/** Whether the user's pi setup names a goal extension at all (cheap: no pi code runs). */
export function piHasGoalExtension(): boolean {
  const agentDir = dirname(harness.piSettings());
  try {
    const settings = JSON.parse(readFileSync(harness.piSettings(), "utf8"));
    const entries = [...(settings.packages ?? []), ...(settings.extensions ?? [])].map((p: any) => (typeof p === "string" ? p : p?.source)).filter((x: unknown) => typeof x === "string");
    if (entries.some((x: string) => !x.startsWith("-") && !x.startsWith("!") && isGoalExtension(x))) return true;
  } catch {}
  try {
    return readdirSync(join(agentDir, "extensions")).some(isGoalExtension);
  } catch {
    return false;
  }
}

/** One extension as pi's package manager resolves it (piResolve.ts). */
export interface PiExtension {
  path: string;
  enabled: boolean;
  /** a package's source ("npm:pi-goal-x"), "local" (settings), "auto" (~/.pi/agent/extensions), "builtin" */
  source: string;
}

/** The launch args for pi's resolved extensions: every enabled one by path except the goal ones. */
export function goalFilterFrom(extensions: PiExtension[]): PiGoalFilter {
  const on = extensions.filter((e) => e.enabled);
  // A package by its source; the user's own extension files (settings or ~/.pi/agent/extensions) by name.
  const goal = (e: PiExtension) => isGoalExtension(e.source) || ((e.source === "local" || e.source === "auto") && isGoalExtension(e.path.slice(e.path.lastIndexOf("/"))));
  const excluded = on.filter(goal);
  if (!excluded.length) return { args: [], excluded: [], why: "no goal extension is loaded" };
  return { args: ["--no-extensions", ...on.filter((e) => !goal(e)).flatMap((e) => ["-e", e.path])], excluded: [...new Set(excluded.map((e) => e.source || e.path))] };
}

export type PiGoalFilter = { args: string[]; excluded: string[] } | { args: []; excluded: []; why: string };
let filterCache: { key: string; value: PiGoalFilter } | undefined;

/**
 * Launch args that keep pi's own goal extension (pi-goal-x and the like) out of a Tether session
 * while every other extension still loads. pi has no flag to leave one extension out, so this asks
 * pi's own package manager (piResolve.ts) which extensions the session would load, and launches
 * with `--no-extensions` plus `-e <path>` for each one except the goal ones (built-ins as
 * `-e builtin:<name>`). Filters nothing (and says why) when there's no goal extension, when the
 * project has pi settings or extensions of its own (those go through pi's project trust, which
 * this can't redo), or when pi's answer can't be had: then pi's goal extension loads and
 * Tether's goal tools and loop still drive the goal.
 */
export async function piGoalFilter(projectPath: string): Promise<PiGoalFilter> {
  const none = (why: string): PiGoalFilter => ({ args: [], excluded: [], why });
  if (!piHasGoalExtension()) return none("no goal extension");
  if (existsSync(join(projectPath, ".pi", "settings.json")) || existsSync(join(projectPath, ".pi", "extensions")))
    return none("the project has its own pi settings or extensions");
  const root = piRoot();
  if (!root) return none("pi's install wasn't found");
  const agentDir = dirname(harness.piSettings());
  const key = JSON.stringify([projectPath, root, mtime(harness.piSettings()), mtime(join(agentDir, "extensions")), mtime(join(agentDir, "npm", "node_modules")), mtime(join(root, "package.json"))]);
  if (filterCache?.key === key) return filterCache.value;
  let value: PiGoalFilter;
  try {
    const proc = Bun.spawn([process.execPath, RESOLVE_SCRIPT, root, projectPath, agentDir], { cwd: projectPath, stdout: "pipe", stderr: "pipe", env: { ...process.env, PI_OFFLINE: "1" } });
    const timer = setTimeout(() => proc.kill(), 10_000);
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    clearTimeout(timer);
    if (code !== 0) throw new Error(err.trim().split("\n")[0] || `exit ${code}`);
    value = goalFilterFrom((JSON.parse(out) as { extensions: PiExtension[] }).extensions);
  } catch (e: any) {
    console.error(`pi: couldn't work out its extensions, so its goal extension stays on: ${e?.message ?? e}`);
    value = none(`pi's extension list couldn't be read: ${e?.message ?? e}`);
  }
  filterCache = { key, value };
  return value;
}

export const piConnector: Connector = {
  id: "pi",
  memory: {
    capability: () => cap("native", "Appended to the system prompt; also ~/.pi/agent/AGENTS.md"),
    forSession: ({ context }) => (context?.prompt ? { args: ["--append-system-prompt", context.prompt] } : undefined),
    globalBlock: (_globalFile, digest) => [harness.piAgentsMd(), digest],
  },
  mcp: {
    capability: () =>
      piMcpAdapterInstalled()
        ? cap("native", "Per session with pi-mcp-adapter (--mcp-config)")
        : cap("unsupported", "No per-session MCP without pi-mcp-adapter; servers reach pi only through ~/.pi/agent/mcp.json"),
    forSession: ({ context, session, servers }) => {
      const path = piMcpConfig(context, session?.key, servers);
      return path ? { args: ["--mcp-config", path] } : undefined;
    },
    exportGlobal: (x) => x.registerJsonMcp(harness.piMcp(), dirname(harness.piMcp())),
    importGlobal: () => piServers(),
    native: (projectPath) => piServers(projectPath).found,
    deliver: () =>
      piMcpAdapterInstalled()
        ? { how: "session", note: "Per session (pi-mcp-adapter)" }
        : { how: "global", note: "Only through ~/.pi/agent/mcp.json: per-session servers need pi-mcp-adapter" },
    targets: () => [{ file: harness.piMcp(), installed: existsSync(dirname(harness.piMcp())), format: "json", key: "mcpServers", flavor: "plain" }],
  },
  skills: {
    capability: () => cap("native", "Runs skills as /skill:name"),
    // pi expands `/skill:name args` itself, in the same block shape Tether uses.
    invoke: (name, args) => (args ? `/skill:${name} ${args}` : `/skill:${name}`),
    dirs: (projectPath) => {
      const up = upward(projectPath);
      return [
        { dir: join(projectPath, ".pi/skills"), source: "repo", root: up[up.length - 1] },
        ...repoDirs(projectPath, ".agents/skills"),
        { dir: harness.piSkills(), source: "pi" },
        { dir: harness.agentsSkills(), source: "agents" },
      ];
    },
    offline: true,
    installDirs: () => [{ harness: "pi", dir: harness.piSkills(), install: false, skip: [] }],
  },
  commands: {
    capability: () => cap("native", "Your commands per session as prompt templates (--prompt-template), where pi fills in the arguments the same way; the others are filled in by Tether"),
    forSession: () => ({ args: piPromptTemplates().flatMap((f) => ["--prompt-template", f]) }),
  },
  agents: {
    capability: () =>
      piSubagentsInstalled()
        ? cap("native", "Through pi-subagents: your subagents are written to ~/.pi/agent/agents/tether (pi-subagents has no per-session path); one limited to tools pi doesn't have is left out")
        : cap("unsupported", "No built-in subagents; the pi-subagents package adds them"),
    forSession: () => {
      try {
        const w = syncPiAgents();
        if (w) console.error(`pi: ${w}`);
      } catch (e: any) {
        console.error(`pi: its agents weren't updated: ${e?.message ?? e}`);
      }
      return undefined;
    },
  },
  hooks: slot("emulated", "Run by Tether on every tool call (through its guard extension), as tool results come in, at the end of each turn and before your messages"),
  env: envSlot("Your secrets in its environment; MCP servers Tether hands it get them too"),
  goal: {
    capability: () =>
      cap(
        "emulated",
        `Tether's goal loop; the goal tools need pi-mcp-adapter${piHasGoalExtension() ? ". pi's own goal extension is left out of Tether sessions (launched with --no-extensions and every other extension by path), except in a project with its own pi settings or extensions" : ""}`,
      ),
  },
  plan: {
    capability: () =>
      cap(
        "emulated",
        `No plan mode: Tether's Plan mode, in which the guard holds back every change until you approve the plan (plan_set${piMcpAdapterInstalled() ? "" : " needs pi-mcp-adapter; without it the agent's reply is the plan"})`,
      ),
  },
  todos: { capability: () => (piMcpAdapterInstalled() ? cap("emulated", "todo_set (tether-context, through pi-mcp-adapter)") : cap("unsupported", "No todo tool; todo_set needs pi-mcp-adapter")) },
  ask_user: { capability: () => (piMcpAdapterInstalled() ? cap("emulated", "ask_user (tether-context, through pi-mcp-adapter) as a question card") : cap("unsupported", "No question tool; ask_user needs pi-mcp-adapter")) },
  schedules: slot("emulated", "Tether's /loop and /schedule, run by the runner; pi has no scheduler"),
  // pi 1.0.4 RPC: `fork` branches only before a user message and moves the running process to the new session.
  fork: slot("emulated", "A new session on a brief; pi's own fork only branches before one of your messages, inside the running process"),
  compact: slot("native", "Its own compaction (compact RPC), focus as its instructions"),
  crossAgents: slot("emulated", "agent_start / agent_wait / agent_result in tether-context, with pi-mcp-adapter only (without it pi can still be started as a subagent, but can't start one)"),
  review: slot("emulated", "Tether's review session without edit and write (--exclude-tools), bash through the guard; findings through review_report with pi-mcp-adapter, else from a JSON block in its reply"),
};
