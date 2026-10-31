import { expect, test } from "bun:test";
import { ClaudeCostCounter } from "./cost";

test("native streaming cost replaces a query's prior total rather than summing turns", () => {
  const c = new ClaudeCostCounter(0);
  const a = c.report(0.12), b = c.report(0.35);
  expect(a.id).toBe(b.id);
  expect(b).toMatchObject({ usd: 0.35, estimated: true, complete: true });
});
test("resumed history is subtracted even when it was subscription-equivalent spend", () => {
  const c = new ClaudeCostCounter(8);
  expect(c.report(8.5)).toMatchObject({ usd: 0.5, estimated: true, complete: true });
  expect(new ClaudeCostCounter(undefined).report(8.5)).toMatchObject({ estimated: true, complete: false });
  expect(new ClaudeCostCounter(undefined).report(8.5).usd).toBeUndefined();
});
test("a native reset begins another cumulative epoch; a decrease without a reset stays unknown", () => {
  const c = new ClaudeCostCounter(4);
  const before = c.report(4.25);
  c.reset();
  const after = c.report(0.1);
  expect(after.id).not.toBe(before.id);
  expect(after.usd).toBe(0.1);
  expect(c.report(0.05).usd).toBeUndefined();
  expect(c.report(0.2).complete).toBe(false);
});
test("zeroed crash and invalid reports never invent a zero amount", () => {
  for (const bad of [undefined, NaN, Infinity, -1]) expect(new ClaudeCostCounter(0).report(bad)).toMatchObject({ complete: false });
  expect(new ClaudeCostCounter(0).report(0, true).usd).toBeUndefined();
  expect(new ClaudeCostCounter(0).report(0).usd).toBe(0);
});
