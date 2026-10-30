// Keeping the reader's place in the transcript without fighting their finger.
//
// iOS Safari ends a momentum scroll the moment the page writes scrollTop, and it has no CSS scroll
// anchoring, so the transcript writes scrollTop only when no finger is down and no scroll is in
// flight: following the bottom (that one only needs the finger off), and putting the reader's row
// back after rows above it were added or dropped. Only a bounded slice of the loaded messages is
// mounted (nextWindow): rows below the viewport come and go at any time, rows above it only once
// the scroll settles.

/** Scroll activity: idle once no finger is down and no scroll event came for `quiet` ms. */
export class Gesture {
  private touching = false;
  private last = -Infinity;
  constructor(readonly quiet = 150) {}
  touch(down: boolean, now: number) {
    this.touching = down;
    // a lifted finger usually starts momentum: count it as a scroll
    this.last = now;
  }
  scrolled(now: number) {
    this.last = now;
  }
  /** a finger is on the transcript */
  get down(): boolean {
    return this.touching;
  }
  idle(now: number): boolean {
    return !this.touching && now - this.last >= this.quiet;
  }
}

/** Messages per page (the server's TRANSCRIPT_PAGE): the window grows and shrinks by this. */
export const PAGE = 50;
/** At most this many messages are mounted: a phone can't hold thousands (memory, every render). */
export const CAP = 300;
/** Mounted once settled while following the bottom, so a session left open stays small. */
export const FOLLOW_KEEP = 100;

/**
 * The mounted slice [lo, hi) of the loaded messages. `tail`: it ends at the newest, and new
 * messages join it; otherwise there are newer messages below it, unmounted.
 */
export interface Win {
  lo: number;
  hi: number;
  tail: boolean;
}

export interface WinInput {
  /** loaded messages */
  n: number;
  /** no finger down and no scroll in flight: a scrollTop write is safe */
  settled: boolean;
  /** following the bottom */
  stick: boolean;
  /** the viewport is near the top of what's mounted */
  nearTop: boolean;
  /** the viewport is near the bottom of what's mounted */
  nearEnd: boolean;
  /** the index of the row at the viewport's top, -1 when unknown */
  anchor: number;
}

/**
 * The next mounted slice. Rows are added or dropped *above* the viewport only once settled (that
 * moves content, so the reader's row is put back with a scrollTop write); *below* it at any time
 * (nothing on screen moves). Going up past CAP drops rows from the bottom; going down past it
 * drops rows from the top, once settled.
 */
export function nextWindow(w: Win, x: WinInput): Win {
  const n = x.n;
  let hi = w.tail ? n : Math.min(w.hi, n);
  let lo = Math.min(w.lo, hi);
  let tail = w.tail || hi >= n;
  if (x.stick && tail) {
    if (x.settled && hi - lo > FOLLOW_KEEP) lo = hi - FOLLOW_KEEP;
    return { lo, hi, tail };
  }
  let above = false;
  if (x.settled && x.nearTop && lo > 0) {
    lo = Math.max(0, lo - PAGE);
    above = true;
  }
  if (x.nearEnd && !tail) hi = Math.min(n, hi + PAGE);
  tail = hi >= n;
  if (hi - lo > CAP) {
    if (above) {
      hi = lo + CAP;
      tail = hi >= n;
    } else {
      // never past the reader's row (it is where the viewport is, so this is a guard)
      if (x.settled) lo = x.anchor >= lo ? Math.min(hi - CAP, Math.max(lo, x.anchor - 10)) : hi - CAP;
      // Still over: the reader is near the slice's top (new messages kept arriving below them),
      // or it isn't settled. Drop from the bottom instead, which is safe at any time, keeping a
      // page below the reader; not while they're heading for the end (rows were just mounted there).
      if (hi - lo > CAP && !x.nearEnd) {
        hi = Math.min(hi, Math.max(lo + CAP, x.anchor >= 0 ? x.anchor + PAGE : 0));
        tail = hi >= n;
      }
    }
  }
  return { lo, hi, tail };
}

/**
 * Last render's slice, found again in the current ids by the first and last mounted ids (older
 * pages arriving in front shift every index). A slice that can't be found (a reset replaced the
 * messages) starts again at the newest.
 */
export function remap(ids: string[], first: string | undefined, last: string | undefined, tail: boolean): Win {
  const n = ids.length;
  const fresh = { lo: Math.max(0, n - FOLLOW_KEEP), hi: n, tail: true };
  if (first === undefined) return fresh;
  const lo = ids.indexOf(first);
  if (lo < 0) return fresh;
  if (tail) return { lo, hi: n, tail };
  const hi = last === undefined ? -1 : ids.indexOf(last);
  return hi < lo ? fresh : { lo, hi: hi + 1, tail: hi + 1 >= n };
}

/**
 * Whether to follow the bottom after a scroll that wasn't ours. Only the reader stops following:
 * a finger or the scrollbar moving the view up, or the view moving up while the transcript kept
 * its size (keys, find in page, a script; the wheel and keys also have handlers). The view also
 * moves up when the transcript gets shorter or its box does, as when the composer grows: that
 * isn't the reader, and it must not stop following. Moving down to the very bottom follows again.
 * `resized`: the box's height changed, or the content got shorter, since the last scroll event.
 */
export function following(s: { stick: boolean; down: boolean; resized: boolean; top: number; lastTop: number; fromBottom: number; tail: boolean }, nearBottom = 40): boolean {
  if (s.top < s.lastTop - 1 && (s.down || !s.resized)) return false;
  if (!s.stick && s.top > s.lastTop + 0.5 && s.tail && s.fromBottom < nearBottom) return true;
  return s.stick;
}

/**
 * The first row whose bottom is below `y` (rows in order, `bottom(i)` increasing): the row at the
 * top of the viewport when y is scrollTop. The last row when all end above y; -1 with no rows.
 */
export function rowAt(n: number, bottom: (i: number) => number, y: number): number {
  if (n <= 0) return -1;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bottom(mid) > y) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** A row and how far below the viewport's top its top was (negative: partly scrolled past). */
export interface Anchor {
  id: string;
  top: number;
}

/**
 * The scrollTop that puts the anchor row back where the reader had it, given where the row's top
 * now is in the content; undefined when it's already there (within a pixel).
 */
export function restoreTop(a: Anchor, rowTop: number, scrollTop: number): number | undefined {
  const want = rowTop - a.top;
  return Math.abs(want - scrollTop) < 1 ? undefined : want;
}
