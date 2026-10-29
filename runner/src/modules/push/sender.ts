// Sending one push (Web Push with VAPID, through the `web-push` library).

import webpush from "web-push";
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
      const res = await fetch(d.endpoint, { method: d.method, headers: d.headers as Record<string, string>, body: d.body as any, signal: AbortSignal.timeout(20_000) });
      status = res.status;
      if (status >= 200 && status < 300) return false;
      why = `${status} ${(await res.text().catch(() => "")).slice(0, 300)}`.trim();
    } catch (e: any) {
      status = 0;
      why = e?.message ?? String(e);
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
