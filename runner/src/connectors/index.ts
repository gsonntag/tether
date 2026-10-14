// One connector per harness (types.ts). Adapters get a session's launch additions from
// sessionLaunch() (launch.ts); the context export and skill install walk the connectors here.

import type { HarnessCapabilities, HarnessId, SlotCapability, SlotId } from "../../../web/src/shared/protocol";
import { opencodeConnector, kiroConnector } from "./acp";
import { antigravityConnector } from "./antigravity";
import { claudeConnector } from "./claude";
import { codexConnector } from "./codex";
import { piConnector } from "./pi";
import { SLOTS, type Connector } from "./types";

export const connectors: Record<HarnessId, Connector> = {
  "claude-code": claudeConnector,
  codex: codexConnector,
  pi: piConnector,
  opencode: opencodeConnector,
  kiro: kiroConnector,
  antigravity: antigravityConnector,
};

export const connectorFor = (h: HarnessId): Connector => connectors[h];

/** Every harness × slot, for the web app. */
export function capabilityMatrix(): HarnessCapabilities {
  const out = {} as HarnessCapabilities;
  for (const [h, c] of Object.entries(connectors) as [HarnessId, Connector][]) {
    out[h] = Object.fromEntries(SLOTS.map((s) => [s, c[s].capability()])) as Record<SlotId, SlotCapability>;
  }
  return out;
}
