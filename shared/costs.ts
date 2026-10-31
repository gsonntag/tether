/** A session's API usage only. Unknown prior usage or prices must not become a $0 total. */
export interface SessionCost {
  usd?: number;
  estimated: boolean;
  complete: boolean;
}

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

/** A price estimate is never presented as a provider invoice or a partial subtotal as a total. */
export function costChip(cost: SessionCost | undefined): { text: string; detail: string } {
  const known = typeof cost?.usd === "number" && Number.isFinite(cost.usd) && cost.usd >= 0;
  if (!known || !cost?.complete) return {
    text: "Cost unknown",
    detail: known ? `Known API subtotal ${dollars(cost!.usd!)}${cost?.estimated ? " estimated" : ""}; some session usage or pricing is unknown` : "This session's API cost hasn't been reported or priced",
  };
  return {
    text: `${dollars(cost.usd!)}${cost.estimated ? " est." : ""}`,
    detail: cost.estimated ? "Estimated session API cost in USD; provider billing may differ" : "Reported session API cost in USD",
  };
}
