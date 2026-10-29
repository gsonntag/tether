// The runner's one connection to the app: it dials out (so the machine needs no inbound port),
// says hello, answers rpcs, and keeps reconnecting with backoff for as long as it runs.
//
// Nothing is queued while disconnected. The server forgets every route when a runner goes away,
// so on reconnect browsers subscribe again and get fresh snapshots (SPEC §5). An answer to an rpc
// that came in on an older connection is dropped: the server that asked has forgotten it, and its
// id may now name a different rpc.

import { capEvent, guardFrame } from "../../../shared/limits";
import { CLOSE_PROTOCOL, CLOSE_REPLACED, type PushKeys, type RunnerInfo, type RunnerToServer, type ServerToRunner } from "../../../shared/protocol";

export interface ConnectionOptions {
  /** the app's base URL, e.g. https://tether--me.foliation.dev or http://localhost:8790 */
  url: string;
  token: string;
  /** what to say in hello, asked on every connect */
  hello: () => Promise<Omit<RunnerInfo, "connectedAt">>;
  onRpc: (op: string, args: unknown) => Promise<{ ok: true; data: unknown } | { ok: false; error: string }>;
  onDetach?: (attachIds: string[]) => void;
  /** no browser watches these sessions any more */
  onUnwatched?: (sessionIds: string[]) => void;
  /** connected, after hello (with the app's push keys, when it has them); or disconnected */
  onState?: (connected: boolean, push?: PushKeys) => void;
  /** which devices look at which sessions (presence) */
  onViewers?: (sessions: Record<string, string[]>) => void;
  log?: (line: string) => void;
  heartbeatMs?: number;
  /** no frame from the server for this long means the connection is dead */
  silenceMs?: number;
  /** a connection that hasn't opened by then is abandoned and retried */
  dialTimeoutMs?: number;
  /** how long to wait after another runner with our id replaced us */
  replacedBackoffMs?: number;
  /** how long to wait after the server refused our protocol version */
  protocolBackoffMs?: number;
  WebSocket?: typeof WebSocket;
  fetch?: typeof fetch;
}

/** 1 s, 2 s, 4 s … up to 30 s, each ±20% so a fleet of runners doesn't reconnect in lockstep. */
export function backoffDelay(attempt: number, random = Math.random): number {
  const base = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 10));
  return Math.round(base * (0.8 + 0.4 * random()));
}

export class Connection {
  private ws?: WebSocket;
  private attempt = 0;
  private retry?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private lastHeard = 0;
  private stopped = false;
  private ready = false;
  private helloName = "";
  private readonly log: (line: string) => void;
  private readonly WS: typeof WebSocket;
  private readonly fetch: typeof fetch;

  constructor(private opts: ConnectionOptions) {
    this.log = opts.log ?? ((l) => console.log(l));
    this.WS = opts.WebSocket ?? WebSocket;
    this.fetch = opts.fetch ?? fetch;
  }

  get connected() {
    return this.ready;
  }

