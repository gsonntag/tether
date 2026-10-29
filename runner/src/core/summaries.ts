// The runner's summary list: the sidebar's recent sessions plus every live one, broadcast to every
// browser (protocol.ts SummaryUpdate). Discovery refreshes it from the harness stores, so sessions
// started outside Tether show up; live sessions update their own rows.

import type { SummaryUpdate } from "../../../shared/protocol";
import type { SessionSummary } from "../../../shared/transcript";

/** Stored sessions with activity this recent are listed (v1 kept 3 days, which worked well). */
export const RECENT_MS = 3 * 24 * 60 * 60 * 1000;
/** At most this many stored sessions are listed; search finds the rest. */
export const RECENT_MAX = 200;

export class SummaryBook {
  private rows = new Map<string, SessionSummary>();
  private seq = 0;

  constructor(
    readonly epoch: string,
    private broadcast: (u: SummaryUpdate) => void,
    private now: () => number = Date.now,
  ) {}

  list(): SessionSummary[] {
    return [...this.rows.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string) {
    return this.rows.get(id);
  }

  /** The whole list as a browser fetches it. */
  all(): { sessions: SessionSummary[]; epoch: string; seq: number } {
    return { sessions: this.list(), epoch: this.epoch, seq: this.seq };
  }

  /** Sends the whole list to every browser (on connect). */
  announce() {
    this.broadcast({ kind: "all", ...this.all() });
  }

  /** Adds or changes rows; only real changes go out. */
  upsert(rows: SessionSummary[]) {
    const changed = rows.filter((r) => JSON.stringify(this.rows.get(r.id)) !== JSON.stringify(r));
    if (!changed.length) return;
    for (const r of changed) this.rows.set(r.id, r);
    this.broadcast({ kind: "upsert", epoch: this.epoch, seq: ++this.seq, sessions: changed });
  }

  remove(ids: string[]) {
    const gone = ids.filter((id) => this.rows.delete(id));
    if (gone.length) this.broadcast({ kind: "remove", epoch: this.epoch, seq: ++this.seq, ids: gone });
  }

  /**
   * Folds in a fresh discovery of stored sessions. `owned` rows are kept as they are whatever
   * discovery says (live sessions and running subagents: the core keeps them current itself);
   * `pinned` rows (sessions someone has open) stay listed even when they are no longer recent.
   */
  refresh(discovered: SessionSummary[], owned: (id: string) => boolean, pinned: (id: string) => boolean = () => false) {
    const cutoff = this.now() - RECENT_MS;
    const byId = new Map(discovered.map((s) => [s.id, s]));
    const recent = discovered
      .filter((s) => s.updatedAt >= cutoff && !s.parentSessionId)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, RECENT_MAX);
    const want = new Map(recent.map((s) => [s.id, s]));
    for (const id of this.rows.keys()) if (pinned(id) && !want.has(id) && byId.has(id)) want.set(id, byId.get(id)!);
    this.remove([...this.rows.keys()].filter((id) => !want.has(id) && !owned(id) && !pinned(id)));
    this.upsert([...want.values()].filter((s) => !owned(s.id)));
  }
}
