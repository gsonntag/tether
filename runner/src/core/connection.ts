// The runner's one connection to the app: it dials out (so the machine needs no inbound port),
// says hello, answers rpcs, and keeps reconnecting with backoff for as long as it runs.
//
// Nothing is queued while disconnected. The server forgets every route when a runner goes away,
// so on reconnect browsers subscribe again and get fresh snapshots (SPEC §5). An answer to an rpc
// that came in on an older connection is dropped: the server that asked has forgotten it, and its
// id may now name a different rpc.

import type { RunnerInfo, RunnerToServer, ServerToRunner } from "../../../shared/protocol";

export interface ConnectionOptions {
  /** the app's base URL, e.g. https://tether--me.foliation.dev or http://localhost:8790 */
  url: string;
  token: string;
  /** what to say in hello, asked on every connect */
  hello: () => Promise<Omit<RunnerInfo, "connectedAt">>;
  onRpc: (op: string, args: unknown) => Promise<{ ok: true; data: unknown } | { ok: false; error: string }>;
  onDetach?: (attachIds: string[]) => void;
  /** connected, after hello; or disconnected */
  onState?: (connected: boolean) => void;
  log?: (line: string) => void;
  heartbeatMs?: number;
  /** no frame from the server for this long means the connection is dead */
  silenceMs?: number;
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

  /** Sends on the current connection; false (and nothing sent) when there isn't one. */
  send(m: RunnerToServer): boolean {
    const ws = this.ws;
    if (!this.ready || !ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(m));
    return true;
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

    sock.onopen = async () => {
      opened = true;
      this.attempt = 0;
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
      this.ready = true;
      this.log(`connected to ${this.opts.url} as ${runner.id}`);
      this.opts.onState?.(true);
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
      if (m.t === "rpc") void this.answer(sock, m.id, m.op, m.args);
      else if (m.t === "detach") this.opts.onDetach?.(m.attachIds);
    };

    sock.onclose = (ev) => {
      if (this.ws !== sock) return;
      const was = this.ready;
      this.drop(sock);
      if (this.stopped) return;
      if (was || opened) this.log(`disconnected (${ev.code}${ev.reason ? ` ${ev.reason}` : ""})`);
      else void this.diagnose();
      this.scheduleRetry();
    };
    sock.onerror = () => {};
  }

  private async answer(sock: WebSocket, id: string, op: string, args: unknown) {
    const r = await this.opts.onRpc(op, args);
    if (this.ws !== sock || sock.readyState !== WebSocket.OPEN) return;
    sock.send(JSON.stringify({ t: "result", id, ...r } satisfies RunnerToServer));
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

  private scheduleRetry() {
    if (this.stopped) return;
    clearTimeout(this.retry);
    const delay = backoffDelay(this.attempt++);
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
