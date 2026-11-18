// The usage module's reader (SPEC §10 Usage): finds the harnesses' store files, reads what's new in
// each and keeps per-file records, persisted so a restart reads only what changed. Store files are
// append-only: a file whose size and mtime haven't changed isn't opened, a grown one is read from where
// the last read stopped (the end of its last whole line: a line still being written waits), and one
// that shrank or whose first bytes changed (rotated, replaced) is read again from the start. Files
// untouched for longer than the records are kept aren't read at all. One file at a time, a chunk at a
// time, giving the event loop back after each, so sessions stay responsive during a first scan.

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import type { HarnessId } from "../../../../shared/transcript";
import { keyOf, lineParser, type FileState } from "./parse";

export interface UsageRoot {
  harness: HarnessId;
  dir: string;
  /** Codex: private CODEX_HOMEs (Tether's API-key threads) */
  private?: boolean;
}

/** How long records are kept: the op's longest range and a day either side for time zones. */
export const RETAIN_MS = 32 * 86_400_000;
const CHUNK = 4 * 1024 * 1024;
/** A line longer than this (a huge tool output) isn't held whole: the file stops there, an error. */
const LINE_MAX = 128 * 1024 * 1024;
const SAVE_MS = 15_000;
const VERSION = 1;

const pause = () => new Promise<void>((r) => setTimeout(r, 0));

/** Claude's session for a file: its own name, or for a subagent's file the session folder it's under. */
export function claudeSession(path: string): string {
  const parts = path.split(sep);
  const sub = parts.lastIndexOf("subagents");
  return sub > 0 ? parts[sub - 1]! : basename(path, ".jsonl");
}

export class UsageScanner {
  readonly files = new Map<string, FileState>();
  progress = { files: 0, done: 0 };
  last?: { at: number; ms: number };
  errors = 0;
  private running?: Promise<void>;
  private saved = 0;
  private now: () => number;

  constructor(private o: { roots: () => UsageRoot[]; cacheFile?: string; now?: () => number; log?: (line: string) => void; chunk?: number }) {
    this.now = o.now ?? Date.now;
    this.load();
  }

  get scanning() { return !!this.running; }

  /** Reads what's new; one scan at a time (a second call joins the running one). */
  scan(): Promise<void> {
    return (this.running ??= this.run().finally(() => (this.running = undefined)));
  }

  private async run() {
    const started = performance.now();
    const now = this.now();
    const cutoff = now - RETAIN_MS;
    const list = await this.list(cutoff);
    const keep = new Set(list.map((f) => f.path));
    for (const path of this.files.keys()) if (!keep.has(path)) this.files.delete(path);
    this.progress = { files: list.length, done: 0 };
    let errors = 0;
    this.saved = performance.now();
    for (const f of list) {
      const st = this.files.get(f.path);
      if (!st || st.size !== f.size || st.mtime !== f.mtime) {
        try { await this.read(f); } catch (e: any) {
          errors++;
          this.files.delete(f.path);
          this.o.log?.(`couldn't read ${f.path}: ${e?.message ?? e}`);
        }
        if (performance.now() - this.saved > SAVE_MS) this.save(cutoff);
      }
      this.progress.done++;
    }
    this.errors = errors;
    this.last = { at: now, ms: Math.round(performance.now() - started) };
    this.save(cutoff);
  }

  /** The store files changed since `cutoff`, oldest first. */
  private async list(cutoff: number) {
    const out: { path: string; harness: HarnessId; private?: boolean; size: number; mtime: number }[] = [];
    for (const root of this.o.roots()) {
      let names: string[];
      try { names = (await readdir(root.dir, { recursive: true })) as string[]; } catch { continue; }
      let i = 0;
      for (const name of names) {
        if (!name.endsWith(".jsonl")) continue;
        if (root.harness === "codex" && !basename(name).startsWith("rollout-")) continue;
        const path = join(root.dir, name);
        try {
          const s = await stat(path);
          if (s.isFile() && s.mtimeMs >= cutoff) out.push({ path, harness: root.harness, ...(root.private ? { private: true } : {}), size: s.size, mtime: s.mtimeMs });
        } catch {}
        if (++i % 500 === 0) await pause();
      }
    }
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
      const parse = lineParser(f.harness);
      const index = new Map(st.recs.map((r, i) => [r[0], i]));
      const decoder = new TextDecoder();
      const chunk = this.o.chunk ?? CHUNK;
      let pos = st.offset;
      let pending: Uint8Array | undefined;
      while (pos < f.size) {
        const buf = new Uint8Array(Math.min(chunk, f.size - pos));
        const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
        if (!bytesRead) break;
        pos += bytesRead;
        let data = buf.subarray(0, bytesRead);
        if (pending) {
          const joined = new Uint8Array(pending.length + data.length);
          joined.set(pending);
          joined.set(data, pending.length);
          data = joined;
        }
        const nl = data.lastIndexOf(10);
        if (nl < 0) {
          if (data.length > LINE_MAX) throw new Error("a line too long to read");
          pending = data;
          continue;
        }
        for (const line of decoder.decode(data.subarray(0, nl)).split("\n")) if (line) parse(line, st, index);
        pending = nl + 1 < data.length ? data.slice(nl + 1) : undefined;
        st.offset = pos - (pending?.length ?? 0);
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
    } catch {}
  }

  /** Writes the cache (records older than `cutoff` left out), atomically, private. */
  save(cutoff = this.now() - RETAIN_MS) {
    this.saved = performance.now();
    const since = cutoff / 1000;
    for (const st of this.files.values()) if (st.recs.some((r) => r[1] < since)) st.recs = st.recs.filter((r) => r[1] >= since);
    if (!this.o.cacheFile) return;
    try {
      mkdirSync(dirname(this.o.cacheFile), { recursive: true, mode: 0o700 });
      const tmp = `${this.o.cacheFile}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: VERSION, last: this.last, files: Object.fromEntries(this.files) }), { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, this.o.cacheFile);
    } catch (e: any) {
      this.o.log?.(`couldn't save the usage cache: ${e?.message ?? e}`);
    }
  }
}
