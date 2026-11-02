import { expect, test } from "bun:test";
import { blankRow, deploymentsOf, manual, resourceOf, rowsOf, tableOf, unchanged } from "./azureForm";

const slot = { set: true, endpoint: "https://my-res.openai.azure.com/openai/v1", deployments: [{ name: "d-one", model: "gpt-6-luna", type: "global" as const, rates: { input: 1.25, output: 10, cached: 0.125, cacheWrite: 1.5 } }, { name: "d-two", type: "dataZone" as const }] };
const row = (o: object) => ({ ...blankRow(), ...o });

test("rows round-trip to the deployments they came from", () => {
  const rows = rowsOf(slot);
  expect(rows.map((r) => [r.name, r.model, r.type, r.override, r.input, r.cached, r.cacheWrite, r.output])).toEqual([["d-one", "gpt-6-luna", "global", true, "1.25", "0.125", "1.5", "10"], ["d-two", "", "dataZone", false, "", "", "", ""]]);
  expect(deploymentsOf(rows)).toEqual({ deployments: slot.deployments });
  expect(unchanged(slot, "my-res", rows)).toBe(true);
  expect(unchanged(slot, "other", rows)).toBe(false);
  expect(unchanged(slot, "my-res", [...rows, blankRow()])).toBe(true);
  expect(unchanged(slot, "my-res", rows.slice(1))).toBe(false);
  expect(unchanged(slot, "my-res", [{ ...rows[0]!, type: "dataZone" }, rows[1]!])).toBe(false);
});

test("migration: saved rates are an Override row with their numbers; a row without is Global on the table", () => {
  const old = { set: true, deployments: [{ name: "manual", model: "gpt-6-luna", rates: { input: 2000, output: 2000, cached: 0 } }, { name: "table", model: "gpt-6-luna" }] };
  const rows = rowsOf(old);
  expect(rows.map((r) => [r.type, r.override, manual(r)])).toEqual([["global", true, true], ["global", false, false]]);
  expect(deploymentsOf(rows)).toEqual({ deployments: [{ name: "manual", model: "gpt-6-luna", type: "global", rates: { input: 2000, output: 2000, cached: 0 } }, { name: "table", model: "gpt-6-luna", type: "global" }] });
  // Only the type is new: nothing to save until something's changed.
  expect(unchanged(old, "", rows)).toBe(true);
});

test("the table: a matching model and type uses it; Override and unmatched rows use the fields", () => {
  expect(tableOf(row({ model: "GPT-6-Luna" }))?.short.cacheWrite).toBe(0.125);
  expect(tableOf(row({ model: "gpt-5.4", type: "dataZone" }))?.long).toBeUndefined();
  expect(tableOf(row({ model: "gpt-6-luna", type: "regional" }))).toBeUndefined();
  expect(tableOf(row({ model: "DeepSeek-V4" }))).toBeUndefined();
  // On the table, typed numbers aren't saved; with Override they are, and must be entered.
  expect(deploymentsOf([row({ name: "a", model: "gpt-6-luna", input: "9", cached: "9", output: "9" })])).toEqual({ deployments: [{ name: "a", model: "gpt-6-luna", type: "global" }] });
  expect(deploymentsOf([row({ name: "a", model: "gpt-6-luna", override: true })])).toEqual({ error: "a: enter the override rates." });
  expect(deploymentsOf([row({ name: "a", model: "gpt-6-luna", override: true, input: "1", cached: "0.1", output: "2" })])).toEqual({ deployments: [{ name: "a", model: "gpt-6-luna", type: "global", rates: { input: 1, cached: 0.1, output: 2 } }] });
  // Not on the table: rates stay optional.
  expect(deploymentsOf([row({ name: "d", model: "DeepSeek-V4", type: "regional" })])).toEqual({ deployments: [{ name: "d", model: "DeepSeek-V4", type: "regional" }] });
});

test("the resource shows as its name when Tether made the endpoint, else the URL", () => {
  expect(resourceOf(slot)).toBe("my-res");
  expect(resourceOf({ set: false, endpoint: "https://x.services.ai.azure.com/openai/v1" })).toBe("https://x.services.ai.azure.com/openai/v1");
  expect(resourceOf(undefined)).toBe("");
});

test("what's wrong, in a few words", () => {
  expect(deploymentsOf([row({ model: "gpt-6-luna" })])).toEqual({ error: "Each deployment needs a name." });
  expect(deploymentsOf([row({ name: "a" }), row({ name: " a " })])).toEqual({ error: "a is listed twice." });
  expect(deploymentsOf([row({ name: "a", input: "1" })])).toEqual({ error: "a: enter input, cached and output, or none." });
  expect(deploymentsOf([row({ name: "a", cacheWrite: "1" })])).toEqual({ error: "a: enter input, cached and output, or none." });
  expect(deploymentsOf([row({ name: "a", input: "-1", cached: "0", output: "0" })])).toEqual({ error: "a: rates are USD per 1M tokens." });
  expect(deploymentsOf([row({ name: "a", input: "1", cached: "0", output: "0", cacheWrite: "-2" })])).toEqual({ error: "a: rates are USD per 1M tokens." });
  expect(deploymentsOf([row({ name: " a ", model: " m ", input: "0", cached: "0", output: "0" })])).toEqual({ deployments: [{ name: "a", model: "m", type: "global", rates: { input: 0, cached: 0, output: 0 } }] });
});
