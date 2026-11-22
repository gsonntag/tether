// Azure OpenAI Standard rates, USD per 1M tokens. The default source is the West US pricing page
// supplied by the owner. Models with a different source identify it in their table. The 272K
// cutoff comes from the GPT-5.4 listing and is also used for the other models' estimates.

/** One band's rates. */
export interface AzureBand { input: number; cached: number; cacheWrite?: number; cacheWrite12h?: number; output: number }
/** A deployment type's rates: short context (≤ 272K input tokens) and, where listed, long. */
export interface AzureTypeRates { short: AzureBand; long?: AzureBand; source?: string }
/** What Azure calls Global Standard and Data Zone Standard. Regional has no rates here. */
export type AzureTableType = "global" | "dataZone" | "dataZoneEU" | "dataZoneAPAC";
export type AzureType = AzureTableType | "regional";
export const AZURE_TYPES = ["global", "dataZone", "dataZoneEU", "dataZoneAPAC", "regional"] as const;
export const isAzureType = (v: unknown): v is AzureType => AZURE_TYPES.some((type) => type === v);

export const AZURE_RATES_DATE = "2026-11-01";
export const AZURE_RATES_SOURCE = "Azure OpenAI pricing page, West US, USD, Standard";
export const AZURE_SOL_RATES_DATE = "2026-11-21";
export const AZURE_SOL_RATES_SOURCE = `Owner-supplied GPT-6.2 Sol rates (${AZURE_SOL_RATES_DATE}), pending Microsoft confirmation`;
/** Input tokens above this are long context. */
export const AZURE_LONG_CONTEXT = 272_000;

const solInternational: AzureTypeRates = {
  short: { input: 2.40, cached: 0.12, cacheWrite: 3, cacheWrite12h: 6, output: 12 },
  long: { input: 4.80, cached: 0.24, cacheWrite: 6, cacheWrite12h: 12, output: 18 },
  source: AZURE_SOL_RATES_SOURCE,
};

