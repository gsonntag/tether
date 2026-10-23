// Per-provider pieces of the Credentials page (components/Credentials.tsx): an Add form, extra
// content on a row, names for the provider's actions. The page renders every provider generically
// from listCredentials; a slot only adds what's specific. A provider branch adds its file
// (credentials/<branch>.tsx: foundry, bedrock, accounts; exporting CredentialSlots) and fills in its two slot lines below.
// Each slot sits apart from the others so the branches merge without conflicts.

import type { ComponentType } from "react";
import type { CredentialList, CredentialProviderInfo, CredentialView } from "../shared/credentials";
// slot foundry: import { foundrySlot } from "./foundry";

// slot bedrock: import { bedrockSlot } from "./bedrock";

// slot accounts: import { accountSlots } from "./accounts";

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

// slot foundry: registerSlot(foundrySlot);

// slot bedrock: registerSlot(bedrockSlot);

// slot accounts: registerSlot(...accountSlots);
