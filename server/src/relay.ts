// The relay between browsers and runners. It holds no session state: runners own sessions, so
// restarting or redeploying the server never interrupts an agent. What it does keep is routing:
// which runners are connected, which browser subscribed to which session, which browser owns
// which terminal attach, and which rpc is waiting for which answer. All of it is rebuilt by
// reconnecting clients.
//
// Sockets are abstract (send/close) so the routing is tested without a network.

import { CLOSE_PROTOCOL, CLOSE_REAUTH, CLOSE_REPLACED, CLOSE_RUNNER_ID, CLOSE_TOO_SLOW, PROTOCOL_VERSION, TERMINAL_OPS, type BrowserToServer, type PushKeys, type OpName, type ResultMsg, type RunnerInfo, type RunnerToServer, type ServerToBrowser, type ServerToRunner, type User } from "../../shared/protocol";
import { runnerIdAllowed, runnerIdRefusal } from "./runnerIds";
import { Tickets } from "./tickets";

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
  /** the app's VAPID keys (push.ts): the public one to browsers, the pair to runners */
  push?: PushKeys;
  /** how long a browser socket stays signed in without a renew ticket (tickets.ts) */
  reauthMs?: number;
  /** issues and checks renew tickets; by default its own, on this relay's clock */
  tickets?: Tickets;
}

/** A browser socket's sign-in lasts this long from connecting, then as long as its latest ticket. */
export const REAUTH_MS = 5 * 60_000;

interface RunnerConn {
  sock: Socket;
  info: RunnerInfo;
}

/**
 * One browser's subscription to one session. A new object each time the route is made, so an
 * answer can tell whether the route it was sent for still exists.
 */
interface Route {
  /** a subscribe for it has succeeded: failures from then on (a refresh) never remove it */
  confirmed: boolean;
  /** subscribes for it still waiting for the runner */
  inFlight: number;
}

interface BrowserConn {
  /** who signed in on this socket: a renew ticket must be for them */
  viewerId: string;
  /** past this (the relay's clock), the socket is closed with CLOSE_REAUTH */
  deadline: number;
  /** a bad renew was already logged for this socket */
  badRenewLogged?: boolean;
  /** session key -> its route (see Route) */
  subs: Map<string, Route>;
  attaches: Set<string>;
  /** what this device looks at (presence) */
  presence?: { deviceId: string; runnerId?: string; sessionId?: string };
}

