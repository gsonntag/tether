import { expect, test } from "bun:test";
import { RowStore } from "./rowStore";

test("a row's state outlives the row", () => {
  const s = new RowStore();
  expect(s.get<boolean | undefined>("tool:a", undefined)).toBeUndefined();
  s.set("tool:a", true);
  // the row was unmounted and mounted again: it reads what it left
  expect(s.get<boolean | undefined>("tool:a", undefined)).toBe(true);
  s.set("tool:a", false);
  expect(s.get<boolean | undefined>("tool:a", undefined)).toBe(false);
  expect(s.get("tool:b", "x")).toBe("x");
});
