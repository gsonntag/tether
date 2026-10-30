import { expect, test } from "bun:test";
import { CAP, FOLLOW_KEEP, following, Gesture, nextWindow, OVERSHOOT, PAGE, remap, restoreTop, rowAt, scrollInFlight, type WinInput } from "./scrollKeep";

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
  // the reader's row is never dropped: near the slice's top, the rest comes off the bottom
  expect(nextWindow(mid, x({ n: 1000, anchor: 120 }))).toEqual({ lo: 110, hi: 410, tail: false });
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

test("only the reader's input stops following: a scroll alone never does", () => {
  const at = { stick: true, bar: false, top: 5000, lastTop: 5000, fromBottom: 0, tail: true };
  // the composer grew, or a streaming render shrank and grew: the view moved up, nobody touched it
  expect(following({ ...at, top: 4956, fromBottom: 44 })).toBe(true);
  // the scrollbar dragged up, even a little (a finger and the wheel have their own handlers)
  expect(following({ ...at, bar: true, top: 4997, fromBottom: 3 })).toBe(false);
  // back down to the very bottom follows again; not with newer messages unmounted below
  const up = { ...at, stick: false, lastTop: 4000, top: 4990, fromBottom: 10 };
  expect(following(up)).toBe(true);
  expect(following({ ...up, tail: false })).toBe(false);
  // moving up never starts following, even near the bottom
  expect(following({ ...up, lastTop: 4995 })).toBe(false);
});

test("the cap holds while new messages keep arriving below a reader near the slice's top", () => {
  // all of the first 300 mounted, the reader at row 2, 600 new messages arrive one by one
  let w = { lo: 0, hi: 300, tail: true };
  for (let n = 301; n <= 900; n++) w = nextWindow(w, x({ n, nearTop: true, anchor: 2 }));
  expect(w).toEqual({ lo: 0, hi: CAP, tail: false });
  // just below the slice's top, not near the top in pixels; and while a fling runs (not settled)
  w = { lo: 500, hi: 800, tail: true };
  for (let n = 801; n <= 1400; n++) w = nextWindow(w, x({ n, anchor: 505 }));
  expect(w.hi - w.lo).toBe(CAP);
  w = { lo: 500, hi: 800, tail: true };
  for (let n = 801; n <= 1400; n++) w = nextWindow(w, x({ n, settled: false, anchor: 505 }));
  expect(w).toEqual({ lo: 500, hi: 800, tail: false });
  // the reviewer's form (hi passed as n each time) stays capped too
  w = { lo: 0, hi: 300, tail: true };
  for (let n = 301; n <= 900; n++) w = nextWindow({ ...w, hi: n }, x({ n, nearTop: true, anchor: 2 }));
  expect(w.hi - w.lo).toBe(CAP);
  // heading down past the cap (rows just mounted below): the top is trimmed once settled instead
  expect(nextWindow({ lo: 100, hi: 400, tail: false }, x({ n: 1000, nearEnd: true, settled: false, anchor: 380 }))).toEqual({ lo: 100, hi: 450, tail: false });
});

test("a downward fling overshoots the cap by a bounded amount, trimmed once settled", () => {
  let w = { lo: 100, hi: 400, tail: false };
  for (let i = 0; i < 20; i++) w = nextWindow(w, x({ n: 2000, nearEnd: true, settled: false, anchor: w.hi - 5 }));
  expect(w).toEqual({ lo: 100, hi: 100 + CAP + OVERSHOOT, tail: false });
  expect(nextWindow(w, x({ n: 2000, anchor: 495 }))).toEqual({ lo: 200, hi: 500, tail: false });
});

test("a scroll on its way is told from a browser clamp", () => {
  // no scroll since the last event
  expect(scrollInFlight(5000, 5000, 5000, 9000)).toBe(false);
  // the reader moved and the event hasn't come yet
  expect(scrollInFlight(5040, 5000, 5040, 9000)).toBe(true);
  // rows dropped above: scrollTop was clamped from 34810 to 27151, and that isn't the reader
  expect(scrollInFlight(34810, 34810, 27151, 27151)).toBe(false);
  // the same clamp seen without a "before" (a ResizeObserver callback)
  expect(scrollInFlight(27151, 34810, 27151, 27151)).toBe(false);
});
