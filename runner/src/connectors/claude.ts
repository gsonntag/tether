// Claude Code (Agent SDK): memory in the system prompt (append) and ~/.claude/CLAUDE.md plus its
// per-project memory dirs; `tether-context` as an SDK MCP server and, on the user's import, in
// ~/.claude.json; skills in ~/.claude/skills, run as `/name`.

import { existsSync, mkdirSync, readdirSync, readlinkSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { invocationText } from "../../../web/src/shared/skill";
import { isTetherOwned, OWNED_MARK } from "../context/blocks";
import { claudeInstalled, registerClaudeMcp } from "../context/globalMcp";
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
  if (context) mcpServers["tether-context"] = { type: "stdio" as const, ...context.mcp };
  return Object.keys(mcpServers).length ? { options: { mcpServers } } : undefined;
}

/**
 * The SDK passes `mcpServers` to the claude process as `--mcp-config <json>` on its command line,
 * which any local user can read (ps, /proc/<pid>/cmdline). So a launch gets the http/SSE servers
 * without their headers (an OAuth token, a pasted key), and `full` (when any were held back) is the set to hand over
 * with setMcpServers, which goes over the SDK's stdin control channel, before the first message.
 */
export function argvSafeMcp(servers: Record<string, any>): { launch: Record<string, any>; full?: Record<string, any> } {
  let held = false;
  const launch: Record<string, any> = {};
  for (const [name, e] of Object.entries(servers)) {
    if ((e?.type === "http" || e?.type === "sse") && e.headers && Object.keys(e.headers).length) {
      const { headers: _, ...bare } = e;
      launch[name] = bare;
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
    capability: () => cap("native", "SDK MCP servers per session; ~/.claude.json on import"),
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
  hooks: slot("native", "Hooks in settings and the SDK; not mapped yet"),
  env: slot("native", "SDK env option; not mapped yet"),
  // Checked with Agent SDK 0.3.293 / Claude Code 2.1.296: its /goal is a slash command whose own
  // evaluator keeps the turn going; there is no call to pause it or read its status, so mirroring
  // would run two loops against each other.
  goal: slot("emulated", "Tether's goal loop and goal tools; Claude Code's own /goal (a slash command with no status or pause API) isn't used"),
};
