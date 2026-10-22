// A fresh copy of a list from the runner (a transcript snapshot replacing the saved one, a project's
// sessions, the projects) keeps the objects of items that didn't change, so the memoized rows
// showing them aren't drawn again. With nothing changed, the list on screen itself is kept.
export function reuseSame<T>(prev: readonly T[] | undefined, next: T[], key: (x: T) => string): T[] {
  if (!prev?.length) return next;
  const old = new Map(prev.map((x) => [key(x), x]));
  let same = prev.length === next.length;
  const out = next.map((x, i) => {
    const o = old.get(key(x));
    const keep = o !== undefined && (o === x || JSON.stringify(o) === JSON.stringify(x)) ? o : x;
    if (keep !== prev[i]) same = false;
    return keep;
  });
  return same ? (prev as T[]) : out;
}

export const byId = (x: { id: string }) => x.id;