interface Pending {
  browser: Socket;
  browserRpcId: string;
  runnerId: string;
  op: OpName;
  /** the session a subscribe is for, or the attach an openTerminal opens */
  key?: string;
  /** a subscribe: the route it was sent for */
  route?: Route;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * A runner-supplied value (id, name, hostname, version) made safe for a log line: quoted, capped,
 * and with control characters escaped, so a runner can't forge or garble log lines.
 */
export const logValue = (v: string, max = 80) =>
  JSON.stringify(v.length > max ? `${v.slice(0, max)}…` : v).replace(/[\u007f-\u009f\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

const subKey = (runnerId: string, sessionId: string) => `${runnerId}\u0000${sessionId}`;
const isTerminalOp = (op: string): op is (typeof TERMINAL_OPS)[number] => (TERMINAL_OPS as readonly string[]).includes(op);

export class Relay {
  private runners = new Map<string, RunnerConn>();
  private runnerOf = new Map<Socket, string>();
  /** each runner connection's service token name, which limits the ids it may claim (runnerIds.ts) */
  private runnerToken = new WeakMap<Socket, string>();
  private browsers = new Map<Socket, BrowserConn>();
  private subscribers = new Map<string, Set<Socket>>();
  private attaches = new Map<string, { browser: Socket; runnerId: string }>();
  private pending = new Map<string, Pending>();
  private seq = 0;
  private readonly rpcTimeoutMs: number;
  private readonly protocol: number;
  private readonly log: (line: string) => void;
  private readonly now: () => number;
  private readonly push?: PushKeys;
  private readonly reauthMs: number;
  readonly tickets: Tickets;
  /** the viewers frame last sent to each runner, so only changes go out */
  private viewersSent = new Map<string, string>();

  constructor(opts: RelayOptions = {}) {
    this.push = opts.push;
    this.rpcTimeoutMs = opts.rpcTimeoutMs ?? 120_000;
    this.protocol = opts.protocol ?? PROTOCOL_VERSION;
    this.log = opts.log ?? (() => {});
    this.now = opts.now ?? Date.now;
    this.reauthMs = opts.reauthMs ?? REAUTH_MS;
    this.tickets = opts.tickets ?? new Tickets({ now: this.now });
  }

  runnerList(): RunnerInfo[] {
    return [...this.runners.values()].map((r) => r.info);
  }

  // ---------------- browsers ----------------

  /** `viewerId`: the signed-in person's id (the identity token's sub), which renew tickets must match. */
  addBrowser(sock: Socket, user: User, protocol: number, viewerId = "") {
    this.browsers.set(sock, { viewerId, deadline: this.now() + this.reauthMs, subs: new Map(), attaches: new Set() });
    this.out(sock, { t: "hello", user, protocol, ...(this.push ? { push: { publicKey: this.push.publicKey } } : {}) });
    this.out(sock, { t: "runners", runners: this.runnerList() });
  }

  removeBrowser(sock: Socket) {
    const b = this.browsers.get(sock);
    if (!b) return;
    this.browsers.delete(sock);
    if (b.presence?.runnerId) this.sendViewers(b.presence.runnerId);
    this.tellUnwatched([...b.subs.keys()].filter((k) => this.unsubscribe(sock, b, k)));
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
    // Its rpcs are answered to nobody, except subscribes: their answer still has to reach
    // settleSubscribe, which tells the runner `unwatched` if it started watching for nobody.
    for (const [id, p] of this.pending) if (p.browser === sock && p.op !== "subscribe") (clearTimeout(p.timer), this.pending.delete(id));
  }

  onBrowserMessage(sock: Socket, msg: BrowserToServer) {
    const b = this.browsers.get(sock);
    if (!b) return;
    // A valid ticket is fresh proof of sign-in, so it counts even just past the deadline (before
    // the sweep got there). Anything else past the deadline closes the socket.
    if (msg.t === "renew") {
      if (!this.renew(b, msg.ticket) && this.now() >= b.deadline) this.expire(sock);
      return;
    }
    if (this.now() >= b.deadline) return this.expire(sock);
    if (msg.t === "ping") return this.out(sock, { t: "pong" });
    if (msg.t === "presence") {
      const was = b.presence?.runnerId;
      b.presence = { deviceId: msg.deviceId, ...(msg.runnerId && msg.sessionId ? { runnerId: msg.runnerId, sessionId: msg.sessionId } : {}) };
      if (was && was !== msg.runnerId) this.sendViewers(was);
      if (msg.runnerId) this.sendViewers(msg.runnerId);
      return;
    }
    const m = msg;

    const reply = (r: Omit<ResultMsg, "t" | "id">) => this.out(sock, { t: "result", id: m.id, ...r });
    const runner = this.runners.get(m.runnerId);
    if (!runner) return reply({ ok: false, error: "That runner is offline." });
    const args = { ...(m.args as Record<string, unknown>) };
    let key: string | undefined;
    let route: Route | undefined;

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
        // Subscribing again (a fresh snapshot) reuses the route (see settle for when it goes).
        key = k;
        route = b.subs.get(k);
        if (!route) b.subs.set(k, (route = { confirmed: false, inFlight: 0 }));
        route.inFlight++;
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
    this.pending.set(id, { browser: sock, browserRpcId: m.id, runnerId: m.runnerId, op: m.op, key, route, timer });
    this.out(runner.sock, { t: "rpc", id, op: m.op, args });
  }

  /** A valid ticket for this socket's own viewer keeps it signed in until the ticket runs out. */
  private renew(b: BrowserConn, ticket: string): boolean {
    const t = this.tickets.verify(ticket);
    if (t && b.viewerId && t.sub === b.viewerId) {
      b.deadline = Math.max(b.deadline, t.exp);
      return true;
    }
    // Never log the ticket itself.
    if (!b.badRenewLogged) this.log(`ignored a renew ticket that was ${t ? "for someone else" : "invalid or expired"}`);
    b.badRenewLogged = true;
    return false;
  }

  /** Closes every browser socket whose sign-in wasn't renewed in time (app.ts calls this often). */
  sweep() {
    const now = this.now();
    for (const [sock, b] of [...this.browsers]) if (now >= b.deadline) this.expire(sock);
  }

  private expire(sock: Socket) {
    // Its routes go now, so nothing more reaches it while the close is under way.
    this.removeBrowser(sock);
    this.log("closed a browser socket whose sign-in wasn't renewed");
    sock.close(CLOSE_REAUTH, "sign-in needs refreshing");
  }

  // ---------------- runners ----------------

  /** A runner connection opened with this service token (by name); its hellos are checked against it. */
  addRunner(sock: Socket, tokenName: string) {
    this.runnerToken.set(sock, tokenName);
  }

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
      case "homeChat": {
        const s = JSON.stringify({ t: "homeChat", runnerId, rev: m.rev, ...(m.sessionId ? { sessionId: m.sessionId } : {}), ...(m.chats ? { chats: m.chats } : {}), ...(m.labels ? { labels: m.labels } : {}) } satisfies ServerToBrowser);
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

  /** A result frame from this runner that didn't parse: its rpc fails now rather than timing out. */
  malformedResult(sock: Socket, id: string) {
    const runnerId = this.runnerOf.get(sock);
    const p = this.pending.get(id);
    if (runnerId && p?.runnerId === runnerId && this.runners.get(runnerId)?.sock === sock) this.settle(id, { ok: false, error: "The runner sent an answer Tether couldn't read." });
  }

  /** An rpc frame from this browser that didn't parse: answered with an error. */
  malformedRpc(sock: Socket, id: string) {
    if (this.browsers.has(sock)) this.out(sock, { t: "result", id, ok: false, error: "Malformed request." });
  }

  removeRunner(sock: Socket) {
    const id = this.runnerOf.get(sock);
    this.runnerOf.delete(sock);
    if (!id || this.runners.get(id)?.sock !== sock) return;
    this.runners.delete(id);
    this.viewersSent.delete(id);
    this.forgetRunner(id, "The runner disconnected.");
    this.log(`runner ${logValue(id)} disconnected`);
    this.broadcastRunners();
  }

  private hello(sock: Socket, info: Omit<RunnerInfo, "connectedAt">) {
    if (info.protocol !== this.protocol) {
      // A runner from another protocol version would misread frames: refuse it, and say which side to update.
      const newer = info.protocol > this.protocol ? "the app" : "the runner";
      this.log(`refused runner ${logValue(info.id)} (${logValue(info.name)}): protocol ${info.protocol}, expected ${this.protocol}`);
      if (this.runnerOf.get(sock) === info.id) this.removeRunner(sock);
      sock.close(CLOSE_PROTOCOL, `protocol mismatch: the app speaks ${this.protocol}, the runner ${info.protocol}; update ${newer}`);
      return;
    }
    const token = this.runnerToken.get(sock) ?? "";
    if (!runnerIdAllowed(token, info.id)) {
      // Checked before anything changes, so a refused claim never disturbs the runner holding the id.
      const reason = runnerIdRefusal(token, info.id);
      this.log(`refused runner ${logValue(info.id)} (${logValue(info.name)}) from ${logValue(info.hostname)}: token ${logValue(token)} may not use that id`);
      // A repeated hello on this connection asking for a forbidden id: its earlier id goes too.
      if (this.runnerOf.has(sock)) this.removeRunner(sock);
      sock.close(CLOSE_RUNNER_ID, reason);
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
    this.out(sock, { t: "welcome", ...(this.push ? { push: this.push } : {}) });
    // A new connection starts with no viewers: tell it all of them.
    if (prev?.sock !== sock) this.viewersSent.delete(id);
    this.sendViewers(id);
    if (prev?.sock !== sock)
      this.log(`runner ${logValue(id)} (${logValue(info.name)}) connected from ${logValue(info.hostname)}; ${info.harnesses.map((h) => `${h.id} ${logValue(h.version, 40)}`).join(", ") || "no harnesses"}`);
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
    if (p.op === "subscribe" && p.key && p.route) this.settleSubscribe(p.browser, b, p.key, p.route, r.ok);
    // A failed attach leaves no route behind.
    if (!r.ok && p.key && p.op === "openTerminal") this.dropAttach(p.key);
    if (b) this.out(p.browser, { t: "result", id: p.browserRpcId, ok: r.ok, data: r.data, error: r.error });
  }

  /**
   * A subscribe's answer, for its route:
   * - success: the route is confirmed. If the route is gone meanwhile (unsubscribed, the browser
   *   left) and nobody else watches the session, the runner just started watching for nobody:
   *   tell it `unwatched` again.
   * - failure: the route goes only if no subscribe for it ever succeeded and none is still in
   *   flight, so a failed refresh never cuts off a working (or about to work) subscription.
   */
  private settleSubscribe(sock: Socket, b: BrowserConn | undefined, key: string, route: Route, ok: boolean) {
    route.inFlight--;
    const current = b?.subs.get(key) === route;
    if (ok) {
      if (current) route.confirmed = true;
      else if (!this.subscribers.get(key)?.size) this.tellUnwatched([key]);
      return;
    }
    if (current && !route.confirmed && route.inFlight === 0 && this.unsubscribe(sock, b!, key)) this.tellUnwatched([key]);
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

  /** Which devices look at which of a runner's sessions: sent to it when that changed. */
  private sendViewers(runnerId: string) {
    const r = this.runners.get(runnerId);
    if (!r) return;
    const sessions: Record<string, string[]> = {};
    for (const b of this.browsers.values()) {
      const p = b.presence;
      if (p?.runnerId !== runnerId || !p.sessionId) continue;
      const list = (sessions[p.sessionId] ??= []);
      if (!list.includes(p.deviceId)) list.push(p.deviceId);
    }
    const frame = JSON.stringify({ t: "viewers", sessions } satisfies ServerToRunner);
    if (this.viewersSent.get(runnerId) === frame) return;
    this.viewersSent.set(runnerId, frame);
    this.raw(r.sock, frame);
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

