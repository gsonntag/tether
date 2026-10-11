// Claude Code (Agent SDK): memory in the system prompt (append) and ~/.claude/CLAUDE.md plus its
// per-project memory dirs; `tether-context` as an SDK MCP server and, on the user's import, in
// ~/.claude.json; skills in ~/.claude/skills, run as `/name`.

import { existsSync, mkdirSync, readdirSync, readlinkSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { invocationText } from "../../../web/src/shared/skill";
import { isTetherOwned, OWNED_MARK } from "../context/blocks";
import { registerClaudeMcp } from "../context/globalMcp";
import { harness, tilde } from "../context/paths";
import { claudeProjectScope } from "../context/repokey";
import { cap, repoDirs, slot } from "./shared";
import type { Connector, ExportContext } from "./types";

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

export const claudeConnector: Connector = {
  id: "claude-code",
  memory: {
    capability: () => cap("native", "Appended to the system prompt; also in ~/.claude/CLAUDE.md and project memory"),
    forSession: ({ context }) => (context ? { options: { systemPrompt: { type: "preset", preset: "claude_code", append: context.prompt } } } : undefined),
    globalBlock: (globalFile) => [harness.claudeMd(), `@${tilde(globalFile)}`],
    exportRepos: claudeRepoFiles,
  },
  mcp: {
    capability: () => cap("native", "SDK MCP servers per session; ~/.claude.json on import"),
    forSession: ({ context }) => (context ? { options: { mcpServers: { "tether-context": { type: "stdio" as const, ...context.mcp } } } } : undefined),
    sharedConfig: true,
    exportGlobal: (x) => registerClaudeMcp(x.out, (p) => x.remember(p)),
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
};
