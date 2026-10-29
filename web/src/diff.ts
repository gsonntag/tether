// A line diff for edit cards: old and new text as removed / added / same lines (LCS). Big inputs
// fall back to "all removed, then all added" rather than spending seconds on a phone.

export type DiffLine = { op: " " | "-" | "+"; text: string };

const MAX_CELLS = 400_000;

export function lineDiff(oldText: string, newText: string): DiffLine[] {
  const a = oldText === "" ? [] : oldText.split("\n");
  const b = newText === "" ? [] : newText.split("\n");
  // Common head and tail first: an edit usually touches a few lines in the middle.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const am = a.slice(head, a.length - tail);
  const bm = b.slice(head, b.length - tail);
  const out: DiffLine[] = a.slice(0, head).map((text) => ({ op: " ", text }));
  if (am.length * bm.length > MAX_CELLS) {
    out.push(...am.map((text) => ({ op: "-" as const, text })), ...bm.map((text) => ({ op: "+" as const, text })));
  } else {
    // lcs[i][j]: the common subsequence length of am[i..] and bm[j..]
    const n = am.length;
    const m = bm.length;
    const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i]![j] = am[i] === bm[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && am[i] === bm[j]) out.push({ op: " ", text: am[i++]! }), j++;
      // Removals before additions, as diffs usually read.
      else if (i < n && (j >= m || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) out.push({ op: "-", text: am[i++]! });
      else out.push({ op: "+", text: bm[j++]! });
    }
  }
  out.push(...a.slice(a.length - tail).map((text) => ({ op: " " as const, text })));
  return out;
}

/** Keeps changed lines and `context` lines around them; runs of unchanged lines become one "…" gap. */
export function withContext(lines: DiffLine[], context = 3): (DiffLine | { op: "gap"; count: number })[] {
  const keep = lines.map(() => false);
  lines.forEach((l, i) => {
    if (l.op === " ") return;
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true;
  });
  const out: (DiffLine | { op: "gap"; count: number })[] = [];
  let gap = 0;
  lines.forEach((l, i) => {
    if (keep[i]) {
      if (gap) out.push({ op: "gap", count: gap });
      gap = 0;
      out.push(l);
    } else gap++;
  });
  if (gap) out.push({ op: "gap", count: gap });
  return out;
}
