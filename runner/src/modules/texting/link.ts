// The connection to Photon Spectrum (iMessage): sends texts to one phone and hears that phone's
// replies. One long-lived listener; history Photon replays on connect is skipped.

import type { TextedFile } from "../homeLine";
import type { InboundFile } from "./images";
import type { LinkConfig } from "./store";

export interface Inbound {
  /** its words ("" when it's only an image) */
  text: string;
  /** what came with it (photos, files), not downloaded yet */
  files?: InboundFile[];
  /** its message id, when Photon gives one: a text heard twice is taken once */
  id?: string;
  /** the message it answers in a thread */
  replyTo?: string;
  /** puts a reaction on this message on the person's phone (a tapback; any emoji) */
  react?: (emoji: string) => Promise<void>;
}

export interface TextLink {
  /** the sent message's id, when Photon gives one */
  send(text: string): Promise<string | undefined>;
  /** sends a file (an image) as its own message; its id, when Photon gives one */
  sendFile?(f: TextedFile): Promise<string | undefined>;
  /** resolves when the listener ends (an error, or stop) */
  closed: Promise<void>;
  stop(): Promise<void>;
}

export type OpenLink = (cfg: LinkConfig, onInbound: (m: Inbound) => void, log: (line: string) => void) => Promise<TextLink>;

const digits = (s: string) => s.replace(/\D/g, "").slice(-10);

/** A message's text and files: plain, markdown, an attachment, several parts (a photo with words), or a threaded reply (with what it answers). */
export function inboundOf(content: any): Inbound | undefined {
  if (!content) return undefined;
  if (content.type === "text" && typeof content.text === "string") return { text: content.text };
  if (content.type === "markdown" && typeof content.markdown === "string") return { text: content.markdown };
  if (content.type === "attachment" && typeof content.read === "function") {
    const file: InboundFile = {
      name: typeof content.name === "string" ? content.name : "",
      mimeType: typeof content.mimeType === "string" ? content.mimeType : "application/octet-stream",
      ...(typeof content.size === "number" ? { size: content.size } : {}),
      read: () => content.read(),
      ...(typeof content.stream === "function" ? { stream: () => content.stream() } : {}),
    };
    return { text: "", files: [file] };
  }
  if (content.type === "group" && Array.isArray(content.items)) {
    const parts = content.items.map((i: any) => inboundOf(i?.content)).filter(Boolean) as Inbound[];
    if (!parts.length) return undefined;
    const files = parts.flatMap((p) => p.files ?? []);
    return { text: parts.map((p) => p.text).filter((t) => t.trim()).join("\n"), ...(files.length ? { files } : {}) };
  }
  if (content.type === "reply") {
    const inner = inboundOf(content.content);
    return inner && { ...inner, replyTo: typeof content.target?.id === "string" ? content.target.id : undefined };
  }
  return undefined;
}

export const openSpectrum: OpenLink = async (cfg, onInbound, log) => {
  const { Spectrum, attachment } = await import("spectrum-ts");
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
        if (m) onInbound({ ...m, ...(typeof message.id === "string" ? { id: message.id } : {}), react: async (emoji) => void (await message.react(emoji)) });
      }
    } catch (e: any) {
      if (!stopped) log(`texting: listener ended: ${e?.message ?? e}`);
    }
  })();

  const im = imessage(app);
  let space: Promise<any> | undefined;
  const send = async (content: any): Promise<string | undefined> => {
    space ??= im.user(cfg.phone).then((u: any) => im.space.create(u));
    try {
      const sent = await (await space).send(content);
      return typeof sent?.id === "string" ? sent.id : undefined;
    } catch (e) {
      space = undefined;
      throw e;
    }
  };
  return {
    send: (text) => send(text),
    // The bytes checked (images.ts), not the path: what was checked is what goes.
    sendFile: (f) => send(attachment(f.data, { name: f.name, mimeType: f.mimeType })),
    closed,
    async stop() {
      stopped = true;
      await app.stop().catch(() => {});
    },
  };
};
