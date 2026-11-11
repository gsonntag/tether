// The connection to Photon Spectrum (iMessage): sends texts to one phone and hears that phone's
// replies. One long-lived listener; history Photon replays on connect is skipped.

import type { LinkConfig } from "./store";

export interface Inbound {
  text: string;
  /** the message it answers in a thread */
  replyTo?: string;
}

export interface TextLink {
  /** the sent message's id, when Photon gives one */
  send(text: string): Promise<string | undefined>;
  /** resolves when the listener ends (an error, or stop) */
  closed: Promise<void>;
  stop(): Promise<void>;
}

export type OpenLink = (cfg: LinkConfig, onInbound: (m: Inbound) => void, log: (line: string) => void) => Promise<TextLink>;

const digits = (s: string) => s.replace(/\D/g, "").slice(-10);

/** A message's text: plain, markdown, or a threaded reply (with what it answers). */
export function inboundOf(content: any): Inbound | undefined {
  if (!content) return undefined;
  if (content.type === "text" && typeof content.text === "string") return { text: content.text };
  if (content.type === "markdown" && typeof content.markdown === "string") return { text: content.markdown };
  if (content.type === "reply") {
    const inner = inboundOf(content.content);
    return inner && { text: inner.text, replyTo: typeof content.target?.id === "string" ? content.target.id : undefined };
  }
  return undefined;
}

export const openSpectrum: OpenLink = async (cfg, onInbound, log) => {
  const { Spectrum } = await import("spectrum-ts");
  const { imessage } = await import("@spectrum-ts/imessage");
  const app = await Spectrum({ projectId: cfg.projectId, projectSecret: cfg.projectSecret, providers: [imessage.config()] });
  const me = digits(cfg.phone);
  const since = new Date(Date.now() - 2000);
  let stopped = false;

  const closed = (async () => {
    try {
      for await (const [, message] of app.messages) {
        if (message.direction !== "inbound" || message.timestamp < since) continue;
        if (!message.sender || digits(message.sender.id) !== me) continue;
        const m = inboundOf(message.content);
        if (m) onInbound(m);
      }
    } catch (e: any) {
      if (!stopped) log(`texting: listener ended: ${e?.message ?? e}`);
    }
  })();

  const im = imessage(app);
  let space: Promise<any> | undefined;
  return {
    async send(text) {
      space ??= im.user(cfg.phone).then((u: any) => im.space.create(u));
      try {
        const sent = await (await space).send(text);
        return typeof sent?.id === "string" ? sent.id : undefined;
      } catch (e) {
        space = undefined;
        throw e;
      }
    },
    closed,
    async stop() {
      stopped = true;
      await app.stop().catch(() => {});
    },
  };
};
