import { expect, test } from "bun:test";
import { costChip, costReasons, dollars, reasonValue, validRates } from "./costs";

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

test("a known subtotal with a named gap reads as a floor, never a total", () => {
  const one = costChip({ usd: 0.02, estimated: true, complete: false, reasons: ["model:gpt-x"] });
  expect(one.text).toBe("~$0.02+");
  expect(one.detail).toContain("not the session's whole cost");
  expect(one.detail).toContain("gpt-x has no published price");
  expect(costChip({ usd: 0.02, estimated: true, complete: false, reasons: ["tool-fee"] }).detail).toContain("tool fees");
  expect(costChip({ usd: 0.02, estimated: true, complete: false, reasons: ["tier:priority"] }).detail).toContain("tier priority");
  expect(costChip({ usd: 0.02, estimated: true, complete: false, reasons: ["long-context"] }).detail).toContain("272K");
});

test("a lower bound keeps est. and says so", () => {
  const chip = costChip({ usd: 0.02, estimated: true, complete: false, reasons: ["no-cache-ttl"] });
  expect(chip.text).toBe("~$0.02+ est.");
  expect(chip.detail).toContain("lower bound");
});

test("no subtotal, a zero one, or a gap with no reason stays Cost unknown, with what's known", () => {
  expect(costChip({ estimated: true, complete: false, reasons: ["tier:scale"] })).toEqual({ text: "Cost unknown", detail: "This session's API cost hasn't been reported or priced. Missing: service tier scale isn't confirmed as Standard." });
  expect(costChip({ usd: 0, estimated: true, complete: false, reasons: ["no-usage"] }).text).toBe("Cost unknown");
  expect(costChip({ usd: 2, estimated: true, complete: false }).text).toBe("Cost unknown");
});

test("a complete estimate says what it assumed", () => {
  const chip = costChip({ usd: 0.02, estimated: true, complete: true, notes: ["no-cache-ttl", "tier:missing"] });
  expect(chip.text).toBe("$0.02 est.");
  expect(chip.detail).toContain("default 30-minute rate");
  expect(chip.detail).toContain("priced as Standard");
});

test("an assumption on a priced report isn't reported as missing beside a real gap", () => {
  const chip = costChip({ usd: 0.02, estimated: true, complete: false, reasons: ["tool-fee"], notes: ["no-cache-ttl", "tier:missing"] });
  expect(chip.text).toBe("~$0.02+");
  expect(chip.detail).not.toContain("lower bound");
  expect(chip.detail).not.toContain("tier");
  expect(costChip({ usd: 0.02, estimated: true, complete: false, notes: ["tier:missing"] }).text).toBe("Cost unknown");
});

test("only fixed codes and plain ids count as reasons", () => {
  expect(costReasons(["no-usage", "no-usage", "tier:auto", "model:a b", "Bearer x", 3])).toEqual(["no-usage", "tier:auto"]);
  expect(costReasons("no-usage")).toEqual([]);
  expect(reasonValue("gpt-6-luna")).toBe("gpt-6-luna");
  expect(reasonValue("sk [redacted]")).toBe("other");
});
