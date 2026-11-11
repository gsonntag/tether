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
  /** where on that connector it was written, when there's more than one place (a Discord DM or channel): an answer goes back there */
  place?: string;
  /** that place is shared (a server channel others read): only the answer of the turn it started goes there (texting/index.ts) */
  shared?: boolean;
}

/** What Tether sends: text, and images (absolute paths on the runner) where the connector takes them. */
export interface Outbound {
  text: string;
  images?: string[];
  /** it answers a message written at this place (Inbound.place): it may go there; anything else goes to the person's private one */
  place?: string;
  /** the place is shared (a channel): set only for the direct answer to a message written there */
  shared?: boolean;
}

/** A send that went partly (a long message split, a later part failed): the parts that went. */
export class PartialSend extends Error {
  constructor(
    message: string,
    readonly ids: string[],
  ) {
    super(message);
  }
}

/** An open connection. */
export interface ChannelLink {
  /** the sent message's id (or each part's, when it was split), when the service gives one */
  send(out: Outbound): Promise<string | string[] | undefined>;
  /** resolves when the link ends (an error, or stop); a fatal end (a bad token) sets `fatal` before */
  closed: Promise<void>;
  /** why it ended for good: no reconnecting until the settings change */
  fatal?: string;
  /** whether it can send right now (a Discord gateway between drops); always, when unset */
  up?(): boolean;
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
  /** how long a settings change waits for its old link to close before connecting again (Channel's 3 s when unset) */
  readonly stopWaitMs?: number;
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
  lastError?: string;

  constructor(
    readonly connector: Connector,
    private onInbound: (m: Inbound) => void,
    private log: (line: string) => void,
    /** how long a settings change waits for the old link to close before connecting again */
    private stopWaitMs = 3_000,
  ) {}

  get id() {
    return this.connector.id;
  }

  /** Its link is open and up. */
  get connected(): boolean {
    return !!this.link && (this.link.up?.() ?? true);
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
    await link?.stop();
  }

  /** Settings changed: a new link with them (or none). The old one closes in the background. */
  async restart() {
    this.stopped = true;
    clearTimeout(this.retry);
    await this.connecting;
    const old = this.link;
    this.link = undefined;
    // Two clients at once (Photon) can fight over the line: wait for the old one to close, but not long.
    if (old) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([old.stop().catch(() => {}), new Promise((r) => (timer = setTimeout(r, this.connector.stopWaitMs ?? this.stopWaitMs)))]);
      clearTimeout(timer);
    }
    this.lastError = undefined;
    this.delay = RETRY_MIN_MS;
    await this.start();
  }

  /** Sends on the link; throws when it didn't go. */
  async send(out: Outbound): Promise<string[]> {
    if (!this.link || !this.connected) throw new Error("not connected");
    try {
      const id = await this.link.send(this.connector.images ? out : { text: out.text, ...(out.place ? { place: out.place } : {}), ...(out.shared ? { shared: true } : {}) });
      return id === undefined ? [] : Array.isArray(id) ? id : [id];
    } catch (e: any) {
      this.lastError = `Couldn't send a text: ${e?.message ?? e}`;
      this.log(`texting: ${this.connector.label}: ${this.lastError}`);
      // Some of it went: those are sent (a reply to them still finds its session).
      if (e instanceof PartialSend && e.ids.length) return e.ids;
      throw e;
    }
  }

  private dropped(link: ChannelLink) {
    if (this.link !== link) return;
    this.link = undefined;
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
