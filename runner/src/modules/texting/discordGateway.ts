// Discord's transport, with no library: the Gateway (a WebSocket that pushes events: hello,
// identify, heartbeats, resume after a drop, reconnect with backoff) and the REST API through fetch.
// The socket and fetch are passed in, so tests drive both (discord.test.ts). discord.ts is the
// connector on top.
// Gateway: https://discord.com/developers/docs/events/gateway

/** GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT */
export const INTENTS = (1 << 9) | (1 << 12) | (1 << 15);
export const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
export const API_URL = "https://discord.com/api/v10";
/** Discord's limit on one message's content. */
export const MESSAGE_MAX = 2000;

/** Close codes that end it for good: the settings must change first. */
const FATAL: Record<number, string> = {
  4004: "Discord turned down the bot token. Reset it in the Developer Portal and save the new one.",
  4010: "Discord says the shard is invalid.",
  4011: "Discord wants the bot sharded (it's in too many servers).",
  4012: "Discord says the gateway version is invalid.",
  4013: "Discord says the intents are invalid.",
  4014: "Discord refused the intents: turn on Message Content Intent under Bot in the Developer Portal.",
};
/** Close codes after which the session can't be resumed: identify again. */
const FRESH = new Set([4007, 4009]);

/** The part of a WebSocket the gateway uses (the browser's, which Bun has). */
export interface Socket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((e: unknown) => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onclose: ((e: { code: number; reason?: string }) => void) | null;
  onerror: ((e: unknown) => void) | null;
}

export type OpenSocket = (url: string) => Socket;

export interface GatewayOptions {
  socket?: OpenSocket;
  /** how long the first connection may take to be ready */
  readyMs?: number;
  /** the first wait before reconnecting; it doubles up to reconnectMaxMs */
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  /** the wait after an invalid session (Discord asks for 1 to 5 seconds) */
  invalidMs?: number;
  random?: () => number;
  log?: (line: string) => void;
}

/** One gateway connection, kept up (resumed after a drop) until stop or a fatal close. */
export class Gateway {
  private ws?: Socket;
  private seq: number | null = null;
  private sessionId?: string;
  private resumeUrl?: string;
  private beat?: ReturnType<typeof setTimeout>;
  private acked = true;
  private stopped = false;
  private retry?: ReturnType<typeof setTimeout>;
  private delay: number;
  private ended!: () => void;
  /** why it ended for good */
  fatal?: string;
  /** the bot's own user, from READY */
  self?: { id: string; username?: string };
  /** resolves when it ends (stop, or a fatal close) */
  readonly closed = new Promise<void>((r) => (this.ended = r));
  /** how many times it connected (tests) */
  connects = 0;

  private o: Required<Omit<GatewayOptions, "log">> & { log: (line: string) => void };

  constructor(
    private token: string,
    private onDispatch: (type: string, data: any) => void,
    o: GatewayOptions = {},
  ) {
    this.o = {
      socket: o.socket ?? ((url) => new WebSocket(url) as unknown as Socket),
      readyMs: o.readyMs ?? 30_000,
      reconnectMinMs: o.reconnectMinMs ?? 1_000,
      reconnectMaxMs: o.reconnectMaxMs ?? 60_000,
      invalidMs: o.invalidMs ?? 1_000 + Math.floor(Math.random() * 4_000),
      random: o.random ?? Math.random,
      log: o.log ?? (() => {}),
    };
    this.delay = this.o.reconnectMinMs;
  }

