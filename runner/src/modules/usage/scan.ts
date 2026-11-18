// The usage module's reader (SPEC §10 Usage): finds the harnesses' store files, reads what's new in
// each and keeps per-file records, persisted so a restart reads only what changed. Store files are
// append-only: a file whose size and mtime haven't changed isn't opened, a grown one is read from where
// the last read stopped (the end of its last whole line: a line still being written waits), and one
// that shrank or whose first bytes changed (rotated, replaced) is read again from the start. Files
// untouched for longer than the records are kept aren't read at all. One file at a time, a chunk at a
// time, giving the event loop back after each, so sessions stay responsive during a first scan.
// Only lines whose start has a parser's marker are decoded; a line over LINE_MAX is skipped whole.
// Directories are walked by hand: a symlinked directory isn't followed (stores have none of their
// own, and a link can loop or reach the same files twice), and one that can't be read is an error
// counted in `errors`, not the end of its root.

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import type { HarnessId } from "../../../../shared/transcript";
import { HEAD, keyOf, lineParser, type FileState } from "./parse";

export interface UsageRoot {
  harness: HarnessId;
  dir: string;
  /** Codex: private CODEX_HOMEs (Tether's API-key threads) */
  private?: boolean;
}

/** How long records are kept: the op's longest range and a day either side for time zones. */
export const RETAIN_MS = 32 * 86_400_000;
const CHUNK = 4 * 1024 * 1024;
/** A line longer than this (a huge tool output) isn't held: it's skipped. */
export const LINE_MAX = 64 * 1024 * 1024;
const SAVE_MS = 15_000;
const VERSION = 2;

const pause = () => new Promise<void>((r) => setTimeout(r, 0));

/** Claude's session for a file: its own name, or for a subagent's file the session folder it's under. */
export function claudeSession(path: string): string {
  const parts = path.split(sep);
  const sub = parts.lastIndexOf("subagents");
  return sub > 0 ? parts[sub - 1]! : basename(path, ".jsonl");
}

const concat = (parts: Uint8Array[], len: number) => {
  const out = new Uint8Array(len);
  let at = 0;
  for (const p of parts) (out.set(p, at), (at += p.length));
  return out;
};

export class UsageScanner {
  readonly files = new Map<string, FileState>();
  progress = { files: 0, done: 0 };
  last?: { at: number; ms: number };
  /** directories and files that couldn't be read in the last scan */
  errors = 0;
  /** lines skipped as too long in the last scan */
  skipped = 0;
  private running?: Promise<void>;
  private saved = 0;
  private dirty = false;
  private stopped = false;
  private now: () => number;

  constructor(private o: { roots: () => UsageRoot[]; cacheFile?: string; now?: () => number; log?: (line: string) => void; chunk?: number; lineMax?: number }) {
    this.now = o.now ?? Date.now;
    this.load();
  }

  get scanning() { return !!this.running; }

  /** Reads what's new; one scan at a time (a second call joins the running one). */
  scan(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return (this.running ??= this.run().finally(() => (this.running = undefined)));
  }

  /** Stops a running scan at its next chunk; nothing is saved after this. */
  stop() { this.stopped = true; }

  private async run() {
    const started = performance.now();
    const now = this.now();
    const cutoff = now - RETAIN_MS;
    let errors = 0;
    this.skipped = 0;
    const list = await this.list(cutoff, () => errors++);
    const keep = new Set(list.map((f) => f.path));
    for (const path of this.files.keys()) if (!keep.has(path)) (this.files.delete(path), (this.dirty = true));
    this.progress = { files: list.length, done: 0 };
    this.saved = performance.now();
    let read = 0;
    for (const f of list) {
      if (this.stopped) return;
      const st = this.files.get(f.path);
      if (!st || st.size !== f.size || st.mtime !== f.mtime) {
        this.dirty = true;
        read++;
        try { await this.read(f); } catch (e: any) {
          if (this.stopped) return;
          errors++;
          this.files.delete(f.path);
          this.o.log?.(`couldn't read ${f.path}: ${e?.message ?? e}`);
        }
        if (performance.now() - this.saved > SAVE_MS) this.save(cutoff);
      }
      this.progress.done++;
    }
    if (this.stopped) return;
    if (this.errors !== errors) this.dirty = true;
    this.errors = errors;
    // Only a change is written: `last` on disk may be older, which costs a restart one quick scan.
    this.last = { at: now, ms: Math.round(performance.now() - started) };
    if (read) this.o.log?.(`read ${read} of ${list.length} files in ${this.last.ms} ms${errors ? `, ${errors} unreadable` : ""}`);
    this.save(cutoff);
  }

