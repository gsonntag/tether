import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CostLedger, estimateTokenCost, priceResponse } from "./costs";

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
  test("a failed request without final usage preserves its known subtotal but invalidates completeness", () => {
    const ledger = new CostLedger();
    ledger.begin("s", true);
    ledger.report("s", "query", { usd: 0.2, estimated: true, complete: true });
    expect(ledger.report("s", "query", { estimated: true, complete: false })).toEqual({ usd: 0.2, estimated: true, complete: false });
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
      expect(estimateTokenCost("openai", "gpt-6-luna", usage, { tier: "standard" })).toMatchObject({ estimated: true, complete: false });
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
    ]) expect(result.usd === undefined && !result.complete && result.reasons?.length).toBe(1);
    expect(estimateTokenCost("azure", "deployment-alias", usage, { rates: { input: 3, output: 7, cached: 0 } })).toEqual({ usd: 0.0037, estimated: true, complete: true });
    expect(estimateTokenCost("azure", "deployment-alias", { ...usage, write30m: 0, write12h: 0 }, { rates: { input: 3, output: 7, cached: 0 } }).complete).toBe(true);
    expect(estimateTokenCost("azure", "deployment-alias", { ...usage, write30m: 1, write12h: 0 }, { rates: { input: 3, output: 7, cached: 0 } })).toEqual({ estimated: true, complete: false, reasons: ["no-cache-ttl"] });
  });
});

