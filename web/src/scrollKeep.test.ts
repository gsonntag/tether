import { expect, test } from "bun:test";
import { firstShown, Gesture, restoreTop, rowAt } from "./scrollKeep";

test("a gesture is idle only with no finger down and no scroll for a while", () => {
  const g = new Gesture(150);
  expect(g.idle(0)).toBe(true);
  g.touch(true, 1000);
  expect(g.idle(5000)).toBe(false); // a finger resting on the screen
  g.touch(false, 5000);
  expect(g.idle(5100)).toBe(false); // momentum may follow the lift
  g.scrolled(5200);
  expect(g.idle(5300)).toBe(false);
  expect(g.idle(5350)).toBe(true);
});

test("older messages that arrive mid-scroll wait until it settles", () => {
  const ids = ["o1", "o2", "a", "b"];
  expect(firstShown(ids, "a", false)).toBe(2);
  expect(firstShown(ids, "a", true)).toBe(0);
  expect(firstShown(ids, undefined, false)).toBe(0); // first render
  expect(firstShown(ids, "gone", false)).toBe(0); // a reset replaced them
  expect(firstShown(ids, "o1", false)).toBe(0);
});

test("the row at the top of the viewport", () => {
  const bottoms = [100, 250, 400];
  const at = (y: number) => rowAt(3, (i) => bottoms[i]!, y);
  expect(at(0)).toBe(0);
  expect(at(99)).toBe(0);
  expect(at(100)).toBe(1); // row 0 ends exactly at the top: row 1 is the first one seen
  expect(at(399)).toBe(2);
  expect(at(5000)).toBe(2);
  expect(rowAt(0, () => 0, 0)).toBe(-1);
});

test("the anchor row goes back where the reader had it", () => {
  // The reader saw row "c" 30 px above the viewport's top (scrollTop 330, row at 300).
  const a = { id: "c", top: -30 };
  // A page of older messages, 900 px, arrived above: the row is now at 1200.
  expect(restoreTop(a, 1200, 330)).toBe(1230);
  expect(restoreTop(a, 300, 330)).toBeUndefined();
  expect(restoreTop(a, 300.4, 330)).toBeUndefined();
});