export const AZURE_RATES: Record<string, Partial<Record<AzureTableType, AzureTypeRates>>> = {
  "gpt-6.2-sol": {
    global: {
      short: { input: 2, cached: 0.10, cacheWrite: 2.50, cacheWrite12h: 5, output: 10 },
      long: { input: 4, cached: 0.20, cacheWrite: 5, cacheWrite12h: 10, output: 15 },
      source: AZURE_SOL_RATES_SOURCE,
    },
    dataZone: {
      short: { input: 2.20, cached: 0.11, cacheWrite: 2.75, cacheWrite12h: 5.50, output: 11 },
      long: { input: 4.40, cached: 0.22, cacheWrite: 5.50, cacheWrite12h: 11, output: 16.50 },
      source: AZURE_SOL_RATES_SOURCE,
    },
    dataZoneEU: solInternational,
    dataZoneAPAC: solInternational,
  },
  "gpt-6.1-sol": {
    global: { short: { input: 2, cached: 0.10, cacheWrite: 2.50, output: 10 }, long: { input: 4, cached: 0.20, cacheWrite: 5, output: 15 } },
    dataZone: { short: { input: 2.20, cached: 0.11, cacheWrite: 2.75, output: 11 }, long: { input: 4.40, cached: 0.22, cacheWrite: 5.50, output: 16.50 } },
  },
  "gpt-6.1-terra": {
    global: { short: { input: 1, cached: 0.05, cacheWrite: 1.25, output: 5 }, long: { input: 2, cached: 0.10, cacheWrite: 2.50, output: 7.50 } },
    dataZone: { short: { input: 1.10, cached: 0.06, cacheWrite: 1.38, output: 5.50 }, long: { input: 2.20, cached: 0.11, cacheWrite: 2.75, output: 8.25 } },
  },
  "gpt-6-astra": {
    global: { short: { input: 10, cached: 1, cacheWrite: 12.50, output: 50 }, long: { input: 20, cached: 2, cacheWrite: 25, output: 75 } },
    dataZone: { short: { input: 11, cached: 1.10, cacheWrite: 13.75, output: 55 }, long: { input: 22, cached: 2.20, cacheWrite: 27.50, output: 82.50 } },
  },
  "gpt-6-sol": {
    global: { short: { input: 2, cached: 0.20, cacheWrite: 2.50, output: 10 }, long: { input: 4, cached: 0.40, cacheWrite: 5, output: 15 } },
    dataZone: { short: { input: 2.20, cached: 0.22, cacheWrite: 2.75, output: 11 }, long: { input: 4.40, cached: 0.44, cacheWrite: 5.50, output: 16.50 } },
  },
  "gpt-6-luna": {
    global: { short: { input: 0.10, cached: 0.01, cacheWrite: 0.125, output: 0.50 }, long: { input: 0.20, cached: 0.02, cacheWrite: 0.25, output: 0.75 } },
    dataZone: { short: { input: 0.11, cached: 0.011, cacheWrite: 0.138, output: 0.55 }, long: { input: 0.22, cached: 0.022, cacheWrite: 0.275, output: 0.825 } },
  },
  "gpt-5.6-sol": {
    global: { short: { input: 4, cached: 0.40, cacheWrite: 5, output: 20 }, long: { input: 8, cached: 0.80, cacheWrite: 10, output: 30 } },
    dataZone: { short: { input: 4.40, cached: 0.44, cacheWrite: 5.50, output: 22 }, long: { input: 8.80, cached: 0.88, cacheWrite: 11, output: 33 } },
  },
  "gpt-5.6-terra": {
    global: { short: { input: 2, cached: 0.20, cacheWrite: 2.50, output: 12 }, long: { input: 4, cached: 0.40, cacheWrite: 5, output: 18 } },
    dataZone: { short: { input: 2.20, cached: 0.22, cacheWrite: 2.75, output: 13.20 }, long: { input: 4.40, cached: 0.44, cacheWrite: 5.50, output: 19.80 } },
  },
  "gpt-5.6-luna": {
    global: { short: { input: 0.20, cached: 0.02, cacheWrite: 0.25, output: 1.20 }, long: { input: 0.40, cached: 0.04, cacheWrite: 0.50, output: 1.80 } },
    dataZone: { short: { input: 0.22, cached: 0.03, cacheWrite: 0.28, output: 1.32 }, long: { input: 0.44, cached: 0.05, cacheWrite: 0.55, output: 1.98 } },
  },
  "gpt-5.5": {
    global: { short: { input: 5, cached: 0.50, output: 30 }, long: { input: 10, cached: 1, output: 45 } },
    dataZone: { short: { input: 5.50, cached: 0.55, output: 33 }, long: { input: 11, cached: 1.10, output: 49.50 } },
  },
  "gpt-5.4": {
    global: { short: { input: 2.50, cached: 0.25, output: 15 }, long: { input: 5, cached: 0.50, output: 22.50 } },
    dataZone: { short: { input: 2.75, cached: 0.28, output: 16.50 } },
  },
};

/**
 * The table's id for a deployment's model: lowercased, exact. Azure names a model's version by date
 * (`2026-03-05`); a model field holding one as a suffix (`gpt-5.4-2026-03-05`) has it removed. Nothing
 * else is mapped: an unlisted id is unpriced.
 */
export function azureModelId(model: string | undefined): string | undefined {
  const id = model?.trim().toLowerCase();
  if (!id) return undefined;
  if (Object.hasOwn(AZURE_RATES, id)) return id;
  const undated = id.replace(/-\d{4}-\d{2}-\d{2}$/, "");
  return undated !== id && Object.hasOwn(AZURE_RATES, undated) ? undated : undefined;
}

/** The table's rates for a model on a deployment type, if it has them. */
export function azureTableRates(model: string | undefined, type: AzureType = "global"): AzureTypeRates | undefined {
  const id = azureModelId(model);
  return id && type !== "regional" ? AZURE_RATES[id]![type] : undefined;
}

/** How one deployment is priced: its model and type find the table's rates, unless the owner's own `rates` are set. */
export interface AzurePricing { model?: string; type: AzureType; rates?: import("./costs").TokenRates }
