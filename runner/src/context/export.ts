// Export (native sync): the store back out to every harness's own files.
//   Claude      managed block in ~/.claude/CLAUDE.md with an @import of exports/global.md;
//               per repo, ~/.claude/projects/<dir>/memory/tether.md + one MEMORY.md index line
//   Gemini/agy  managed block with an @import in ~/.gemini/GEMINI.md
//   Codex, pi, opencode  managed block in their global AGENTS.md, digest inlined
//   Kiro        ~/.kiro/steering/tether.md (Tether's own file, inclusion: always)
//   MCP         `tether-context` registered in Codex, pi, Kiro and Antigravity MCP configs
// Only harnesses that are installed (their dir exists) are written. Every write is recorded in
// `ownWrites`, so the watcher can tell Tether's writes from the user's.
//
// Data safety: user files are only changed inside the managed block (or one MCP entry / one
// index line); a symlinked file is written through to its target with its mode kept; whole files
// are only overwritten or deleted when they carry Tether's mark; and the first time a file is
// touched its original is saved under exports/originals/, with whether it existed, so
// unexportAll() can put everything back.

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { MemoryEntry } from "../../../web/src/shared/protocol";
import { hasTomlBlock, isTetherOwned, OWNED_MARK, upsertBlock, upsertTomlBlock } from "./blocks";
import { contentHash } from "./format";
import { mcpLaunch } from "./launch";
import { harness, tilde } from "./paths";
import { claudeProjectScope } from "./repokey";
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

// ---------------- touched files (for undo) ----------------

interface Touched {
  existed: boolean;
  /** saved copy of the original, under exports/originals/ */
  original?: string;
  /** we created the directory too (Claude memory dirs) */
  createdDir?: boolean;
}

const stateFile = (store: Store) => join(store.dir, "exports", "touched.json");

function readTouched(store: Store): Record<string, Touched> {
  try {
    return JSON.parse(readFileSync(stateFile(store), "utf8"));
  } catch {
    return {};
  }
}

/** Records a harness file's original state the first time Tether is about to change it. */
function remember(store: Store, path: string, createdDir = false) {
  const all = readTouched(store);
  if (all[path]) return;
  const t: Touched = { existed: existsSync(path) };
  if (t.existed) {
    const dir = join(store.dir, "exports", "originals");
    mkdirSync(dir, { recursive: true });
    const copy = join(dir, createHash("sha256").update(path).digest("hex").slice(0, 16) + ".orig");
    copyFileSync(path, copy); // follows symlinks: the content the user had
    t.original = copy;
  }
  if (createdDir) t.createdDir = true;
  all[path] = t;
  writeAtomic(stateFile(store), JSON.stringify(all, null, 2));
}

/** Where a write to `path` should land: through a symlink (dotfiles) to its target. */
function writeTarget(path: string): string {
  try {
    return realpathSync(path);
  } catch {}
  try {
    // A dangling link: write where it points, keeping the link.
    return resolve(dirname(path), readlinkSync(path));
  } catch {}
  return path;
}

function writeHarness(path: string, text: string) {
  const target = writeTarget(path);
  let mode: number | undefined;
  try {
    mode = statSync(target).mode & 0o7777;
  } catch {}
  writeAtomic(target, text, mode);
}

