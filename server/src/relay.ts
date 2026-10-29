// The relay between browsers and runners. It holds no session state: runners own sessions, so
// restarting or redeploying the server never interrupts an agent. What it does keep is routing:
// which runners are connected, which browser subscribed to which session, which browser owns
// which terminal attach, and which rpc is waiting for which answer. All of it is rebuilt by
// reconnecting clients.
//
// Sockets are abstract (send/close) so the routing is tested without a network.

import { CLOSE_PROTOCOL, CLOSE_REPLACED, CLOSE_TOO_SLOW, PROTOCOL_VERSION, TERMINAL_OPS, type BrowserToServer, type OpName, type ResultMsg, type RunnerInfo, type RunnerToServer, type ServerToBrowser, type ServerToRunner } from "../../shared/protocol";

export interface Socket {
  /** Bun's convention: bytes sent, -1 queued under backpressure, 0 dropped */
  send(data: string): number | void;
  close(code?: number, reason?: string): void;
}

export interface RelayOptions {
  rpcTimeoutMs?: number;
  /** the protocol version runners must speak */
  protocol?: number;
  log?: (line: string) => void;
  now?: () => number;
}

interface RunnerConn {
  sock: Socket;
  info: RunnerInfo;
}

interface BrowserConn {
  subs: Set<string>;
  attaches: Set<string>;
}

interface Pending {
  browser: Socket;
  browserRpcId: string;
  runnerId: string;
  op: OpName;
  /** the session a subscribe is for, or the attach an openTerminal opens */
  key?: string;
  timer: ReturnType<typeof setTimeout>;
}

const subKey = (runnerId: string, sessionId: string) => `${runnerId}\u0000${sessionId}`;
const isTerminalOp = (op: string): op is (typeof TERMINAL_OPS)[number] => (TERMINAL_OPS as readonly string[]).includes(op);

export class Relay {
  private runners = new Map<string, RunnerConn>();
  private runnerOf = new Map<Socket, string>();
  private browsers = new Map<Socket, BrowserConn>();
  private subscribers = new Map<string, Set<Socket>>();
  private attaches = new Map<string, { browser: Socket; runnerId: string }>();
  private pending = new Map<string, Pending>();
  private seq = 0;
  private readonly rpcTimeoutMs: number;
  private readonly protocol: number;
  private readonly log: (line: string) => void;
  private readonly now: () => number;

  constructor(opts: RelayOptions = {}) {
    this.rpcTimeoutMs = opts.rpcTimeoutMs ?? 120_000;
    this.protocol = opts.protocol ?? PROTOCOL_VERSION;
    this.log = opts.log ?? (() => {});
    this.now = opts.now ?? Date.now;
  }

  runnerList(): RunnerInfo[] {
    return [...this.runners.values()].map((r) => r.info);
  }

  // ---------------- browsers ----------------

  addBrowser(sock: Socket, user: { name: string; email: string }, protocol: number) {
    this.browsers.set(sock, { subs: new Set(), attaches: new Set() });
    this.out(sock, { t: "hello", user, protocol });
    this.out(sock, { t: "runners", runners: this.runnerList() });
  }

  removeBrowser(sock: Socket) {
    const b = this.browsers.get(sock);
    if (!b) return;
    this.browsers.delete(sock);
    this.tellUnwatched([...b.subs].filter((k) => this.unsubscribe(sock, b, k)));
    // Its PTYs have no one to draw for: the runners close them.
    const byRunner = new Map<string, string[]>();
    for (const a of b.attaches) {
      const at = this.attaches.get(a);
      this.attaches.delete(a);
      if (at) byRunner.set(at.runnerId, [...(byRunner.get(at.runnerId) ?? []), a]);
    }
    for (const [runnerId, attachIds] of byRunner) {
      const r = this.runners.get(runnerId);
      if (r) this.out(r.sock, { t: "detach", attachIds });
    }
    for (const [id, p] of this.pending) if (p.browser === sock) (clearTimeout(p.timer), this.pending.delete(id));
  }

