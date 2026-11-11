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
/** How long with no runner connected before saying so (still waiting for one). */
export const OFFLINE_MS = 10_000;
/** How long one runner gets to answer before it's asked again. */
export const ASK_TIMEOUT_MS = 8_000;
/** After an error (not a timeout), how long before that runner is asked again. */
export const RETRY_MS = 2_000;

export type LinkLook = "looking" | "missing" | "offline";

export type Answer = { kind: "hit"; sessionId: string } | { kind: "miss" } | { kind: "timeout" } | { kind: "error" };

export type Ask = (runnerId: string, code: string) => Promise<{ sessionId: string } | null>;

/** Asks one runner. An older runner without the op doesn't know the code either. */
export async function askRunner(ask: Ask, runnerId: string, code: string): Promise<Answer> {
  try {
    const r = await ask(runnerId, code);
    return r && typeof r.sessionId === "string" ? { kind: "hit", sessionId: r.sessionId } : { kind: "miss" };
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (msg.includes("doesn't know")) return { kind: "miss" };
    if (msg === NO_ANSWER) return { kind: "timeout" };
    return { kind: "error" };
  }
}

/** One short link's lookup: who to ask when, and what the page shows. */
export class Lookup {
  /** asked, no answer yet */
  private inFlight = new Set<string>();
  /** said they don't know it */
  private missed = new Set<string>();
  /** answered (a no) or timed out at least once since the link opened */
  private settled = new Set<string>();
  private retryAt = new Map<string, number>();
  /** when the link last opened; undefined while it's down */
  private openedAt?: number;
  private readonly since: number;

  constructor(
    readonly code: string,
    now: number,
  ) {
    this.since = now;
  }

  /** The link's state: the settle wait counts from when it (re)opens. */
  linkOpen(open: boolean, now: number) {
    if (!open) this.openedAt = undefined;
    else this.openedAt ??= now;
  }

  /** The runners to ask now (each one marked asked). */
  toAsk(online: string[], now: number): string[] {
    if (this.openedAt === undefined || !CODE_RE.test(this.code)) return [];
    const ids = online.filter((id) => !this.inFlight.has(id) && !this.missed.has(id) && (this.retryAt.get(id) ?? 0) <= now);
    for (const id of ids) this.inFlight.add(id);
    return ids;
  }

  /** A runner's answer; its session when it knows the code. */
  answered(runnerId: string, a: Answer, now: number): string | undefined {
    this.inFlight.delete(runnerId);
    if (a.kind === "hit") return a.sessionId;
    if (a.kind === "miss") {
      this.missed.add(runnerId);
      this.settled.add(runnerId);
    } else if (a.kind === "timeout") {
      // Wedged, maybe: it doesn't hold "doesn't exist" up, but it's asked again.
      if (this.openedAt !== undefined) this.settled.add(runnerId);
      this.retryAt.delete(runnerId);
    } else {
      this.retryAt.set(runnerId, now + RETRY_MS);
    }
    return undefined;
  }

  look(online: string[], now: number): LinkLook {
    if (!CODE_RE.test(this.code)) return "missing";
    if (online.length === 0) return now - this.since >= OFFLINE_MS ? "offline" : "looking";
    if (this.openedAt !== undefined && now - this.openedAt >= SETTLE_MS && online.every((id) => this.settled.has(id))) return "missing";
    return "looking";
  }
}