// Shaped as the docs show: the reference's usage, the guide's write breakdown, and what Codex really sends.
describe("pricing a finished response", () => {
  const codex = JSON.stringify({ model: "gpt-6-luna", stream: true, input: [{ type: "message", content: "a line with \"ttl\":\"12h\" in it" }] });
  const response = (details: object, more: object = {}) => ({
    id: "resp_1", model: "gpt-6-luna", service_tier: "default", output: [],
    usage: { input_tokens: 100_000, output_tokens: 1_000, input_tokens_details: { cached_tokens: 40_000, ...details } }, ...more,
  });
  const breakdown = { cache_write_tokens: 50_000, cache_write_tokens_details: { ttl_30m_tokens: 20_000, ttl_12h_tokens: 30_000 } };
  // 10k ordinary, 40k cached, 1k output at gpt-6-luna's rates
  const rest = (10_000 * 0.1 + 40_000 * 0.01 + 1_000 * 0.5) / 1e6;
  const at30m = rest + (50_000 * 0.125) / 1e6;

  test("the full documented shape prices both lifetimes", () => {
    const cost = priceResponse("openai", response(breakdown), { request: codex });
    expect(cost.usd).toBeCloseTo(rest + (20_000 * 0.125 + 30_000 * 0.25) / 1e6, 10);
    expect(cost).toMatchObject({ estimated: true, complete: true });
    expect(cost.reasons).toBeUndefined();
  });
  test("the prod session's shape: a write total, no lifetimes, no tier, a request that chose neither", () => {
    const cost = priceResponse("openai", response({ cache_write_tokens: 50_000 }, { service_tier: undefined }), { request: codex });
    expect(cost.usd).toBeCloseTo(at30m, 10);
    expect(cost).toEqual({ usd: cost.usd, estimated: true, complete: true, notes: ["no-cache-ttl", "tier:missing"] });
  });
  test("standard by default: default and standard, or auto and missing on a request that left it", () => {
    for (const service_tier of ["default", "standard"]) expect(priceResponse("openai", response({ cache_write_tokens: 0 }, { service_tier }), { request: codex }).reasons).toBeUndefined();
    for (const service_tier of ["auto", null, undefined, ""]) expect(priceResponse("openai", response({ cache_write_tokens: 0 }, { service_tier }), { request: codex })).toMatchObject({ complete: true, estimated: true });
    for (const asked of ["auto", "default", null]) expect(priceResponse("openai", response({ cache_write_tokens: 0 }, { service_tier: undefined }), { request: JSON.stringify({ service_tier: asked }) }).complete).toBe(true);
  });
  test("any other tier, asked for or served, isn't priced as Standard", () => {
    const zero = { cache_write_tokens: 0 };
    expect(priceResponse("openai", response(zero, { service_tier: "priority" }), { request: codex })).toEqual({ estimated: true, complete: false, reasons: ["tier:priority"] });
    expect(priceResponse("openai", response(zero, { service_tier: "flex" }), { request: codex }).reasons).toEqual(["tier:flex"]);
    expect(priceResponse("openai", response(zero, { service_tier: undefined }), { request: JSON.stringify({ service_tier: "priority" }) }).reasons).toEqual(["tier:priority"]);
    expect(priceResponse("openai", response(zero, { service_tier: "auto" }), { request: JSON.stringify({ service_tier: "flex" }) }).reasons).toEqual(["tier:flex"]);
    expect(priceResponse("openai", response(zero, { service_tier: undefined }), { request: "\u0028 not json" }).reasons).toEqual(["tier:missing"]);
    expect(priceResponse("openai", response(zero, { service_tier: undefined })).reasons).toEqual(["tier:missing"]);
  });
  test("a chosen lifetime with no breakdown is the cheaper rate, a lower bound, never complete", () => {
    for (const ttl of [{ prompt_cache_options: { ttl: "12h" } }, { input: [{ prompt_cache_breakpoint: { ttl: "12h" } }] }]) {
      const cost = priceResponse("openai", response({ cache_write_tokens: 50_000 }), { request: JSON.stringify(ttl) });
      expect(cost.usd).toBeCloseTo(at30m, 10);
      expect(cost).toMatchObject({ estimated: true, complete: false, reasons: ["no-cache-ttl"] });
    }
    expect(priceResponse("openai", response({ cache_write_tokens: 50_000 }), { request: JSON.stringify({ prompt_cache_options: { ttl: "30m" } }) }).complete).toBe(true);
    expect(priceResponse("openai", response({ cache_write_tokens: 50_000 }), { request: codex }).complete).toBe(true); // text isn't a setting
  });
  test("a breakdown that doesn't add up, or no write count, is a lower bound", () => {
    const wrong = priceResponse("openai", response({ cache_write_tokens: 50_000, cache_write_tokens_details: { ttl_30m_tokens: 1, ttl_12h_tokens: 2 } }), { request: codex });
    expect(wrong).toMatchObject({ complete: false, reasons: ["no-cache-ttl"] });
    expect(wrong.usd).toBeCloseTo(at30m, 10);
    const none = priceResponse("openai", response({}), { request: codex });
    expect(none).toMatchObject({ complete: false, reasons: ["no-cache-ttl"] });
    expect(none.usd).toBeCloseTo((60_000 * 0.1 + 40_000 * 0.01 + 1_000 * 0.5) / 1e6, 10);
  });
  test("no usage, and writes that exceed the input", () => {
    expect(priceResponse("openai", { id: "resp_1", usage: null, status: "failed" }, { request: codex })).toEqual({ estimated: true, complete: false, reasons: ["no-usage"] });
    expect(priceResponse("openai", undefined).reasons).toEqual(["no-usage"]);
    expect(priceResponse("openai", response({ cache_write_tokens: 100_000 }), { request: codex }).reasons).toEqual(["no-usage"]);
  });
  test("a dated or unlisted model isn't priced, and only its id is kept", () => {
    expect(priceResponse("openai", response({ cache_write_tokens: 0 }, { model: "gpt-6-luna-2026-10-01" }), { request: codex })).toEqual({ estimated: true, complete: false, reasons: ["model:gpt-6-luna-2026-10-01"] });
    expect(priceResponse("openai", response({ cache_write_tokens: 0 }, { model: "not a model: sk-[redacted]" }), { request: codex }).reasons).toEqual(["model:other"]);
    expect(priceResponse("openai", response({ cache_write_tokens: 0 }, { service_tier: "x".repeat(99) }), { request: codex }).reasons).toEqual(["tier:other"]);
  });
  test("long context stays unpriced, at the boundary and over it", () => {
    const usage = (input_tokens: number) => ({ id: "r", model: "gpt-6-luna", service_tier: "default", usage: { input_tokens, output_tokens: 1, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } } });
    expect(priceResponse("openai", usage(272_000), { request: codex }).complete).toBe(true);
    expect(priceResponse("openai", usage(272_001), { request: codex })).toEqual({ estimated: true, complete: false, reasons: ["long-context"] });
  });
  test("tool fees keep the token subtotal and are never complete", () => {
    const cost = priceResponse("openai", response({ cache_write_tokens: 0 }, { output: [{ type: "web_search_call" }] }), { request: codex });
    expect(cost.usd).toBeGreaterThan(0);
    expect(cost).toMatchObject({ complete: false, reasons: ["tool-fee"] });
  });
  test("Azure is as it was: rates price, and any write or a missing count is unknown", () => {
    const rates = { input: 3, output: 7, cached: 0 };
    const zero = { cache_write_tokens: 0 };
    expect(priceResponse("azure", response(zero, { service_tier: undefined }), { rates }).complete).toBe(true);
    expect(priceResponse("azure", response(zero))).toEqual({ estimated: true, complete: false, reasons: ["model:gpt-6-luna"] });
    expect(priceResponse("azure", response({}), { rates })).toEqual({ estimated: true, complete: false, reasons: ["no-cache-ttl"] });
    expect(priceResponse("azure", response(breakdown), { rates })).toEqual({ estimated: true, complete: false, reasons: ["no-cache-ttl"] });
  });
});

