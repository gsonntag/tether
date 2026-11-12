// The browser's WebSocket to the relay: reconnects with backoff, notices a dead link (a phone
// that slept, a network that changed), and carries rpcs. Everything it touches in the browser
// comes in through `LinkDeps`, so the logic is tested without one (link.test.ts).

import { CLOSE_REAUTH, type ServerToBrowser } from "../../shared/protocol";

export type LinkState = "connecting" | "open" | "down";
export type AuthState = "ok" | "signedOut" | "notOwner";

/** The part of WebSocket the link uses. */
export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev: any) => void) | null;
  onmessage: ((ev: any) => void) | null;
  onclose: ((ev: any) => void) | null;
  onerror: ((ev: any) => void) | null;
}

export interface LinkDeps {
  url: string;
  open: (url: string) => SocketLike;
  /** GET /api/me: status, whether it redirected, content type, and the parsed body when JSON */
  me: () => Promise<{ status: number; redirected: boolean; json: boolean; body?: { allowed?: boolean } }>;
  /**
   * GET /api/ws-ticket: a fresh ticket that keeps the socket signed in (server/src/tickets.ts).
   * 401/403 means this person may no longer use the app. Without it the link never renews.
   */
  ticket?: () => Promise<{ status: number; ticket?: string }>;
  now?: () => number;
}

export interface LinkTimings {
  pingMs: number;
  silenceMs: number;
  /** how long a wake-up probe waits for any answer */
  probeMs: number;
  rpcTimeoutMs: number;
  maxBackoffMs: number;
  /** a socket still connecting after this long is abandoned and redialled */
  dialMs: number;
  /** how often an open socket renews its sign-in (the server closes it after 5 minutes without) */
  renewMs: number;
  /** waking renews at once unless the last renew is more recent than this */
  renewWakeMs: number;
}

const OPEN = 1;
/** An rpc's error when no answer came in time. */
export const NO_ANSWER = "No answer in time.";

export const DEFAULT_TIMINGS: LinkTimings = { pingMs: 25_000, silenceMs: 60_000, probeMs: 5_000, rpcTimeoutMs: 130_000, maxBackoffMs: 15_000, dialMs: 10_000, renewMs: 120_000, renewWakeMs: 30_000 };

/** 0.5 s, 1 s, 2 s … up to the cap. */
export const linkBackoff = (attempt: number, max: number) => Math.min(max, 500 * 2 ** Math.min(attempt, 10));

type Handler = (m: any) => void;

export class Link {
  private ws?: SocketLike;
  private attempt = 0;
  private retry?: ReturnType<typeof setTimeout>;
  private pinger?: ReturnType<typeof setInterval>;
  private probe?: ReturnType<typeof setTimeout>;
  private dial?: ReturnType<typeof setTimeout>;
  private lastHeard = 0;
  private renewer?: ReturnType<typeof setInterval>;
  /** the open socket's renewals: one at a time, and none after the server said no */
  private renewal?: { sock: SocketLike; busy: boolean; refused: boolean; last: number };
  private rpcSeq = 0;
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private handlers = new Map<string, Set<Handler>>();
  private stateListeners = new Set<(s: LinkState) => void>();
  private authListeners = new Set<(a: AuthState) => void>();
  private readonly t: LinkTimings;
  private readonly now: () => number;
  state: LinkState = "connecting";

  constructor(
    private deps: LinkDeps,
    timings: Partial<LinkTimings> = {},
  ) {
    this.t = { ...DEFAULT_TIMINGS, ...timings };
    this.now = deps.now ?? Date.now;
  }

  /** Listen for one type of server message. Returns the unsubscribe function. */
  on<T extends ServerToBrowser["t"]>(t: T, fn: (m: Extract<ServerToBrowser, { t: T }>) => void): () => void {
    let set = this.handlers.get(t);
    if (!set) this.handlers.set(t, (set = new Set()));
    set.add(fn);
    return () => void set.delete(fn);
  }

  onState(fn: (s: LinkState) => void) {
    this.stateListeners.add(fn);
    return () => void this.stateListeners.delete(fn);
  }

  onAuth(fn: (a: AuthState) => void) {
    this.authListeners.add(fn);
    return () => void this.authListeners.delete(fn);
  }

