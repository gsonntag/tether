// Keeping the reader's place in the transcript without fighting their finger.
//
// iOS Safari ends a momentum scroll the moment the page writes scrollTop, and it has no CSS scroll
// anchoring, so the transcript writes scrollTop only when no finger is down and no scroll is in
// flight: following the bottom, and putting the reader's row back after older messages arrive
// above it. Older pages that arrive mid-fling wait (hidden) until the scroll settles.

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
  idle(now: number): boolean {
    return !this.touching && now - this.last >= this.quiet;
  }
}

/**
 * The index of the first message to render. Older messages that arrived in front of the ones
 * shown wait while the reader scrolls; they're shown once it settles (or when there is nothing to
 * keep, such as a reset that dropped the first shown message).
 */
export function firstShown(ids: string[], shownFrom: string | undefined, settled: boolean): number {
  if (settled || shownFrom === undefined) return 0;
  const i = ids.indexOf(shownFrom);
  return i < 0 ? 0 : i;
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
