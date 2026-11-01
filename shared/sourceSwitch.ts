import type { Billing, LiveState } from "./transcript";

export type SourceSwitchBlocker = "terminal" | "turn" | "background" | "restart" | "queue";

/** Activity that means the confirmed source can still be drawing the session's current work. */
export function sourceSwitchBlocker(state: LiveState): SourceSwitchBlocker | undefined {
  if (state.mode === "terminal" || state.terminal) return "terminal";
  if (state.status !== "idle" || state.requests.length > 0) return "turn";
  const backgroundCommands = state.turnSettings?.who === "background" ? state.turnSettings.count ?? 1 : 0;
  if ((state.backgroundSubagents ?? 0) > 0 || (state.shellsRunning ?? 0) > 0 || backgroundCommands > 0) return "background";
  if (state.restartWait) return "restart";
  if (state.queue.length > 0 && !state.queueHeld) return "queue";
  return undefined;
}

export function sourceSwitchBlockMessage(blocker: SourceSwitchBlocker): string {
  switch (blocker) {
    case "terminal": return "Close the terminal first.";
    case "turn": return "Wait for the turn to end.";
    case "background": return "Wait for background work to finish.";
    case "restart": return "Wait for the session to reconnect.";
    case "queue": return "Wait for queued messages to finish.";
  }
}

/** A queued source is current only once no existing work can still use the confirmed source. */
export function billingForDisplay(state: LiveState): Billing | undefined {
  return sourceSwitchBlocker(state) || state.sourceSwitchFailed ? state.billing : state.nextBilling ?? state.billing;
}

/** Keep the separate Next chip until the queued source is the one the session will actually use. */
export function visibleNextBilling(state: LiveState): Billing | undefined {
  return sourceSwitchBlocker(state) || state.sourceSwitchFailed ? state.nextBilling : undefined;
}
