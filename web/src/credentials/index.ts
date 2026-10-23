// Per-provider pieces of the Credentials page (components/Credentials.tsx): an Add form, extra
// content on a row, names for the provider's actions. The page renders every provider generically
// from listCredentials; a slot only adds what's specific. Each provider has its file
// (credentials/<name>.tsx: foundry, bedrock, accounts; exporting CredentialSlots) and two lines below.

import { foundrySlot } from "./foundry";

import { bedrockSlot } from "./bedrock";

import { accountSlots } from "./accounts";

// The registry and types live in ./slots (tests import that, not the slots, which may need a browser).
export { clearSlots, registerSlot, slotFor, type CredentialSlot, type OnList } from "./slots";
import { registerSlot } from "./slots";

registerSlot(foundrySlot);

registerSlot(bedrockSlot);

registerSlot(...accountSlots);
