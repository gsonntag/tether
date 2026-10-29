// The page's one link to the relay (link.ts), wired to the browser: the socket URL, /api/me, and
// waking on visibility and network changes.

import type { OpArgs, OpName, OpResult, ServerToBrowser } from "../../shared/protocol";
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
});

export const on = <T extends ServerToBrowser["t"]>(t: T, fn: (m: Extract<ServerToBrowser, { t: T }>) => void) => link.on(t, fn);
export const onLinkState = (fn: (s: LinkState) => void) => link.onState(fn);
export const onAuth = (fn: (a: AuthState) => void) => link.onAuth(fn);
export const connect = () => link.connect();

/** Calls an op on a runner through the relay. */
export const rpc = <K extends OpName>(runnerId: string, op: K, args: OpArgs<K>) => link.rpc(runnerId, op, args) as Promise<OpResult<K>>;

document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && link.wake());
window.addEventListener("online", () => link.wake());
