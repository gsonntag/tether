// Sending one push (Web Push with VAPID, through the `web-push` library).

import http from "node:http";
import https from "node:https";
import webpush from "web-push";
import { pinnedLookup } from "./endpoint";

/**
 * POSTs to a push endpoint: the address connected to is the one checked (pinnedLookup), redirects
 * aren't followed, and only the status comes back (the body is read and dropped).
 */
export function postPush(endpoint: string, headers: Record<string, string>, body: Buffer | string, o: { dev: boolean; timeoutMs?: number }): Promise<{ status: number; statusText: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(endpoint);
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request(u, { method: "POST", headers: { ...headers, "content-length": String(Buffer.byteLength(body)) }, lookup: pinnedLookup(o.dev) as any, timeout: o.timeoutMs ?? 20_000 }, (res) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0, statusText: res.statusMessage ?? "" });
    });
    req.on("timeout", () => req.destroy(Object.assign(new Error("no answer in 20 s"), { name: "TimeoutError" })));
    req.on("error", reject);
    req.end(body);
  });
}
import type { PushKeys, PushPayload } from "../../../../shared/protocol";
import type { PushSub } from "./store";

export interface Sender {
  ready(): boolean;
  /** true when the push service says the subscription is gone (drop it) */
  send(sub: PushSub, payload: PushPayload, throwErrors?: boolean): Promise<boolean>;
}

/**
 * The VAPID `sub` claim: the server's choice, else the app's own https URL (Apple's push service
 * refuses a localhost address), else a mailto.
 */
export function pushSubject(serverSubject: string | undefined, appUrl: string): string {
  if (serverSubject) return serverSubject;
  try {
    const u = new URL(appUrl);
    if (u.protocol === "https:" && u.hostname !== "localhost") return u.origin;
  } catch {}
  return "mailto:tether@example.com";
}

/** Push services replace an undelivered message with the same topic (≤ 32 url-safe chars). */
export function topicOf(key: string) {
  let h = 0;
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) | 0;
  return `t${(h >>> 0).toString(36)}`;
}

export class PushSender implements Sender {
  private keys?: PushKeys;

  constructor(
    private appUrl: string,
    private log: (line: string) => void,
    /** checked before every push (a name may resolve somewhere else now): why it's refused */
    private vet: (endpoint: string) => Promise<string | undefined> = async () => undefined,
    /** a dev runner: plain http to this machine is allowed (tests) */
    private dev = false,
  ) {}

  setKeys(k: PushKeys | undefined) {
    if (k) this.keys = k;
  }

  ready() {
    return !!this.keys;
  }

  async send(sub: PushSub, payload: PushPayload, throwErrors = false): Promise<boolean> {
    const k = this.keys;
    if (!k) return false;
    let status: number;
    let why = "";
    const refused = await this.vet(sub.endpoint);
    if (refused) {
      this.log(`push to ${safeHost(sub.endpoint)} refused: ${refused}`);
      if (throwErrors) throw new Error(refused);
      return true;
    }
    try {
      // web-push builds the request (encryption, VAPID); fetch sends it (any proxy applies, and a
      // local test push service on http works).
      const d = webpush.generateRequestDetails({ endpoint: sub.endpoint, keys: sub.keys }, JSON.stringify(payload), {
        vapidDetails: { subject: pushSubject(k.subject, this.appUrl), publicKey: k.publicKey, privateKey: k.privateKey },
        TTL: 24 * 3600,
        urgency: payload.kind === "request" ? "high" : "normal",
        // A newer "finished" for a session replaces one not yet delivered; requests all arrive.
        ...(payload.tag && payload.kind !== "request" ? { topic: topicOf(payload.tag) } : {}),
      });
      // Never followed: a push service doesn't redirect, and a redirect could lead anywhere.
      const res = await postPush(d.endpoint, d.headers as Record<string, string>, d.body as Buffer, { dev: this.dev });
      status = res.status;
      if (status >= 200 && status < 300) return false;
      // Only the status: what the endpoint answered isn't passed back to anyone.
      why = `HTTP ${status}${res.statusText ? ` ${res.statusText}` : ""}`;
    } catch (e: any) {
      status = 0;
      why = e?.name === "TimeoutError" ? "no answer in 20 s" : e?.code === "EPRIVATE" ? e.message : "couldn't reach it";
    }
    // 404/410: the browser dropped the subscription (unsubscribed, cleared data, uninstalled).
    const gone = status === 404 || status === 410;
    if (!gone) this.log(`push to ${safeHost(sub.endpoint)} failed: ${why}`);
    if (throwErrors && !gone) throw new Error(`The push service refused it: ${why}`);
    return gone;
  }
}

const safeHost = (u: string) => {
  try {
    return new URL(u).host;
  } catch {
    return "?";
  }
};
