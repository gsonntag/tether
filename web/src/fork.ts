// Forking from the UI (SPEC §16): where the session menu offers Fork, and the call. Which replies
// offer Fork from here is shared/fork.ts forkPoints. The runner checks all of it again.

import { useSyncExternalStore } from "react";
import type { ForkedFrom } from "../../shared/fork";
import type { SummaryState } from "../../shared/summary";
import type { HarnessCapabilities, LiveState, SessionSummary } from "../../shared/transcript";

/** A turn may be running: in Tether, or in a TUI that took the session over (Tether doesn't follow its turns). */
export function forkRunning(state: Pick<LiveState, "status" | "mode" | "terminal">, capabilities: HarnessCapabilities | undefined): boolean {
  return state.status !== "idle" || (capabilities?.terminal === "handoff" && (state.mode === "terminal" || !!state.terminal));
}

/** The session menu has Fork: a main session whose harness forks, on a confirmed source. */
export function canFork(session: Pick<SessionSummary, "parentSessionId" | "sideOf">, capabilities: HarnessCapabilities | undefined, state: Pick<LiveState, "nextBilling">): boolean {
  return !session.parentSessionId && !session.sideOf && !!capabilities?.fork && !state.nextBilling;
}

/** What a fork's header calls its original: its title now when it's listed, else as it was forked. */
export function forkedFromTitle(summaries: Record<string, SummaryState | undefined>, runnerId: string, from: ForkedFrom): string | undefined {
  return summaries[runnerId]?.sessions[from.sessionId]?.title || from.title;
}

/** The session being forked now (one at a time), for its busy line. */
let forking: string | undefined;
const listeners = new Set<() => void>();
const setForking = (id: string | undefined) => {
  forking = id;
  listeners.forEach((l) => l());
};
/** Whether this session is being forked now. */
export function useForking(sessionId: string): boolean {
  const now = () => forking === sessionId;
  return useSyncExternalStore((l) => (listeners.add(l), () => void listeners.delete(l)), now, now);
}

/** Forks, then opens the fork. A failure shows in the original's chat. One at a time. */
export async function forkSession(runnerId: string, sessionId: string, messageId?: string) {
  if (forking) return;
  setForking(sessionId);
  const [{ rpc }, { openSession }, { failedSend }, { focusComposerOf }] = await Promise.all([import("./connection"), import("./route"), import("./store"), import("./components/SessionView")]);
  try {
    const r = await rpc(runnerId, "forkSession", { sessionId, ...(messageId ? { messageId } : {}) });
    focusComposerOf(runnerId, r.sessionId);
    openSession(runnerId, r.sessionId);
  } catch (e) {
    failedSend(runnerId, sessionId, `Fork failed: ${(e as Error).message}`);
  } finally {
    setForking(undefined);
  }
}
