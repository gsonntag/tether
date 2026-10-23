// The credential plugins this runner has. A provider branch adds its plugin file next to this one
// and fills in its two slot lines below (import, register); nothing else in the runner names a
// provider. Each slot sits apart from the others so the branches merge without conflicts.

import { examplePlugin } from "./example";
import { register } from "./registry";
// slot foundry: import { foundryPlugin } from "./foundry";

// slot bedrock: import { bedrockPlugin } from "./bedrock";

// slot accounts: import { accountPlugins } from "./accounts";

export * from "./registry";

let done = false;

/** Registers the plugins, once (runner startup). */
export function registerCredentialPlugins() {
  if (done) return;
  done = true;
  // Local UI work only: a stand-in provider for the Credentials page.
  if (process.env.TETHER_EXAMPLE_CREDENTIALS === "1") register(examplePlugin);
  // slot foundry: register(foundryPlugin);

  // slot bedrock: register(bedrockPlugin);

  // slot accounts: register(...accountPlugins);
}
