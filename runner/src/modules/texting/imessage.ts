// iMessage through Photon Spectrum (link.ts), as a connector (connector.ts). Its settings are
// texting.json's own `settings` (store.ts), as they were before there were other connectors. It takes
// images out (Outbound.files: bytes already checked; each its own message after the words), and
// every Photon call gives up after PHOTON.ms (link.ts timed).

import { FROM_IMESSAGE } from "../../../../shared/fromTether";
import type { ConnectorForm } from "../../../../shared/protocol";
import { PartialSend, type Connector, type Outbound } from "./connector";
import { readOutgoingImage } from "./images";
import { openSpectrum, timed, type OpenLink, type TextLink } from "./link";
import type { TextingStore } from "./store";

export const IMESSAGE = "imessage";

export function imessageConnector(store: TextingStore, open: OpenLink = openSpectrum): Connector {
  return {
    id: IMESSAGE,
    label: "iMessage",
    service: "Photon",
    mark: FROM_IMESSAGE,
    images: true,
    // One Photon client at a time: a settings change waits for the old one to stop.
    stopWaitMs: 15_000,
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
      return { send: (out) => sendAll(link, out), closed: link.closed, stop: () => link.stop() };
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

/**
 * The words, then each image as its own message: their ids. A part that fails after another went is
 * a PartialSend (the parts that went still find their session). Image paths (Outbound.images) are
 * read and checked like an agent's (images.ts); `files` were already.
 */
async function sendAll(link: TextLink, out: Outbound): Promise<string[]> {
  const ids: string[] = [];
  try {
    if (out.text) {
      const id = await timed(link.send(out.text), "a send");
      if (id) ids.push(id);
    }
    const files = [...(out.files ?? [])];
    for (const p of out.images ?? []) {
      const r = readOutgoingImage(p);
      if ("problem" in r) throw new Error(r.problem);
      files.push(r);
    }
    if (files.length && !link.sendFile) throw new Error("this link can't send images");
    for (const f of files) {
      const id = await timed(link.sendFile!({ name: f.name, mimeType: f.mimeType, data: Buffer.from(f.data) }), "an image");
      if (id) ids.push(id);
    }
  } catch (e) {
    if (ids.length) throw Object.assign(new PartialSend(String((e as Error)?.message ?? e), ids), { timedOut: (e as { timedOut?: unknown })?.timedOut });
    throw e;
  }
  return ids;
}
