// Loop caps for sessions talking to each other (SPEC §9a). Nothing asks the person; instead an agent
// can't send to itself, chain messages past MAX_HOPS, send more than RATE_MAX in RATE_MS, keep more
// than ASKS_MAX asks open, ask a session that is (through others) waiting on its own ask, or
// broadcast more than once in RATE_MS or from a turn a broadcast started.

export const MAX_HOPS = 4;
export const RATE_MAX = 10;
export const RATE_MS = 10 * 60_000;
export const ASKS_MAX = 3;
export const BROADCAST_MAX = 20;

/** Where a session's current turn came from: how many sessions passed it on, and whether by a broadcast. */
export interface Hop {
  hops: number;
  broadcast?: boolean;
}

export class PeerCaps {
  /** when each sender's messages went, newest last */
  private sent = new Map<string, number[]>();
  private broadcasts = new Map<string, number>();
  /** open asks: asker -> the sessions it waits on (one entry per ask) */
  private asks = new Map<string, string[]>();
  /** each session's current turn */
  private turns = new Map<string, Hop>();

  constructor(private now: () => number = Date.now) {}

  /** The hop count a message from `from` carries. */
  hopsFrom(from: string): number {
    return (this.turns.get(from)?.hops ?? 0) + 1;
  }

  /** `id`'s turn now comes from that message (or, with none, from the person: hop 0). */
  turnFrom(id: string, hop?: Hop) {
    if (hop?.hops) this.turns.set(id, hop);
    else this.turns.delete(id);
  }

  /** Why `from` can't message `to` now, or undefined. */
  check(from: string, to: string, kind: "send" | "ask"): string | undefined {
    if (from === to) return "That's this session. Message another one.";
    if (this.hopsFrom(from) > MAX_HOPS)
      return `This message would be the ${this.hopsFrom(from)}th in a chain of sessions passing work along (at most ${MAX_HOPS}). Stop here and tell the person what you have.`;
    const rate = this.rate(from);
    if (rate) return rate;
    if (kind === "ask") {
      const open = this.asks.get(from)?.length ?? 0;
      if (open >= ASKS_MAX) return `You already have ${open} questions waiting for answers (at most ${ASKS_MAX}). Wait for those first.`;
      if (this.waitsOn(to, from)) return "That session is waiting for an answer from you, so asking it back would leave you both waiting. Answer it first (end your turn), or use tether_send.";
    }
    return undefined;
  }

  /** Why `from` can't broadcast now, or undefined. */
  checkBroadcast(from: string): string | undefined {
    if (this.turns.get(from)?.broadcast) return "This turn started with a note to all sessions, so it can't send one to all itself. Use tether_send to answer whoever wrote it.";
    if (this.hopsFrom(from) > MAX_HOPS) return `This turn is the end of a chain of ${MAX_HOPS} sessions passing work along: no more messages from it. Tell the person what you have.`;
    const last = this.broadcasts.get(from);
    if (last !== undefined && this.now() - last < RATE_MS) {
      const m = Math.max(1, Math.round((this.now() - last) / 60_000));
      return `You sent a note to all sessions ${m} minute${m === 1 ? "" : "s"} ago. At most one every ${RATE_MS / 60_000} minutes.`;
    }
    return this.rate(from);
  }

  private rate(from: string): string | undefined {
    const recent = (this.sent.get(from) ?? []).filter((t) => this.now() - t < RATE_MS);
    this.sent.set(from, recent);
    if (recent.length >= RATE_MAX) return `You've sent ${recent.length} messages to other sessions in the last ${RATE_MS / 60_000} minutes (at most ${RATE_MAX}). Wait, or tell the person instead.`;
    return undefined;
  }

  /** A message (or one broadcast) went from `from`. */
  count(from: string, broadcast = false) {
    this.sent.set(from, [...(this.sent.get(from) ?? []), this.now()]);
    if (broadcast) this.broadcasts.set(from, this.now());
  }

  /** `from` waits on `to`; the returned function ends the wait. */
  open(from: string, to: string): () => void {
    this.asks.set(from, [...(this.asks.get(from) ?? []), to]);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const list = [...(this.asks.get(from) ?? [])];
      list.splice(list.indexOf(to), 1);
      if (list.length) this.asks.set(from, list);
      else this.asks.delete(from);
    };
  }

  /** Whether `a` waits (directly or through other asks) on `b`. */
  private waitsOn(a: string, b: string, seen = new Set<string>()): boolean {
    if (seen.has(a)) return false;
    seen.add(a);
    return (this.asks.get(a) ?? []).some((x) => x === b || this.waitsOn(x, b, seen));
  }
}
