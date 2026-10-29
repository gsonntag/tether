// The one sync rule (SPEC §5): apply an event only when its seq is the next one; anything older
// is already in the snapshot, and a jump means something was missed, so subscribe again.

export type SeqVerdict = "apply" | "stale" | "gap";

export function checkSeq(last: number, seq: number): SeqVerdict {
  if (seq === last + 1) return "apply";
  return seq <= last ? "stale" : "gap";
}

/**
 * Events that arrived while a subscribe was in flight, folded onto its snapshot: the ones the
 * snapshot already holds are dropped. Returns the events to apply in order, or "gap" when one
 * is missing between the snapshot and the buffered events.
 */
export function afterSnapshot<E extends { seq: number }>(snapshotSeq: number, buffered: E[]): E[] | "gap" {
  const out: E[] = [];
  let last = snapshotSeq;
  for (const e of [...buffered].sort((a, b) => a.seq - b.seq)) {
    const v = checkSeq(last, e.seq);
    if (v === "stale") continue;
    if (v === "gap") return "gap";
    out.push(e);
    last = e.seq;
  }
  return out;
}
