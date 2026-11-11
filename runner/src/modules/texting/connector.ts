// A messaging connector: one way the person and Tether text each other (iMessage through Photon,
// a Discord bot, …). Each one is a file implementing Connector: it knows its own settings (and which
// of them are secrets), opens a link that hears the person's messages and sends Tether's, and nothing
// else. Who a message is for (session numbers, the picker, y/n answers, the Home agent, threaded
// replies) is decided above every connector, once, by the Texter (index.ts) and its Router: a new
// connector gets all of that for free. CONNECTORS (connectors.ts) lists them.
//
// Channel runs one connector's link: connects when it's on and set, reconnects after a drop with
// backoff, and keeps its status (connected, the last error) for settings.

import type { ConnectorForm } from "../../../../shared/protocol";

/** A file the person sent, fetched only when something takes it (texting/index.ts stash). */
export interface InboundFile {
  name: string;
  mimeType: string;
  /** bytes, when the service says */
  size?: number;
  /** its bytes; throws past `max` bytes (and stops fetching), or when it can't be fetched */
  read(max?: number): Promise<Uint8Array>;
}

/** A message from the person. */
export interface Inbound {
  text: string;
  /** its message id, when the service gives one: a message heard twice is taken once */
  id?: string;
  /** the message it answers in a thread */
  replyTo?: string;
  /** puts a reaction on this message (an iMessage tapback, a Discord reaction; any emoji) */
  react?: (emoji: string) => Promise<void>;
  /** files and images that came with it */
  files?: InboundFile[];
  /** the connector it came by (Channel sets it) */
  via?: string;
}

/** What Tether sends: text, and images (absolute paths on the runner) where the connector takes them. */
export interface Outbound {
  text: string;
  images?: string[];
}

/** An open connection. */
export interface ChannelLink {
  /** the sent message's id (or each part's, when it was split), when the service gives one */
  send(out: Outbound): Promise<string | string[] | undefined>;
  /** resolves when the link ends (an error, or stop); a fatal end (a bad token) sets `fatal` before */
  closed: Promise<void>;
  /** why it ended for good: no reconnecting until the settings change */
  fatal?: string;
  stop(): Promise<void>;
}

/** One way to reach the person. */
export interface Connector {
  /** "imessage", "discord": stable, kept in settings */
  readonly id: string;
  /** "iMessage", "Discord" */
  readonly label: string;
  /** what it connects to, for "Couldn't connect to Photon" (the label when unset) */
  readonly service?: string;
  /** what starts the person's words when they reach the Home agent ("[From Discord] ", shared/fromTether.ts) */
  readonly mark: string;
  /** whether it takes images out */
  readonly images?: boolean;
  /** turned on (by its settings or its environment) */
  enabled(): boolean;
  /** everything its link needs is set */
  configured(): boolean;
  /** opens its link when it's on and set; throws when it can't connect */
  open(onInbound: (m: Inbound) => void, log: (line: string) => void): Promise<ChannelLink>;
  /** what settings show and take: never a secret's value */
  forms(): ConnectorForm[];
  /** what settings shows above its forms */
  about: string;
  /** "Set the phone and …": why it can't be tested yet */
  notReady: string;
  /** changes settings (an empty string clears a field; `enabled` turns it on or off); throws on a bad value */
  update(a: { enabled?: unknown; values?: Record<string, unknown> }): void;
}

/** An error retrying can't fix (a refused token, intents not allowed): the link stays down until the settings change. */
export class FatalError extends Error {
  readonly fatal = true;
}

export const isFatal = (e: unknown): boolean => !!(e && typeof e === "object" && (e as { fatal?: unknown }).fatal === true);

const RETRY_MIN_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;

/** One connector's link, kept up. */
export class Channel {
  private link?: ChannelLink;
  private connecting?: Promise<void>;
  private retry?: ReturnType<typeof setTimeout>;
  private delay = RETRY_MIN_MS;
  private stopped = false;
  connected = false;
  lastError?: string;

  constructor(
    readonly connector: Connector,
    private onInbound: (m: Inbound) => void,
    private log: (line: string) => void,
  ) {}

  get id() {
    return this.connector.id;
  }

  /** Connects when it's on and set; reconnects after a drop, backing off. */
  start(): Promise<void> {
    this.stopped = false;
    if (this.link || this.connecting) return this.connecting ?? Promise.resolve();
    if (!this.connector.enabled() || !this.connector.configured()) return Promise.resolve();
    this.connecting = (async () => {
      try {
        const link = await this.connector.open((m) => this.onInbound({ ...m, via: this.id }), this.log);
        if (this.stopped) return void (await link.stop());
        this.link = link;
        this.connected = true;
        this.lastError = undefined;
        this.delay = RETRY_MIN_MS;
        void link.closed.then(() => this.dropped(link));
      } catch (e: any) {
        this.lastError = `Couldn't connect to ${this.connector.service ?? this.connector.label}: ${e?.message ?? e}`;
        this.log(`texting: ${this.lastError}`);
        // Retrying won't help: down, with why, until the settings change (restart).
        if (!isFatal(e)) this.later();
      } finally {
        this.connecting = undefined;
      }
    })();
    return this.connecting;
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.retry);
    await this.connecting;
    const link = this.link;
    this.link = undefined;
    this.connected = false;
    await link?.stop();
  }

  /** Settings changed: a new link with them (or none). */
  async restart() {
    await this.stop();
    this.lastError = undefined;
    this.delay = RETRY_MIN_MS;
    await this.start();
  }

  /** Sends on the link; throws when it didn't go. */
  async send(out: Outbound): Promise<string[]> {
    if (!this.link) throw new Error("not connected");
    try {
      const id = await this.link.send(this.connector.images ? out : { text: out.text });
      return id === undefined ? [] : Array.isArray(id) ? id : [id];
    } catch (e: any) {
      this.lastError = `Couldn't send a text: ${e?.message ?? e}`;
      this.log(`texting: ${this.connector.label}: ${this.lastError}`);
      throw e;
    }
  }

  private dropped(link: ChannelLink) {
    if (this.link !== link) return;
    this.link = undefined;
    this.connected = false;
    if (link.fatal) {
      this.lastError = link.fatal;
      this.log(`texting: ${this.connector.label}: ${link.fatal}`);
      return;
    }
    if (!this.stopped) this.later();
  }

  private later() {
    if (this.stopped) return;
    clearTimeout(this.retry);
    this.retry = setTimeout(() => void this.start(), this.delay);
    this.delay = Math.min(this.delay * 2, RETRY_MAX_MS);
  }
}
