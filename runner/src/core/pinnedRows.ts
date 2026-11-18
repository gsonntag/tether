// Rows for pinned sessions too old for discovery's pass (SPEC §10 Pinning): the Sidebar lists a
// pinned session however old. Each is looked up on its own, in parallel and with a short timeout,
// and kept: read again when its store changes or after a minute. A failed or slow lookup keeps the
// row it had; a session its harness twice says it doesn't have is gone (its pin is dropped).

import { parseSessionId } from "../../../shared/ids";
import type { SessionSummary } from "../../../shared/transcript";
import type { Adapter } from "./adapter";

/** Read again after this long even when the store says nothing changed. */
export const PIN_REREAD_MS = 60_000;
/** A lookup slower than this keeps the row it had. */
export const PIN_LOOKUP_MS = 5_000;
/** Lookups in a row that find nothing before the session counts as gone. */
const GONE_AFTER = 2;

interface Entry {
  row?: SessionSummary;
  at: number;
  changedAt?: number;
  misses: number;
}

export class PinnedRows {
  private cache = new Map<string, Entry>();

  constructor(
    private adapters: Adapter[],
    private projectOf: (id: string) => string | undefined,
    private now: () => number,
    private lookupMs = PIN_LOOKUP_MS,
  ) {}

  /** The rows of these pinned sessions, and those confirmed gone. */
  async rows(ids: string[]): Promise<{ rows: SessionSummary[]; gone: string[] }> {
    for (const id of this.cache.keys()) if (!ids.includes(id)) this.cache.delete(id);
    const rows: SessionSummary[] = [];
    const gone: string[] = [];
    await Promise.all(
      ids.map(async (id) => {
        const parsed = parseSessionId(id);
        const a = parsed && this.adapters.find((x) => x.id === parsed.harness);
        const e = this.cache.get(id);
        // A harness this runner doesn't drive now: nothing to say, and the pin stays.
        if (!parsed || !a) return;
        const projectPath = this.projectOf(id);
        const changedAt = projectPath ? a.storeChangedAt?.(parsed.nativeId, projectPath) : undefined;
        const now = this.now();
        if (e && now - e.at < PIN_REREAD_MS && changedAt === e.changedAt) {
          if (e.row) rows.push(e.row);
          return;
        }
        const next: Entry = { ...(e?.row ? { row: e.row } : {}), at: now, changedAt, misses: e?.misses ?? 0 };
        try {
          const row = await this.lookup(a, parsed.nativeId, projectPath);
          if (row) Object.assign(next, { row, misses: 0 });
          else if (++next.misses >= GONE_AFTER) {
            this.cache.delete(id);
            gone.push(id);
            return;
          }
        } catch {
          // a transient failure or a slow harness: the row it had stays
        }
        this.cache.set(id, next);
        if (next.row) rows.push(next.row);
      }),
    );
    return { rows, gone };
  }

  private lookup(a: Adapter, nativeId: string, projectPath?: string): Promise<SessionSummary | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("timed out")), this.lookupMs)));
    return Promise.race([a.sessionInfo(nativeId, projectPath), late]).finally(() => clearTimeout(timer));
  }
}
