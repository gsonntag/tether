// Windowing for the transcript: only messages near the viewport are rendered. Heights are measured
// once rendered and estimated before. Scroll position is kept by an anchor (the message at the top
// of the viewport and how far into it we are), restored by hand after anything above it changes
// size or arrives, because iOS Safari has no CSS scroll anchoring.

/** Offsets of each item's top, plus the total height at the end (length n + 1). */
export function offsets(ids: string[], height: (id: string, i: number) => number): number[] {
  const out = new Array<number>(ids.length + 1);
  out[0] = 0;
  for (let i = 0; i < ids.length; i++) out[i + 1] = out[i]! + height(ids[i]!, i);
  return out;
}

/** The index of the item containing `y` (the last one when y is past the end). */
export function indexAt(offs: number[], y: number): number {
  const n = offs.length - 1;
  if (n <= 0) return 0;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offs[mid]! <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Items to render: [start, end) covering the viewport plus `overscan` pixels each way. */
export function visibleRange(offs: number[], scrollTop: number, viewport: number, overscan: number): [number, number] {
  const n = offs.length - 1;
  if (n <= 0) return [0, 0];
  const start = indexAt(offs, Math.max(0, scrollTop - overscan));
  const end = indexAt(offs, scrollTop + viewport + overscan) + 1;
  return [start, Math.min(n, end)];
}

export interface Anchor {
  id: string;
  /** scrollTop minus the item's top: how far into the item the viewport starts */
  into: number;
}

export function anchorAt(ids: string[], offs: number[], scrollTop: number): Anchor | undefined {
  if (!ids.length) return undefined;
  const i = indexAt(offs, scrollTop);
  return { id: ids[i]!, into: scrollTop - offs[i]! };
}

/** The scrollTop that puts the anchor back where it was; undefined when the anchor is gone. */
export function restore(ids: string[], offs: number[], a: Anchor): number | undefined {
  const i = ids.indexOf(a.id);
  return i < 0 ? undefined : offs[i]! + a.into;
}