  onBrowserMessage(sock: Socket, msg: BrowserToServer) {
    const b = this.browsers.get(sock);
    if (!b) return;
    if (msg.t === "ping") return this.out(sock, { t: "pong" });
    const m = msg;

    const reply = (r: Omit<ResultMsg, "t" | "id">) => this.out(sock, { t: "result", id: m.id, ...r });
    const runner = this.runners.get(m.runnerId);
    if (!runner) return reply({ ok: false, error: "That runner is offline." });
    const args = { ...(m.args as Record<string, unknown>) };
    let key: string | undefined;

    if ((m.op === "subscribe" || m.op === "unsubscribe") && (typeof args.sessionId !== "string" || !args.sessionId))
      return reply({ ok: false, error: "sessionId is required." });

    switch (m.op) {
      case "unsubscribe": {
        const k = subKey(m.runnerId, args.sessionId as string);
        if (this.unsubscribe(sock, b, k)) this.tellUnwatched([k]);
        return reply({ ok: true, data: null });
      }
      case "subscribe": {
        // Registered before the runner answers, so no event between its snapshot and the answer is lost.
        const k = subKey(m.runnerId, args.sessionId as string);
        // Subscribing again (a fresh snapshot) reuses the route; only a subscribe that created it
        // may take it down when it fails, or a failed refresh would cut off a working subscription.
        if (!b.subs.has(k)) key = k;
        b.subs.add(k);
        let set = this.subscribers.get(k);
        if (!set) this.subscribers.set(k, (set = new Set()));
        set.add(sock);
        break;
      }
      case "openTerminal": {
        // The server names the attach, so output can be routed before the runner even answers.
        key = `a${crypto.randomUUID()}`;
        this.attaches.set(key, { browser: sock, runnerId: m.runnerId });
        b.attaches.add(key);
        args.attachId = key;
        break;
      }
      default:
        if (isTerminalOp(m.op)) {
          const at = this.attaches.get(String(args.attachId));
          if (!at || at.browser !== sock || at.runnerId !== m.runnerId) return reply({ ok: false, error: "That terminal isn't attached here." });
          if (m.op === "closeTerminal") this.dropAttach(String(args.attachId));
        }
    }

    const id = `s${++this.seq}`;
    const timer = setTimeout(() => this.settle(id, { ok: false, error: "The runner didn't answer in time." }), this.rpcTimeoutMs);
    this.pending.set(id, { browser: sock, browserRpcId: m.id, runnerId: m.runnerId, op: m.op, key, timer });
    this.out(runner.sock, { t: "rpc", id, op: m.op, args });
  }

  // ---------------- runners ----------------

  onRunnerMessage(sock: Socket, m: RunnerToServer) {
    if (m.t === "hello") return this.hello(sock, m.runner);
    if (m.t === "ping") return this.out(sock, { t: "pong" });
    const runnerId = this.runnerOf.get(sock);
    // Nothing counts before hello, and nothing from a connection a newer one replaced.
    if (!runnerId || this.runners.get(runnerId)?.sock !== sock) return;
    switch (m.t) {
      case "result": {
        const p = this.pending.get(m.id);
        if (p && p.runnerId === runnerId) this.settle(m.id, m);
        return;
      }
      case "event": {
        const subs = this.subscribers.get(subKey(runnerId, m.sessionId));
        if (!subs?.size) return;
        const s = JSON.stringify({ t: "event", runnerId, sessionId: m.sessionId, seq: m.seq, event: m.event } satisfies ServerToBrowser);
        for (const b of [...subs]) this.raw(b, s);
        return;
      }
      case "summary": {
        const s = JSON.stringify({ t: "summary", runnerId, summary: m.summary } satisfies ServerToBrowser);
        for (const b of [...this.browsers.keys()]) this.raw(b, s);
        return;
      }
      case "term": {
        const at = this.attaches.get(m.attachId);
        if (at && at.runnerId === runnerId) this.out(at.browser, { t: "term", attachId: m.attachId, data: m.data });
        // Output for an attach nobody owns: tell the runner to close it.
        else this.out(sock, { t: "detach", attachIds: [m.attachId] });
        return;
      }
      case "termEnd": {
        const at = this.attaches.get(m.attachId);
        if (!at || at.runnerId !== runnerId) return;
        this.dropAttach(m.attachId);
        this.out(at.browser, { t: "termEnd", attachId: m.attachId, reason: m.reason });
        return;
      }
    }
  }

  removeRunner(sock: Socket) {
    const id = this.runnerOf.get(sock);
    this.runnerOf.delete(sock);
    if (!id || this.runners.get(id)?.sock !== sock) return;
    this.runners.delete(id);
    this.forgetRunner(id, "The runner disconnected.");
    this.log(`runner ${id} disconnected`);
    this.broadcastRunners();
  }

