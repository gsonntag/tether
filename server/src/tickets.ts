// Renew tickets for browser sockets. A browser socket is authenticated once, at the upgrade, and
// the browser never sees the edge's identity token, so the server can't re-check it over the
// socket. Instead the page fetches GET /api/ws-ticket now and then (an ordinary request, which the
// edge signs afresh) and hands the ticket over the socket: proof that this person still passed
// the owner check moments ago. A revoked share or a demoted owner gets no more tickets, and the
// socket is closed when its last one runs out (relay.ts).
//
// ticket = base64url(JSON {sub, exp}) "." base64url(HMAC-SHA256(secret, that payload part)). The
// secret is random per server process: a restart drops every socket anyway.

import { createHmac, timingSafeEqual } from "node:crypto";

/** How long a ticket is good for after it's issued. */
export const TICKET_TTL_MS = 5 * 60_000;

export interface TicketOptions {
  ttlMs?: number;
  now?: () => number;
  /** for tests; otherwise 32 random bytes */
  secret?: Uint8Array;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export class Tickets {
  private readonly secret: Uint8Array;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts: TicketOptions = {}) {
    this.secret = opts.secret ?? crypto.getRandomValues(new Uint8Array(32));
    this.ttlMs = opts.ttlMs ?? TICKET_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  issue(sub: string): string {
    const payload = b64url(JSON.stringify({ sub, exp: this.now() + this.ttlMs }));
    return `${payload}.${this.mac(payload).toString("base64url")}`;
  }

  /** The ticket's subject and expiry when it is genuine and unexpired, else null. */
  verify(ticket: string): { sub: string; exp: number } | null {
    const [payload, sig, extra] = ticket.split(".");
    if (!payload || !sig || extra !== undefined) return null;
    const given = Buffer.from(sig, "base64url");
    const want = this.mac(payload);
    if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
    let claims: unknown;
    try {
      claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    } catch {
      return null;
    }
    const { sub, exp } = (claims ?? {}) as { sub?: unknown; exp?: unknown };
    if (typeof sub !== "string" || !sub || typeof exp !== "number" || !(exp > this.now())) return null;
    return { sub, exp };
  }

  private mac(payload: string): Buffer {
    return createHmac("sha256", this.secret).update(payload).digest();
  }
}
