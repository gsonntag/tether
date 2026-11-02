import { expect, test } from "bun:test";
import { AZURE_RATES, azureModelId, azureTableRates } from "./azureRates";

test("model ids: lowercased and exact, a dated version suffix removed, nothing else mapped", () => {
  expect(azureModelId("GPT-6.1-Sol")).toBe("gpt-6.1-sol");
  expect(azureModelId(" gpt-5.4-2026-03-05 ")).toBe("gpt-5.4");
  expect(azureModelId("gpt-6-luna-2026-03")).toBeUndefined();
  expect(azureModelId("gpt-6-luna-mini")).toBeUndefined();
  expect(azureModelId("deepseek-v4")).toBeUndefined();
  expect(azureModelId("unlisted-2026-03-05")).toBeUndefined();
  expect(azureModelId("")).toBeUndefined();
  expect(azureModelId("constructor")).toBeUndefined();
});

test("types: Global and Data Zone from the table; Regional has none; gaps stay gaps", () => {
  expect(azureTableRates("gpt-6-luna")?.short).toEqual({ input: 0.10, cached: 0.01, cacheWrite: 0.125, output: 0.50 });
  expect(azureTableRates("gpt-6-luna", "dataZone")?.long).toEqual({ input: 0.22, cached: 0.022, cacheWrite: 0.275, output: 0.825 });
  expect(azureTableRates("gpt-6-luna", "regional")).toBeUndefined();
  expect(azureTableRates("gpt-5.5")?.short.cacheWrite).toBeUndefined();
  expect(azureTableRates("gpt-5.4", "dataZone")?.long).toBeUndefined();
  expect(Object.keys(AZURE_RATES)).toEqual(["gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4"]);
});