  /** Connects; resolves once Discord says it's ready, throws when the first connection fails. */
  start(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => fail(new Error("Discord didn't answer.")), this.o.readyMs);
      const done = () => (clearTimeout(timer), (this.whenReady = undefined), (this.whenFailed = undefined));
      const fail = (e: Error) => {
        done();
        this.stop();
        reject(e);
      };
      this.whenReady = () => (done(), resolve());
      this.whenFailed = fail;
      this.connect();
    });
  }

  private whenReady?: () => void;
  private whenFailed?: (e: Error) => void;

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.retry);
    clearTimeout(this.beat);
    const ws = this.ws;
    this.ws = undefined;
    try {
      ws?.close(1000, "bye");
    } catch {}
    this.ended();
  }

  private connect() {
    if (this.stopped) return;
    const resuming = !!(this.sessionId && this.resumeUrl);
    const base = resuming ? this.resumeUrl! : GATEWAY_URL;
    const url = resuming ? `${base.replace(/\/?(\?.*)?$/, "")}/?v=10&encoding=json` : base;
    let ws: Socket;
    try {
      ws = this.o.socket(url);
    } catch (e: any) {
      return this.dropped(undefined, `couldn't open the gateway: ${e?.message ?? e}`);
    }
    this.ws = ws;
    this.connects++;
    this.acked = true;
    ws.onmessage = (e) => {
      if (this.ws !== ws) return;
      let p: any;
      try {
        p = JSON.parse(typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data as ArrayBuffer));
      } catch {
        return;
      }
      this.packet(ws, p);
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.dropped(e.code, e.reason);
    };
    ws.onerror = () => {};
  }

  private send(ws: Socket, p: unknown) {
    try {
      ws.send(JSON.stringify(p));
    } catch {}
  }

  private packet(ws: Socket, p: { op: number; d: any; s?: number | null; t?: string | null }) {
    if (typeof p.s === "number") this.seq = p.s;
    switch (p.op) {
      case 10: {
        // Hello: heartbeat on its interval (the first after a random part of it), then identify or resume.
        const every = Number(p.d?.heartbeat_interval) || 41_250;
        this.heartbeat(ws, every, every * this.o.random());
        if (this.sessionId && this.resumeUrl) this.send(ws, { op: 6, d: { token: this.token, session_id: this.sessionId, seq: this.seq } });
        else this.send(ws, { op: 2, d: { token: this.token, intents: INTENTS, properties: { os: process.platform, browser: "tether", device: "tether" } } });
        return;
      }
      case 11:
        this.acked = true;
        return;
      case 1:
        this.send(ws, { op: 1, d: this.seq });
        return;
      case 7:
        // Reconnect: resume on a new connection.
        return this.reopen(ws, 4000);
      case 9: {
        // Invalid session: resume if Discord says it can be, else start over, after a short wait.
        if (!p.d) this.forget();
        this.ws = undefined;
        try {
          ws.close(4000, "invalid session");
        } catch {}
        clearTimeout(this.beat);
        clearTimeout(this.retry);
        this.retry = setTimeout(() => this.connect(), this.o.invalidMs);
        return;
      }
      case 0: {
        if (p.t === "READY") {
          this.sessionId = p.d?.session_id;
          this.resumeUrl = p.d?.resume_gateway_url;
          this.self = p.d?.user ? { id: String(p.d.user.id), username: p.d.user.username } : undefined;
          this.delay = this.o.reconnectMinMs;
          this.whenReady?.();
        } else if (p.t === "RESUMED") {
          this.delay = this.o.reconnectMinMs;
        }
        if (p.t) {
          try {
            this.onDispatch(p.t, p.d);
          } catch (e: any) {
            this.o.log(`discord: ${e?.message ?? e}`);
          }
        }
        return;
      }
    }
  }

  private heartbeat(ws: Socket, every: number, first: number) {
    clearTimeout(this.beat);
    const tick = () => {
      if (this.ws !== ws) return;
      // No ack since the last one: the connection is a zombie. Resume on a new one.
      if (!this.acked) return this.reopen(ws, 4000);
      this.acked = false;
      this.send(ws, { op: 1, d: this.seq });
      this.beat = setTimeout(tick, every);
    };
    this.beat = setTimeout(tick, first);
  }

  /** Closes this connection and resumes on a new one, now. */
  private reopen(ws: Socket, code: number) {
    this.ws = undefined;
    clearTimeout(this.beat);
    try {
      ws.close(code, "reconnect");
    } catch {}
    this.connect();
  }

  private forget() {
    this.sessionId = undefined;
    this.resumeUrl = undefined;
    this.seq = null;
  }

  private dropped(code?: number, reason?: string) {
    this.ws = undefined;
    clearTimeout(this.beat);
    if (this.stopped) return;
    const fatal = code !== undefined ? FATAL[code] : undefined;
    if (fatal) {
      this.fatal = fatal;
      this.o.log(`discord: ${fatal}`);
      if (this.whenFailed) return this.whenFailed(new Error(fatal));
      return this.stop();
    }
    if (this.whenFailed) return this.whenFailed(new Error(`the gateway closed${code ? ` (${code}${reason ? `: ${reason}` : ""})` : reason ? `: ${reason}` : ""}`));
    if (code !== undefined && FRESH.has(code)) this.forget();
    this.o.log(`discord: gateway closed (${code ?? "?"}), reconnecting in ${Math.round(this.delay / 1000)}s`);
    clearTimeout(this.retry);
    this.retry = setTimeout(() => this.connect(), this.delay);
    this.delay = Math.min(this.delay * 2, this.o.reconnectMaxMs);
  }
}

