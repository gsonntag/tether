// The sessions this page has open, and keeping them subscribed. The server forgets a browser's
// subscriptions when its socket drops and a runner's when the runner reconnects, so both call
// resubscribe(); each open session then gets a fresh snapshot (SPEC §5, sync). The same session
// can be shown in several places: one subscription serves all its watchers, and it ends when the
// last of them closes.

import type { SessionSnapshot } from "../../shared/transcript";

type Subscribe = (runnerId: string, sessionId: string) => Promise<SessionSnapshot>;
type Unsubscribe = (runnerId: string, sessionId: string) => Promise<unknown>;

interface Watch {
  runnerId: string;
  sessionId: string;
  onSnapshot: (s: SessionSnapshot) => void;
  onError?: (e: Error) => void;
}

interface Open {
  runnerId: string;
  sessionId: string;
  watchers: Set<Watch>;
  /** bumped by every subscribe: only the newest one's answer counts */
  gen: number;
}

const key = (runnerId: string, sessionId: string) => `${runnerId}\u0000${sessionId}`;

export interface SubscriptionOptions {
  /**
   * Resubscribing many sessions at once (a reconnect) spaces their subscribes this far apart, so
   * the runner doesn't answer with every snapshot in one burst (each can be megabytes, and the
   * relay closes a socket whose send buffer overflows). 0: all at once.
   */
  staggerMs?: number;
}

export class Subscriptions {
  private open = new Map<string, Open>();
  private readonly staggerMs: number;

  constructor(
    private subscribe: Subscribe,
    private unsubscribe: Unsubscribe,
    opts: SubscriptionOptions = {},
  ) {
    this.staggerMs = opts.staggerMs ?? 75;
  }

  /** Starts watching a session; snapshots arrive through onSnapshot (now and after every resubscribe). */
  watch(w: Watch): () => void {
    const k = key(w.runnerId, w.sessionId);
    let o = this.open.get(k);
    if (!o) this.open.set(k, (o = { runnerId: w.runnerId, sessionId: w.sessionId, watchers: new Set(), gen: 0 }));
    // A copy: the same callbacks watching twice are still two watchers.
    const mine = { ...w };
    o.watchers.add(mine);
    // A new watcher needs a snapshot of its own; a fresh one serves every watcher alike.
    this.fetch(o);
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      o.watchers.delete(mine);
      if (o.watchers.size || this.open.get(k) !== o) return;
      this.open.delete(k);
      // Not an error if it fails: a dropped link already took the subscription with it.
      this.unsubscribe(o.runnerId, o.sessionId).catch(() => {});
    };
  }

  /** Subscribes again to every open session, or only those on the given runners, staggered. */
  resubscribe(runnerIds?: string[]) {
    const list = [...this.open.values()].filter((o) => !runnerIds || runnerIds.includes(o.runnerId));
    list.forEach((o, i) => {
      if (i === 0 || !this.staggerMs) return this.fetch(o);
      // Claimed now, so an answer to an older subscribe that lands meanwhile is already stale.
      const gen = ++o.gen;
      setTimeout(() => this.open.get(key(o.runnerId, o.sessionId)) === o && o.gen === gen && this.fetch(o), i * this.staggerMs);
    });
  }

  /** A fresh snapshot of one open session (after a gap in its events, or a resync). */
  refresh(runnerId: string, sessionId: string) {
    const o = this.open.get(key(runnerId, sessionId));
    if (o) this.fetch(o);
  }

  /** Open sessions (not watchers). */
  get size() {
    return this.open.size;
  }

  private fetch(o: Open) {
    const gen = ++o.gen;
    // An older subscribe answering after a newer one would roll the view back: drop it.
    const current = () => this.open.get(key(o.runnerId, o.sessionId)) === o && o.gen === gen;
    this.subscribe(o.runnerId, o.sessionId).then(
      (snap) => current() && [...o.watchers].forEach((w) => w.onSnapshot(snap)),
      (e: Error) => current() && [...o.watchers].forEach((w) => w.onError?.(e)),
    );
  }
}

/**
 * When to resubscribe: everything on each server hello (the server dropped this page's
 * subscriptions with its old socket), and a runner's sessions when that runner reconnects. The
 * runners list right after a hello names runners this page only just learned are online; hello
 * already covered them, so that one list doesn't trigger a second round.
 */
export function resubscriber(subs: Pick<Subscriptions, "resubscribe">) {
  let afterHello = false;
  return {
    hello() {
      subs.resubscribe();
      afterHello = true;
    },
    runners(reconnectedIds: string[]) {
      if (reconnectedIds.length && !afterHello) subs.resubscribe(reconnectedIds);
      afterHello = false;
    },
  };
}
