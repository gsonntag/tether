// Forking from the UI (SPEC §16): where the session menu offers Fork, and the call. Which replies
// offer Fork from here is shared/fork.ts forkPoints. The runner checks all of it again.

import type { ForkedFrom } from "../../shared/fork";
import type { SummaryState } from "../../shared/summary";
import type { HarnessCapabilities, LiveState, SessionSummary } from "../../shared/transcript";

/** The session menu has Fork: a main session whose harness forks, on a confirmed source. */
export function canFork(session: Pick<SessionSummary, "parentSessionId">, capabilities: HarnessCapabilities | undefined, state: Pick<LiveState, "nextBilling">): boolean {
  return !session.parentSessionId && !!capabilities?.fork && !state.nextBilling;
}

/** What a fork's header calls its original: its title now when it's listed, else as it was forked. */
export function forkedFromTitle(summaries: Record<string, SummaryState | undefined>, runnerId: string, from: ForkedFrom): string | undefined {
  return summaries[runnerId]?.sessions[from.sessionId]?.title || from.title;
}

let forking = false;

/** Forks, then opens the fork. A failure shows in the original's chat. One at a time. */
export async function forkSession(runnerId: string, sessionId: string, messageId?: string) {
  if (forking) return;
  forking = true;
  const [{ rpc }, { openSession }, { failedSend }, { focusComposerOf }] = await Promise.all([import("./connection"), import("./route"), import("./store"), import("./components/SessionView")]);
  try {
    const r = await rpc(runnerId, "forkSession", { sessionId, ...(messageId ? { messageId } : {}) });
    focusComposerOf(runnerId, r.sessionId);
    openSession(runnerId, r.sessionId);
  } catch (e) {
    failedSend(runnerId, sessionId, `Fork failed: ${(e as Error).message}`);
  } finally {
    forking = false;
  }
}
