// Export (native sync): the store back out to every harness's own files.
//   Claude      managed block in ~/.claude/CLAUDE.md with an @import of exports/global.md;
//               per repo, ~/.claude/projects/<dir>/memory/tether.md + one MEMORY.md index line
//   Gemini/agy  managed block with an @import in ~/.gemini/GEMINI.md
//   Codex, pi, opencode  managed block in their global AGENTS.md, digest inlined
//   Kiro        ~/.kiro/steering/tether.md (Tether's own file, inclusion: always)
//   MCP         `tether-context` registered in Codex, pi, Kiro and Antigravity MCP configs; on the
//               user's import also in ~/.claude.json and opencode's config (globalMcp.ts)
// What each harness gets is its connector's (runner/src/connectors/): this file runs them in a
// fixed order with the shared write helpers below, and undoes everything. Only harnesses that are
// installed (their dir exists) are written. Every write is recorded in `ownWrites`, so the watcher
// can tell Tether's writes from the user's.
//
// Data safety: user files are only changed inside the managed block (or one MCP entry / one
// index line); a symlinked file is written through to its target with its mode kept; whole files
// are only overwritten or deleted when they carry Tether's mark; and the first time a file is
// touched its original is saved under exports/originals/, with whether it existed, so
// unexportAll() can put everything back.

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { HarnessId, MemoryEntry } from "../../../web/src/shared/protocol";
import { connectorFor } from "../connectors";
import { isIndexLine, withoutIndexLine } from "../connectors/claude";
import { isKiroOwned, kiroFile } from "../connectors/acp";
import type { ExportContext } from "../connectors/types";
import { hasTomlBlock, isTetherOwned, upsertBlock, upsertTomlBlock } from "./blocks";
import { contentHash } from "./format";
import { isOurs, unregisterGlobalMcp } from "./globalMcp";
import { mcpLaunch } from "./launch";
import { harness, tilde } from "./paths";
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

/** What a digest rendered: the text, the entries shown in full and those listed as index lines. */
export interface DigestLayout {
  text: string;
  full: MemoryEntry[];
  index: MemoryEntry[];
}

/**
 * A compact digest: user and feedback entries in full, project and reference entries as a one-line
 * index. Full entries collapse to index lines (oldest first) until it fits `budget` bytes.
 */
export function digestLayout(entries: MemoryEntry[], title: string, budget: number, footer?: string): DigestLayout {
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
  return { text, full: f, index: i };
}

export function digest(entries: MemoryEntry[], title: string, budget: number, footer?: string): string {
  return digestLayout(entries, title, budget, footer).text;
}

const MCP_HINT = "More memory, per-repo facts and the skill library: the `tether-context` MCP tools (memory_search, memory_get, memory_write, skill_list, skill_get).";

export function globalDigestLayout(store: Store, all = store.list()): DigestLayout {
  return digestLayout(
    all.filter((m) => m.scope === "global"),
    "Shared memory (Tether)",
    GLOBAL_BUDGET,
    MCP_HINT,
  );
}

export function globalDigest(store: Store): string {
  return globalDigestLayout(store).text;
}

export function repoDigestLayout(store: Store, key: string, all = store.list()): DigestLayout | undefined {
  const list = all.filter((m) => m.scope === `repo:${key}`);
  if (!list.length) return undefined;
  // In a repo every entry matters: full bodies, newest first, until the budget.
  const sorted = [...list].sort((a, b) => b.updated.localeCompare(a.updated));
  const parts = [`# Repository memory (Tether): ${key}`];
  let size = parts[0]!.length;
  const full: MemoryEntry[] = [];
  const rest: MemoryEntry[] = [];
  for (const m of sorted) {
    const block = `## ${m.name}\n${m.body.trim()}`;
    if (size + block.length > REPO_BUDGET) rest.push(m);
    else {
      parts.push(block);
      full.push(m);
      size += block.length + 2;
    }
  }
  if (rest.length) parts.push(`## More\n${rest.map(line).join("\n")}`);
  return { text: parts.join("\n\n") + "\n", full, index: rest };
}

