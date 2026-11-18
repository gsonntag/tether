// A request's price at published API rates, and what its cache reads saved. Claude: Anthropic's table
// (shared/anthropicRates.ts), by the exact model id, its 5-minute and 1-hour write rates, Haiku 5.5's
// prompt-length bands, fast mode and US-only inference. Codex: OpenAI's Standard table
// (runner/src/costs.ts), writes at the 30-minute default (Codex reports no lifetimes), nothing over
// 272K input. A model or case with no published rate has no price: never a guess.

import { ANTHROPIC_FAST, ANTHROPIC_RATES, ANTHROPIC_US_GEO } from "../../../../shared/anthropicRates";
import type { HarnessId } from "../../../../shared/transcript";
import { STANDARD_OPENAI } from "../../costs";
import { FAST, LONG, ODD_TIER, US_GEO, type Rec } from "./parse";

export interface Price { usd: number; savings: number }

/** `provider`: Codex's model provider for the thread; only OpenAI's own is priced (Azure's rates depend on the deployment). */
export function priceRec(harness: HarnessId, r: Rec, provider?: string): Price | undefined {
  const [, , model, input, output, read, w1, w2, flags] = r;
  if (flags & ODD_TIER) return undefined;
  if (harness === "claude") {
    const rates = ANTHROPIC_RATES[model];
    if (!rates) return undefined;
    let x = 1;
    if (flags & FAST) {
      if (!ANTHROPIC_FAST[model]) return undefined;
      x *= ANTHROPIC_FAST[model]!;
    }
    if (flags & US_GEO) x *= ANTHROPIC_US_GEO;
    const prompt = input + read + w1 + w2;
    if (rates.maxPrompt !== undefined && prompt > rates.maxPrompt) return undefined;
    const b = rates.long && prompt > rates.longAbove! ? rates.long : rates;
    return {
      usd: (x * (input * b.input + output * b.output + read * b.read + w1 * b.write5m + w2 * b.write1h)) / 1e6,
      savings: (x * read * (b.input - b.read)) / 1e6,
    };
  }
  if (flags & LONG) return undefined;
  if (provider !== undefined && provider !== "openai" && provider !== "tether_openai") return undefined;
  const rates = STANDARD_OPENAI[model];
  if (!rates) return undefined;
  return {
    usd: (input * rates.input + output * rates.output + read * rates.cached + w1 * rates.input * 1.25 + w2 * rates.input * 2.5) / 1e6,
    savings: (read * (rates.input - rates.cached)) / 1e6,
  };
}
