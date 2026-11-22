import type { BedrockModel } from "./credentials";
import type { TokenRates } from "./costs";

export const BEDROCK_RATES_DATE = "2026-11-22";
export const BEDROCK_RATES_SOURCE = "AWS US East (N. Virginia) on-demand price lists";

export interface BedrockRates extends Omit<TokenRates, "cached"> {
  cached?: number;
  cacheWriteLong?: number;
}

export function bedrockTableRates(region: string, model: Pick<BedrockModel, "id" | "harness">): BedrockRates | undefined {
  if (region !== "us-east-1") return undefined;
  if (model.harness === "codex") {
    if (model.id === "openai.gpt-oss-120b") return { input: 0.15, output: 0.60 };
    if (model.id === "openai.gpt-oss-20b") return { input: 0.07, output: 0.30 };
  }
  if (model.harness === "claude") {
    if (model.id === "global.anthropic.claude-sonnet-4-6") return { input: 3, output: 15, cached: 0.30, cacheWrite: 3.75, cacheWriteLong: 6 };
    if (model.id === "us.anthropic.claude-sonnet-4-6") return { input: 3.30, output: 16.50, cached: 0.33, cacheWrite: 4.125, cacheWriteLong: 6.60 };
  }
  return undefined;
}
