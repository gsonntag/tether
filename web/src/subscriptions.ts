// The sessions this page has open, and keeping them subscribed. The server forgets a browser's
// subscriptions when its socket drops and a runner's when the runner reconnects, so both call
// resubscribe(); each open session then gets a fresh snapshot (SPEC §5, sync).

import type { SessionSnapshot } from "../../shared/transcript";

type Subscribe = (runnerId: string, sessionId: string) => Promise<SessionSnapshot>;

interface Open {
  runnerId: string;
  sessionId: string;
  onSnapshot: (s: SessionSnapshot) => void;
  onError?: (e: Error) => void;
}

const key = (runnerId: string, sessionId: string) => `${runnerId}\u0000${sessionId}`;

export class Subscriptions {
  private open = new Map<string, Open>();

  constructor(private subscribe: Subscribe) {}

  /** Starts watching a session; the snapshot arrives through onSnapshot (now and after every resubscribe). */
  watch(o: Open): () => void {
    const k = key(o.runnerId, o.sessionId);
    this.open.set(k, o);
    this.fetch(o);
    return () => {
      if (this.open.get(k) === o) this.open.delete(k);
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
    this.subscribe(o.runnerId, o.sessionId).then(
      (snap) => this.open.get(key(o.runnerId, o.sessionId)) === o && o.onSnapshot(snap),
      (e: Error) => this.open.get(key(o.runnerId, o.sessionId)) === o && o.onError?.(e),
    );
  }
}
