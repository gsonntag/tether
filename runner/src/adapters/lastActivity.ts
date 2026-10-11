// When a stored session's last message was written, for session lists (they sort by it). A file's
// mtime moves on much more than messages (a harness resuming, a settings change, a title), so this
// reads the transcript backwards from its end until a line `pick` recognizes as a message. Usually
// that's within the last few KB. The read is bounded (TAIL_BUDGET: a transcript can be hundreds of
// MB), a few files are read at a time (a project can have thousands of sessions, and search lists
// every project at once), and results are cached by mtime and size, so a list only rereads files
// that changed.

import { open, stat } from "node:fs/promises";

const cache = new Map<string, { mtime: number; size: number; at: number | undefined }>();
const MAX_CACHED = 20_000;
/** The chunks read from the end of the file, each further back than the last. */
const CHUNKS = [64 * 1024, 448 * 1024, 1536 * 1024, 2048 * 1024];
/** At most this much of a file's end is read (the CHUNKS' sum); past it, the caller's fallback. */
export const TAIL_BUDGET = CHUNKS.reduce((a, b) => a + b, 0);
/** Files read at once. */
const PARALLEL = 32;

/** The time `pick` finds on the last line it recognizes (undefined: none). */
export type LinePick = (line: string) => number | undefined;

let running = 0;
const waiting: (() => void)[] = [];
async function limited<T>(f: () => Promise<T>): Promise<T> {
  if (running >= PARALLEL) await new Promise<void>((r) => waiting.push(r));
  running++;
  try {
    return await f();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

const inflight = new Map<string, Promise<number | undefined>>();

/**
 * The time of the last line `pick` recognizes in the last TAIL_BUDGET bytes of `path` (undefined:
 * none there, or unreadable). `known`: its mtime and size when the caller already has them.
 */
export async function lastLineTime(path: string, pick: LinePick, known?: { mtime: number; size: number }): Promise<number | undefined> {
  let mtime = known?.mtime;
  let size = known?.size;
  if (mtime === undefined || size === undefined) {
    try {
      const st = await stat(path);
      mtime = st.mtimeMs;
      size = st.size;
    } catch {
      return undefined;
    }
  }
  const hit = cache.get(path);
  if (hit && hit.mtime === mtime && hit.size === size) return hit.at;
  const key = `${path}\0${mtime}\0${size}`;
  let p = inflight.get(key);
  if (!p) {
    p = limited(() => scanBack(path, size!, pick)).then(
      (at) => {
        // An oldest-first bound: a long-running runner sees new sessions forever.
        if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value!);
        cache.delete(path);
        cache.set(path, { mtime: mtime!, size: size!, at });
        return at;
      },
      // Unreadable right now (gone, locked, out of file handles): not cached, the next list retries.
      () => undefined,
    );
    inflight.set(key, p);
    void p.finally(() => inflight.delete(key));
  }
  return p;
}

/** Reads `path` backwards in CHUNKS, newest line first, until `pick` recognizes one. */
async function scanBack(path: string, size: number, pick: LinePick): Promise<number | undefined> {
  const fh = await open(path, "r");
  try {
    let end = size;
    // The start of the earliest line seen so far, cut by the chunk boundary: completed by the next chunk.
    let carry = Buffer.alloc(0);
    for (const chunk of CHUNKS) {
      if (end <= 0) break;
      const start = Math.max(0, end - chunk);
      const buf = Buffer.alloc(end - start);
      const { bytesRead } = await fh.read(buf, 0, buf.length, start);
      const data = Buffer.concat([buf.subarray(0, bytesRead), carry]);
      // Split on raw newlines (never inside a UTF-8 sequence), newest line first.
      let lineEnd = data.length;
      for (let i = data.length - 1; i >= 0; i--) {
        if (data[i] !== 0x0a) continue;
        const t = check(data.subarray(i + 1, lineEnd), pick);
        if (t !== undefined) return t;
        lineEnd = i;
      }
      carry = data.subarray(0, lineEnd);
      end = start;
      if (start === 0) {
        // The file's first line is whole.
        return check(carry, pick);
      }
    }
    return undefined;
  } finally {
    await fh.close();
  }
}

function check(bytes: Buffer, pick: LinePick): number | undefined {
  if (bytes.length < 2) return undefined;
  const line = bytes.toString("utf8").trim();
  if (!line) return undefined;
  const t = pick(line);
  return t !== undefined && Number.isFinite(t) && t > 0 ? t : undefined;
}

/** Parses a JSONL line (undefined when it isn't valid JSON). */
export function jsonLine(line: string): any {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

/**
 * Claude Code: the last user or assistant entry of the main conversation: not a subagent's
 * (sidechain), and not one Claude Code adds itself (isMeta: command caveats, skill bodies, …).
 */
export const claudePick: LinePick = (line) => {
  if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) return undefined;
  const e = jsonLine(line);
  if ((e?.type !== "user" && e?.type !== "assistant") || e.isSidechain || e.isMeta || typeof e.timestamp !== "string") return undefined;
  return Date.parse(e.timestamp);
};

/** Codex rollout: the last conversation item (a message, reasoning, a tool call or its output). */
export const codexPick: LinePick = (line) => {
  if (!line.includes('"response_item"')) return undefined;
  const e = jsonLine(line);
  return e?.type === "response_item" && typeof e.timestamp === "string" ? Date.parse(e.timestamp) : undefined;
};

/** Antigravity transcript: every line is a conversation step. */
export const agyPick: LinePick = (line) => {
  if (!line.includes('"created_at"')) return undefined;
  const e = jsonLine(line);
  return typeof e?.created_at === "string" ? Date.parse(e.created_at) : undefined;
};
