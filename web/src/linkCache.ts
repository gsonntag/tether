// The short links this browser knows (code ↔ runner + session), so the address bar shows a
// session as `#/l/<code>` (route.ts) without asking a runner on every click, reload or Back. A code
// comes from the session's runner (the linkFor op, runner modules/links) or from opening a short
// link (ShortLink.tsx). Kept in localStorage; an entry goes when the runner's code would have expired.
//
// The runner keeps a code 7 days from the last time it handed it out, so a code in use here is
// renewed (asked for again) once a day.

/** The runner's life for a code (runner modules/links/store.ts LINK_TTL_MS). */
export const LINK_TTL_MS = 7 * 24 * 60 * 60_000;
/** A code is asked for again (renewed on the runner) when it was last handed out longer ago than this. */
export const RENEW_MS = 24 * 60 * 60_000;
/** After a runner couldn't give a code (old runner, offline, error), the wait before asking it again. */
export const RETRY_MS = 60_000;
/** The most entries kept. */
export const MAX_ENTRIES = 1000;
const STORE_KEY = "tether.links";

export interface Entry {
  code: string;
  runnerId: string;
  sessionId: string;
  /** when the runner last handed the code out (a code only resolved counts as handed out RENEW_MS ago: renewed when next wanted) */
  renewedAt: number;
}

export type AskCode = (runnerId: string, sessionId: string) => Promise<string | null>;

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

const key = (runnerId: string, sessionId: string) => `${runnerId}\u0000${sessionId}`;

export class LinkCache {
  private byCode = new Map<string, Entry>();
  private bySession = new Map<string, Entry>();
  private asking = new Set<string>();
  private failedAt = new Map<string, number>();
  private listeners = new Set<() => void>();
  private ask?: AskCode;
  /** bumped on every change (useSyncExternalStore's snapshot) */
  version = 0;

  constructor(
    private store: Storage | undefined = typeof localStorage === "undefined" ? undefined : localStorage,
    private now: () => number = Date.now,
  ) {
    try {
      const list = JSON.parse(this.store?.getItem(STORE_KEY) ?? "[]");
      if (Array.isArray(list)) for (const e of list) if (e && typeof e.code === "string" && typeof e.runnerId === "string" && typeof e.sessionId === "string" && typeof e.renewedAt === "number") this.put(e);
    } catch {}
    this.prune();
  }

  /** How codes are asked for (store.ts: the linkFor op). */
  setAsk(ask: AskCode) {
    this.ask = ask;
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };

  /** What a code opens, as far as this browser knows. */
  session(code: string): { runnerId: string; sessionId: string } | undefined {
    const e = this.byCode.get(code);
    return e && this.live(e) ? { runnerId: e.runnerId, sessionId: e.sessionId } : undefined;
  }

  /** The session's code, as far as this browser knows. */
  code(runnerId: string, sessionId: string): string | undefined {
    const e = this.bySession.get(key(runnerId, sessionId));
    return e && this.live(e) ? e.code : undefined;
  }

  /**
   * A code and its session. `fromRunner`: the runner just handed it out (linkFor), else it was
   * only resolved (and is renewed on the next `want`).
   */
  remember(code: string, runnerId: string, sessionId: string, fromRunner: boolean) {
    const had = this.bySession.get(key(runnerId, sessionId));
    const renewedAt = fromRunner ? this.now() : had?.code === code ? had.renewedAt : this.now() - RENEW_MS;
    if (had?.code === code && had.renewedAt === renewedAt) return;
    this.put({ code, runnerId, sessionId, renewedAt });
    this.changed();
  }

  /** The session's code is wanted (it's open): asks its runner when there's none, or it's due a renewal. */
  want(runnerId: string, sessionId: string) {
    const k = key(runnerId, sessionId);
    const e = this.bySession.get(k);
    const at = this.now();
    if (e && this.live(e) && at - e.renewedAt < RENEW_MS) return;
    if (!this.ask || this.asking.has(k) || at - (this.failedAt.get(k) ?? -Infinity) < RETRY_MS) return;
    this.asking.add(k);
    this.ask(runnerId, sessionId)
      .then((code) => {
        if (code) {
          this.failedAt.delete(k);
          this.remember(code, runnerId, sessionId, true);
        } else this.failedAt.set(k, this.now());
      })
      .catch(() => this.failedAt.set(k, this.now()))
      .finally(() => this.asking.delete(k));
  }

  /** Runners came online: the ones that couldn't answer may be asked again at once. */
  retrySoon() {
    this.failedAt.clear();
  }

  /** An entry the runner hasn't let expire. */
  private live(e: Entry) {
    return this.now() - e.renewedAt < LINK_TTL_MS;
  }

  private put(e: Entry) {
    const old = this.bySession.get(key(e.runnerId, e.sessionId));
    if (old) this.byCode.delete(old.code);
    const other = this.byCode.get(e.code);
    if (other) this.bySession.delete(key(other.runnerId, other.sessionId));
    this.byCode.set(e.code, e);
    this.bySession.set(key(e.runnerId, e.sessionId), e);
  }

  private prune() {
    for (const e of [...this.byCode.values()]) {
      if (!this.live(e)) {
        this.byCode.delete(e.code);
        this.bySession.delete(key(e.runnerId, e.sessionId));
      }
    }
    // Oldest out first.
    const extra = this.byCode.size - MAX_ENTRIES;
    if (extra > 0)
      for (const e of [...this.byCode.values()].sort((a, b) => a.renewedAt - b.renewedAt).slice(0, extra)) {
        this.byCode.delete(e.code);
        this.bySession.delete(key(e.runnerId, e.sessionId));
      }
  }

  private changed() {
    this.prune();
    try {
      this.store?.setItem(STORE_KEY, JSON.stringify([...this.byCode.values()]));
    } catch {}
    this.version++;
    for (const fn of this.listeners) fn();
  }
}

export const linkCache = new LinkCache();
