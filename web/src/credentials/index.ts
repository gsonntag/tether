// Per-provider pieces of the Credentials page (components/Credentials.tsx): an Add form, extra
// content on a row, names for the provider's actions. The page renders every provider generically
// from listCredentials; a slot only adds what's specific. A provider branch adds its file
// (credentials/<branch>.tsx: foundry, bedrock, accounts; exporting CredentialSlots) and fills in its two slot lines below.
// Each slot sits apart from the others so the branches merge without conflicts.

import type { ComponentType } from "react";
import type { CredentialList, CredentialProviderInfo, CredentialView } from "../shared/credentials";
// slot foundry: import { foundrySlot } from "./foundry";

// slot bedrock: import { bedrockSlot } from "./bedrock";

import { accountSlots } from "./accounts";

// The registry and types live in ./slots (tests import that, not the slots, which may need a browser).
export { clearSlots, registerSlot, slotFor, type CredentialSlot, type OnList } from "./slots";
import { registerSlot } from "./slots";

// slot foundry: registerSlot(foundrySlot);

// slot bedrock: registerSlot(bedrockSlot);

registerSlot(...accountSlots);
