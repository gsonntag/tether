/** A session's API usage only. Unknown prior usage or prices must not become a $0 total. */
export interface SessionCost {
  usd?: number;
  estimated: boolean;
  complete: boolean;
  /** What's missing from `usd`: fixed codes, a service tier or a model id. Never response text, keys or headers. */
  reasons?: string[];
  /** The same codes, for what a priced report assumed. It's still whole: the first real run reads these. */
  notes?: string[];
}

const REASON = /^(no-usage|no-cache-ttl|tool-fee|long-context|(tier|model):[\w.:-]{1,64})$/;
/** A value inside a reason: what doesn't look like a tier or a model id isn't stored. */
export const reasonValue = (value: unknown) => (typeof value === "string" && /^[\w.:-]{1,64}$/.test(value) ? value : "other");
export const costReasons = (value: unknown): string[] =>
  Array.isArray(value) ? [...new Set(value.filter((r) => typeof r === "string" && REASON.test(r)))].slice(0, 8) : [];

/** USD per one million tokens; deployment-specific rates may be supplied by the owner. */
export interface TokenRates { input: number; output: number; cached: number }

export function validRates(value: unknown): value is TokenRates {
  const rates = value as TokenRates | undefined;
  return !!rates && [rates.input, rates.output, rates.cached].every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1_000_000);
}

export function dollars(usd: number): string {
  if (usd > 0 && usd < 0.00005) return "<$0.0001";
  return `$${usd.toLocaleString("en-US", { minimumFractionDigits: usd > 0 && usd < 0.01 ? 4 : 2, maximumFractionDigits: usd > 0 && usd < 0.01 ? 4 : 2 })}`;
}

function missing(reason: string): string {
  if (reason === "no-usage") return "a request reported no usable token counts";
  if (reason === "no-cache-ttl") return "cache write lifetimes weren't reported, so this is a lower bound";
  if (reason === "tool-fee") return "hosted tool fees aren't included";
  if (reason === "long-context") return "a request over 272K input tokens isn't priced";
  if (reason.startsWith("tier:")) return `service tier ${reason.slice(5)} isn't confirmed as Standard`;
  return `${reason.slice(6)} has no published price`;
}
function assumed(reason: string): string | undefined {
  if (reason === "no-cache-ttl") return "Cache write lifetimes weren't reported: priced at the default 30-minute rate.";
  if (reason.startsWith("tier:")) return `The response gave service tier ${reason.slice(5)} and the request asked for none: priced as Standard.`;
}
const sentence = (reasons: string[]) => (reasons.length ? ` Missing: ${reasons.join("; ")}.` : "");

/** A price estimate is never presented as a provider invoice or a partial subtotal as a total. */
export function costChip(cost: SessionCost | undefined): { text: string; detail: string } {
  const known = typeof cost?.usd === "number" && Number.isFinite(cost.usd) && cost.usd >= 0;
  const reasons = costReasons(cost?.reasons);
  if (!known || !cost?.complete) {
    const why = sentence(reasons.map(missing));
    // A coverage gap with no reason (a TUI's unobserved spend, lost history) can be any size: no figure.
    if (known && cost!.usd! > 0 && reasons.length) return {
      text: `~${dollars(cost!.usd!)}+${reasons.includes("no-cache-ttl") ? " est." : ""}`,
      detail: `Known API subtotal ${dollars(cost!.usd!)}${cost!.estimated ? " estimated" : ""}, not the session's whole cost.${why}`,
    };
    return {
      text: "Cost unknown",
      detail: known ? `Known API subtotal ${dollars(cost!.usd!)}${cost?.estimated ? " estimated" : ""}; some session usage or pricing is unknown.${why}` : `This session's API cost hasn't been reported or priced.${why}`,
    };
  }
  const notes = costReasons(cost.notes).flatMap((r) => assumed(r) ?? []);
  return {
    text: `${dollars(cost.usd!)}${cost.estimated ? " est." : ""}`,
    detail: (cost.estimated ? "Estimated session API cost in USD; provider billing may differ." : "Reported session API cost in USD.") + (notes.length ? ` ${notes.join(" ")}` : ""),
  };
}
