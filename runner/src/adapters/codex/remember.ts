// What Tether remembers about threads it made, where the daemon doesn't keep it (a small JSON file
// in the runner's config dir, mode 600; in memory under `bun test`):
//  - the settings a new thread started with, until its first turn writes them to its rollout
//    (a thread with no turn has no turn_context, so they couldn't be read back after a restart);
//  - that it still carries the placeholder name (driver.ts beforeTerminal), so it's renamed after its
//    first turn even if the runner restarted in between.

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { StartOpts } from "../../core/adapter";
import { CONFIG_DIR } from "../../config";

export interface Remembered {
  start?: StartOpts;
  /** the settings the daemon last confirmed while Tether was on the thread, and when (ms) */
  applied?: StartOpts & { at: number };
  placeholder?: boolean;
  /** "default": you picked Default, so the thread shows as Default while it runs the default model */
  modelAlias?: string;
  at: number;
}

const MAX = 500;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

let file: string | undefined = process.env.NODE_ENV === "test" ? undefined : join(CONFIG_DIR, "codex-threads.json");
let map: Record<string, Remembered> | undefined;

/** Tests: where it's kept (undefined: memory only), starting empty. */
export function rememberIn(path: string | undefined) {
  file = path;
  map = undefined;
}

function load(): Record<string, Remembered> {
  if (map) return map;
  map = {};
  if (file)
    try {
      map = JSON.parse(readFileSync(file, "utf8")) ?? {};
    } catch {}
  return map!;
}

function save() {
  if (!file || !map) return;
  const now = Date.now();
  const kept = Object.entries(map)
    .filter(([, r]) => now - r.at < MAX_AGE_MS)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, MAX);
  map = Object.fromEntries(kept);
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(map), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  } catch {}
}

export function remembered(threadId: string): Remembered | undefined {
  return load()[threadId];
}

/** Merges into what's remembered (undefined fields are dropped; nothing left: forgotten). */
export function remember(threadId: string, patch: Partial<Omit<Remembered, "at">>) {
  const m = load();
  const next: any = { ...m[threadId], ...patch, at: Date.now() };
  for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
  if (Object.keys(next).length <= 1) delete m[threadId];
  else m[threadId] = next;
  save();
}
