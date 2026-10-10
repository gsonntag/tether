// Export (native sync): the store back out to every harness's own files.
//   Claude      managed block in ~/.claude/CLAUDE.md with an @import of exports/global.md;
//               per repo, ~/.claude/projects/<dir>/memory/tether.md + one MEMORY.md index line
//   Gemini/agy  managed block with an @import in ~/.gemini/GEMINI.md
//   Codex, pi, opencode  managed block in their global AGENTS.md, digest inlined
//   Kiro        ~/.kiro/steering/tether.md (Tether's own file, inclusion: always)
//   MCP         `tether-context` registered in Codex, pi, Kiro and Antigravity MCP configs
// Only harnesses that are installed (their dir exists) are written. Every write is recorded in
// `ownWrites`, so the watcher can tell Tether's writes from the user's.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { MemoryEntry } from "../../../web/src/shared/protocol";
import { upsertBlock, upsertTomlBlock } from "./blocks";
import { contentHash } from "./format";
import { mcpLaunch } from "./launch";
import { harness, tilde } from "./paths";
import { claudeDirCwd, isHome, repoKey } from "./repokey";
import { isScratch } from "./sources";
import { writeAtomic, type Store } from "./store";

const GLOBAL_BUDGET = 4000;
const REPO_BUDGET = 8000;

/** path → content hash of what Tether last wrote there. */
export const ownWrites = new Map<string, string>();

/** True when the file still holds exactly what Tether wrote (a watcher event we caused). */
export function isOwnWrite(path: string): boolean {
  const h = ownWrites.get(path);
  if (!h) return false;
  try {
    return contentHash(readFileSync(path, "utf8")) === h;
  } catch {
    return false;
  }
}

function writeOwned(path: string, text: string, out: ExportResult) {
  let cur: string | undefined;
  try {
    cur = readFileSync(path, "utf8");
  } catch {}
  if (cur === text) return;
  if (out.dryRun) {
    out.written.push(path);
    return;
  }
  ownWrites.set(path, contentHash(text));
  writeAtomic(path, text);
  out.written.push(path);
}

const line = (m: MemoryEntry) => `- **${m.name}**: ${m.description}`;

/**
 * A compact digest: user and feedback entries in full, project and reference entries as a one-line
 * index. Full entries collapse to index lines (oldest first) until it fits `budget` bytes.
 */
export function digest(entries: MemoryEntry[], title: string, budget: number, footer?: string): string {
  const full = entries.filter((m) => m.type === "user" || m.type === "feedback");
  const index = entries.filter((m) => m.type !== "user" && m.type !== "feedback");
  const render = (fullList: MemoryEntry[], indexList: MemoryEntry[], more = 0) => {
    const parts = [`# ${title}`];
    if (fullList.length) parts.push(fullList.map((m) => `## ${m.name}\n${m.body.trim()}`).join("\n\n"));
    if (indexList.length || more) parts.push(`## Index\n${[...indexList.map(line), ...(more ? [`- …and ${more} more (memory_search)`] : [])].join("\n")}`);
    if (footer) parts.push(footer);
    return parts.join("\n\n") + "\n";
  };
  let f = [...full].sort((a, b) => b.updated.localeCompare(a.updated));
  let i = [...index].sort((a, b) => b.updated.localeCompare(a.updated));
  let text = render(f, i);
  while (Buffer.byteLength(text) > budget && f.length) {
    i = [f[f.length - 1]!, ...i];
    f = f.slice(0, -1);
    text = render(f, i);
  }
  let more = 0;
  while (Buffer.byteLength(text) > budget && i.length) {
    i = i.slice(0, -1);
    text = render(f, i, ++more);
  }
  return text;
}

const MCP_HINT = "More memory, per-repo facts and the skill library: the `tether-context` MCP tools (memory_search, memory_get, memory_write, skill_list, skill_get).";

export function globalDigest(store: Store): string {
  return digest(
    store.list().filter((m) => m.scope === "global"),
    "Shared memory (Tether)",
    GLOBAL_BUDGET,
    MCP_HINT,
  );
}

export function repoDigest(store: Store, key: string): string | undefined {
  const list = store.list().filter((m) => m.scope === `repo:${key}`);
  if (!list.length) return undefined;
  // In a repo every entry matters: full bodies, newest first, until the budget.
  const sorted = [...list].sort((a, b) => b.updated.localeCompare(a.updated));
  const parts = [`# Repository memory (Tether): ${key}`];
  let size = parts[0]!.length;
  const rest: MemoryEntry[] = [];
  for (const m of sorted) {
    const block = `## ${m.name}\n${m.body.trim()}`;
    if (size + block.length > REPO_BUDGET) rest.push(m);
    else {
      parts.push(block);
      size += block.length + 2;
    }
  }
  if (rest.length) parts.push(`## More\n${rest.map(line).join("\n")}`);
  return parts.join("\n\n") + "\n";
}

export interface ExportResult {
  dryRun?: boolean;
  written: string[];
  mcpConfigs: string[];
  warnings: string[];
}

