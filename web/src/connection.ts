// The browser's WebSocket to the relay: reconnects with backoff, notices a dead link (a phone
// that slept, a network that changed), and carries rpcs. Other modules listen for server
// messages by type; this file knows nothing about what they mean.

import type { OpArgs, OpName, OpResult, ServerToBrowser } from "../../shared/protocol";

export type LinkState = "connecting" | "open" | "down";
export type AuthState = "ok" | "signedOut" | "notOwner";

type Msg<T extends ServerToBrowser["t"]> = Extract<ServerToBrowser, { t: T }>;
type Handler = (m: any) => void;

const handlers = new Map<string, Set<Handler>>();
const stateListeners = new Set<(s: LinkState) => void>();
const authListeners = new Set<(a: AuthState) => void>();

let ws: WebSocket | undefined;
let attempt = 0;
let retry: ReturnType<typeof setTimeout> | undefined;
let pinger: ReturnType<typeof setInterval> | undefined;
let probe: ReturnType<typeof setTimeout> | undefined;
let lastHeard = 0;
let rpcSeq = 0;
const pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

const PING_MS = 25_000;
const SILENCE_MS = 60_000;
const RPC_TIMEOUT_MS = 130_000; // a little over the server's own 120 s

/** Listen for one type of server message. Returns the unsubscribe function. */
export function on<T extends ServerToBrowser["t"]>(t: T, fn: (m: Msg<T>) => void): () => void {
  let set = handlers.get(t);
  if (!set) handlers.set(t, (set = new Set()));
  set.add(fn);
  return () => void set.delete(fn);
}

export function onLinkState(fn: (s: LinkState) => void) {
  stateListeners.add(fn);
  return () => void stateListeners.delete(fn);
}

export function onAuth(fn: (a: AuthState) => void) {
  authListeners.add(fn);
  return () => void authListeners.delete(fn);
}

const setState = (s: LinkState) => stateListeners.forEach((f) => f(s));

/** Calls an op on a runner through the relay. */
export function rpc<K extends OpName>(runnerId: string, op: K, args: OpArgs<K>, timeoutMs = RPC_TIMEOUT_MS): Promise<OpResult<K>> {
  return new Promise((resolve, reject) => {
    const sock = ws;
    if (!sock || sock.readyState !== WebSocket.OPEN) return reject(new Error("Not connected."));
    const id = String(++rpcSeq);
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("No answer in time."));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    sock.send(JSON.stringify({ t: "rpc", id, runnerId, op, args }));
  });
}

export function connect() {
  clearTimeout(retry);
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const sock = new WebSocket(`${proto}//${location.host}/api/ws`);
  ws = sock;
  let opened = false;
  setState("connecting");

  sock.onopen = () => {
    if (ws !== sock) return;
    opened = true;
    attempt = 0;
    lastHeard = Date.now();
    authListeners.forEach((f) => f("ok"));
    setState("open");
    pinger = setInterval(() => {
      if (Date.now() - lastHeard > SILENCE_MS) return drop(sock);
      sock.send(JSON.stringify({ t: "ping" }));
    }, PING_MS);
  };
  sock.onmessage = (ev) => {
    if (ws !== sock) return;
    lastHeard = Date.now();
    clearTimeout(probe);
    let m: ServerToBrowser;
    try {
      m = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    if (m.t === "result") {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.ok) p.resolve(m.data);
      else p.reject(new Error(m.error ?? "Failed."));
      return;
    }
    handlers.get(m.t)?.forEach((f) => f(m));
  };
  sock.onclose = () => {
    if (ws !== sock) return;
    closed(opened);
  };
  sock.onerror = () => {};
}

/** Gives up on a socket that has gone quiet and reconnects now. */
function drop(sock: WebSocket) {
  if (ws !== sock) return;
  sock.close();
  closed(true);
  attempt = 0;
  clearTimeout(retry);
  connect();
}

function closed(wasOpen: boolean) {
  ws = undefined;
  clearInterval(pinger);
  clearTimeout(probe);
  for (const p of pending.values()) (clearTimeout(p.timer), p.reject(new Error("Disconnected.")));
  pending.clear();
  setState("down");
  // A connection refused outright may be a sign-in problem rather than the network.
  if (!wasOpen) void checkAuth();
  const delay = Math.min(15_000, 500 * 2 ** attempt++);
  retry = setTimeout(connect, delay);
}

async function checkAuth() {
  try {
    const res = await fetch("/api/me", { credentials: "same-origin" });
    // Signed out: our 401, or Foliation's edge answering with its sign-in page instead.
    const json = res.headers.get("content-type")?.includes("json");
    if (res.status === 401 || (res.ok && (res.redirected || !json))) return authListeners.forEach((f) => f("signedOut"));
    if (!res.ok) return;
    const me = (await res.json()) as { allowed?: boolean };
    authListeners.forEach((f) => f(me.allowed ? "ok" : "notOwner"));
  } catch {
    // offline: the network, not the sign-in
  }
}

// A phone waking the tab or the device coming back online: reconnect now instead of waiting out
// the backoff, and check that an "open" socket still answers.
function wake() {
  if (!ws) {
    attempt = 0;
    return connect();
  }
  if (ws.readyState !== WebSocket.OPEN) return;
  const sock = ws;
  clearTimeout(probe);
  sock.send(JSON.stringify({ t: "ping" }));
  probe = setTimeout(() => drop(sock), 5_000);
}

document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && wake());
window.addEventListener("online", wake);
