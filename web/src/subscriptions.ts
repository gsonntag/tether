// The sessions this page has open, and keeping them subscribed. The server forgets a browser's
// subscriptions when its socket drops and a runner's when the runner reconnects, so both call
// resubscribe(); each open session then gets a fresh snapshot (SPEC §5, sync).

import type { SessionSnapshot } from "../../shared/transcript";

type Subscribe = (runnerId: string, sessionId: string) => Promise<SessionSnapshot>;
type Unsubscribe = (runnerId: string, sessionId: string) => Promise<unknown>;

interface Watch {
  runnerId: string;
  sessionId: string;
  onSnapshot: (s: SessionSnapshot) => void;
  onError?: (e: Error) => void;
}

interface Open extends Watch {
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
    const o: Open = { ...w, gen: 0 };
    this.open.set(k, o);
    this.fetch(o);
    return () => {
      if (this.open.get(k) !== o) return;
      this.open.delete(k);
      // Not an error if it fails: a dropped link already took the subscription with it.
      this.unsubscribe(w.runnerId, w.sessionId).catch(() => {});
    };
  }

  /** Subscribes again to every open session, or only those on the given runners. */
  resubscribe(runnerIds?: string[]) {
    for (const o of this.open.values()) if (!runnerIds || runnerIds.includes(o.runnerId)) this.fetch(o);
  }

  get size() {
    return this.open.size;
  }

  private fetch(o: Open) {
    const gen = ++o.gen;
    // An older subscribe answering after a newer one would roll the view back: drop it.
    const current = () => this.open.get(key(o.runnerId, o.sessionId)) === o && o.gen === gen;
    this.subscribe(o.runnerId, o.sessionId).then(
      (snap) => current() && o.onSnapshot(snap),
      (e: Error) => current() && o.onError?.(e),
    );
  }
}