/** Discord's REST API, through fetch. */
export class Rest {
  constructor(
    private token: string,
    private fetcher: typeof fetch = fetch,
    private base = API_URL,
  ) {}

  /** A request; JSON back (or null). Waits out a 429 (up to three times, at most 10 s each). */
  async call(method: string, path: string, body?: unknown): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      const form = body instanceof FormData;
      const r = await this.fetcher(`${this.base}${path}`, {
        method,
        headers: { Authorization: `Bot ${this.token}`, "User-Agent": "DiscordBot (tether, 0.2)", ...(body !== undefined && !form ? { "Content-Type": "application/json" } : {}) },
        ...(body !== undefined ? { body: form ? body : JSON.stringify(body) } : {}),
      });
      if (r.status === 429 && attempt < 3) {
        const v = await r.json().catch(() => ({}));
        const wait = Math.min(Number(v?.retry_after ?? r.headers.get("retry-after") ?? 1), 10);
        await new Promise((res) => setTimeout(res, wait * 1000));
        continue;
      }
      if (!r.ok) {
        const v = await r.json().catch(() => undefined);
        throw new Error(`Discord answered ${r.status}${v?.message ? `: ${v.message}` : ""}`);
      }
      return r.status === 204 ? null : r.json().catch(() => null);
    }
  }

  /** The DM channel with a user (the bot and they must share a server, or they installed it). */
  async dm(userId: string): Promise<string> {
    const c = await this.call("POST", "/users/@me/channels", { recipient_id: userId });
    if (!c?.id) throw new Error("Discord didn't open a DM.");
    return String(c.id);
  }

  /** Posts a message (with files: multipart, each attached); its id. Mentions never ping anyone. */
  async post(channelId: string, content: string, files: { name: string; data: Uint8Array; type: string }[] = []): Promise<string | undefined> {
    const payload = { content, allowed_mentions: { parse: [] as string[] } };
    let body: unknown = payload;
    if (files.length) {
      const fd = new FormData();
      fd.append("payload_json", JSON.stringify({ ...payload, attachments: files.map((f, i) => ({ id: i, filename: f.name })) }));
      files.forEach((f, i) => fd.append(`files[${i}]`, new Blob([f.data as Uint8Array<ArrayBuffer>], { type: f.type }), f.name));
      body = fd;
    }
    const m = await this.call("POST", `/channels/${channelId}/messages`, body);
    return m?.id ? String(m.id) : undefined;
  }

  async react(channelId: string, messageId: string, emoji: string) {
    await this.call("PUT", `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`);
  }
}
