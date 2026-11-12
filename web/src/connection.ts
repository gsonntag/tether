// The page's one link to the relay (link.ts), wired to the browser: the socket URL, /api/me, and
// waking on visibility and network changes.

import type { BrowserToServer, OpArgs, OpName, OpResult, ServerToBrowser } from "../../shared/protocol";
import { Link, type AuthState, type LinkState } from "./link";

export type { AuthState, LinkState };

const link = new Link({
  url: `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/ws`,
  open: (url) => new WebSocket(url),
  me: async () => {
    const res = await fetch("/api/me", { credentials: "same-origin" });
    const json = !!res.headers.get("content-type")?.includes("json");
    return { status: res.status, redirected: res.redirected, json, body: json && res.ok ? await res.json() : undefined };
  },
  ticket: async () => {
    const res = await fetch("/api/ws-ticket", { credentials: "same-origin", cache: "no-store" });
    // The edge's sign-in page instead of our JSON: signed out, as good as a 401.
    if (res.redirected || !res.headers.get("content-type")?.includes("json")) return { status: res.ok ? 401 : res.status };
    return { status: res.status, ticket: res.ok ? (await res.json()).ticket : undefined };
  },
});

export const on = <T extends ServerToBrowser["t"]>(t: T, fn: (m: Extract<ServerToBrowser, { t: T }>) => void) => link.on(t, fn);
export const onLinkState = (fn: (s: LinkState) => void) => link.onState(fn);
export const onAuth = (fn: (a: AuthState) => void) => link.onAuth(fn);
export const connect = () => link.connect();
/** Checks that a link that looks open still answers (and redials one that doesn't). */
export const wakeLink = () => link.wake();

/** A frame that needs no answer (presence); false when not connected. */
export const sendFrame = (m: Exclude<BrowserToServer, { t: "rpc" }>) => link.send(m);

/** Calls an op on a runner through the relay (`timeoutMs`: sooner than the usual wait for an answer). */
export const rpc = <K extends OpName>(runnerId: string, op: K, args: OpArgs<K>, timeoutMs?: number) => link.rpc(runnerId, op, args, timeoutMs) as Promise<OpResult<K>>;

document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && link.wake());
window.addEventListener("online", () => link.wake());
