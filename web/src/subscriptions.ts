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

export class Subscriptions {
  private open = new Map<string, Open>();

  constructor(
    private subscribe: Subscribe,
    private unsubscribe: Unsubscribe,
  ) {}

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

  /** Subscribes again to every open session, or only those on the given runners. */
  resubscribe(runnerIds?: string[]) {
    for (const o of this.open.values()) if (!runnerIds || runnerIds.includes(o.runnerId)) this.fetch(o);
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
