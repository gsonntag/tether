// Claude Code's session JSONL, read by Tether itself (not the SDK's getSessionMessages, whose
// parentUuid walk stops at a compaction and drops everything before it).
//
// Each line is an entry with `uuid` and `parentUuid`; the conversation is the chain from the last
// message back. A compaction writes a `compact_boundary` whose parentUuid is null, so the chain
// after it ends there. Its `logicalParentUuid` can't be trusted to lead back (in real files it
// names an entry written after the boundary), so the walk carries on from the last main-thread
// message written before the boundary: the conversation as it stood when it was compacted. An
// entry is shown once, where it first happened.
//
// Files are read incrementally: a watched session that grows by a few lines parses only those
// (a 27 MB transcript reparsed on every change took ~250 ms). A file that shrank or was replaced
// is read again from the start.

import { open, stat } from "node:fs/promises";

export interface Entry {
  uuid: string;
  parentUuid?: string | null;
  logicalParentUuid?: string;
  type: string;
  subtype?: string;
  message?: any;
  isSidechain?: boolean;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  origin?: any;
  timestamp?: string;
  /** its place in the file (line count) */
  order: number;
}

/** What is kept of a line: the chain fields always, content only for messages. */
function entryOf(line: string): Entry | undefined {
  let e: any;
  try {
    e = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!e || typeof e.uuid !== "string" || typeof e.type !== "string") return undefined;
  const out: Entry = { uuid: e.uuid, parentUuid: e.parentUuid ?? null, type: e.type, order: 0 };
  if (e.logicalParentUuid) out.logicalParentUuid = e.logicalParentUuid;
  if (e.isSidechain) out.isSidechain = true;
  if (e.timestamp) out.timestamp = e.timestamp;
  if (e.type === "user" || e.type === "assistant") {
    out.message = e.message;
    if (e.isMeta) out.isMeta = true;
    if (e.isCompactSummary) out.isCompactSummary = true;
    if (e.origin) out.origin = e.origin;
  } else if (e.type === "system") {
    out.subtype = e.subtype;
  }
  return out;
}

export class StoreFile {
  /** bytes consumed (always just after a newline) */
  offset = 0;
  private ino = -1;
  readonly entries = new Map<string, Entry>();
  /** user and assistant entries of the main thread, in file order */
  private messages: Entry[] = [];
  private lines = 0;

  constructor(readonly path: string) {}

  /** Reads what was appended since the last call. True when anything changed. */
  async update(): Promise<boolean> {
    const s = await stat(this.path);
    if (s.ino !== this.ino || s.size < this.offset) this.reset(s.ino);
    if (s.size === this.offset) return false;
    const fh = await open(this.path, "r");
    let changed = false;
    try {
      const CHUNK = 8 * 1024 * 1024;
      let carry = Buffer.alloc(0);
      while (this.offset + carry.length < s.size) {
        const want = Math.min(CHUNK, s.size - this.offset - carry.length);
        const buf = Buffer.alloc(want);
        const { bytesRead } = await fh.read(buf, 0, want, this.offset + carry.length);
        if (!bytesRead) break;
        const data = Buffer.concat([carry, buf.subarray(0, bytesRead)]);
        const end = data.lastIndexOf(0x0a);
        if (end < 0) {
          carry = data;
          continue;
        }
        for (const line of data.subarray(0, end).toString("utf8").split("\n")) if (line.trim()) changed = this.add(line) || changed;
        this.offset += end + 1;
        carry = data.subarray(end + 1);
      }
      // A last line without its newline is still being written: read again next time.
    } finally {
      await fh.close();
    }
    return changed;
  }

  private reset(ino: number) {
    this.ino = ino;
    this.offset = 0;
    this.entries.clear();
    this.messages = [];
    this.lines = 0;
  }

  private add(line: string): boolean {
    const e = entryOf(line);
    if (!e) return false;
    e.order = ++this.lines;
    this.entries.set(e.uuid, e);
    if ((e.type === "user" || e.type === "assistant") && !e.isSidechain) this.messages.push(e);
    return true;
  }

  /** The conversation, oldest first, across every compaction. */
  chain(): Entry[] {
    const walk: Entry[] = [];
    const visited = new Set<string>();
    let cur: Entry | undefined = this.messages.at(-1);
    while (cur && !visited.has(cur.uuid)) {
      visited.add(cur.uuid);
      walk.push(cur);
      if (cur.parentUuid) cur = this.entries.get(cur.parentUuid);
      else if (cur.type === "system" && cur.subtype === "compact_boundary") cur = this.lastMessageBefore(cur.order);
      else cur = undefined;
    }
    // Oldest first, each entry once, where it first happened.
    const seen = new Set<string>();
    const out: Entry[] = [];
    for (let i = walk.length - 1; i >= 0; i--) {
      const e = walk[i]!;
      if (seen.has(e.uuid)) continue;
      seen.add(e.uuid);
      out.push(e);
    }
    return out;
  }

  /** The last main-thread message written before line `order`. */
  private lastMessageBefore(order: number): Entry | undefined {
    let lo = 0;
    let hi = this.messages.length - 1;
    let hit: Entry | undefined;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.messages[mid]!.order < order) {
        hit = this.messages[mid];
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return hit;
  }
}

const cache = new Map<string, StoreFile>();

const CACHE_MAX = 8;

/** The file, brought up to date (cached, so repeated reads parse only what was appended). */
export async function readStore(path: string): Promise<StoreFile> {
  let f = cache.get(path);
  if (f) cache.delete(path);
  else f = new StoreFile(path);
  cache.set(path, f);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  await f.update();
  return f;
}
