// JSON-RPC with Codex's app-server daemon over its control socket (SPEC §6): requests out,
// answers back by id, notifications, and the daemon's own requests to the client (approvals,
// questions), which a handler answers. One connection per live thread plus one shared connection
// for discovery and history; the daemon fans every thread event out to every connection
// subscribed to the thread.

import { homedir } from "node:os";
import { join } from "node:path";
import { UnixWebSocket } from "./ws";

export const DAEMON_SOCKET = process.env.CODEX_DAEMON_SOCKET ?? join(homedir(), ".codex", "app-server-control", "app-server-control.sock");

export interface RpcError extends Error {
  code?: number;
}

/** What answers the daemon's requests; undefined means Tether doesn't handle that method. */
export type ServerRequestHandler = (method: string, params: any, id: number | string) => Promise<unknown> | undefined;

/** Anything that carries JSON text both ways (the daemon's WebSocket, or a test double). */
export interface Wire {
  send(text: string): void;
  close(): void;
}

export class CodexRpc {
  private nextId = 0;
  private waits = new Map<number, { res: (v: any) => void; rej: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private notifyHandlers = new Set<(method: string, params: any) => void>();
  private closeHandlers = new Set<(reason: string) => void>();
  onRequest?: ServerRequestHandler;
  closed = false;
  wire?: Wire;

  /** Connects to the daemon and says hello (initialize). */
  static async connect(name = "tether", socketPath = DAEMON_SOCKET): Promise<CodexRpc> {
    const rpc = new CodexRpc();
    const ws = await UnixWebSocket.connect(socketPath, { message: (t) => rpc.receive(t), close: (r) => rpc.ended(r) }).catch((e: any) => {
      const gone = e?.code === "ENOENT" || e?.code === "ECONNREFUSED";
      throw new Error(gone ? "The Codex daemon isn't running. Start it with `codex app-server daemon start`." : String(e?.message ?? e));
    });
    rpc.wire = ws;
    try {
      await rpc.initialize(name);
    } catch (e) {
      ws.close();
      throw e;
    }
    return rpc;
  }

  async initialize(name: string) {
    await this.call("initialize", { clientInfo: { name, title: "Tether", version: "2" }, capabilities: { experimentalApi: true } }, 20_000);
    this.notify("initialized");
  }

  /** Feeds one text frame from the daemon. */
  receive(text: string) {
    let m: any;
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    if (m.id !== undefined && m.method) return this.serverRequest(m);
    if (m.id !== undefined) {
      const w = this.waits.get(m.id);
      if (!w) return;
      this.waits.delete(m.id);
      clearTimeout(w.timer);
      if (m.error) {
        const e: RpcError = new Error(m.error.message ?? JSON.stringify(m.error));
        e.code = m.error.code;
        w.rej(e);
      } else w.res(m.result);
      return;
    }
    if (m.method) for (const h of this.notifyHandlers) h(m.method, m.params ?? {});
  }

  private serverRequest(m: any) {
    const reply = (body: object) => this.write({ id: m.id, ...body });
    const p = this.onRequest?.(m.method, m.params ?? {}, m.id);
    if (!p) return reply({ error: { code: -32601, message: `Tether doesn't handle ${m.method}` } });
    p.then(
      (result) => (result === undefined ? undefined : reply({ result })),
      (e) => reply({ error: { code: -32000, message: String(e?.message ?? e) } }),
    );
  }

  onNotify(h: (method: string, params: any) => void): () => void {
    this.notifyHandlers.add(h);
    return () => this.notifyHandlers.delete(h);
  }

  onClose(h: (reason: string) => void): () => void {
    this.closeHandlers.add(h);
    return () => this.closeHandlers.delete(h);
  }

  call<T = any>(method: string, params: unknown, timeoutMs = 60_000): Promise<T> {
    if (this.closed) return Promise.reject(new Error("The connection to the Codex daemon is closed."));
    const id = ++this.nextId;
    return new Promise<T>((res, rej) => {
      const timer = setTimeout(() => {
        this.waits.delete(id);
        rej(new Error(`Codex didn't answer ${method} in time.`));
      }, timeoutMs);
      this.waits.set(id, { res, rej, timer });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params?: unknown) {
    this.write(params === undefined ? { method } : { method, params });
  }

  private write(obj: object) {
    if (this.closed || !this.wire) return;
    try {
      this.wire.send(JSON.stringify(obj));
    } catch {}
  }

  /** The socket ended: every call waiting fails. */
  ended(reason: string) {
    if (this.closed) return;
    this.closed = true;
    for (const w of this.waits.values()) {
      clearTimeout(w.timer);
      w.rej(new Error(`The connection to the Codex daemon closed (${reason}).`));
    }
    this.waits.clear();
    for (const h of this.closeHandlers) h(reason);
  }

  close() {
    if (this.closed) return;
    this.wire?.close();
    this.ended("closed");
  }
}