export function repoDigest(store: Store, key: string): string | undefined {
  return repoDigestLayout(store, key)?.text;
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

/**
 * The order connectors export in (and the import preview lists files in): managed blocks, then
 * Tether's own memory files, then MCP registrations.
 */
const EXPORT_ORDER: { memory: HarnessId[]; mcp: HarnessId[] } = {
  memory: ["claude-code", "antigravity", "codex", "pi", "opencode", "kiro"],
  mcp: ["codex", "pi", "kiro", "antigravity", "claude-code", "opencode"],
};

/** The global AGENTS.md / CLAUDE.md / GEMINI.md files that get a managed block (memory connectors). */
function blockFiles(globalFile: string, text: string): [string, string][] {
  return EXPORT_ORDER.memory.flatMap((h) => {
    const b = connectorFor(h).memory.globalBlock?.(globalFile, text);
    return b ? [b] : [];
  });
}

function setBlock(store: Store, path: string, content: string, out: ExportResult) {
  if (!existsSync(dirname(path))) return; // harness not installed
  const cur = readText(path);
  writeOwned(store, path, upsertBlock(cur, content), out);
}

/** Everywhere a JSON registration (pi, Kiro, Antigravity) may have been written, Antigravity's old path included. */
const jsonMcpFiles = () => [harness.piMcp(), harness.kiroMcp(), harness.agyMcp(), harness.agyMcpLegacy()];

/** JSON MCP configs (`{"mcpServers": {...}}`). Unparseable files are left alone. */
function registerJsonMcp(store: Store, path: string, installed: string, out: ExportResult) {
  if (!existsSync(installed)) return;
  if (!existsSync(dirname(path))) {
    if (out.dryRun) {
      out.written.push(path);
      out.mcpConfigs.push(path);
      return;
    }
    mkdirSync(dirname(path), { recursive: true });
  }
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
  const cur = cfg.mcpServers["tether-context"];
  if (cur && !isOurs(cur)) {
    out.mcpConfigs.push(path); // the user's own entry under that name
    return;
  }
  if (JSON.stringify(cur) === JSON.stringify(want)) {
    out.mcpConfigs.push(path);
    return;
  }
  cfg.mcpServers["tether-context"] = want;
  writeOwned(store, path, JSON.stringify(cfg, null, 2) + "\n", out);
  out.mcpConfigs.push(path);
}

function exportContext(store: Store, out: ExportResult, globalFile: string, digest: string): ExportContext {
  return {
    store,
    out,
    globalFile,
    digest,
    readText,
    writeOwned: (path, text) => writeOwned(store, path, text, out),
    remember: (path, createdDir) => remember(store, path, createdDir),
    registerJsonMcp: (path, installed) => registerJsonMcp(store, path, installed, out),
    repoDigest: (key) => repoDigest(store, key),
  };
}

/** Each connector's global MCP registration; `shared`: only the configs the harness itself keeps writing. */
async function exportMcp(x: ExportContext, shared: boolean) {
  for (const h of EXPORT_ORDER.mcp) {
    const mcp = connectorFor(h).mcp;
    if (!!mcp.sharedConfig === shared) await mcp.exportGlobal?.(x);
  }
}

/**
 * `tether-context` in ~/.claude.json and opencode's global config, edited in place under the
 * harness's own file lock (globalMcp.ts); the original is snapshotted like every other export.
 */
export async function registerNativeMcp(store: Store, out: ExportResult) {
  await exportMcp(exportContext(store, out, join(store.dir, "exports", "global.md"), ""), true);
}

/** Writes every export. With `dryRun`, lists the files it would change instead. */
export async function exportAll(store: Store, opts: { dryRun?: boolean; globalMcp?: boolean } = {}): Promise<ExportResult> {
  const out: ExportResult = { dryRun: opts.dryRun, written: [], mcpConfigs: [], warnings: [] };
  const text = globalDigest(store);
  const globalFile = join(store.dir, "exports", "global.md");
  writeOwned(store, globalFile, text, out);
  out.written = out.written.filter((p) => p !== globalFile); // the store's own file isn't news
  const x = exportContext(store, out, globalFile, text);
  for (const [p, content] of blockFiles(globalFile, text)) setBlock(store, p, content, out);
  for (const h of EXPORT_ORDER.memory) await connectorFor(h).memory.exportGlobal?.(x);
  for (const h of EXPORT_ORDER.memory) await connectorFor(h).memory.exportRepos?.(x);
  await exportMcp(x, false);
  // Native Claude Code and opencode: their configs are shared with the running harness, so only
  // the user's own import registers there (opts.globalMcp), never a background re-export.
  if (opts.globalMcp) await exportMcp(x, true);
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
  // ~/.claude.json and opencode's config: our entry comes out in place (globalMcp.ts), never a
  // snapshot restore, since the harness has kept writing its own state there. A file Tether
  // created that is now empty again goes.
  const native = unregisterGlobalMcp();
  for (const p of native.written) {
    changed.push(p);
    const t = touched[p];
    try {
      if (t && !t.existed && /^\s*(\{\s*\})?\s*$/.test(readText(p))) rmSync(writeTarget(p), { force: true });
    } catch {}
  }
  warnings.push(...native.warnings);
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
