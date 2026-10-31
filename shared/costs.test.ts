import { expect, test } from "bun:test";
import { costChip, dollars, validRates } from "./costs";

test("API dollars distinguish estimates, tiny amounts, unknown and partial totals", () => {
  expect(costChip({ usd: 1.23, estimated: true, complete: true }).text).toBe("$1.23 est.");
  expect(costChip({ usd: 0.0003, estimated: true, complete: true }).text).toBe("$0.0003 est.");
  expect(dollars(0.000001)).toBe("<$0.0001");
  expect(costChip({ usd: 0, estimated: false, complete: true }).text).toBe("$0.00");
  expect(costChip(undefined).text).toBe("Cost unknown");
  expect(costChip({ estimated: true, complete: true }).text).toBe("Cost unknown");
  expect(costChip({ usd: 0, estimated: true, complete: false }).text).toBe("Cost unknown");
  expect(costChip({ usd: 2, estimated: true, complete: false }).detail).toContain("Known API subtotal $2.00 estimated");
  expect(costChip({ usd: NaN, estimated: false, complete: true }).text).toBe("Cost unknown");
});

test("rates require all three explicit finite nonnegative numbers, including free cached tokens", () => {
  expect(validRates({ input: 1, output: 2, cached: 0 })).toBe(true);
  for (const value of [undefined, {}, { input: 1, output: 2 }, { input: "1", output: 2, cached: 0 }, { input: -1, output: 2, cached: 0 }, { input: Infinity, output: 2, cached: 0 }]) expect(validRates(value)).toBe(false);
});

test("cost formatting does not turn an unsafe or negative total into a reported amount", () => {
  expect(costChip({ usd: -1, estimated: false, complete: true }).text).toBe("Cost unknown");
  expect(costChip({ usd: Infinity, estimated: false, complete: true }).text).toBe("Cost unknown");
});
