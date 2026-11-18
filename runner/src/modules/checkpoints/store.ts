// What checkpoints remember per session, beside the commits in the repo: one small JSON file each in
// the module's folder (mode 600), written whole through a temporary file. The refs keep the
// snapshots alive in the repo; this keeps their order, times and labels.

import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckpointInfo } from "../../../../shared/checkpoints";

export interface Checkpoint extends CheckpointInfo {
  /** the commit of the files before */
  before: string;
  /** and after (none while open) */
  after?: string;
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

/** A session id as one ref name component: letters, digits, `.`, `_` and `-` only. */
export function refSafe(sessionId: string): string {
  const s = sessionId.replace(/[^A-Za-z0-9_-]/g, "-").replace(/^-+/, "");
  return s.slice(0, 120) || "session";
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
