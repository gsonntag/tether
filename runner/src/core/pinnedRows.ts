// Rows for pinned sessions too old for discovery's pass (SPEC §10 Pinning): the Sidebar lists a
// pinned session however old. Each is looked up on its own, in parallel and with a short timeout,
// and kept: read again when its store changes or after a minute. A failed or slow lookup keeps the
// row it had (none yet: the pin's snapshot, and it tries again next pass). A session its harness
// can't find is listed from the snapshot, marked `missing`; only the person unpins it.

import { parseSessionId } from "../../../shared/ids";
import type { SessionSummary } from "../../../shared/transcript";
import type { Adapter } from "./adapter";

/** Read again after this long even when the store says nothing changed. */
export const PIN_REREAD_MS = 60_000;
/** A lookup slower than this keeps the row it had. */
export const PIN_LOOKUP_MS = 5_000;

interface Entry {
  row: SessionSummary;
  at: number;
  changedAt?: number;
}

export class PinnedRows {
  private cache = new Map<string, Entry>();

  constructor(
    private adapters: Adapter[],
    private projectOf: (id: string) => string | undefined,
    /** the row saved when it was pinned (SessionPrefs.pinnedRow) */
    private snapshot: (id: string) => SessionSummary,
    private now: () => number,
    private lookupMs = PIN_LOOKUP_MS,
  ) {}

  /** The rows of these pinned sessions: as the harness has them, else from the pin's snapshot. */
  async rows(ids: string[]): Promise<SessionSummary[]> {
    for (const id of this.cache.keys()) if (!ids.includes(id)) this.cache.delete(id);
    return Promise.all(ids.map((id) => this.row(id)));
  }

  private async row(id: string): Promise<SessionSummary> {
    const parsed = parseSessionId(id);
    const a = parsed && this.adapters.find((x) => x.id === parsed.harness);
    // A harness this runner doesn't drive now: listed as saved.
    if (!parsed || !a) return this.snapshot(id);
    const e = this.cache.get(id);
    const projectPath = this.projectOf(id);
    const changedAt = projectPath ? a.storeChangedAt?.(parsed.nativeId, projectPath) : undefined;
    const now = this.now();
    if (e && now - e.at < PIN_REREAD_MS && changedAt === e.changedAt) return e.row;
    try {
      const found = await this.lookup(a, parsed.nativeId, projectPath);
      const row = found ?? { ...this.snapshot(id), missing: true };
      this.cache.set(id, { row, at: now, changedAt });
      return row;
    } catch {
      // A transient failure or a slow harness: the row it had, for a while; none yet, try again next pass.
      if (e) this.cache.set(id, { ...e, at: now });
      return e?.row ?? this.snapshot(id);
    }
  }

  private lookup(a: Adapter, nativeId: string, projectPath?: string): Promise<SessionSummary | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("timed out")), this.lookupMs)));
    return Promise.race([a.sessionInfo(nativeId, projectPath), late]).finally(() => clearTimeout(timer));
  }
}
