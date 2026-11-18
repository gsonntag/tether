// Side chats from the UI (SPEC §16a): where they're offered, and what the box does with `/btw`. The
// runner checks all of it again.

import { BTW_COMMAND, parseBtw } from "../../shared/sideChat";
import type { HarnessCommand } from "../../shared/commands";
import type { HarnessCapabilities, LiveState, SessionSummary } from "../../shared/transcript";
import { canFork } from "./fork";

/** A session can have side chats: one that forks, on a harness with a read-only mode, that isn't one itself. */
export function canSideChat(session: Pick<SessionSummary, "parentSessionId" | "sideOf">, capabilities: HarnessCapabilities | undefined, state: Pick<LiveState, "nextBilling">): boolean {
  return canFork(session, capabilities, state) && !session.sideOf && !!capabilities?.readOnlyMode;
}

/** The session's `/` menu with Tether's `/btw` first (when it can have side chats). */
export const withBtw = (list: HarnessCommand[]) => [BTW_COMMAND, ...list.filter((c) => c.name !== BTW_COMMAND.name)];

/** What the box sends: a side chat's question (`/btw …`), or undefined for anything else. */
export const btwQuestion = (text: string, enabled: boolean) => (enabled ? parseBtw(text) : undefined);
