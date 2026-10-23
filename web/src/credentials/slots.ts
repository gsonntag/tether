// The slot registry behind credentials/index.ts, apart from the slots themselves: tests and the
// page import it without loading every slot (a slot may import the store, which needs a browser).

import type { ComponentType } from "react";
import type { CredentialList, CredentialProviderInfo, CredentialView } from "../shared/credentials";

/** What a slot's piece calls with the runner's answer (credentialAction returns the new list). */
export type OnList = (list: CredentialList) => void;

export interface CredentialSlot {
  /** the runner plugin it's for ("azure"): its CredentialProviderInfo.provider, the "azure:" of its credential ids */
  provider: string;
  /** the form behind the group's "Add" button (provider action "add"); `close` when done or cancelled */
  Add?: ComponentType<{ provider: CredentialProviderInfo; onList: OnList; close: () => void }>;
  /** extra content under one row (models, a sign-in flow…) */
  Row?: ComponentType<{ credential: CredentialView; onList: OnList }>;
  /** button labels for its actions ("signIn" → "Sign in"); an action without one shows its name */
  actionLabels?: Record<string, string>;
  /** actions its Row handles itself: no generic button for them */
  ownActions?: string[];
}

const slots = new Map<string, CredentialSlot>();

export function registerSlot(...ss: CredentialSlot[]) {
  for (const s of ss) slots.set(s.provider, s);
}

/** Tests: forget them all. */
export const clearSlots = () => slots.clear();

export const slotFor = (provider: string): CredentialSlot | undefined => slots.get(provider);
