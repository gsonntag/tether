// Anthropic's first-party API rates, USD per 1M tokens, from the Model pricing table on
// https://platform.claude.com/docs/en/about-claude/pricing, read 2026-11-18. Only what that page lists,
// by the exact model id Claude Code records. Models before the 4.6 generation are also recorded by
// their dated ids, which their aliases resolve to (models overview); the three published ones are here.
// Sonnet 4.5's window is 200K; its 1M long-context beta bills a premium above 200K that the page
// doesn't list, so a Sonnet 4.5 request with a prompt over 200K has no price here (`maxPrompt`)
// rather than a low one. Server tool fees (web search, $10 per 1,000) and code execution time aren't
// tokens and aren't counted. Cache writes are the
// page's 5-minute and 1-hour rates; reads its "cache hits and refreshes". Fast mode and US-only
// inference are multipliers on these (below); Bedrock, Vertex and other partners price their own.
// These price estimates, never invoices: a plan's usage at these rates is what the API would cost.

export const ANTHROPIC_RATES_DATE = "2026-11-18";
export const ANTHROPIC_RATES_SOURCE = "Anthropic API pricing page (first-party, USD)";

export interface AnthropicBand { input: number; write5m: number; write1h: number; read: number; output: number }
/**
 * `long`: the rates of a request whose prompt (input, cache reads and writes) is over `longAbove`
 * tokens. `maxPrompt`: a longer prompt has rates the page doesn't list: no price.
 */
export interface AnthropicRates extends AnthropicBand { longAbove?: number; long?: AnthropicBand; maxPrompt?: number }

const band = (input: number, write5m: number, write1h: number, read: number, output: number): AnthropicBand => ({ input, write5m, write1h, read, output });

export const ANTHROPIC_RATES: Record<string, AnthropicRates> = {
  "claude-fable-5-2": band(8, 10, 16, 0.2, 40),
  "claude-mythos-5-2": band(8, 10, 16, 0.2, 40),
  "claude-fable-5-1": band(10, 12.5, 20, 0.25, 50),
  "claude-mythos-5-1": band(10, 12.5, 20, 0.25, 50),
  "claude-fable-5": band(10, 12.5, 20, 1, 50),
  "claude-mythos-5": band(10, 12.5, 20, 1, 50),
  "claude-opus-5-5": band(4, 5, 8, 0.2, 20),
  "claude-opus-5": band(5, 6.25, 10, 0.5, 25),
  "claude-opus-4-8": band(5, 6.25, 10, 0.5, 25),
  "claude-opus-4-7": band(5, 6.25, 10, 0.5, 25),
  "claude-opus-4-6": band(5, 6.25, 10, 0.5, 25),
  "claude-opus-4-5": band(5, 6.25, 10, 0.5, 25),
  "claude-opus-4-5-20251101": band(5, 6.25, 10, 0.5, 25),
  "claude-sonnet-5-5": band(2, 2.5, 4, 0.1, 10),
  "claude-sonnet-5": band(2, 2.5, 4, 0.2, 10),
  "claude-sonnet-4-6": band(3, 3.75, 6, 0.3, 15),
  "claude-sonnet-4-5": { ...band(3, 3.75, 6, 0.3, 15), maxPrompt: 200_000 },
  "claude-sonnet-4-5-20250929": { ...band(3, 3.75, 6, 0.3, 15), maxPrompt: 200_000 },
  "claude-haiku-5-5": { ...band(0.1, 0.125, 0.2, 0.01, 0.5), longAbove: 100_000, long: band(0.5, 0.625, 1, 0.05, 2.5) },
  "claude-haiku-4-5": band(1, 1.25, 2, 0.1, 5),
  "claude-haiku-4-5-20251001": band(1, 1.25, 2, 0.1, 5),
};

/** Fast mode's price over standard, where the page lists one (all token kinds; caching multipliers stack). */
export const ANTHROPIC_FAST: Record<string, number> = { "claude-fable-5-2": 2, "claude-mythos-5-2": 2, "claude-opus-5-5": 2, "claude-opus-5": 2, "claude-opus-4-8": 2 };
/** `inference_geo: "us"` on Claude 4.6 and later: every token kind. */
export const ANTHROPIC_US_GEO = 1.1;