describe("reasons and carrying", () => {
  test("reasons persist with a report, reach the session, and what isn't a code is dropped", () => {
    const path = file(), ledger = new CostLedger(path);
    ledger.begin("s", true);
    ledger.report("s", "a", { usd: 0.02, estimated: true, complete: true });
    ledger.report("s", "b", { estimated: true, complete: false, reasons: ["tier:scale", "sk-secret text", "model:bad value"] });
    expect(new CostLedger(path).get("s")).toEqual({ usd: 0.02, estimated: true, complete: false, reasons: ["tier:scale"] });
    expect(readFileSync(path, "utf8")).not.toContain("secret");
  });
  test("what a priced report assumed never reads as something missing", () => {
    const ledger = new CostLedger();
    ledger.begin("s", true);
    ledger.report("s", "a", { usd: 0.02, estimated: true, complete: true, notes: ["no-cache-ttl", "tier:missing", "not a code"] });
    expect(ledger.get("s")).toEqual({ usd: 0.02, estimated: true, complete: true, notes: ["no-cache-ttl", "tier:missing"] });
    ledger.report("s", "b", { estimated: true, complete: false, reasons: ["tool-fee"] });
    expect(ledger.get("s")).toMatchObject({ complete: false, reasons: ["tool-fee"], notes: ["no-cache-ttl", "tier:missing"] });
  });
  test("a file from before reasons reads unchanged", () => {
    const path = file();
    writeFileSync(path, JSON.stringify({ version: 1, sessions: { s: { complete: true, reports: { r: { estimated: true, complete: false } } } } }));
    expect(new CostLedger(path).get("s")).toEqual({ estimated: true, complete: false });
  });
  test("a takeover carries the total once, there and back, and a plan brings nothing", () => {
    const ledger = new CostLedger();
    ledger.begin("key", true);
    ledger.report("key", "r", { usd: 1, estimated: true, complete: true });
    ledger.begin("next", true);
    ledger.report("next", "r2", { usd: 0.5, estimated: true, complete: true });
    expect(ledger.carry("key", "next")).toEqual({ usd: 1.5, estimated: true, complete: true });
    expect(ledger.carry("key", "next")).toEqual({ usd: 1.5, estimated: true, complete: true }); // a replay
    expect(ledger.carry("next", "plan")).toEqual({ usd: 1.5, estimated: true, complete: true }); // kept out of sight
    ledger.begin("back", true);
    ledger.report("back", "r3", { usd: 0.25, estimated: true, complete: true });
    expect(ledger.carry("plan", "back")).toEqual({ usd: 1.75, estimated: true, complete: true });
    expect(ledger.carry("never-metered", "other")).toBeUndefined();
  });
  test("what was partial stays partial after a takeover, with its reason", () => {
    const ledger = new CostLedger();
    ledger.begin("a", true);
    ledger.report("a", "r", { usd: 1, estimated: true, complete: true });
    ledger.report("a", "q", { estimated: true, complete: false, reasons: ["long-context"] });
    ledger.begin("b", true);
    expect(ledger.carry("a", "b")).toEqual({ usd: 1, estimated: true, complete: false, reasons: ["long-context"] });
  });
});
