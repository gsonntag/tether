// A runner's way to the person through its texting hub (shared/textingHub.ts): a Channel whose
// "service" is the hub runner. Its texts go to the hub, which numbers them with every other
// session's ("[n] …") and sends them on its own connector; the replies the hub's router gives to
// this runner's sessions come back (Texter.fromHub). It's the last of a runner's channels, so a
// connector of its own, when connected, still comes first.
//
// The connector a reply came by on the hub is kept here as "hub:<id>" (HUB_VIA), so an answer goes
// back the same way (the hub's Discord DM, or the channel a message was written in).

import type { TextingHubInfo } from "../../../../shared/textingHub";
import { Channel, type Connector, type Outbound } from "./connector";
import type { HubWire } from "./hubWire";
import { PHOTON } from "./link";

/** The id the hub's channel has here; "hub:<connector>" names one of the hub's connectors. */
export const HUB = "hub";
export const HUB_VIA = `${HUB}:`;
export const isHubVia = (id: string | undefined): id is string => !!id && (id === HUB || id.startsWith(HUB_VIA));
/** The hub's own connector id in a "hub:<id>" (none: wherever the hub's texts go). */
export const hubConnector = (id: string | undefined) => (id?.startsWith(HUB_VIA) ? id.slice(HUB_VIA.length) || undefined : undefined);

/** What a text is about, so the hub numbers it with the session's slot (and notes it for threaded replies). */
export interface HubAbout {
  sessionId: string;
  requestId?: string;
  /** the slot's status and the text's words: the hub stamps them "[n] …"; absent (an image after a text): sent as it is */
  status?: string;
  body?: string;
  /** the session's name, for the hub's picker (it may text: it just did) */
  label?: string;
}

/** What a send through the hub answers. */
export interface HubSent {
  sent: boolean;
  ids?: string[];
  unsure?: boolean;
  error?: string;
}

/** How long a text through the hub may take: the hub's own send, and the way there and back. */
export const HUB_SEND_MS = PHOTON.ms + 15_000;

export class HubChannel extends Channel {
  constructor(
    private hub: () => TextingHubInfo | null,
    private wire: HubWire,
  ) {
    const self = (): Connector => ({
      id: HUB,
      get label() {
        return hub()?.name ?? "the texting hub";
      },
      get service() {
        return hub()?.name ?? "the texting hub";
      },
      get images() {
        return !!hub()?.images;
      },
      enabled: () => !!hub(),
      configured: () => true,
      open: () => Promise.reject(new Error("The hub's channel doesn't open a link.")),
      forms: () => [],
      about: "",
      notReady: "No computer texts for this one.",
      update: () => {
        throw new Error("Set texting up on the hub.");
      },
    });
    super(self(), () => {}, () => {});
  }

  override get connected(): boolean {
    return !!this.hub()?.up;
  }

  override start(): Promise<void> {
    return Promise.resolve();
  }

  override async stop() {}

  override async restart() {}

  /** Sends through the hub (`about`: the session it's about, which the hub stamps and notes). Throws when it didn't go. */
  override async send(out: Outbound & { about?: HubAbout }): Promise<string[]> {
    const h = this.hub();
    if (!h?.up) throw new Error("not connected");
    const what = out.files?.length && !out.text ? "an image" : "a send";
    const via = hubConnector(out.via);
    const args = { text: out.text, ...(via ? { via } : {}), ...(out.place ? { place: out.place } : {}), ...(out.shared ? { shared: true } : {}), ...(out.about ? { about: out.about } : {}) };
    let r: HubSent;
    try {
      r = (await this.wire.call(h.id, "send", args, { files: out.files ?? [], timeoutMs: HUB_SEND_MS, what })) as HubSent;
    } catch (e: any) {
      this.lastError = `Couldn't send a text through ${h.name}: ${e?.message ?? e}`;
      throw e;
    }
    if (!r?.sent) {
      this.lastError = r?.error ?? `${h.name} couldn't send the text.`;
      throw Object.assign(new Error(this.lastError), r?.unsure ? { timedOut: what } : {});
    }
    this.lastError = undefined;
    return Array.isArray(r.ids) ? r.ids.filter((x): x is string => typeof x === "string") : [];
  }
}