  /** The store files changed since `cutoff`, oldest first. */
  private async list(cutoff: number, error: () => void) {
    const out: { path: string; harness: HarnessId; private?: boolean; size: number; mtime: number }[] = [];
    let n = 0;
    const walk = async (root: UsageRoot, dir: string, top: boolean) => {
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); } catch (e: any) {
        // A root that isn't there is a harness that isn't used here.
        if (!(top && e?.code === "ENOENT")) (error(), this.o.log?.(`couldn't list ${dir}: ${e?.code ?? e}`));
        return;
      }
      for (const d of entries) {
        if (this.stopped) return;
        const path = join(dir, d.name);
        if (d.isDirectory()) await walk(root, path, false);
        else if (d.isFile() && d.name.endsWith(".jsonl") && (root.harness !== "codex" || d.name.startsWith("rollout-"))) {
          try {
            const s = await stat(path);
            if (s.mtimeMs >= cutoff) out.push({ path, harness: root.harness, ...(root.private ? { private: true } : {}), size: s.size, mtime: s.mtimeMs });
          } catch { error(); }
        }
        // Symlinks (to directories or files) aren't followed.
        if (++n % 500 === 0) await pause();
      }
    };
    for (const root of this.o.roots()) await walk(root, root.dir, true);
    return out.sort((a, b) => a.mtime - b.mtime);
  }

  private async read(f: { path: string; harness: HarnessId; private?: boolean; size: number; mtime: number }) {
    const fh = await open(f.path, "r");
    try {
      const headBuf = new Uint8Array(Math.min(256, f.size));
      await fh.read(headBuf, 0, headBuf.length, 0);
      const headOf = (len: number) => keyOf(new TextDecoder().decode(headBuf.subarray(0, len)));
      let st = this.files.get(f.path);
      if (!st || f.size < st.size || st.head !== headOf(st.headLen ?? 0) || st.harness !== f.harness) {
        st = { harness: f.harness, size: 0, mtime: 0, offset: 0, head: headOf(0), recs: [], ...(f.harness === "claude" ? { session: claudeSession(f.path) } : {}), ...(f.private ? { private: true } : {}) };
      }
      st.head = headOf(headBuf.length);
      st.headLen = headBuf.length;
      this.files.set(f.path, st);
      const { marks, parse } = lineParser(f.harness);
      const index = new Map(st.recs.map((r, i) => [r[0], i]));
      const decoder = new TextDecoder();
      const chunk = this.o.chunk ?? CHUNK;
      const lineMax = this.o.lineMax ?? LINE_MAX;
      const line = (bytes: Uint8Array) => {
        if (!bytes.length || !marks(decoder.decode(bytes.subarray(0, HEAD)))) return;
        parse(decoder.decode(bytes), st!, index);
      };
      let pos = st.offset;
      // The line being read across chunks, in pieces (joined once, when it ends), or skipped.
      let parts: Uint8Array[] = [];
      let partLen = 0;
      let skipping = false;
      while (pos < f.size) {
        if (this.stopped) throw new Error("stopped");
        const buf = new Uint8Array(Math.min(chunk, f.size - pos));
        const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
        if (!bytesRead) break;
        const base = pos;
        pos += bytesRead;
        let start = 0;
        for (;;) {
          const nl = buf.indexOf(10, start);
          if (nl < 0 || nl >= bytesRead) {
            if (!skipping && start < bytesRead) {
              parts.push(buf.slice(start, bytesRead));
              partLen += bytesRead - start;
              if (partLen > lineMax) (skipping = true), (parts = []), (partLen = 0), this.skipped++;
            }
            break;
          }
          if (!skipping) line(parts.length ? concat([...parts, buf.subarray(start, nl)], partLen + nl - start) : buf.subarray(start, nl));
          parts = [];
          partLen = 0;
          skipping = false;
          start = nl + 1;
          st.offset = base + start;
        }
        await pause();
      }
      // What's read is what was there when listed: a file still growing is read on from here next time.
      st.size = f.size;
      st.mtime = f.mtime;
    } finally {
      await fh.close();
    }
  }

  private load() {
    if (!this.o.cacheFile) return;
    try {
      const saved = JSON.parse(readFileSync(this.o.cacheFile, "utf8"));
      if (saved?.version !== VERSION || !saved.files || typeof saved.files !== "object") return;
      for (const [path, st] of Object.entries(saved.files) as [string, FileState][]) if (Array.isArray(st?.recs) && typeof st.offset === "number") this.files.set(path, st);
      if (saved.last) this.last = saved.last;
      if (typeof saved.errors === "number") this.errors = saved.errors;
    } catch {}
  }

  /** Writes the cache when something changed (records older than `cutoff` left out), atomically, private. Never after stop. */
  save(cutoff = this.now() - RETAIN_MS) {
    if (this.stopped) return;
    this.saved = performance.now();
    const since = cutoff / 1000;
    for (const st of this.files.values()) if (st.recs.some((r) => r[1] < since)) (st.recs = st.recs.filter((r) => r[1] >= since)), (st.last = undefined), (this.dirty = true);
    if (!this.o.cacheFile || !this.dirty) return;
    try {
      mkdirSync(dirname(this.o.cacheFile), { recursive: true, mode: 0o700 });
      const tmp = `${this.o.cacheFile}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: VERSION, last: this.last, errors: this.errors, files: Object.fromEntries(this.files) }), { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, this.o.cacheFile);
      this.dirty = false;
    } catch (e: any) {
      this.o.log?.(`couldn't save the usage cache: ${e?.message ?? e}`);
    }
  }
}
