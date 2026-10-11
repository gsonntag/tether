// When a stored session's last message was written, for session lists (they sort by it). A file's
// mtime moves on much more than messages (a harness resuming, a settings change, a title), so this
// reads the transcript backwards from its end until a line `pick` recognizes as a message. Usually
// that's within the last few KB; results are cached by mtime and size, so a list only rereads
// files that changed.

import { open, stat } from "node:fs/promises";

const cache = new Map<string, { mtime: number; size: number; at: number | undefined }>();
const MAX_CACHED = 5000;
/** How much of the end of the file each try reads; the last try reads the whole file. */
const WINDOWS = [64 * 1024, 1024 * 1024, 16 * 1024 * 1024];

/** The time `pick` finds on the last line it recognizes (undefined: none, or unreadable). */
export type LinePick = (line: string) => number | undefined;

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
  const at = await scanBack(path, size, pick).catch(() => undefined);
  if (cache.size >= MAX_CACHED) cache.clear();
  cache.set(path, { mtime, size, at });
  return at;
}

async function scanBack(path: string, size: number, pick: LinePick): Promise<number | undefined> {
  const fh = await open(path, "r");
  try {
    for (const win of [...WINDOWS, Infinity]) {
      const start = Math.max(0, size - win);
      const buf = Buffer.alloc(size - start);
      const { bytesRead } = await fh.read(buf, 0, buf.length, start);
      const lines = buf.subarray(0, bytesRead).toString("utf8").split("\n");
      if (start > 0) lines.shift(); // cut mid-line
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]!.trim();
        if (!line) continue;
        const t = pick(line);
        if (t !== undefined && Number.isFinite(t) && t > 0) return t;
      }
      if (start === 0) return undefined;
    }
    return undefined;
  } finally {
    await fh.close();
  }
}

/** Parses a JSONL line (undefined when it isn't valid JSON). */
export function jsonLine(line: string): any {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

/** Claude Code: the last user or assistant entry of the main conversation (not a subagent's). */
export const claudePick: LinePick = (line) => {
  if (!line.includes('"timestamp"')) return undefined;
  const e = jsonLine(line);
  if ((e?.type !== "user" && e?.type !== "assistant") || e.isSidechain || typeof e.timestamp !== "string") return undefined;
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
  const e = jsonLine(line);
  return typeof e?.created_at === "string" ? Date.parse(e.created_at) : undefined;
};
