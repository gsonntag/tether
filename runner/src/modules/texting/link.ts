// The connection to Photon Spectrum (iMessage): sends texts to one phone and hears that phone's
// replies. One long-lived listener; history Photon replays on connect is skipped.

import type { TextedFile } from "../homeLine";
import type { InboundFile } from "./images";
import { normalPhone, type LinkConfig } from "./store";

export interface Inbound {
  /** its words ("" when it's only an image) */
  text: string;
  /** what came with it (photos, files), not downloaded yet */
  files?: InboundFile[];
  /** parts Tether can't pass on (a voice note, a contact card, a poll, an app card): the person is told once */
  unsupported?: number;
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

/** How long one call to Photon may take (a send, a reaction, opening the chat): a stalled Photon mustn't freeze the texts queue. Tests shorten it. */
export const PHOTON = { ms: 30_000 };

/** The start of `timed`'s error for `what`. */
export const TIMED_OUT = (what: string) => `Photon didn't answer ${what}`;

/** `p`, or a rejection after `ms` ("Photon didn't answer …"): the call itself is left to finish or fail on its own. */
export function timed<T>(p: Promise<T>, what: string, ms = PHOTON.ms): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, no) => {
    timer = setTimeout(() => no(new Error(`${TIMED_OUT(what)} within ${Math.round(ms / 1000)}s`)), ms);
    (timer as { unref?: () => void }).unref?.();
  });
  p.catch(() => {});
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

export type OpenLink = (cfg: LinkConfig, onInbound: (m: Inbound) => void, log: (line: string) => void) => Promise<TextLink>;

/**
 * A sender's Apple address as an E.164 phone number, when it is one: no "@" (an Apple ID email is
 * never a phone, whatever digits it has), only digits, "+", spaces, dashes, dots and parentheses
 * (after a "tel:" or "sms:" prefix, if one is ever used). Else undefined.
 */
export function senderPhone(address: unknown): string | undefined {
  if (typeof address !== "string") return undefined;
  const a = address.trim().replace(/^(?:tel|sms):/i, "");
  if (!a || a.includes("@") || !/^[+\d\s().-]+$/.test(a)) return undefined;
  return normalPhone(a);
}

/** Whether a message is from the person: its sender's address is their phone number, exactly (E.164). */
export function fromOwner(address: unknown, ownerPhone: string): boolean {
  const owner = normalPhone(ownerPhone);
  const sender = senderPhone(address);
  return !!owner && !!sender && sender === owner;
}

/** What the person can send that isn't text or a file: kept as "unsupported", so they hear it didn't go. (Reactions, read receipts and the like aren't messages: ignored.) */
const UNSUPPORTED = new Set(["voice", "contact", "poll", "app"]);

/**
 * A message's text and files: plain, markdown, an attachment, several parts (a photo with words), a
 * threaded reply (with what it answers), or one with an effect; what can't be passed on is counted.
 */
export function inboundOf(content: any): Inbound | undefined {
  if (!content) return undefined;
  if (UNSUPPORTED.has(content.type) || (content.type === "custom" && content.raw?.imessage_type === "unsupported-message"))
    return { text: "", unsupported: 1 };
  if (content.type === "effect") return inboundOf(content.content);
  // A link sent with its preview: the link is the message.
  if (content.type === "richlink") {
    const url = typeof content.url === "string" ? content.url : content.url instanceof URL ? content.url.href : undefined;
    return url ? { text: url } : undefined;
  }
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
    const unsupported = parts.reduce((n, p) => n + (p.unsupported ?? 0), 0);
    return { text: parts.map((p) => p.text).filter((t) => t.trim()).join("\n"), ...(files.length ? { files } : {}), ...(unsupported ? { unsupported } : {}) };
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
  const since = new Date(Date.now() - 2000);
  let stopped = false;

  const closed = (async () => {
    try {
      for await (const [, message] of app.messages) {
        if (message.direction !== "inbound" || message.timestamp < since) continue;
        // Only the person's own number: never an Apple ID email or another country's number that
        // happens to end in the same digits.
        if (!message.sender || !fromOwner(message.sender.id, cfg.phone)) continue;
        const m = inboundOf(message.content);
        if (m) onInbound({ ...m, ...(typeof message.id === "string" ? { id: message.id } : {}), react: async (emoji) => void (await timed(message.react(emoji), "a reaction")) });
      }
    } catch (e: any) {
      if (!stopped) log(`texting: listener ended: ${e?.message ?? e}`);
    }
  })();

  const im = imessage(app);
  let space: Promise<any> | undefined;
  const send = async (content: any): Promise<string | undefined> => {
    space ??= timed(
      im.user(cfg.phone).then((u: any) => im.space.create(u)),
      "opening the chat",
    );
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
