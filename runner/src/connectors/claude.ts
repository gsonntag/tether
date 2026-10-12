// Claude Code (Agent SDK): memory in the system prompt (append) and ~/.claude/CLAUDE.md plus its
// per-project memory dirs; `tether-context` as an SDK MCP server and, on the user's import, in
// ~/.claude.json; skills in ~/.claude/skills, run as `/name`.

import { existsSync, mkdirSync, readdirSync, readlinkSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { invocationText } from "../../../web/src/shared/skill";
import { isTetherOwned, OWNED_MARK } from "../context/blocks";
import { claudeInstalled, registerClaudeMcp } from "../context/globalMcp";
import { SESSION_TOOL_TIMEOUT_S } from "../context/launch";
import { harness, tilde } from "../context/paths";
import { claudeProjectScope } from "../context/repokey";
import { toEntry } from "../mcp/formats";
import { claudeServers, claudeSessionServers } from "../mcp/sources";
import { cap, repoDirs, slot } from "./shared";
import type { Connector, ExportContext, SessionCtx } from "./types";

export const INDEX_LINE = "- [Tether shared memory](tether.md) — repo facts shared by every agent (managed by Tether; edits are overwritten)";
export const isIndexLine = (l: string) => l.trim() === INDEX_LINE || /^- \[Tether shared memory\]\(tether\.md\)/.test(l.trim());

const repoFile = (text: string) =>
  `---\nname: tether\ndescription: Shared repository memory from Tether (managed; edits are overwritten)\ntype: project\n${OWNED_MARK}\n---\n\n${text}`;

/** Removes our index line from a MEMORY.md, keeping every other byte. */
export function withoutIndexLine(idx: string): string {
  return idx
    .split("\n")
    .filter((l) => !isIndexLine(l))
    .join("\n");
}

const isLinkish = (p: string) => {
  try {
    return !!readlinkSync(p);
  } catch {
    return false;
  }
};

/** Claude's own per-project memory: a Tether-owned tether.md plus one index line in MEMORY.md. */
async function claudeRepoFiles(x: ExportContext) {
  const { store, out } = x;
  const root = harness.claudeProjects();
  let dirs: string[] = [];
  try {
    dirs = readdirSync(root);
  } catch {
    return;
  }
  const keys = new Set(store.list().flatMap((m) => (m.scope.startsWith("repo:") ? [m.scope.slice(5)] : [])));
  for (const d of dirs) {
    const projectDir = join(root, d);
    if (!statSync(projectDir, { throwIfNoEntry: false })?.isDirectory()) continue;
    const scope = await claudeProjectScope(projectDir).catch(() => undefined);
    if (!scope || scope.kind !== "repo") continue;
    const memDir = join(projectDir, "memory");
    const file = join(memDir, "tether.md");
    const index = join(memDir, "MEMORY.md");
    const existing = existsSync(file) || isLinkish(file) ? x.readText(file) : undefined;
    if (existing !== undefined && !isTetherOwned(existing)) {
      out.warnings.push(`${tilde(file)} is the user's own memory, not Tether's; left alone (repo memory reaches Claude there through MCP only).`);
      continue;
    }
    const text = keys.has(scope.key) ? x.repoDigest(scope.key) : undefined;
    if (!text) {
      if (existing !== undefined && !out.dryRun) {
        x.remember(file);
        rmSync(file, { force: true });
        out.written.push(file);
      }
      const idx = x.readText(index);
      if (idx.split("\n").some(isIndexLine)) x.writeOwned(index, withoutIndexLine(idx));
      continue;
    }
    if (!out.dryRun && !existsSync(memDir)) {
      x.remember(file, true);
      mkdirSync(memDir, { recursive: true });
    }
    x.writeOwned(file, repoFile(text));
    const idx = x.readText(index);
    if (!idx.split("\n").some(isIndexLine)) x.writeOwned(index, (idx.trim() ? idx.replace(/\n*$/, "\n") : "") + INDEX_LINE + "\n");
  }
}

/** SDK `mcpServers`: the registry's servers for this session, and `tether-context`. */
function claudeMcp({ context, servers }: SessionCtx) {
  const mcpServers: Record<string, unknown> = {};
  for (const s of servers ?? []) mcpServers[s.name] = toEntry(s.transport, "claude");
  // `timeout` (ms): ask_user waits for the user (context/launch.ts SESSION_TOOL_TIMEOUT_S).
  if (context) mcpServers["tether-context"] = { type: "stdio" as const, ...context.mcp, timeout: SESSION_TOOL_TIMEOUT_S * 1000 };
  return Object.keys(mcpServers).length ? { options: { mcpServers } } : undefined;
}

/**
 * The SDK passes `mcpServers` to the claude process as `--mcp-config <json>` on its command line,
 * which any local user can read (ps, /proc/<pid>/cmdline). So a launch gets the http/SSE servers
 * without their headers (an OAuth token, a pasted key) and none of the stdio servers that carry env
 * values (API keys); `full` (when any were held back) is the set to hand over with setMcpServers,
 * which goes over the SDK's stdin control channel, before the first message. `tether-context` stays
 * on the command line: its env is paths and the session's guard key, which is no use without the
 * bridge's own token (bridge.json, mode 600), and its tools must be there from the start.
 */
export function argvSafeMcp(servers: Record<string, any>): { launch: Record<string, any>; full?: Record<string, any> } {
  let held = false;
  const launch: Record<string, any> = {};
  for (const [name, e] of Object.entries(servers)) {
    if ((e?.type === "http" || e?.type === "sse") && e.headers && Object.keys(e.headers).length) {
      const { headers: _, ...bare } = e;
      launch[name] = bare;
      held = true;
    } else if (name !== "tether-context" && (e?.type ?? "stdio") === "stdio" && e?.env && Object.keys(e.env).length) {
      // Started with its env or not at all: setMcpServers adds it.
      held = true;
    } else launch[name] = e;
  }
  return held ? { launch, full: servers } : { launch };
}

export const claudeConnector: Connector = {
  id: "claude-code",
  memory: {
    capability: () => cap("native", "Appended to the system prompt; also in ~/.claude/CLAUDE.md and project memory"),
    forSession: ({ context }) => (context?.prompt ? { options: { systemPrompt: { type: "preset", preset: "claude_code", append: context.prompt } } } : undefined),
    globalBlock: (globalFile) => [harness.claudeMd(), `@${tilde(globalFile)}`],
    exportRepos: claudeRepoFiles,
  },
  mcp: {
    capability: () => cap("native", "SDK MCP servers per session (secrets over stdin, not the command line); registry servers also written to ~/.claude.json on every change (tether-context on import)"),
    forSession: claudeMcp,
    sharedConfig: true,
    exportGlobal: (x) => registerClaudeMcp(x.out, (p) => x.remember(p)),
    importGlobal: () => claudeServers({ projects: true }),
    native: (projectPath) => claudeSessionServers(projectPath).found,
    deliver: () => ({ how: "session", note: "Per session (SDK MCP servers)" }),
    targets: () => [{ file: harness.claudeJson(), installed: claudeInstalled(), format: "json", key: "mcpServers", flavor: "claude" }],
  },
  skills: {
    capability: () => cap("native", "Runs skills as /name from ~/.claude/skills and .claude/skills"),
    invoke: invocationText,
    dirs: (projectPath) => [...repoDirs(projectPath, ".claude/skills"), { dir: harness.claudeSkills(), source: "claude" }],
    offline: true,
    installDirs: () => [{ harness: "claude", dir: harness.claudeSkills(), install: true, skip: ["synced"] }],
  },
  commands: slot("native", "Its own commands show in the / menu; Tether commands aren't mapped yet"),
  agents: slot("native", "Subagents (SDK agents, ~/.claude/agents); not mapped yet"),
  hooks: slot("native", "Your hooks run as SDK hook callbacks on every tool call, prompt and stop; the ones already in its own settings files run only there"),
  env: slot("native", "SDK env option; not mapped yet"),
  // Checked with Agent SDK 0.3.293 / Claude Code 2.1.296: its /goal is a slash command whose own
  // evaluator keeps the turn going; there is no call to pause it or read its status, so mirroring
  // would run two loops against each other.
  goal: slot("emulated", "Tether's goal loop and goal tools; Claude Code's own /goal (a slash command with no status or pause API) isn't used"),
  plan: slot("native", "Plan mode with its own review (ExitPlanMode), shown as Tether's plan card; plan_set also records the plan"),
  todos: slot("native", "Its TodoWrite list, kept as the session's todo list; todo_set also works"),
  ask_user: slot("native", "AskUserQuestion as a question card; ask_user (tether-context) also works"),
  // Agent SDK 0.3.293: CronCreate (durable only to .claude/scheduled_tasks.json, recurring ones
  // expire after 7 days) and ScheduleWakeup are tools of the running process, with no control API.
  schedules: slot("emulated", "Tether's /loop and /schedule, run by the runner; Claude Code's own crons and wakeups (CronCreate, ScheduleWakeup) stay as they are, show as activity and fire only while its process runs. Its own /loop and /schedule are replaced by Tether's"),
  // Agent SDK 0.3.293: forkSession(sessionId, { upToMessageId }) copies the transcript up to any entry.
  fork: slot("native", "Its own fork (forkSession) at any message, into Claude Code; into another harness, a new session on a brief"),
  compact: slot("native", "Its own /compact, focus included"),
  review: slot("emulated", "Tether's review session: without its edit tools (disallowedTools), Bash through the guard, findings through review_report"),
};
