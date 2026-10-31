import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CostLedger, estimateTokenCost } from "./costs";

const file = () => { const root = "/tmp/claude-1001/keys/unit"; mkdirSync(root, { recursive: true }); return join(mkdtempSync(join(root, "cost-")), "costs.json"); };
describe("session API dollars", () => {
  test("cumulative process reports replace replayed totals and add across processes and restart", () => {
    const path = file(), ledger = new CostLedger(path);
    expect(ledger.get("s")).toEqual({ estimated: true, complete: false });
    expect(ledger.begin("s", true)).toEqual({ usd: 0, estimated: false, complete: true });
    ledger.report("s", "first-process", { usd: 0.1, estimated: true, complete: true });
    ledger.report("s", "first-process", { usd: 0.3, estimated: true, complete: true });
    ledger.report("s", "first-process", { usd: 0.3, estimated: true, complete: true });
    expect(ledger.report("s", "second-process", { usd: 0.2, estimated: true, complete: true })).toEqual({ usd: 0.5, estimated: true, complete: true });
    expect(new CostLedger(path).get("s")).toEqual({ usd: 0.5, estimated: true, complete: true });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).not.toContain("transcript");
  });
  test("unknown history/rates remain unknown, never a complete partial subtotal", () => {
    const ledger = new CostLedger();
    expect(ledger.report("older", "new", { usd: 2, estimated: true, complete: true })).toEqual({ usd: 2, estimated: true, complete: false });
    ledger.begin("new", true);
    ledger.report("new", "priced", { usd: 1, estimated: true, complete: true });
    expect(ledger.report("new", "unpriced", { estimated: true, complete: false })).toEqual({ usd: 1, estimated: true, complete: false });
    expect(ledger.report("new", "unpriced", { usd: 0.5, estimated: true, complete: true })).toEqual({ usd: 1.5, estimated: true, complete: true });
    ledger.markUnknown("new");
    expect(ledger.get("new").complete).toBe(false);
    ledger.begin("new", true);
    expect(ledger.get("new").complete).toBe(false);
  });
  test("special report ids are safe and lower cumulative totals cannot reduce prior totals", () => {
    const ledger = new CostLedger();
    ledger.begin("__proto__", true);
    ledger.report("__proto__", "__proto__", { usd: 0.4, estimated: true, complete: true });
    expect(ledger.report("__proto__", "__proto__", { usd: 0.2, estimated: true, complete: true }).usd).toBe(0.4);
    expect(ledger.get("__proto__").usd).toBe(0.4);
  });
  test("failed persistence does not expose an unsaved report in the in-memory ledger", () => {
    const path = file();
    mkdirSync(path, { recursive: true });
    const ledger = new CostLedger(path);
    expect(() => ledger.report("s", "r", { usd: 1, estimated: true, complete: true })).toThrow("Couldn't save");
    expect(ledger.get("s")).toEqual({ estimated: true, complete: false });
  });
  test("a corrupt saved ledger cannot turn lost costs into a new zero total", () => {
    const path = file(); writeFileSync(path, '{broken', { mode: 0o600 });
    const ledger = new CostLedger(path);
    expect(ledger.begin("s", true).complete).toBe(false);
    expect(ledger.report("s", "now", { usd: 0.3, estimated: true, complete: true }).complete).toBe(false);
    expect(() => ledger.report("s", "bad", { usd: NaN, estimated: true, complete: true })).toThrow("Invalid");
    expect(() => ledger.report("s", "missing", { estimated: true, complete: true })).toThrow("Invalid");
  });
  test("OpenAI standard estimates subtract cached input instead of double billing it", () => {
    const value = estimateTokenCost("openai", "gpt-6-luna", { input: 100_000, cached: 50_000, output: 10_000, write30m: 0, write12h: 0 }, { tier: "default" });
    expect(value.complete).toBe(true);
    expect(value.estimated).toBe(true);
    expect(value.usd).toBeCloseTo(0.0105, 10);
    expect(estimateTokenCost("openai", "gpt-6.1-sol", { input: 100_000, cached: 0, output: 1_000, write30m: 0, write12h: 0 }, { tier: "standard" }).usd).toBeCloseTo(0.21, 10);
  });
  test("OpenAI cache write tiers use their published multipliers and require a full breakdown", () => {
    const base = { input: 100_000, output: 0, cached: 10_000 };
    const priced = estimateTokenCost("openai", "gpt-6-luna", { ...base, write30m: 20_000, write12h: 30_000 }, { tier: "standard" });
    expect(priced.usd).toBeCloseTo((40_000 * 0.1 + 10_000 * 0.01 + 20_000 * 0.125 + 30_000 * 0.25) / 1_000_000, 12);
    for (const usage of [base, { ...base, write30m: 20_000 }, { ...base, write30m: 90_001, write12h: 0 }, { ...base, write30m: -1, write12h: 0 }]) {
      expect(estimateTokenCost("openai", "gpt-6-luna", usage, { tier: "standard" })).toEqual({ estimated: true, complete: false });
    }
  });
  test("unknown models, tiers, long context, invalid usage and missing Azure rates are not guessed", () => {
    const usage = { input: 1000, output: 100, cached: 0 };
    for (const result of [
      estimateTokenCost("azure", "gpt-6-luna", usage, { tier: "default" }),
      estimateTokenCost("openai", "unknown", { ...usage, write30m: 0, write12h: 0 }, { tier: "default" }),
      estimateTokenCost("openai", "gpt-6-luna", { ...usage, write30m: 0, write12h: 0 }),
      estimateTokenCost("openai", "gpt-6-luna", { ...usage, write30m: 0, write12h: 0 }, { tier: "priority" }),
      estimateTokenCost("openai", "gpt-6-luna", { ...usage, write30m: 0, write12h: 0, input: 272_001 }, { tier: "default" }),
      estimateTokenCost("openai", "gpt-6-luna", { ...usage, write30m: 0, write12h: 0, cached: 1001 }, { tier: "default" }),
      estimateTokenCost("openai", "gpt-6-luna", { ...usage, write30m: 0, write12h: 0, input: -1 }, { tier: "default" }),
    ]) expect(result).toEqual({ estimated: true, complete: false });
    expect(estimateTokenCost("azure", "deployment-alias", usage, { rates: { input: 3, output: 7, cached: 0 } })).toEqual({ usd: 0.0037, estimated: true, complete: true });
    expect(estimateTokenCost("azure", "deployment-alias", { ...usage, write30m: 0, write12h: 0 }, { rates: { input: 3, output: 7, cached: 0 } }).complete).toBe(true);
    expect(estimateTokenCost("azure", "deployment-alias", { ...usage, write30m: 1, write12h: 0 }, { rates: { input: 3, output: 7, cached: 0 } })).toEqual({ estimated: true, complete: false });
  });
});
