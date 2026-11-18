// What checkpoints remember per session, beside the commits in the repo: one small JSON file each in
// the module's folder (mode 600), written whole through a temporary file. The refs keep the
// snapshots alive in the repo; this keeps their order, times and labels.

import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { CheckpointInfo } from "../../../../shared/checkpoints";

export interface Checkpoint extends CheckpointInfo {
  /** the commit of the files before */
  before: string;
  /** and after (none while open) */
  after?: string;
  /** untracked paths the before snapshot left out (too big, unreadable): a restore to it never removes them */
  left?: string[];
  /** the before snapshot took no untracked file: a restore to it removes none */
  noUntracked?: true;
  /** when the before snapshot started (a turn: `at` is when the turn did) */
  snapAt?: number;
}

export interface SessionCheckpoints {
  sessionId: string;
  /** the repo's top folder the refs are in */
  root: string;
  /** the next checkpoint's number */
  next: number;
  /** oldest first */
  items: Checkpoint[];
}

/**
 * A session id as one ref name component (and file name), one to one: letters, digits and `-` stay,
 * `_` becomes `__`, any other byte `_XX` (hex). Past 120 characters, the start and a hash of the whole.
 */
export function refSafe(sessionId: string): string {
  let s = "";
  for (const b of Buffer.from(sessionId, "utf8")) {
    const c = String.fromCharCode(b);
    s += /[A-Za-z0-9-]/.test(c) ? c : c === "_" ? "__" : `_${b.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  if (!s) return "_";
  return s.length <= 120 ? s : `${s.slice(0, 96)}-${createHash("sha256").update(sessionId).digest("hex").slice(0, 20)}`;
}

export const refName = (sessionId: string, n: number) => `refs/tether/checkpoints/${refSafe(sessionId)}/${n}`;

export class CheckpointStore {
  private cache = new Map<string, SessionCheckpoints | null>();

  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private file(sessionId: string) {
    return join(this.dir, `${refSafe(sessionId)}.json`);
  }

  get(sessionId: string): SessionCheckpoints | undefined {
    if (!this.cache.has(sessionId)) {
      let v: SessionCheckpoints | null = null;
      try {
        const raw = JSON.parse(readFileSync(this.file(sessionId), "utf8"));
        if (raw?.sessionId === sessionId && Array.isArray(raw.items)) v = raw;
      } catch {}
      this.cache.set(sessionId, v);
    }
    return this.cache.get(sessionId) ?? undefined;
  }

  put(v: SessionCheckpoints) {
    this.cache.set(v.sessionId, v);
    const f = this.file(v.sessionId);
    if (!v.items.length) return void rmSync(f, { force: true });
    const tmp = `${f}.tmp`;
    writeFileSync(tmp, JSON.stringify(v), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, f);
  }

  /** every session with checkpoints on disk */
  sessions(): string[] {
    const out: string[] = [];
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const id = JSON.parse(readFileSync(join(this.dir, f), "utf8"))?.sessionId;
        if (typeof id === "string") out.push(id);
      } catch {}
    }
    return out;
  }
}
