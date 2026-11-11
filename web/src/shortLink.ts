// A short link (`#/l/<code>`, runner modules/links): the code doesn't say which runner made it, so
// every connected runner is asked (over the signed-in rpc, so it opens nothing the person couldn't
// already) and the first that knows it wins. The page then becomes the session's own #/s/… in place.
//
// Only a runner's real answer is a "no": a dropped link, a runner restarting or a relay that lost it
// is asked again once the link is back (or the runner is), so a good link never reads as expired.

import { NO_ANSWER } from "./link";

/** What a code may look like; anything else is never asked about. */
export const CODE_RE = /^[0-9A-Za-z]{4,32}$/;
/** How long after the link opens "doesn't exist" may show: runners announce themselves just after. */
export const SETTLE_MS = 2_000;
/** How long after the link opens with no runner connected before saying so (still waiting for one). */
export const OFFLINE_MS = 10_000;
/** How long one runner gets to answer an ask. */
export const ASK_TIMEOUT_MS = 8_000;
/** After an error (not a timeout), how long before that runner is asked again. */
export const RETRY_MS = 2_000;
/** After timeouts, the wait before asking again: doubling from ASK_TIMEOUT_MS, at most this. */
export const TIMEOUT_BACKOFF_MAX_MS = 30_000;
/** How long a runner may go without a real answer before the page says it isn't answering. */
export const SLOW_MS = 30_000;

/**
 * looking: asking (spinner) · connecting: the app's link isn't open · missing: every runner said no ·
 * maybeOffline: every connected runner said no, but one is offline · unanswered: a runner hasn't
 * answered for SLOW_MS · offline: no runner connected.
 */
export type LinkLook = "looking" | "connecting" | "missing" | "maybeOffline" | "unanswered" | "offline";

export type Answer = { kind: "hit"; sessionId: string } | { kind: "miss" } | { kind: "timeout" } | { kind: "error" };

export type Ask = (runnerId: string, code: string) => Promise<{ sessionId: string } | null>;

/** Asks one runner. An older runner without the op doesn't know the code either. */
export async function askRunner(ask: Ask, runnerId: string, code: string): Promise<Answer> {
  try {
    const r = await ask(runnerId, code);
    return r && typeof r.sessionId === "string" && r.sessionId ? { kind: "hit", sessionId: r.sessionId } : { kind: "miss" };
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (msg.includes("doesn't know")) return { kind: "miss" };
    if (msg === NO_ANSWER) return { kind: "timeout" };
    return { kind: "error" };
  }
}

/** One short link's lookup: who to ask when, and what the page shows. Only a runner's real "no" feeds "doesn't exist". */
export class Lookup {
  /** asked, no answer yet */
  private inFlight = new Set<string>();
  /** said they don't know it: a real answer, kept across reconnects */
  private missed = new Set<string>();
  /** no real answer yet: when each was first asked since the link opened */
  private firstAsked = new Map<string, number>();
  private retryAt = new Map<string, number>();
  /** timeouts in a row, for the backoff */
  private timeouts = new Map<string, number>();
  /** a timeout since the link opened already asked the link to check itself */
  private woke = false;
  /** when the link last opened; undefined while it's down */
  private openedAt?: number;

  constructor(readonly code: string) {}

  /** The link's state: waits count from when it (re)opens, and everything but real answers starts over. */
  linkOpen(open: boolean, now: number) {
    if (!open) return void (this.openedAt = undefined);
    if (this.openedAt !== undefined) return;
    this.openedAt = now;
    this.firstAsked.clear();
    this.retryAt.clear();
    this.timeouts.clear();
    this.woke = false;
  }

  /** The runners to ask now (each one marked asked). */
  toAsk(online: string[], now: number): string[] {
    if (this.openedAt === undefined || !CODE_RE.test(this.code)) return [];
    const ids = online.filter((id) => !this.inFlight.has(id) && !this.missed.has(id) && (this.retryAt.get(id) ?? 0) <= now);
    for (const id of ids) {
      this.inFlight.add(id);
      if (!this.firstAsked.has(id)) this.firstAsked.set(id, now);
    }
    return ids;
  }

  /** A runner's answer: its session when it knows the code; `wake` the first time one times out (the socket may be half dead). */
  answered(runnerId: string, a: Answer, now: number): { sessionId?: string; wake?: boolean } {
    this.inFlight.delete(runnerId);
    if (a.kind === "hit") return { sessionId: a.sessionId };
    if (a.kind === "miss") {
      this.missed.add(runnerId);
      this.firstAsked.delete(runnerId);
      return {};
    }
    if (a.kind === "timeout") {
      const n = (this.timeouts.get(runnerId) ?? 0) + 1;
      this.timeouts.set(runnerId, n);
      this.retryAt.set(runnerId, now + Math.min(ASK_TIMEOUT_MS * 2 ** (n - 1), TIMEOUT_BACKOFF_MAX_MS));
      const wake = !this.woke;
      this.woke = true;
      return wake ? { wake } : {};
    }
    this.retryAt.set(runnerId, now + RETRY_MS);
    return {};
  }

  /** `offlineKnown`: runners this browser knows that aren't connected now. */
  look(online: string[], offlineKnown: string[], now: number): LinkLook {
    if (!CODE_RE.test(this.code)) return "missing";
    if (this.openedAt === undefined) return "connecting";
    if (online.length === 0) return now - this.openedAt >= OFFLINE_MS ? "offline" : "looking";
    if (online.every((id) => this.missed.has(id))) {
      if (now - this.openedAt < SETTLE_MS) return "looking";
      return offlineKnown.length ? "maybeOffline" : "missing";
    }
    const slow = online.some((id) => !this.missed.has(id) && now - (this.firstAsked.get(id) ?? now) >= SLOW_MS);
    return slow ? "unanswered" : "looking";
  }
}
