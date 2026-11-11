// A short link (`#/l/<code>`, runner modules/links): the code doesn't say which runner made it, so
// every connected runner is asked (over the signed-in rpc, so it opens nothing the person couldn't
// already) and the first that knows it wins. The page then becomes the session's own #/s/… in place.

/** What a code may look like; anything else is never asked about. */
export const CODE_RE = /^[0-9A-Za-z]{4,32}$/;
/** How long after the link is open (and every connected runner answered) "doesn't exist" may show: runners announce themselves just after. */
export const SETTLE_MS = 2_000;
/** How long with no runner connected before saying so (still waiting for one). */
export const OFFLINE_MS = 10_000;

export type LinkLook = "looking" | "missing" | "offline";

/** What the page shows while resolving. */
export function linkLook(a: { code: string; elapsedMs: number; linkOpen: boolean; online: string[]; answered: ReadonlySet<string> }): LinkLook {
  if (!CODE_RE.test(a.code)) return "missing";
  if (a.online.length === 0) return a.elapsedMs >= OFFLINE_MS ? "offline" : "looking";
  if (a.linkOpen && a.elapsedMs >= SETTLE_MS && a.online.every((id) => a.answered.has(id))) return "missing";
  return "looking";
}

export type Ask = (runnerId: string, code: string) => Promise<{ runnerId: string; sessionId: string } | null>;

/** Asks one runner; an error (an older runner without the op, a timeout) counts as not knowing it. */
export async function askRunner(ask: Ask, runnerId: string, code: string): Promise<{ runnerId: string; sessionId: string } | undefined> {
  try {
    const r = await ask(runnerId, code);
    return r && typeof r.sessionId === "string" ? { runnerId: r.runnerId || runnerId, sessionId: r.sessionId } : undefined;
  } catch {
    return undefined;
  }
}
