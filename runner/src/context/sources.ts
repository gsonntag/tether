// Importers: every harness's own memory, read as candidate entries for the merge pass. Each
// source reports only what changed since its watermark (sources.json), and nothing here writes
// outside the store. Tether's own exports are never read back: managed blocks are stripped and
// Tether-owned files are skipped, so an export can't loop into an import.

import { Database } from "bun:sqlite";
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { outsideBlock } from "./blocks";
import { contentHash, parseMemory, slugify, splitFrontMatter, type Memory } from "./format";
import { harness, store as storePaths, tilde } from "./paths";
import { claudeDirCwd, isHome, repoKey } from "./repokey";
import type { Store } from "./store";

export type SourceHarness = "claude" | "codex" | "pi" | "opencode" | "kiro" | "gemini" | "antigravity" | "mcp";

export interface SourceEntry {
  /** watermark key */
  key: string;
  harness: SourceHarness;
  path: string;
  /** recorded in the memory's `sources` */
  provenance: string;
  title: string;
  text: string;
  /** fields the source already has (Claude memory files are fully structured) */
  memory?: Partial<Memory>;
  /** "global" / "repo:<key>"; undefined when the source doesn't say (the merge model decides) */
  scope?: string;
  /** the repo a scope-less entry would belong to, if any */
  repoHint?: string;
  hash: string;
  /** the Tether session that wrote it (MCP memory_write) */
  sessionId?: string;
  /** that session's guard key, when the harness hadn't assigned an id yet */
  sessionKey?: string;
  /** inbox file to delete once merged */
  consume?: string;
}

export interface ScanResult {
  entries: SourceEntry[];
  warnings: string[];
}

/** Files Tether writes into harness dirs; never imported. */
export const OWN_FILES = new Set(["tether.md"]);

/** Claude Code's throwaway scratchpad sessions (/tmp/claude-<uid>/…). */
export const isScratch = (cwd: string) => /^\/tmp\/claude-\d+(\/|$)/.test(cwd);

const read = (p: string) => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return undefined;
  }
};

const isDir = (p: string) => statSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false;
const ls = (p: string) => {
  try {
    return readdirSync(p).sort();
  } catch {
    return [];
  }
};

/** Markdown split at `#`/`##` headings; sections without a body are dropped. Import lines (`@path`) are skipped. */
export function sections(text: string): { title: string; body: string }[] {
  const out: { title: string; lines: string[] }[] = [{ title: "", lines: [] }];
  let fence = false;
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const h = !fence && /^(#{1,2})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) out.push({ title: h[2]!, lines: [] });
    else if (!/^\s*@\S+\s*$/.test(line) || fence) out[out.length - 1]!.lines.push(line);
  }
  return out.map((s) => ({ title: s.title, body: s.lines.join("\n").trim() })).filter((s) => s.body);
}

function markdownEntries(h: SourceHarness, path: string, text: string, scope: string | undefined, label: string): SourceEntry[] {
  const used = new Set<string>();
  return sections(text).map((s, i) => {
    let id = slugify(s.title) ?? `part-${i + 1}`;
    while (used.has(id)) id += "-x";
    used.add(id);
    const body = s.title ? `## ${s.title}\n\n${s.body}` : s.body;
    return {
      key: `${path}#${id}`,
      harness: h,
      path,
      provenance: `${h}:${tilde(path)}#${id}`,
      title: s.title || `${label} (${basename(path)})`,
      text: body,
      memory: { name: slugify(s.title) ?? undefined, description: s.title || undefined, body: s.body },
      scope,
      hash: contentHash(body),
    };
  });
}

/** Global markdown memory files (outside Tether's managed block). */
function globalFiles(): [SourceHarness, string][] {
  return [
    ["claude", harness.claudeMd()],
    ["codex", harness.codexAgentsMd()],
    ["pi", harness.piAgentsMd()],
    ["opencode", harness.opencodeAgentsMd()],
    ["gemini", harness.geminiMd()],
  ];
}

async function claudeMemory(warnings: string[]): Promise<SourceEntry[]> {
  const out: SourceEntry[] = [];
  const root = harness.claudeProjects();
  for (const d of ls(root)) {
    const memDir = join(root, d, "memory");
    if (!isDir(memDir)) continue;
    const cwd = claudeDirCwd(join(root, d));
    if (isScratch(cwd)) continue;
    let scope: string;
    try {
      scope = isHome(cwd) ? "global" : `repo:${await repoKey(cwd)}`;
    } catch (e: any) {
      warnings.push(`${tilde(memDir)}: ${e?.message ?? e}`);
      continue;
    }
    for (const f of ls(memDir)) {
      if (!f.endsWith(".md") || f === "MEMORY.md" || OWN_FILES.has(f)) continue;
      const p = join(memDir, f);
      const text = read(p);
      if (!text?.trim()) continue;
      const m = parseMemory(text, { name: f.slice(0, -3) });
      out.push({
        key: p,
        harness: "claude",
        path: p,
        provenance: `claude:${tilde(p)}`,
        title: m.description || m.name,
        text,
        memory: { name: m.name, description: m.description, type: m.type, body: m.body },
        scope,
        hash: contentHash(text),
      });
    }
  }
  return out;
}