function readText(p: string): string {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

function setBlock(path: string, content: string, out: ExportResult) {
  if (!existsSync(dirname(path))) return; // harness not installed
  const cur = readText(path);
  writeOwned(path, upsertBlock(cur, content), out);
}

/** JSON MCP configs (`{"mcpServers": {...}}`). Unparseable files are left alone. */
function registerJsonMcp(path: string, out: ExportResult) {
  if (!existsSync(dirname(path))) return;
  const raw = readText(path);
  let cfg: any = {};
  if (raw.trim()) {
    try {
      cfg = JSON.parse(raw);
    } catch {
      out.warnings.push(`${tilde(path)} isn't plain JSON; register tether-context there by hand.`);
      return;
    }
  }
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return;
  const launch = mcpLaunch();
  const want = { command: launch.command, args: launch.args, env: launch.env };
  cfg.mcpServers ??= {};
  if (JSON.stringify(cfg.mcpServers["tether-context"]) === JSON.stringify(want)) {
    out.mcpConfigs.push(path);
    return;
  }
  cfg.mcpServers["tether-context"] = want;
  writeOwned(path, JSON.stringify(cfg, null, 2) + "\n", out);
  out.mcpConfigs.push(path);
}

function registerCodexMcp(out: ExportResult) {
  const path = harness.codexConfig();
  if (!existsSync(dirname(path))) return;
  const cur = readText(path);
  if (/^\s*\[mcp_servers\.("?)tether-context\1\]/m.test(cur.replace(/# tether:begin[\s\S]*?# tether:end/, ""))) {
    out.mcpConfigs.push(path); // the user registered it themselves
    return;
  }
  const l = mcpLaunch();
  const toml = [
    `[mcp_servers.tether-context]`,
    `command = ${JSON.stringify(l.command)}`,
    `args = [${l.args.map((a) => JSON.stringify(a)).join(", ")}]`,
    `default_tools_approval_mode = "approve"`,
    `[mcp_servers.tether-context.env]`,
    ...Object.entries(l.env).map(([k, v]) => `${k} = ${JSON.stringify(v)}`),
  ].join("\n");
  writeOwned(path, upsertTomlBlock(cur, toml), out);
  out.mcpConfigs.push(path);
}

const INDEX_LINE = "- [Tether shared memory](tether.md) — repo facts shared by every agent (managed by Tether; edits are overwritten)";

/** Claude's own per-project memory: a Tether-owned tether.md plus one index line in MEMORY.md. */
async function claudeRepoFiles(store: Store, out: ExportResult) {
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
    const cwd = claudeDirCwd(projectDir);
    if (isHome(cwd) || isScratch(cwd)) continue;
    const memDir = join(projectDir, "memory");
    const file = join(memDir, "tether.md");
    const index = join(memDir, "MEMORY.md");
    const key = await repoKey(cwd).catch(() => undefined);
    const text = key && keys.has(key) ? repoDigest(store, key) : undefined;
    if (!text) {
      if (existsSync(file) && !out.dryRun) {
        rmSync(file, { force: true });
        const idx = readText(index);
        if (idx.includes("(tether.md)")) writeOwned(index, idx.split("\n").filter((l) => !l.includes("(tether.md)")).join("\n"), out);
      }
      continue;
    }
    if (!out.dryRun) mkdirSync(memDir, { recursive: true });
    writeOwned(file, `---\nname: tether\ndescription: Shared repository memory from Tether (managed; edits are overwritten)\ntype: project\n---\n\n${text}`, out);
    const idx = readText(index);
    if (!idx.includes("(tether.md)")) writeOwned(index, (idx.trim() ? idx.replace(/\n*$/, "\n") : "") + INDEX_LINE + "\n", out);
  }
}

/** Writes every export. With `dryRun`, lists the files it would change instead. */
export async function exportAll(store: Store, opts: { dryRun?: boolean } = {}): Promise<ExportResult> {
  const out: ExportResult = { dryRun: opts.dryRun, written: [], mcpConfigs: [], warnings: [] };
  const text = globalDigest(store);
  const globalFile = join(store.dir, "exports", "global.md");
  writeOwned(globalFile, text, out);
  out.written = out.written.filter((p) => p !== globalFile); // the store's own file isn't news
  setBlock(harness.claudeMd(), `@${tilde(globalFile)}`, out);
  setBlock(harness.geminiMd(), `@${globalFile}`, out);
  for (const p of [harness.codexAgentsMd(), harness.piAgentsMd(), harness.opencodeAgentsMd()]) setBlock(p, text, out);
  if (existsSync(dirname(harness.kiroSteering()))) {
    if (!opts.dryRun) mkdirSync(harness.kiroSteering(), { recursive: true });
    writeOwned(join(harness.kiroSteering(), "tether.md"), `---\ninclusion: always\n---\n\n${text}`, out);
  }
  await claudeRepoFiles(store, out);
  registerCodexMcp(out);
  for (const p of [harness.piMcp(), harness.kiroMcp(), harness.agyMcp()]) registerJsonMcp(p, out);
  return out;
}
