import { expect, test } from "bun:test";
import { CAP, Follow, FOLLOW_KEEP, Gesture, HOLD, LEAVE, nextWindow, OVERSHOOT, PAGE, remap, restoreTop, rowAt, scrollInFlight, type WinInput } from "./scrollKeep";

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

const moved = (f: Follow, top: number, lastTop: number, now: number, o: { fromBottom?: number; tail?: boolean; selecting?: boolean } = {}) =>
  f.scrolled({ top, lastTop, fromBottom: 0, tail: true, now, selecting: false, ...o });

test("a scroll with no input never stops following", () => {
  const f = new Follow();
  // the composer grew, or a streaming render shrank and grew: the view moved up, nobody touched it
  moved(f, 4956, 5000, 0, { fromBottom: 44 });
  expect(f.on).toBe(true);
});

test("following stops on real upward movement, not on the wheel's sign", () => {
  const f = new Follow();
  // three -1 px wheel events
  for (const [i, top] of [4999, 4998, 4997].entries()) {
    f.wheel(0, -1, top + 1, i * 16);
    moved(f, top, top + 1, i * 16 + 1);
  }
  expect(f.on).toBe(true);
  // the pixels add up: a slow trackpad does leave
  for (let t = 48, top = 4997; f.on && t < 200; t += 16, top--) {
    f.wheel(0, -1, top, t);
    moved(f, top - 1, top, t + 1);
  }
  expect(f.on).toBe(false);
});

test("a wheel that moves nothing, or goes sideways, isn't input", () => {
  const f = new Follow();
  f.wheel(0, -100, 0, 0); // a page too short to scroll: no scroll follows
  expect(f.on).toBe(true);
  const g = new Follow();
  g.wheel(40, -1, 5000, 1000);
  expect(g.live(1000)).toBe(false);
  g.wheel(0, 5, 5000, 2000); // down
  expect(g.live(2000)).toBe(false);
  g.wheel(0, -5, 5000, 3000);
  expect(g.live(3000)).toBe(true);
  expect(g.live(3000 + HOLD)).toBe(false);
});

test("a finger is judged by what moved: up then back down still leaves the bottom", () => {
  const f = new Follow();
  f.input(5000, 0, true);
  moved(f, 5000, 5000, 10);
  moved(f, 4800, 5000, 20); // well above where it started or not, it moved up
  expect(f.on).toBe(false);
  // a held input stays live through a pause, then for HOLD after the release
  const g = new Follow();
  g.input(5000, 0, true);
  expect(g.live(60_000)).toBe(true);
  g.release(60_000);
  expect(g.live(60_000 + HOLD)).toBe(false);
});

test("a rubber band past the end isn't a move up", () => {
  const f = new Follow();
  f.input(5000, 0, true);
  moved(f, 5060, 5000, 10, { fromBottom: -60 });
  moved(f, 5000, 5060, 20);
  expect(f.on).toBe(true);
});

test("moving down to the real bottom follows again", () => {
  const f = new Follow();
  f.stop();
  moved(f, 4990, 4000, 0, { fromBottom: 10, tail: false }); // newer messages unmounted below
  expect(f.on).toBe(false);
  moved(f, 4992, 4990, 1, { fromBottom: 8, selecting: true }); // the browser, autoscrolling a selection
  expect(f.on).toBe(false);
  moved(f, 4995, 4992, 2, { fromBottom: 5 });
  expect(f.on).toBe(true);
  // moving up never starts following, even near the bottom
  const g = new Follow();
  g.stop();
  moved(g, 4990, 4995, 0, { fromBottom: 10 });
  expect(g.on).toBe(false);
  // reached with no scroll event left
  const h = new Follow();
  h.stop();
  moved(h, 4000, 3000, 0, { fromBottom: 900 });
  h.arrived(10, true);
  expect(h.on).toBe(true);
});

test("Jump to latest isn't undone by the wheel's inertia", () => {
  const f = new Follow();
  f.input(5000, 0);
  moved(f, 4000, 5000, 1);
  expect(f.on).toBe(false);
  for (let t = 0, v = 40; t < 300; t += 16, v *= 0.9) f.wheel(0, -v, 9000, t);
  f.jumped(300);
  expect(f.on).toBe(true);
  for (let t = 316; t < 600; t += 16) {
    f.wheel(0, -2, 9000, t);
    moved(f, 8990, 9000, t + 1);
  }
  expect(f.on).toBe(true);
  // a new gesture after a pause is heard
  f.wheel(0, -100, 9000, 1100);
  moved(f, 9000 - LEAVE - 1, 9000, 1101);
  expect(f.on).toBe(false);
  // with no wheel running, the next wheel is heard at once
  const g = new Follow();
  g.jumped(1000);
  g.wheel(0, -100, 9000, 1010);
  expect(g.live(1010)).toBe(true);
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