function mdFilesUnder(dir: string, depth = 3): string[] {
  if (depth < 0) return [];
  const out: string[] = [];
  for (const n of ls(dir)) {
    if (n.startsWith(".")) continue;
    const p = join(dir, n);
    if (isDir(p)) out.push(...mdFilesUnder(p, depth - 1));
    else if (n.endsWith(".md") && !OWN_FILES.has(n)) out.push(p);
  }
  return out;
}

function codexDb(warnings: string[]): SourceEntry[] {
  const path = harness.codexMemoriesDb();
  if (!existsSync(path)) return [];
  let db: Database | undefined;
  try {
    // Read-only, and never create anything: the schema is Codex's and undocumented.
    db = new Database(path, { readonly: true, create: false });
    const cols = (db.query(`PRAGMA table_info(stage1_outputs)`).all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes("raw_memory")) return [];
    const idCol = cols.includes("thread_id") ? "thread_id" : "rowid";
    const at = cols.includes("source_updated_at") ? "source_updated_at" : "0";
    const summary = cols.includes("rollout_summary") ? "rollout_summary" : "''";
    const rows = db.query(`SELECT ${idCol} AS id, raw_memory AS raw, ${summary} AS summary, ${at} AS at FROM stage1_outputs ORDER BY ${at} ASC LIMIT 2000`).all() as any[];
    return rows
      .filter((r) => typeof r.raw === "string" && r.raw.trim())
      .map((r) => {
        const text = String(r.raw).trim();
        const title = String(r.summary ?? "").split("\n")[0]?.slice(0, 120) || `Codex memory ${r.id}`;
        return {
          key: `${path}#${r.id}`,
          harness: "codex" as const,
          path,
          provenance: `codex:memories#${r.id}`,
          title,
          text,
          hash: contentHash(text),
        };
      });
  } catch (e: any) {
    warnings.push(`${tilde(path)}: ${e?.message ?? e}`);
    return [];
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

/** Pending `memory_write` calls from MCP servers. */
export function inboxEntries(inboxDir = storePaths.inbox()): SourceEntry[] {
  const out: SourceEntry[] = [];
  for (const f of ls(inboxDir)) {
    if (!f.endsWith(".json")) continue;
    const p = join(inboxDir, f);
    try {
      const w = JSON.parse(readFileSync(p, "utf8"));
      const text = String(w.text ?? "").trim();
      if (!text) {
        rmSync(p, { force: true });
        continue;
      }
      const scope = w.scope === "global" || (typeof w.scope === "string" && w.scope.startsWith("repo:")) ? w.scope : undefined;
      out.push({
        key: `inbox:${f}`,
        harness: "mcp",
        path: p,
        provenance: w.sessionId ? `mcp:${w.sessionId}` : "mcp",
        title: text.split("\n")[0]!.slice(0, 120),
        text,
        memory: { type: w.type, name: w.name },
        scope,
        repoHint: typeof w.repo === "string" ? w.repo : undefined,
        hash: contentHash(text),
        sessionId: typeof w.sessionId === "string" ? w.sessionId : undefined,
        sessionKey: typeof w.sessionKey === "string" ? w.sessionKey : undefined,
        consume: p,
      });
    } catch {}
  }
  return out;
}

/**
 * Everything every source currently holds. `changedOnly` drops entries whose content matches
 * their watermark (the normal, incremental case).
 */
export async function scanSources(st: Store | undefined, opts: { changedOnly?: boolean } = {}): Promise<ScanResult> {
  const warnings: string[] = [];
  const entries: SourceEntry[] = [];
  entries.push(...(await claudeMemory(warnings)));
  for (const [h, p] of globalFiles()) {
    const text = read(p);
    if (text) entries.push(...markdownEntries(h, p, outsideBlock(text), "global", `${h} global instructions`));
  }
  for (const p of mdFilesUnder(harness.codexMemories())) {
    const text = read(p);
    if (text) entries.push(...markdownEntries("codex", p, splitFrontMatter(text).body, undefined, "Codex memory"));
  }
  entries.push(...codexDb(warnings));
  for (const f of ls(harness.kiroSteering())) {
    if (!f.endsWith(".md") || OWN_FILES.has(f)) continue;
    const p = join(harness.kiroSteering(), f);
    const text = read(p);
    if (text) entries.push(...markdownEntries("kiro", p, splitFrontMatter(text).body, "global", `Kiro steering ${f}`));
  }
  for (const p of mdFilesUnder(harness.agyKnowledge())) {
    const text = read(p);
    if (text) entries.push(...markdownEntries("antigravity", p, splitFrontMatter(text).body, undefined, "Antigravity knowledge"));
  }
  if (st) entries.push(...inboxEntries(join(st.dir, "inbox")));
  if (!opts.changedOnly || !st) return { entries, warnings };
  const marks = st.watermarks();
  return { entries: entries.filter((e) => e.consume || marks[e.key]?.hash !== e.hash), warnings };
}

/** Directories (and files) to watch for changes. */
export function watchTargets(): string[] {
  const out = [harness.claudeProjects(), harness.codexMemories(), harness.kiroSteering(), harness.agyKnowledge()];
  for (const [, p] of globalFiles()) out.push(p);
  out.push(harness.codexMemoriesDb());
  for (const d of ls(harness.claudeProjects())) out.push(join(harness.claudeProjects(), d, "memory"));
  return out.filter((p) => existsSync(p));
}
