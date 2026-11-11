// Short links (`<appUrl>/#/l/<code>`) for what Tether texts the person, in place of the long
// `#/s/<runnerId>/<sessionId>`. The mapping lives here on the runner (links.json in the module's
// folder, mode 600): the server is a stateless relay. A code is 8 random base62 characters; it
// lasts LINK_TTL_MS from the last time it was handed out (the same session's code is reused and its
// life renewed, so a link just sent is always good for 7 days). The web app resolves a code by
// asking its runners (the resolveLink op, behind the app's sign-in): nothing is revealed to anyone
// who couldn't already open the session.

import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const LINK_TTL_MS = 7 * 24 * 60 * 60_000;
export const CODE_LENGTH = 8;
const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
/** What a code looks like (anything else isn't looked up). */
export const CODE_RE = /^[0-9A-Za-z]{4,32}$/;

export interface LinkEntry {
  sessionId: string;
  createdAt: number;
  expiresAt: number;
}

/** `n` random base62 characters (rejection sampling, so every character is equally likely). */
export function randomCode(n = CODE_LENGTH, bytes: (n: number) => Uint8Array = randomBytes): string {
  let out = "";
  while (out.length < n) {
    for (const b of bytes(n * 2)) {
      // 248 = 4 × 62: bytes past it would favour the first characters.
      if (b < 248 && out.length < n) out += ALPHABET[b % 62];
    }
  }
  return out;
}

export class ShortLinks {
  private links = new Map<string, LinkEntry>();

  constructor(
    private file?: string,
    private now: () => number = Date.now,
    private code: () => string = () => randomCode(),
  ) {
    if (file) {
      try {
        const v = JSON.parse(readFileSync(file, "utf8"));
        for (const [c, e] of Object.entries<any>(v?.links ?? {})) {
          if (CODE_RE.test(c) && typeof e?.sessionId === "string" && typeof e.createdAt === "number" && typeof e.expiresAt === "number") this.links.set(c, { sessionId: e.sessionId, createdAt: e.createdAt, expiresAt: e.expiresAt });
        }
      } catch {}
      this.prune();
    }
  }

  /** A code for the session, good for LINK_TTL_MS from now (its unexpired one, renewed, when it has one). */
  codeFor(sessionId: string): string {
    this.prune();
    const at = this.now();
    for (const [c, e] of this.links) {
      if (e.sessionId === sessionId) {
        e.expiresAt = at + LINK_TTL_MS;
        this.save();
        return c;
      }
    }
    let c = this.code();
    for (let i = 0; this.links.has(c); i++) {
      if (i > 100) throw new Error("couldn't make an unused link code");
      c = this.code();
    }
    this.links.set(c, { sessionId, createdAt: at, expiresAt: at + LINK_TTL_MS });
    this.save();
    return c;
  }

  /** The session's short link in the app. */
  url(appUrl: string, sessionId: string): string {
    return `${appUrl.replace(/\/+$/, "")}/#/l/${this.codeFor(sessionId)}`;
  }

  /** What a code opens, while it hasn't expired. */
  resolve(code: unknown): { sessionId: string } | undefined {
    if (typeof code !== "string" || !CODE_RE.test(code)) return undefined;
    const e = this.links.get(code);
    if (!e || e.expiresAt <= this.now()) return undefined;
    return { sessionId: e.sessionId };
  }

  get size() {
    return this.links.size;
  }

  private prune() {
    const at = this.now();
    let gone = false;
    for (const [c, e] of this.links) if (e.expiresAt <= at) gone = this.links.delete(c) || gone;
    if (gone) this.save();
  }

  private save() {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ links: Object.fromEntries(this.links) }), { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, this.file);
    } catch {}
  }
}
