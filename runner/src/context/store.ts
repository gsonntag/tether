// The master store: memory files, the skill library, and the bookkeeping beside them
// (watermarks, activity feed, conflicts). Memory and skills are committed; bookkeeping is not.

import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { ContextActivity, MemoryConflict, MemoryEntry } from "../../../web/src/shared/protocol";
import { contentHash, parseMemory, serializeMemory, similarity, slugify, words, type Memory } from "./format";
import { commit, ensureRepo, log, Mutex, patch, show } from "./git";
import { contextDir } from "./paths";
import { keyDir } from "./repokey";

/** Watermark per import source: path (or path#section, or db) → what was last imported. */
export interface Watermark {
  hash?: string;
  mtime?: number;
  /** sqlite sources: highest source_updated_at seen */
  cursor?: number;
}

export function scopeDir(scope: string): string {
  return scope.startsWith("repo:") ? `repos/${keyDir(scope.slice(5))}` : "global";
}

export function writeAtomic(path: string, text: string, mode?: number) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tether-tmp`;
  try {
    writeFileSync(tmp, text);
    if (mode !== undefined) chmodSync(tmp, mode);
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

let actCounter = 0;

export class Store {
  readonly dir: string;
  private lock = new Mutex();

  constructor(dir = contextDir()) {
    this.dir = dir;
  }

  get memoryDir() {
    return join(this.dir, "memory");
  }
  get skillsDir() {
    return join(this.dir, "skills");
  }

  async init() {
    // Only this runner commits here; a lock left by a crash would block every commit after it.
    const lock = join(this.dir, ".git", "index.lock");
    const st = statSync(lock, { throwIfNoEntry: false });
    if (st && Date.now() - st.mtimeMs > 60_000) rmSync(lock, { force: true });
    await ensureRepo(this.dir);
    for (const d of ["memory/global", "memory/repos", "skills", "inbox"]) mkdirSync(join(this.dir, d), { recursive: true });
  }

  exists() {
    return existsSync(join(this.dir, ".git"));
  }

  // ---------------- memory ----------------

  private file(id: string) {
    if (!/^(global|repos\/[A-Za-z0-9._-]+)\/[a-z0-9-]+$/.test(id)) throw new Error(`Bad memory id "${id}"`);
    return join(this.memoryDir, `${id}.md`);
  }

  list(): MemoryEntry[] {
    const out: MemoryEntry[] = [];
    const walk = (dir: string) => {
      let names: string[] = [];
      try {
        names = readdirSync(dir);
      } catch {
        return;
      }
      for (const n of names) {
        const p = join(dir, n);
        if (n.endsWith(".md")) {
          try {
            out.push(this.entry(relative(this.memoryDir, p).slice(0, -3), readFileSync(p, "utf8")));
          } catch {}
        } else if (!n.startsWith(".") && statSync(p, { throwIfNoEntry: false })?.isDirectory()) walk(p);
      }
    };
    walk(this.memoryDir);
    return out.sort((a, b) => b.updated.localeCompare(a.updated));
  }

  private entry(id: string, text: string): MemoryEntry {
    const slug = id.split("/").pop()!;
    const m = parseMemory(text, { name: slug, scope: id.startsWith("global/") ? "global" : undefined });
    return { id, slug, ...m };
  }

  get(id: string): MemoryEntry | undefined {
    const p = this.file(id);
    return existsSync(p) ? this.entry(id, readFileSync(p, "utf8")) : undefined;
  }

  /** A free id for a new entry in `scope`, based on its name. */
  newId(scope: string, name: string): string {
    const dir = scopeDir(scope);
    const base = slugify(name) ?? "memory";
    let id = `${dir}/${base}`;
    for (let i = 2; existsSync(join(this.memoryDir, `${id}.md`)); i++) id = `${dir}/${base}-${i}`;
    return id;
  }

  /** Writes (or with `memory` undefined, deletes) one entry and commits it. Returns the commit sha. */
  async put(id: string, memory: Memory | undefined, message: string): Promise<string | undefined> {
    const p = this.file(id);
    return this.lock.run(async () => {
      if (memory) writeAtomic(p, serializeMemory(memory));
      else rmSync(p, { force: true });
      return commit(this.dir, [relative(this.dir, p)], message);
    });
  }

  /** Commits arbitrary store paths (skills) in one go. */
  async commitPaths(paths: string[], message: string): Promise<string | undefined> {
    return this.lock.run(() => commit(this.dir, paths.map((p) => relative(this.dir, p)), message));
  }

  async history(id: string): Promise<{ sha: string; ts: number; message: string; patch: string }[]> {
    const rel = relative(this.dir, this.file(id));
    const entries = await log(this.dir, rel);
    return Promise.all(entries.map(async (e) => ({ ...e, patch: await patch(this.dir, e.sha, rel) })));
  }

  /** The entry as it was just before `sha` (undefined: it didn't exist yet). */
  async before(id: string, sha: string): Promise<string | undefined> {
    return show(this.dir, `${sha}^`, relative(this.dir, this.file(id)));
  }

  /** Raw file text, for "keep old". */
  async restore(id: string, text: string | undefined, message: string) {
    const p = this.file(id);
    return this.lock.run(async () => {
      if (text === undefined) rmSync(p, { force: true });
      else writeAtomic(p, text);
      return commit(this.dir, [relative(this.dir, p)], message);
    });
  }

  /** Ranked by word overlap with the query over name, description and body. */
  search(query: string, scopes?: string[], limit = 20): MemoryEntry[] {
    const q = words(query);
    const pool = this.list().filter((m) => !scopes || scopes.includes(m.scope));
    if (!q.size) return pool.slice(0, limit);
    const lower = query.toLowerCase().trim();
    return pool
      .map((m) => {
        const head = words(`${m.name} ${m.description}`);
        const all = words(`${m.name} ${m.description} ${m.body}`);
        const exact = `${m.name}\n${m.description}\n${m.body}`.toLowerCase().includes(lower) ? 1 : 0;
        return { m, score: similarity(q, head) * 2 + similarity(q, all) + exact };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => x.m);
  }

  findByHash(scope: string, body: string): MemoryEntry | undefined {
    const h = contentHash(body);
    return this.list().find((m) => m.scope === scope && contentHash(m.body) === h);
  }

  // ---------------- bookkeeping ----------------

  watermarks(): Record<string, Watermark> {
    return readJson(join(this.dir, "sources.json"), {});
  }

  setWatermark(key: string, w: Watermark | undefined) {
    const all = this.watermarks();
    if (w) all[key] = w;
    else delete all[key];
    writeAtomic(join(this.dir, "sources.json"), JSON.stringify(all, null, 2));
  }

  activity(act: Omit<ContextActivity, "id" | "ts"> & { ts?: number }): ContextActivity {
    const full: ContextActivity = { id: `a${Date.now().toString(36)}${(actCounter++).toString(36)}`, ts: Date.now(), ...act };
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(join(this.dir, "activity.jsonl"), JSON.stringify(full) + "\n");
    return full;
  }

  readActivity(limit = 100, before?: number): ContextActivity[] {
    let lines: string[] = [];
    try {
      lines = readFileSync(join(this.dir, "activity.jsonl"), "utf8").split("\n").filter(Boolean);
    } catch {}
    const out: ContextActivity[] = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      try {
        const a: ContextActivity = JSON.parse(lines[i]!);
        if (before === undefined || a.ts < before) out.push(a);
      } catch {}
    }
    return out;
  }

  conflicts(): MemoryConflict[] {
    return readJson(join(this.dir, "conflicts.json"), []);
  }

  saveConflicts(list: MemoryConflict[]) {
    writeAtomic(join(this.dir, "conflicts.json"), JSON.stringify(list.slice(-500), null, 2));
  }
}
