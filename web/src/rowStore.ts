// Rows' own state, kept outside the rows (sessionContext.ts useRowState): one map per session,
// dropped when the session's view closes.

import type { Part } from "../../shared/transcript";

export class RowStore {
  private sessions = new Map<string, Map<string, unknown>>();
  get<T>(scope: string, key: string, initial: T): T {
    const m = this.sessions.get(scope);
    return m?.has(key) ? (m.get(key) as T) : initial;
  }
  set(scope: string, key: string, v: unknown) {
    let m = this.sessions.get(scope);
    if (!m) this.sessions.set(scope, (m = new Map()));
    m.set(key, v);
  }
  drop(scope: string) {
    this.sessions.delete(scope);
  }
  get size() {
    return this.sessions.size;
  }
}

/** Changes when a part's content does: a copy fetched whole of an older revision is stale. */
export function partRev(p: Part | undefined): string {
  if (!p) return "";
  if (p.type === "tool") return `tool:${p.status}:${p.output?.length ?? 0}:${p.truncated ?? 0}:${p.inputTruncated ? 1 : 0}`;
  return `${p.type}:${p.type === "image" ? p.data.length : p.text.length}:${p.truncated ?? 0}`;
}