  /** Calls an op on a runner through the relay. */
  rpc(runnerId: string, op: string, args: unknown, timeoutMs = this.t.rpcTimeoutMs): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const sock = this.ws;
      if (!sock || sock.readyState !== OPEN || this.state !== "open") return reject(new Error("Not connected."));
      const id = String(++this.rpcSeq);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(NO_ANSWER));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      sock.send(JSON.stringify({ t: "rpc", id, runnerId, op, args }));
    });
  }

  /** Sends a frame that needs no answer (presence); false when not connected. */
  send(frame: unknown): boolean {
    const sock = this.ws;
    if (!sock || sock.readyState !== OPEN || this.state !== "open") return false;
    sock.send(JSON.stringify(frame));
    return true;
  }

  connect() {
    clearTimeout(this.retry);
    const sock = this.deps.open(this.deps.url);
    this.ws = sock;
    let opened = false;
    this.setState("connecting");
    // A phone waking on a dead network can sit in CONNECTING for minutes.
    clearTimeout(this.dial);
    this.dial = setTimeout(() => {
      if (this.ws !== sock || opened) return;
      sock.close();
      this.closed(true); // timed out, not refused: no sign-in check
    }, this.t.dialMs);

    sock.onopen = () => {
      if (this.ws !== sock) return;
      clearTimeout(this.dial);
      opened = true;
      this.attempt = 0;
      this.lastHeard = this.now();
      this.authListeners.forEach((f) => f("ok"));
      this.setState("open");
      this.pinger = setInterval(() => {
        if (this.now() - this.lastHeard > this.t.silenceMs) return this.drop(sock);
        sock.send(JSON.stringify({ t: "ping" }));
      }, this.t.pingMs);
      this.renewal = { sock, busy: false, refused: false, last: 0 };
      this.renew(sock);
      this.renewer = setInterval(() => this.renew(sock), this.t.renewMs);
    };
    sock.onmessage = (ev) => {
      if (this.ws !== sock) return;
      this.lastHeard = this.now();
      clearTimeout(this.probe);
      let m: ServerToBrowser;
      try {
        m = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (m.t === "result") {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        clearTimeout(p.timer);
        if (m.ok) p.resolve(m.data);
        else p.reject(new Error(m.error ?? "Failed."));
        return;
      }
      this.handlers.get(m.t)?.forEach((f) => f(m));
    };
    sock.onclose = (ev) => {
      if (this.ws === sock) this.closed(opened, ev?.code === CLOSE_REAUTH);
    };
    sock.onerror = () => {};
  }

  /**
   * The tab became visible or the device came online: reconnect now instead of waiting out the
   * backoff, and check that a socket that looks open still answers.
   */
  wake() {
    if (!this.ws) {
      this.attempt = 0;
      return this.connect();
    }
    if (this.state === "connecting" && this.ws.readyState !== OPEN) {
      // Stuck dialling on the network we had before sleeping: start over on the current one.
      const stale = this.ws;
      this.ws = undefined;
      stale.close();
      this.attempt = 0;
      return this.connect();
    }
    if (this.ws.readyState !== OPEN || this.state !== "open") return;
    const sock = this.ws;
    // A background tab's timers are throttled: its renewals may have fallen behind.
    if (this.now() - (this.renewal?.last ?? 0) >= this.t.renewWakeMs) this.renew(sock);
    clearTimeout(this.probe);
    sock.send(JSON.stringify({ t: "ping" }));
    this.probe = setTimeout(() => this.drop(sock), this.t.probeMs);
  }

  stop() {
    clearTimeout(this.retry);
    const sock = this.ws;
    this.ws = undefined;
    this.cleanup();
    sock?.close();
  }

  private setState(s: LinkState) {
    this.state = s;
    this.stateListeners.forEach((f) => f(s));
  }

  /** Gives up on a socket that has gone quiet and reconnects now. */
  private drop(sock: SocketLike) {
    if (this.ws !== sock) return;
    sock.close();
    this.closed(true);
    this.attempt = 0;
    this.connect();
  }

  /**
   * Fetches a fresh ticket and hands it to the server over this socket. A refusal (the share was
   * revoked, or they're no longer an owner) stops renewing: the server closes the socket when its
   * last ticket runs out, and the sign-in check shows why.
   */
  private renew(sock: SocketLike) {
    const r = this.renewal;
    const ticket = this.deps.ticket;
    if (!ticket || !r || r.sock !== sock || r.busy || r.refused) return;
    r.busy = true;
    r.last = this.now();
    ticket()
      .then((res) => {
        if (res.status === 401 || res.status === 403) {
          r.refused = true;
          return void this.checkAuth();
        }
        if (res.ticket && this.ws === sock && sock.readyState === OPEN) sock.send(JSON.stringify({ t: "renew", ticket: res.ticket }));
      })
      .catch(() => {}) // offline: the next renewal tries again
      .finally(() => (r.busy = false));
  }

  private cleanup() {
    clearTimeout(this.dial);
    clearInterval(this.pinger);
    clearInterval(this.renewer);
    this.renewal = undefined;
    clearTimeout(this.probe);
    for (const p of this.pending.values()) (clearTimeout(p.timer), p.reject(new Error("Disconnected.")));
    this.pending.clear();
  }

  private closed(wasOpen: boolean, reauth = false) {
    this.ws = undefined;
    this.cleanup();
    this.setState("down");
    // A connection refused outright may be a sign-in problem rather than the network; so is one
    // the server closed because its sign-in wasn't renewed.
    if (!wasOpen || reauth) void this.checkAuth();
    this.retry = setTimeout(() => this.connect(), linkBackoff(this.attempt++, this.t.maxBackoffMs));
  }

  private async checkAuth() {
    try {
      const me = await this.deps.me();
      // Signed out: our 401, or Foliation's edge answering with its sign-in page instead.
      if (me.status === 401 || (me.status < 400 && (me.redirected || !me.json))) return this.authListeners.forEach((f) => f("signedOut"));
      if (me.status >= 400 || !me.body) return;
      const auth: AuthState = me.body.allowed ? "ok" : "notOwner";
      this.authListeners.forEach((f) => f(auth));
    } catch {
      // offline: the network, not the sign-in
    }
  }
}
