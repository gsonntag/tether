// Short links (`<appUrl>/#/l/<code>`) for what Tether texts the person, in place of the long
// `#/s/<runnerId>/<sessionId>`. The mapping lives here on the runner (links.json in the module's
// folder, mode 600): the server is a stateless relay. A code is 8 random base62 characters; it
// lasts LINK_TTL_MS from the last time it was handed out (the same session's code is reused and its
// life renewed, so a link just sent is always good for 7 days). The web app resolves a code by
// asking its runners (the resolveLink op, behind the app's sign-in): nothing is revealed to anyone
// who couldn't already open the session.

import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

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
  /** the file couldn't be read (not a parse error): it's left alone, and links run in memory only */
  private readOnly = false;

  constructor(
    private file?: string,
    private now: () => number = Date.now,
    private code: () => string = () => randomCode(),
    private log: (line: string) => void = () => {},
  ) {
    if (!file) return;
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch (e: any) {
      if (e?.code === "ENOENT") return;
      // Permissions, I/O: the file may be fine. Never written over by this process.
      this.readOnly = true;
      this.log(`links: couldn't read ${file} (${e?.message ?? e}); texts get long links until the runner restarts with it readable`);
      return;
    }
    try {
      const v = JSON.parse(raw);
      if (!v || typeof v !== "object" || !v.links || typeof v.links !== "object") throw new Error("no links in it");
      for (const [c, e] of Object.entries<any>(v.links)) {
        if (CODE_RE.test(c) && typeof e?.sessionId === "string" && e.sessionId && typeof e.createdAt === "number" && typeof e.expiresAt === "number") this.links.set(c, { sessionId: e.sessionId, createdAt: e.createdAt, expiresAt: e.expiresAt });
      }
    } catch (e: any) {
      this.setAside(file, e);
    }
    this.prune();
  }

  /** A broken file is kept for a look (only the newest), not overwritten: its links stop working, the next ones start fresh. */
  private setAside(file: string, why: any) {
    const aside = `${file}.corrupt-${this.now()}`;
    try {
      renameSync(file, aside);
      this.log(`links: ${file} couldn't be parsed (${why?.message ?? why}); moved it to ${basename(aside)}`);
    } catch (e: any) {
      this.readOnly = true;
      return this.log(`links: ${file} couldn't be parsed (${why?.message ?? why}) or moved aside (${e?.message ?? e}); links run in memory only`);
    }
    const dir = dirname(file);
    for (const f of readdirSync(dir)) {
      if (f.startsWith(`${basename(file)}.corrupt-`) && f !== basename(aside)) rmSync(join(dir, f), { force: true });
    }
  }

  /** A code for the session, good for LINK_TTL_MS from now (its unexpired one, renewed, when it has one); undefined when it couldn't be kept (it wouldn't outlive a restart). */
  codeFor(sessionId: string): string | undefined {
    if (!sessionId) return undefined;
    this.prune();
    const at = this.now();
    for (const [c, e] of this.links) {
      if (e.sessionId === sessionId) {
        e.expiresAt = at + LINK_TTL_MS;
        return this.save() ? c : undefined;
      }
    }
    let c = this.code();
    for (let i = 0; this.links.has(c); i++) {
      if (i > 100) return undefined;
      c = this.code();
    }
    this.links.set(c, { sessionId, createdAt: at, expiresAt: at + LINK_TTL_MS });
    if (this.save()) return c;
    this.links.delete(c);
    return undefined;
  }

  /** The session's short link in the app; undefined when there's none to give (the caller sends the long one). */
  url(appUrl: string, sessionId: string): string | undefined {
    const c = this.codeFor(sessionId);
    return c && `${appUrl.replace(/\/+$/, "")}/#/l/${c}`;
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

  /** Whether the links are on disk now (in-memory stores, with no file, always are as far as they go). */
  private save(): boolean {
    if (!this.file) return true;
    if (this.readOnly) return false;
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      writeFileSync(tmp, JSON.stringify({ links: Object.fromEntries(this.links) }), { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, this.file);
      return true;
    } catch (e: any) {
      rmSync(tmp, { force: true });
      this.log(`links: couldn't save ${this.file}: ${e?.message ?? e}`);
      return false;
    }
  }
}
