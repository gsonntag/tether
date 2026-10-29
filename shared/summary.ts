// A browser's copy of one runner's session list, kept in order by the summary seq (protocol.ts).

import type { SummaryUpdate } from "./protocol";
import type { SessionSummary } from "./transcript";

export interface SummaryState {
  /** the seq this list is current to; -1 before any list arrived */
  seq: number;
  sessions: Record<string, SessionSummary>;
}

export const emptySummary = (): SummaryState => ({ seq: -1, sessions: {} });

/**
 * Applies a broadcast update or a fetched list. Anything not newer than the state is stale and
 * changes nothing, so a slow list reply can't overwrite newer updates. `relist` is set when an
 * update skipped a seq (or came before any list): the browser should fetch the whole list again.
 */
export function applySummary(state: SummaryState, u: SummaryUpdate): { state: SummaryState; relist: boolean } {
  if (u.seq <= state.seq) return { state, relist: false };
  if (u.kind === "all") return { state: { seq: u.seq, sessions: Object.fromEntries(u.sessions.map((s) => [s.id, s])) }, relist: false };
  const relist = state.seq < 0 || u.seq !== state.seq + 1;
  const sessions = { ...state.sessions };
  if (u.kind === "upsert") for (const s of u.sessions) sessions[s.id] = s;
  else for (const id of u.ids) delete sessions[id];
  return { state: { seq: u.seq, sessions }, relist };
}