  start() {
    this.stopped = false;
    this.dial();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retry);
    const ws = this.ws;
    this.drop(ws);
    ws?.close(1001, "runner stopping");
  }

  /** Bytes waiting in the socket's send buffer (a terminal stream that falls behind ends, attach.ts). */
  buffered(): number {
    return this.ws?.bufferedAmount ?? 0;
  }

  /**
   * Sends on the current connection; false (and nothing sent) when there isn't one. Session events
   * are capped, and nothing over the frame limit ever goes out (shared/limits.ts).
   */
  send(m: RunnerToServer): boolean {
    const ws = this.ws;
    if (!this.ready || !ws || ws.readyState !== WebSocket.OPEN) return false;
    if (m.t === "event") m = { ...m, event: capEvent(m.event) };
    this.write(ws, m);
    return true;
  }

  private write(ws: WebSocket, m: RunnerToServer) {
    const { frame, replaced } = guardFrame(m);
    if (replaced) this.log(`a ${m.t} frame was too large to send; ${frame === null ? "dropped it" : `sent ${m.t === "event" ? "resync" : "an error"} instead`}`);
    if (frame !== null) ws.send(frame);
  }

  private dial() {
    const target = this.opts.url.replace(/^http/, "ws").replace(/\/$/, "") + "/api/runner";
    let opened = false;
    let sock: WebSocket;
    try {
      // Bun's WebSocket takes headers; a browser's wouldn't, but this only runs in Bun.
      sock = new this.WS(target, { headers: { Authorization: `Bearer ${this.opts.token}` } } as any);
    } catch (e: any) {
      this.log(`can't connect to ${target}: ${e?.message ?? e}`);
      return this.scheduleRetry();
    }
    this.ws = sock;
    // A dial that hangs (a black-holed network) would otherwise wait on the OS's TCP timeout.
    const dialTimer = setTimeout(() => {
      if (opened || this.ws !== sock) return;
      this.log(`no answer from ${target} in ${Math.round((this.opts.dialTimeoutMs ?? 15_000) / 1000)}s`);
      this.drop(sock);
      sock.close();
      this.scheduleRetry();
    }, this.opts.dialTimeoutMs ?? 15_000);

    sock.onopen = async () => {
      clearTimeout(dialTimer);
      opened = true;
      this.lastHeard = Date.now();
      let runner: Omit<RunnerInfo, "connectedAt">;
      try {
        runner = await this.opts.hello();
      } catch (e: any) {
        this.log(`hello failed: ${e?.message ?? e}`);
        return sock.close(1011, "hello failed");
      }
      if (this.ws !== sock || sock.readyState !== WebSocket.OPEN) return;
      sock.send(JSON.stringify({ t: "hello", runner } satisfies RunnerToServer));
      this.helloName = `${runner.name} (${runner.id})`;
      // Keepalive from the start: a server that never answers the hello is caught like any silence.
      this.heartbeat = setInterval(() => this.beat(sock), this.opts.heartbeatMs ?? 20_000);
    };

    sock.onmessage = (ev) => {
      if (this.ws !== sock) return;
      this.lastHeard = Date.now();
      let m: ServerToRunner;
      try {
        m = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (m.t === "welcome") {
        if (this.ready) return; // a repeated hello's answer
        // Connected only now, and only now is the backoff reset: a server that accepts the socket
        // but refuses the hello must not be retried every second.
        this.ready = true;
        this.attempt = 0;
        this.log(`connected to ${this.opts.url} as ${this.helloName}`);
        this.opts.onState?.(true, m.push);
      } else if (m.t === "viewers") this.opts.onViewers?.(m.sessions ?? {});
      else if (m.t === "rpc") void this.answer(sock, m.id, m.op, m.args);
      else if (m.t === "detach") this.opts.onDetach?.(m.attachIds);
      else if (m.t === "unwatched") this.opts.onUnwatched?.(m.sessionIds);
    };

    sock.onclose = (ev) => {
      clearTimeout(dialTimer);
      if (this.ws !== sock) return;
      const was = this.ready;
      this.drop(sock);
      if (this.stopped) return;
      if (ev.code === CLOSE_REPLACED) {
        // Another runner said hello with our id. Reconnecting right away would only replace it in
        // turn, and the two would take turns forever: wait long, and say why.
        const wait = this.opts.replacedBackoffMs ?? 60_000;
        this.log(`another runner connected with this runner's id (${ev.reason}). Each runner needs its own runnerId in runner.json. Retrying in ${wait / 1000}s.`);
        return this.scheduleRetry(wait);
      }
      if (ev.code === CLOSE_PROTOCOL) {
        // Retrying won't help until one side is updated; keep trying rarely in case the app is.
        const wait = this.opts.protocolBackoffMs ?? 5 * 60_000;
        this.log(`the server refused this runner: ${ev.reason}. Retrying in ${wait / 1000}s.`);
        return this.scheduleRetry(wait);
      }
      if (was || opened) this.log(`disconnected (${ev.code}${ev.reason ? ` ${ev.reason}` : ""})`);
      else void this.diagnose();
      this.scheduleRetry();
    };
    sock.onerror = () => {};
  }

  private async answer(sock: WebSocket, id: string, op: string, args: unknown) {
    const r = await this.opts.onRpc(op, args);
    if (this.ws !== sock || sock.readyState !== WebSocket.OPEN) return;
    this.write(sock, { t: "result", id, ...r });
  }

  private beat(sock: WebSocket) {
    if (this.ws !== sock) return;
    const silent = Date.now() - this.lastHeard;
    if (silent > (this.opts.silenceMs ?? 60_000)) {
      // A half-open connection (the network dropped without a FIN) may never fire close by itself.
      this.log(`no word from the server in ${Math.round(silent / 1000)}s; reconnecting`);
      this.drop(sock);
      sock.close(4001, "silent");
      return this.scheduleRetry();
    }
    sock.send(JSON.stringify({ t: "ping" } satisfies RunnerToServer));
  }

  /** Forgets a connection: no more frames from it count, and nothing more is sent on it. */
  private drop(sock: WebSocket | undefined) {
    if (!sock || this.ws !== sock) return;
    this.ws = undefined;
    clearInterval(this.heartbeat);
    if (this.ready) {
      this.ready = false;
      this.opts.onState?.(false);
    }
  }

  private scheduleRetry(delay = backoffDelay(this.attempt++)) {
    if (this.stopped) return;
    clearTimeout(this.retry);
    this.log(`retrying in ${(delay / 1000).toFixed(1)}s`);
    this.retry = setTimeout(() => this.dial(), delay);
  }

  /** The upgrade failed before opening: say why, as far as plain HTTP can tell. */
  private async diagnose() {
    const url = this.opts.url.replace(/\/$/, "") + "/api/runner";
    try {
      const res = await this.fetch(url, { headers: { Authorization: `Bearer ${this.opts.token}` }, signal: AbortSignal.timeout(10_000) });
      if (res.status === 401 || res.status === 403) this.log(`the server refused TETHER_TOKEN (${res.status}): check the token and that it's a runner service token`);
      else this.log(`couldn't open a WebSocket to ${url} (HTTP ${res.status})`);
    } catch (e: any) {
      this.log(`can't reach ${url}: ${e?.message ?? e}`);
    }
  }
}
