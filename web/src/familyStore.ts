// spawnedFamily answers (SPEC §6a), one per runner and session, shared by the Sidebar and the
// session's header: one ask each time what it was for changes (subagents.ts familyKey).

import { create } from "zustand";
import type { SpawnedFamily } from "../../shared/protocol";
import type { SummaryState } from "../../shared/summary";
import { familyKey, mainIds } from "./subagents";

export interface FamilyEntry {
  f: SpawnedFamily;
  /** familyKey when it came */
  key: string;
  /** the runner's main sessions then */
  seen: string[];
}

export const useFamilies = create<{ by: Record<string, FamilyEntry> }>(() => ({ by: {} }));

/** The key of the ask under way, per runner and session. */
const asking = new Map<string, string>();

export const familyKeyOf = (runnerId: string, sessionId: string) => `${runnerId}\u0000${sessionId}`;

/**
 * Asks once for `key` (another caller asking for the same waits on this one). `summaries`: the
 * store's, now; `ask`: the spawnedFamily rpc.
 */
export function loadFamily(runnerId: string, sessionId: string, key: string, summaries: () => Record<string, SummaryState>, ask: (runnerId: string, sessionId: string) => Promise<SpawnedFamily>) {
  const k = familyKeyOf(runnerId, sessionId);
  if (asking.get(k) === key) return;
  asking.set(k, key);
  const seen = mainIds(summaries(), runnerId);
  ask(runnerId, sessionId)
    .then((f) => {
      // Kept under the key the answer itself makes, so a new member doesn't ask again.
      const now = familyKey(summaries(), runnerId, sessionId, f);
      useFamilies.setState((s) => ({ by: { ...s.by, [k]: { f, key: now, seen } } }));
    })
    .catch(() => {})
    .finally(() => asking.get(k) === key && asking.delete(k));
}

/** Back from a dropped link: what changed meanwhile is unknown, so every family is asked again. */
export function forgetFamilies() {
  if (Object.keys(useFamilies.getState().by).length) useFamilies.setState({ by: {} });
}
