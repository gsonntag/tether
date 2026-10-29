// A browser's copy of one runner's session list, kept in order by the summary epoch and seq
// (protocol.ts).

import type { SummaryUpdate } from "./protocol";
import type { SessionSummary } from "./transcript";

export interface SummaryState {
  /** the runner process this list came from; undefined before any update */
  epoch?: string;
  /** the seq this list is current to; -1 before any list arrived */
  seq: number;
  sessions: Record<string, SessionSummary>;
}

export const emptySummary = (): SummaryState => ({ seq: -1, sessions: {} });

/**
 * Applies a broadcast update or a fetched list. Within an epoch, anything not newer than the
 * state is stale and changes nothing, so a slow list reply can't overwrite newer updates. A new
 * epoch (the runner restarted, its seq starting over) replaces the state. `relist` is set when the
 * browser should fetch the whole list: an update skipped a seq, or came without a list before it.
 */
export function applySummary(state: SummaryState, u: SummaryUpdate): { state: SummaryState; relist: boolean } {
  if (u.epoch !== state.epoch) state = { epoch: u.epoch, seq: -1, sessions: {} };
  else if (u.seq <= state.seq) return { state, relist: false };
  if (u.kind === "all") return { state: { epoch: u.epoch, seq: u.seq, sessions: Object.fromEntries(u.sessions.map((s) => [s.id, s])) }, relist: false };
  const relist = state.seq < 0 || u.seq !== state.seq + 1;
  const sessions = { ...state.sessions };
  if (u.kind === "upsert") for (const s of u.sessions) sessions[s.id] = s;
  else for (const id of u.ids) delete sessions[id];
  return { state: { epoch: u.epoch, seq: u.seq, sessions }, relist };
}