function writeOwned(store: Store, path: string, text: string, out: ExportResult) {
  let cur: string | undefined;
  try {
    cur = readFileSync(path, "utf8");
  } catch {}
  if (cur === text) return;
  if (out.dryRun) {
    out.written.push(path);
    return;
  }
  if (!path.startsWith(store.dir + "/")) remember(store, path);
  ownWrites.set(path, contentHash(text));
  writeHarness(path, text);
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

/** The global AGENTS.md / CLAUDE.md / GEMINI.md files that get a managed block. */
function blockFiles(globalFile: string, text: string): [string, string][] {
  return [
    [harness.claudeMd(), `@${tilde(globalFile)}`],
    [harness.geminiMd(), `@${globalFile}`],
    [harness.codexAgentsMd(), text],
    [harness.piAgentsMd(), text],
    [harness.opencodeAgentsMd(), text],
  ];
}

function setBlock(store: Store, path: string, content: string, out: ExportResult) {
  if (!existsSync(dirname(path))) return; // harness not installed
  const cur = readText(path);
  writeOwned(store, path, upsertBlock(cur, content), out);
}

const jsonMcpFiles = () => [harness.piMcp(), harness.kiroMcp(), harness.agyMcp()];

/** JSON MCP configs (`{"mcpServers": {...}}`). Unparseable files are left alone. */
function registerJsonMcp(store: Store, path: string, out: ExportResult) {
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
  if (cfg.mcpServers !== undefined && (typeof cfg.mcpServers !== "object" || cfg.mcpServers === null || Array.isArray(cfg.mcpServers))) {
    out.warnings.push(`${tilde(path)} has an unexpected mcpServers; register tether-context there by hand.`);
    return;
  }
  const launch = mcpLaunch();
  const want = { command: launch.command, args: launch.args, env: launch.env };
  cfg.mcpServers ??= {};
  if (JSON.stringify(cfg.mcpServers["tether-context"]) === JSON.stringify(want)) {
    out.mcpConfigs.push(path);
    return;
  }
  cfg.mcpServers["tether-context"] = want;
  writeOwned(store, path, JSON.stringify(cfg, null, 2) + "\n", out);
  out.mcpConfigs.push(path);
}

function registerCodexMcp(store: Store, out: ExportResult) {
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
  writeOwned(store, path, upsertTomlBlock(cur, toml), out);
  out.mcpConfigs.push(path);
}

const INDEX_LINE = "- [Tether shared memory](tether.md) — repo facts shared by every agent (managed by Tether; edits are overwritten)";
const isIndexLine = (l: string) => l.trim() === INDEX_LINE || /^- \[Tether shared memory\]\(tether\.md\)/.test(l.trim());

const repoFile = (text: string) =>
  `---\nname: tether\ndescription: Shared repository memory from Tether (managed; edits are overwritten)\ntype: project\n${OWNED_MARK}\n---\n\n${text}`;

/** Removes our index line from a MEMORY.md, keeping every other byte. */
function withoutIndexLine(idx: string): string {
  return idx
    .split("\n")
    .filter((l) => !isIndexLine(l))
    .join("\n");
}

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
    if (!statSync(projectDir, { throwIfNoEntry: false })?.isDirectory()) continue;
    const scope = await claudeProjectScope(projectDir).catch(() => undefined);
    if (!scope || scope.kind !== "repo") continue;
    const memDir = join(projectDir, "memory");
    const file = join(memDir, "tether.md");
    const index = join(memDir, "MEMORY.md");
    const existing = existsSync(file) || isLinkish(file) ? readText(file) : undefined;
    if (existing !== undefined && !isTetherOwned(existing)) {
      out.warnings.push(`${tilde(file)} is the user's own memory, not Tether's; left alone (repo memory reaches Claude there through MCP only).`);
      continue;
    }
    const text = keys.has(scope.key) ? repoDigest(store, scope.key) : undefined;
    if (!text) {
      if (existing !== undefined && !out.dryRun) {
        remember(store, file);
        rmSync(file, { force: true });
        out.written.push(file);
      }
      const idx = readText(index);
      if (idx.split("\n").some(isIndexLine)) writeOwned(store, index, withoutIndexLine(idx), out);
      continue;
    }
    if (!out.dryRun && !existsSync(memDir)) {
      remember(store, file, true);
      mkdirSync(memDir, { recursive: true });
    }
    writeOwned(store, file, repoFile(text), out);
    const idx = readText(index);
    if (!idx.split("\n").some(isIndexLine)) writeOwned(store, index, (idx.trim() ? idx.replace(/\n*$/, "\n") : "") + INDEX_LINE + "\n", out);
  }
}

const isLinkish = (p: string) => {
  try {
    return !!readlinkSync(p);
  } catch {
    return false;
  }
};

const kiroFile = () => join(harness.kiroSteering(), "tether.md");
/** Ours: the mark, or (exports before the mark) exactly the shape we used to write. */
const isKiroOwned = (text: string) => isTetherOwned(text) || /^---\ninclusion: always\n---\n\n# Shared memory \(Tether\)\n/.test(text);

/** Writes every export. With `dryRun`, lists the files it would change instead. */
export async function exportAll(store: Store, opts: { dryRun?: boolean } = {}): Promise<ExportResult> {
  const out: ExportResult = { dryRun: opts.dryRun, written: [], mcpConfigs: [], warnings: [] };
  const text = globalDigest(store);
  const globalFile = join(store.dir, "exports", "global.md");
  writeOwned(store, globalFile, text, out);
  out.written = out.written.filter((p) => p !== globalFile); // the store's own file isn't news
  for (const [p, content] of blockFiles(globalFile, text)) setBlock(store, p, content, out);
  if (existsSync(dirname(harness.kiroSteering()))) {
    const cur = existsSync(kiroFile()) ? readText(kiroFile()) : undefined;
    if (cur !== undefined && !isKiroOwned(cur)) out.warnings.push(`${tilde(kiroFile())} is the user's own; left alone.`);
    else {
      if (!opts.dryRun) mkdirSync(harness.kiroSteering(), { recursive: true });
      writeOwned(store, kiroFile(), `---\ninclusion: always\n${OWNED_MARK}\n---\n\n${text}`, out);
    }
  }
  await claudeRepoFiles(store, out);
  registerCodexMcp(store, out);
  for (const p of jsonMcpFiles()) registerJsonMcp(store, p, out);
  return out;
}

