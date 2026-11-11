// iMessage through Photon Spectrum (link.ts), as a connector (connector.ts). Its settings are
// texting.json's own `settings` (store.ts), as they were before there were other connectors.

import { FROM_IMESSAGE } from "../../../../shared/fromTether";
import type { ConnectorForm } from "../../../../shared/protocol";
import type { Connector } from "./connector";
import { openSpectrum, type OpenLink } from "./link";
import type { TextingStore } from "./store";

export const IMESSAGE = "imessage";

export function imessageConnector(store: TextingStore, open: OpenLink = openSpectrum): Connector {
  return {
    id: IMESSAGE,
    label: "iMessage",
    service: "Photon",
    mark: FROM_IMESSAGE,
    about: "Phone must be added and verified on Photon dashboard",
    notReady: "Set the phone and the Photon project's id and secret first, and turn texting on.",
    enabled: () => store.enabled(),
    configured: () => {
      const st = store.status({ connected: false });
      return st.keysSet && !!st.phoneLast4;
    },
    async open(onInbound, log) {
      const cfg = store.config();
      if (!cfg) throw new Error("not set up");
      const link = await open(cfg, onInbound, log);
      return { send: (out) => link.send(out.text), closed: link.closed, stop: () => link.stop() };
    },
    forms(): ConnectorForm[] {
      const st = store.status({ connected: false });
      return [
        {
          key: "phone",
          label: "Your phone",
          status: st.phoneLast4 ? `••••${st.phoneLast4}${st.fromEnv.phone ? " · from runner.env" : ""}` : "Not set",
          fromEnv: st.fromEnv.phone,
          inputs: [{ key: "phone", placeholder: "+13105551234", type: "tel" }],
        },
        {
          key: "project",
          label: "Photon project",
          status: st.keysSet ? `Set${st.fromEnv.keys ? " · from runner.env" : ""}` : "Not set",
          fromEnv: st.fromEnv.keys,
          inputs: [
            { key: "projectId", placeholder: "Project ID" },
            { key: "projectSecret", placeholder: "Project secret", secret: true },
          ],
          unset: st.keysSet && !st.fromEnv.keys,
        },
      ];
    },
    update(a) {
      store.update({ ...(a.values ?? {}), enabled: a.enabled });
    },
  };
}
