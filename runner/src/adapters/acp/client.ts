// A client for the Agent Client Protocol (https://agentclientprotocol.com): JSON-RPC 2.0, one
// message per line, over a harness process's stdin and stdout. Generic on purpose: Antigravity
// (`agy acp`) is the first harness that speaks it, and any later one can reuse this.
//
// The harness calls back too: `session/update` notifications (the transcript as it streams) and
// requests such as `session/request_permission`, which `onRequest` answers.

import { redact } from "../../credentials";
import { childEnv } from "../../childEnv";

/** A `session/update` notification's `update`, as the protocol names its fields. */
export interface AcpUpdate {
  sessionUpdate: string;
  [k: string]: any;
}

export class AcpError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
  }
}

export interface AcpClientOpts {
  argv: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
  /** a `session/update` for one session */
  onUpdate?(sessionId: string, update: AcpUpdate): void;
  /** a request from the harness: its result, or throw to answer with an error */
  onRequest?(method: string, params: any, id: string | number): Promise<unknown>;
  /** the process ended, by itself or by `close` (`error`: why, when it wasn't asked to) */
  onExit?(error?: string): void;
  /** a label for logs */
  name?: string;
}

/** How long a call may take before it fails, unless the call says otherwise. */
const CALL_TIMEOUT_MS = 60_000;

export class AcpClient {
  private proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  private nextId = 1;
  private pending = new Map<number, { ok: (v: any) => void; fail: (e: Error) => void; timer?: ReturnType<typeof setTimeout> }>();
  private stderr: string[] = [];
  private closing = false;
  private exited = false;
  /** what the harness said it can do (`initialize`) */
  agent: { name?: string; version?: string; capabilities?: any } = {};
  readonly done: Promise<void>;

  constructor(private o: AcpClientOpts) {
    this.proc = Bun.spawn(o.argv, { cwd: o.cwd, env: childEnv(o.env), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    void this.readErr();
    this.done = this.readOut().then(async () => {
      const code = await this.proc.exited.catch(() => -1);
      this.exited = true;
      const error = this.closing ? undefined : this.why(`It exited (code ${code}).`);
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.fail(new AcpError(error ?? "It was closed."));
      }
      this.pending.clear();
      this.o.onExit?.(error);
    });
  }

  /** Starts the conversation: protocol version 1, no file system or terminal of ours. */
  async initialize() {
    const r = await this.call("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
    this.agent = { name: r?.agentInfo?.name, version: r?.agentInfo?.version, capabilities: r?.agentCapabilities };
    return r;
  }

  get alive() {
    return !this.exited && !this.closing;
  }

  get pid(): number {
    return this.proc.pid;
  }

  call<T = any>(method: string, params: unknown, timeoutMs = CALL_TIMEOUT_MS): Promise<T> {
    if (!this.alive) return Promise.reject(new AcpError(`${this.o.name ?? "The harness"} isn't running.`));
    const id = this.nextId++;
    return new Promise<T>((ok, fail) => {
      const timer = timeoutMs > 0 ? setTimeout(() => {
        this.pending.delete(id);
        fail(new AcpError(`${method} didn't answer in ${Math.round(timeoutMs / 1000)} s.`));
      }, timeoutMs) : undefined;
      timer?.unref?.();
      this.pending.set(id, { ok, fail, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown) {
    if (this.alive) this.write({ jsonrpc: "2.0", method, params });
  }

  async close() {
    if (this.exited) return;
    this.closing = true;
    try {
      this.proc.stdin.end();
    } catch {}
    this.proc.kill();
    const killed = setTimeout(() => this.proc.kill(9), 3000);
    await this.done;
    clearTimeout(killed);
  }

  /** The last lines the harness printed to stderr, for a failure's message. */
  why(message: string): string {
    const err = this.stderr.join("").trim().split("\n").filter(Boolean).slice(-3).join(" ").slice(0, 400);
    return redact(err && !message.includes(err) ? `${message} (${err})` : message);
  }

  private write(o: unknown) {
    try {
      this.proc.stdin.write(JSON.stringify(o) + "\n");
      this.proc.stdin.flush();
    } catch {}
  }

  private async readErr() {
    const dec = new TextDecoder();
    try {
      for await (const c of this.proc.stderr) {
        this.stderr.push(dec.decode(c));
        if (this.stderr.length > 50) this.stderr.shift();
      }
    } catch {}
  }

  private async readOut() {
    const dec = new TextDecoder();
    let buf = "";
    try {
      for await (const c of this.proc.stdout) {
        buf += dec.decode(c, { stream: true });
        let n: number;
        while ((n = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, n).trim();
          buf = buf.slice(n + 1);
          if (line) this.handle(line);
        }
      }
    } catch {}
  }

  private handle(line: string) {
    let m: any;
    try {
      m = JSON.parse(line);
    } catch {
      return; // not ours: a stray print
    }
    if (m?.method && m.id !== undefined && m.id !== null) return void this.answer(m);
    if (m?.method) {
      if (m.method === "session/update" && m.params?.update) {
        try {
          this.o.onUpdate?.(m.params.sessionId, m.params.update);
        } catch (e) {
          console.error(`${this.o.name ?? "acp"}: couldn't handle an update: ${(e as Error)?.message ?? e}`);
        }
      }
      return;
    }
    const p = typeof m?.id === "number" ? this.pending.get(m.id) : undefined;
    if (!p) return;
    this.pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.error) p.fail(new AcpError(String(m.error.message ?? "The harness refused."), m.error.code));
    else p.ok(m.result);
  }

  private async answer(m: { id: string | number; method: string; params: any }) {
    try {
      if (!this.o.onRequest) throw new AcpError("Not supported.", -32601);
      const result = await this.o.onRequest(m.method, m.params, m.id);
      this.write({ jsonrpc: "2.0", id: m.id, result: result ?? {} });
    } catch (e: any) {
      this.write({ jsonrpc: "2.0", id: m.id, error: { code: e instanceof AcpError && e.code ? e.code : -32603, message: String(e?.message ?? e) } });
    }
  }
}