  private hello(sock: Socket, info: Omit<RunnerInfo, "connectedAt">) {
    if (info.protocol !== this.protocol) {
      // A runner from another protocol version would misread frames: refuse it, and say which side to update.
      const newer = info.protocol > this.protocol ? "the app" : "the runner";
      this.log(`refused runner ${info.id} (${info.name}): protocol ${info.protocol}, expected ${this.protocol}`);
      if (this.runnerOf.get(sock) === info.id) this.removeRunner(sock);
      sock.close(CLOSE_PROTOCOL, `protocol mismatch: the app speaks ${this.protocol}, the runner ${info.protocol}; update ${newer}`);
      return;
    }
    const id = info.id;
    const prev = this.runners.get(id);
    if (prev && prev.sock !== sock) {
      // The same runner again (a restart, or it noticed a dead connection before we did): the
      // newer connection wins. Its old routes are gone; browsers re-subscribe from the runners update.
      this.runnerOf.delete(prev.sock);
      prev.sock.close(CLOSE_REPLACED, "replaced by a newer connection with the same runner id");
      this.forgetRunner(id, "The runner reconnected.");
    }
    const was = this.runnerOf.get(sock);
    if (was && was !== id && this.runners.get(was)?.sock === sock) {
      this.runners.delete(was);
      this.forgetRunner(was, "The runner changed its id.");
    }
    this.runnerOf.set(sock, id);
    // A repeated hello on the same connection (harnesses changed) is the same connection: keeping
    // connectedAt tells browsers there's nothing to subscribe to again.
    const connectedAt = prev?.sock === sock ? prev.info.connectedAt : this.now();
    this.runners.set(id, { sock, info: { ...info, connectedAt } });
    if (prev?.sock !== sock)
      this.log(`runner ${id} (${info.name}) connected from ${info.hostname}; ${info.harnesses.map((h) => `${h.id} ${h.version}`).join(", ") || "no harnesses"}`);
    this.broadcastRunners();
  }

  /** Drops every route through a runner that is gone or replaced. */
  private forgetRunner(runnerId: string, why: string) {
    for (const [k, socks] of this.subscribers) {
      if (!k.startsWith(`${runnerId}\u0000`)) continue;
      for (const s of socks) this.browsers.get(s)?.subs.delete(k);
      this.subscribers.delete(k);
    }
    for (const [a, at] of this.attaches) {
      if (at.runnerId !== runnerId) continue;
      this.dropAttach(a);
      this.out(at.browser, { t: "termEnd", attachId: a, reason: why });
    }
    for (const [id, p] of this.pending) if (p.runnerId === runnerId) this.settle(id, { ok: false, error: why });
  }

  // ---------------- helpers ----------------

  private settle(id: string, r: Pick<ResultMsg, "ok" | "data" | "error">) {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    const b = this.browsers.get(p.browser);
    if (!r.ok && p.key && b) {
      // A failed subscribe or attach leaves no route behind.
      if (p.op === "subscribe" && this.unsubscribe(p.browser, b, p.key)) this.tellUnwatched([p.key]);
      if (p.op === "openTerminal") this.dropAttach(p.key);
    }
    if (b) this.out(p.browser, { t: "result", id: p.browserRpcId, ok: r.ok, data: r.data, error: r.error });
  }

  /** True when this was the session's last subscriber. */
  private unsubscribe(sock: Socket, b: BrowserConn, key: string): boolean {
    b.subs.delete(key);
    const set = this.subscribers.get(key);
    if (!set?.delete(sock) || set.size > 0) return false;
    this.subscribers.delete(key);
    return true;
  }

  /** Tells each runner which of its sessions nobody watches any more. */
  private tellUnwatched(keys: string[]) {
    const byRunner = new Map<string, string[]>();
    for (const k of keys) {
      const [runnerId, sessionId] = k.split("\u0000") as [string, string];
      byRunner.set(runnerId, [...(byRunner.get(runnerId) ?? []), sessionId]);
    }
    for (const [runnerId, sessionIds] of byRunner) {
      const r = this.runners.get(runnerId);
      if (r) this.out(r.sock, { t: "unwatched", sessionIds });
    }
  }

  private dropAttach(attachId: string) {
    const at = this.attaches.get(attachId);
    if (!at) return;
    this.attaches.delete(attachId);
    this.browsers.get(at.browser)?.attaches.delete(attachId);
  }

  private broadcastRunners() {
    const s = JSON.stringify({ t: "runners", runners: this.runnerList() } satisfies ServerToBrowser);
    for (const b of [...this.browsers.keys()]) this.raw(b, s);
  }

  private out(sock: Socket, m: ServerToBrowser | ServerToRunner) {
    this.raw(sock, JSON.stringify(m));
  }

  /**
   * Never drops a frame silently: a socket whose buffer is full is closed instead (the protocol's
   * slow-socket policy). Its close handler then clears its routes like any disconnect.
   */
  private raw(sock: Socket, data: string) {
    if (sock.send(data) !== 0) return;
    this.log("closing a socket that can't keep up");
    sock.close(CLOSE_TOO_SLOW, "too slow");
  }

  /** For tests and diagnostics. */
  stats() {
    return { runners: this.runners.size, browsers: this.browsers.size, subscriptions: this.subscribers.size, attaches: this.attaches.size, pending: this.pending.size };
  }
}

