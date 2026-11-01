import { HARNESS_KEYS, type BillingSource, type SourceChoices } from "../../shared/credentials";
import type { Billing, HarnessId, LiveState } from "../../shared/transcript";

export interface SourceMenuItem {
  /** a source, or CURRENT_SOURCE */
  value: string;
  label: string;
  /** why it can't be picked now */
  reason?: string;
}

/** The session's own source when it's no longer on offer (its key was unset): shown, not pickable. */
export const CURRENT_SOURCE = "current";

function sourceChangeIsPending(state: LiveState): boolean {
  return state.status !== "idle" || state.requests.length > 0 || state.mode === "terminal" || !!state.terminal;
}

/** A queued source is what a completed session will use next; active work keeps its confirmed source. */
export function billingForDisplay(state: LiveState): Billing | undefined {
  return sourceChangeIsPending(state) ? state.billing : state.nextBilling ?? state.billing;
}

/** Keep the separate next-source badge until active work ends and the queued source becomes current. */
export function visibleNextBilling(state: LiveState): Billing | undefined {
  return sourceChangeIsPending(state) ? state.nextBilling : undefined;
}

/** Why a process start can't change source now. The runner refuses these too. */
export function switchBlocked(state: LiveState): string | undefined {
  if (state.mode === "terminal" || state.terminal) return "Close the terminal first.";
  return state.status !== "idle" ? "Wait for the turn to end." : undefined;
}

/** The billing chip's menu: the harness's sources, the displayed session source, and why others are unavailable. */
export function sourceMenu(harness: HarnessId, state: LiveState, choices: SourceChoices): { items: SourceMenuItem[]; value?: string; addKey: boolean } {
  const shown = billingForDisplay(state);
  const own = choices.options.find((o) => o.billing.label === shown?.label);
  const reason = switchBlocked(state);
  const items: SourceMenuItem[] = choices.options.map((o) => ({ value: o.source, label: o.billing.label, ...(o !== own && reason ? { reason } : {}) }));
  const gone = !own && shown && shown.kind !== "unknown";
  if (gone) items.unshift({ value: CURRENT_SOURCE, label: shown.label });
  const set = new Set<BillingSource>(choices.options.map((o) => o.source));
  return { items, value: own?.source ?? (gone ? CURRENT_SOURCE : undefined), addKey: HARNESS_KEYS[harness].some((k) => !set.has(k)) };
}
