import { expect, test } from "bun:test";
import { blankRow, deploymentsOf, resourceOf, rowsOf, unchanged } from "./azureForm";

const slot = { set: true, endpoint: "https://my-res.openai.azure.com/openai/v1", deployments: [{ name: "d-one", model: "gpt-6-luna", rates: { input: 1.25, output: 10, cached: 0.125 } }, { name: "d-two" }] };

test("rows round-trip to the deployments they came from", () => {
  const rows = rowsOf(slot);
  expect(rows.map((r) => [r.name, r.model, r.input, r.cached, r.output])).toEqual([["d-one", "gpt-6-luna", "1.25", "0.125", "10"], ["d-two", "", "", "", ""]]);
  expect(deploymentsOf(rows)).toEqual({ deployments: slot.deployments });
  expect(unchanged(slot, "my-res", rows)).toBe(true);
  expect(unchanged(slot, "other", rows)).toBe(false);
  expect(unchanged(slot, "my-res", [...rows, blankRow()])).toBe(true);
  expect(unchanged(slot, "my-res", rows.slice(1))).toBe(false);
});

test("the resource shows as its name when Tether made the endpoint, else the URL", () => {
  expect(resourceOf(slot)).toBe("my-res");
  expect(resourceOf({ set: false, endpoint: "https://x.services.ai.azure.com/openai/v1" })).toBe("https://x.services.ai.azure.com/openai/v1");
  expect(resourceOf(undefined)).toBe("");
});

test("what's wrong, in a few words", () => {
  const row = (o: object) => ({ ...blankRow(), ...o });
  expect(deploymentsOf([row({ model: "gpt-6-luna" })])).toEqual({ error: "Each deployment needs a name." });
  expect(deploymentsOf([row({ name: "a" }), row({ name: " a " })])).toEqual({ error: "a is listed twice." });
  expect(deploymentsOf([row({ name: "a", input: "1" })])).toEqual({ error: "a: enter all three rates, or none." });
  expect(deploymentsOf([row({ name: "a", input: "-1", cached: "0", output: "0" })])).toEqual({ error: "a: rates are USD per 1M tokens." });
  expect(deploymentsOf([row({ name: " a ", model: " m ", input: "0", cached: "0", output: "0" })])).toEqual({ deployments: [{ name: "a", model: "m", rates: { input: 0, cached: 0, output: 0 } }] });
});