// ---------------- undo ----------------

/** Puts a file back: its saved original when the undone text matches it semantically, else `text`. */
function putBack(path: string, text: string, t: Touched | undefined, same: (orig: string) => boolean) {
  if (t && !t.existed && !text.trim()) {
    rmSync(writeTarget(path), { force: true });
    return;
  }
  if (t?.original) {
    try {
      const orig = readFileSync(t.original, "utf8");
      if (same(orig)) {
        writeHarness(path, orig);
        return;
      }
    } catch {}
  }
  writeHarness(path, text);
}

/**
 * Undoes every export (turning the master context off): managed blocks, MCP registrations, Claude
 * per-repo files and index lines, Kiro's steering file. The user's text is left as it is now,
 * minus what Tether added; files Tether created are removed when nothing else is in them.
 */
export async function unexportAll(store: Store): Promise<{ changed: string[]; warnings: string[] }> {
  const touched = readTouched(store);
  const changed: string[] = [];
  const warnings: string[] = [];
  const attempt = (path: string, fn: () => boolean) => {
    try {
      if (fn()) {
        changed.push(path);
        ownWrites.delete(path);
      }
    } catch (e: any) {
      warnings.push(`${tilde(path)}: ${e?.code ?? e?.message ?? e}`);
    }
  };
  for (const [p] of blockFiles(join(store.dir, "exports", "global.md"), "")) {
    attempt(p, () => {
      if (!existsSync(p)) return false;
      const cur = readText(p);
      const next = upsertBlock(cur, undefined);
      if (next === cur) return false;
      putBack(p, next, touched[p], (orig) => orig === next || orig.replace(/\n$/, "") === next.replace(/\n$/, ""));
      return true;
    });
  }
  attempt(harness.codexConfig(), () => {
    const p = harness.codexConfig();
    const cur = readText(p);
    if (!hasTomlBlock(cur)) return false;
    const next = upsertTomlBlock(cur, undefined);
    putBack(p, next, touched[p], (orig) => orig.replace(/\n+$/, "") === next.replace(/\n+$/, ""));
    return true;
  });
  for (const p of jsonMcpFiles()) {
    attempt(p, () => {
      const raw = readText(p);
      if (!raw.trim()) return false;
      const cfg = JSON.parse(raw);
      if (!cfg?.mcpServers?.["tether-context"]) return false;
      delete cfg.mcpServers["tether-context"];
      const t = touched[p];
      let origCfg: any;
      try {
        const o = t?.original ? readFileSync(t.original, "utf8") : undefined;
        origCfg = o === undefined ? undefined : o.trim() ? JSON.parse(o) : {};
      } catch {}
      if (!Object.keys(cfg.mcpServers).length && !(origCfg && typeof origCfg === "object" && "mcpServers" in origCfg)) delete cfg.mcpServers;
      putBack(p, Object.keys(cfg).length ? JSON.stringify(cfg, null, 2) + "\n" : "", t, (orig) => {
        try {
          return JSON.stringify(orig.trim() ? JSON.parse(orig) : {}) === JSON.stringify(cfg);
        } catch {
          return false;
        }
      });
      return true;
    });
  }
  attempt(kiroFile(), () => {
    if (!existsSync(kiroFile()) || !isKiroOwned(readText(kiroFile()))) return false;
    rmSync(kiroFile(), { force: true });
    return true;
  });
  let dirs: string[] = [];
  try {
    dirs = readdirSync(harness.claudeProjects());
  } catch {}
  for (const d of dirs) {
    const memDir = join(harness.claudeProjects(), d, "memory");
    const file = join(memDir, "tether.md");
    const index = join(memDir, "MEMORY.md");
    attempt(file, () => {
      if (!isTetherOwned(readText(file))) return false;
      rmSync(file, { force: true });
      return true;
    });
    attempt(index, () => {
      const idx = readText(index);
      if (!idx.split("\n").some(isIndexLine)) return false;
      const next = withoutIndexLine(idx);
      putBack(index, next, touched[index], (orig) => orig === next);
      return true;
    });
    if (touched[file]?.createdDir) {
      try {
        if (!readdirSync(memDir).length) rmdirSync(memDir);
      } catch {}
    }
  }
  try {
    rmSync(stateFile(store), { force: true });
  } catch {}
  return { changed, warnings };
}
