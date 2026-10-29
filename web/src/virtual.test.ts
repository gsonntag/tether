import { expect, test } from "bun:test";
import { anchorAt, indexAt, offsets, restore, visibleRange } from "./virtual";

test("offsets, lookup and the visible range", () => {
  const ids = ["a", "b", "c", "d"];
  const offs = offsets(ids, () => 100);
  expect(offs).toEqual([0, 100, 200, 300, 400]);
  expect(indexAt(offs, 0)).toBe(0);
  expect(indexAt(offs, 150)).toBe(1);
  expect(indexAt(offs, 1000)).toBe(3);
  expect(visibleRange(offs, 150, 100, 0)).toEqual([1, 3]);
  expect(visibleRange(offs, 150, 100, 100)).toEqual([0, 4]);
  expect(visibleRange([0], 0, 100, 0)).toEqual([0, 0]);
});

test("the anchor keeps the reader's place when older items arrive or items above grow", () => {
  let ids = ["c", "d", "e"];
  let h = new Map([["c", 100], ["d", 100], ["e", 100]]);
  const a = anchorAt(ids, offsets(ids, (id) => h.get(id)!), 130)!;
  expect(a).toEqual({ id: "d", into: 30 });
  // Two older messages arrive in front, and "c" turns out taller once measured.
  ids = ["a", "b", ...ids];
  h = new Map([...h, ["a", 50], ["b", 70], ["c", 160]]);
  expect(restore(ids, offsets(ids, (id) => h.get(id)!), a)).toBe(50 + 70 + 160 + 30);
  expect(restore(["x"], [0, 10], a)).toBeUndefined();
});
