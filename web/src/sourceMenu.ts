import { HARNESS_KEYS, keyTarget, type BillingSource, type SourceChoices } from "../../shared/credentials";
import { billingForDisplay, sourceSwitchBlocker, sourceSwitchBlockMessage, visibleNextBilling } from "../../shared/sourceSwitch";
import type { HarnessId, LiveState } from "../../shared/transcript";

export { billingForDisplay, visibleNextBilling };

export interface SourceMenuItem {
  /** a source, or CURRENT_SOURCE */
  value: string;
  label: string;
  /** why it can't be picked now */
  reason?: string;
}

/** The session's own source when it's no longer on offer (its key was unset): shown, not pickable. */
export const CURRENT_SOURCE = "current";

/** Why a process start can't change source now. The runner refuses these too. */
export function switchBlocked(state: LiveState): string | undefined {
  const blocker = sourceSwitchBlocker(state);
  return blocker ? sourceSwitchBlockMessage(blocker) : undefined;
}

/** The billing chip's menu: the harness's sources, the displayed session source, and why others are unavailable. */
export function sourceMenu(harness: HarnessId, state: LiveState, choices: SourceChoices): { items: SourceMenuItem[]; value?: string; addKey: boolean } {
  // A failed start leaves the target queued, so keep it selected in the menu for cancellation.
  const shown = state.sourceSwitchFailed ? state.nextBilling ?? billingForDisplay(state) : billingForDisplay(state);
  const own = choices.options.find((o) => o.billing.label === shown?.label);
  const reason = switchBlocked(state);
  const items: SourceMenuItem[] = choices.options.map((o) => ({ value: o.source, label: o.billing.label, ...(o !== own && reason ? { reason } : {}) }));
  const gone = !own && shown && shown.kind !== "unknown";
  if (gone) items.unshift({ value: CURRENT_SOURCE, label: shown.label });
  const set = new Set<BillingSource>(choices.options.map((o) => o.source));
  return { items, value: own?.source ?? (gone ? CURRENT_SOURCE : undefined), addKey: HARNESS_KEYS[harness].some((k) => !set.has(k)) };
}

/**
 * The billing menu's switch for when the plan runs out (SPEC §10): on a plan session with a key to go
 * to, or already on so it can be turned off. Its label names the target. `order`: Fallback keys…,
 * for a harness with more than one key. Not shown: undefined.
 */
export function autoKeyItem(harness: HarnessId, state: LiveState, choices: SourceChoices): { label: string; order: boolean } | undefined {
  if (billingForDisplay(state)?.kind !== "plan") return undefined;
  const keys = choices.options.filter((o) => o.source !== "subscription");
  if (!keys.length && !state.autoKey) return undefined;
  const target = keyTarget(choices.options, state.lastKey, state.fallbackKeys);
  return { label: target ? `Switch to ${target.billing.label} when plan runs out` : "No allowed key", order: HARNESS_KEYS[harness].length > 1 };
}
