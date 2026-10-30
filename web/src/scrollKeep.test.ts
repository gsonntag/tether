import { expect, test } from "bun:test";
import { CAP, FOLLOW_KEEP, following, Gesture, nextWindow, PAGE, remap, restoreTop, rowAt, type WinInput } from "./scrollKeep";

test("a gesture is idle only with no finger down and no scroll for a while", () => {
  const g = new Gesture(150);
  expect(g.idle(0)).toBe(true);
  g.touch(true, 1000);
  expect(g.down).toBe(true);
  expect(g.idle(5000)).toBe(false); // a finger resting on the screen
  g.touch(false, 5000);
  expect(g.down).toBe(false);
  expect(g.idle(5100)).toBe(false); // momentum may follow the lift
  g.scrolled(5200);
  expect(g.idle(5300)).toBe(false);
  expect(g.idle(5350)).toBe(true);
});

const x = (o: Partial<WinInput>): WinInput => ({ n: 50, settled: true, stick: false, nearTop: false, nearEnd: false, anchor: -1, ...o });

test("following the bottom: new messages join, and once settled only the newest pages stay", () => {
  expect(nextWindow({ lo: 0, hi: 50, tail: true }, x({ n: 51, stick: true, settled: false }))).toEqual({ lo: 0, hi: 51, tail: true });
  // a session left open: the slice shrinks back once nothing moves
  expect(nextWindow({ lo: 0, hi: 400, tail: true }, x({ n: 401, stick: true, settled: false }))).toEqual({ lo: 0, hi: 401, tail: true });
  expect(nextWindow({ lo: 0, hi: 400, tail: true }, x({ n: 401, stick: true }))).toEqual({ lo: 401 - FOLLOW_KEEP, hi: 401, tail: true });
});

test("rows above are shown only once the scroll settles, a page at a time", () => {
  // an older page arrived in front (the slice's first message is now at 50)
  expect(nextWindow({ lo: 50, hi: 100, tail: true }, x({ n: 100, nearTop: true, settled: false }))).toEqual({ lo: 50, hi: 100, tail: true });
  expect(nextWindow({ lo: 50, hi: 100, tail: true }, x({ n: 100, nearTop: true }))).toEqual({ lo: 0, hi: 100, tail: true });
  // settled but not near the top: nothing to show yet
  expect(nextWindow({ lo: 50, hi: 100, tail: true }, x({ n: 100 }))).toEqual({ lo: 50, hi: 100, tail: true });
});

test("going up past the cap drops rows from the bottom; newer ones then wait below", () => {
  const w = nextWindow({ lo: 1000 - CAP, hi: 1000, tail: true }, x({ n: 1000, nearTop: true }));
  expect(w).toEqual({ lo: 1000 - CAP - PAGE, hi: 1000 - PAGE, tail: false });
  // a new message arrives: it isn't mounted (it's past the gap)
  expect(nextWindow(w, x({ n: 1001, settled: false }))).toEqual({ ...w, tail: false });
});

test("going down mounts rows below at once, and drops rows above only once settled", () => {
  const w = { lo: 100, hi: 400, tail: false };
  const mid = nextWindow(w, x({ n: 1000, nearEnd: true, settled: false, anchor: 380 }));
  expect(mid).toEqual({ lo: 100, hi: 450, tail: false });
  expect(nextWindow(mid, x({ n: 1000, anchor: 380 }))).toEqual({ lo: 150, hi: 450, tail: false });
  // the reader's row is never dropped
  expect(nextWindow(mid, x({ n: 1000, anchor: 120 }))).toEqual({ lo: 110, hi: 450, tail: false });
  // reaching the newest: the slice is the tail again
  expect(nextWindow({ lo: 700, hi: 980, tail: false }, x({ n: 1000, nearEnd: true, settled: false }))).toEqual({ lo: 700, hi: 1000, tail: true });
});

test("the slice is found again by its ids after a page arrives in front, or starts over", () => {
  const ids = Array.from({ length: 150 }, (_, i) => `m${i}`);
  expect(remap(ids, "m50", "m149", true)).toEqual({ lo: 50, hi: 150, tail: true });
  expect(remap(ids, "m50", "m99", false)).toEqual({ lo: 50, hi: 100, tail: false });
  expect(remap(ids, undefined, undefined, true)).toEqual({ lo: 150 - FOLLOW_KEEP, hi: 150, tail: true });
  expect(remap(ids, "gone", "m99", false)).toEqual({ lo: 150 - FOLLOW_KEEP, hi: 150, tail: true });
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

test("only the reader stops following: a transcript that gets shorter doesn't", () => {
  const at = { stick: true, down: false, resized: false, top: 5000, lastTop: 5000, fromBottom: 0, tail: true };
  // the composer grew by two lines: the box got shorter and the view moved up 44 px, no finger on it
  expect(following({ ...at, resized: true, top: 4956, fromBottom: 44 })).toBe(true);
  // a finger (or the scrollbar) moved it up, even a little, even while something resized
  expect(following({ ...at, down: true, resized: true, top: 4997, fromBottom: 3 })).toBe(false);
  // moved up with nothing resized: keys, find in page, a script
  expect(following({ ...at, top: 4990, fromBottom: 10 })).toBe(false);
  // back down to the very bottom follows again; not with newer messages unmounted below
  const up = { ...at, stick: false, lastTop: 4000, top: 4990, fromBottom: 10 };
  expect(following(up)).toBe(true);
  expect(following({ ...up, tail: false })).toBe(false);
  // moving up never starts following, even near the bottom
  expect(following({ ...up, lastTop: 4995, resized: true })).toBe(false);
});
