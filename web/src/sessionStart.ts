// Sessions whose agent process isn't running: opening one shows its stored conversation (except
// harnesses in STARTS_ON_OPEN), and the process starts when something needs it, like a message.

import { STARTS_ON_OPEN, type HarnessId, type SessionSummary } from "./shared/protocol";

/**
 * What the loading screen says: "Starting <harness> process…" only where opening starts it (a
 * session known not to be running, on a harness that can't show it otherwise).
 */
export function opensByStarting(harness: HarnessId, knownLive: boolean | undefined): boolean {
  return knownLive === false && STARTS_ON_OPEN.has(harness);
}

/**
 * An open session's process just started: the browser takes a fresh snapshot from it (what it
 * shows was the stored copy, or the state the old process left).
 */
export function processStarted(open: { loading?: boolean; syncing?: boolean; session?: Pick<SessionSummary, "live"> } | undefined, next: Pick<SessionSummary, "live">): boolean {
  return !!open && !open.loading && !open.syncing && !!open.session && !open.session.live && next.live;
}
