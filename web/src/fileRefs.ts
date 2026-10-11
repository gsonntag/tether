// File references in transcript text: `web/src/App.tsx`, `./x.py`, `src/a.ts:42`, `src/a.ts:42-50`,
// `src/a.ts:12:3`, `src/a.ts#L42`, absolute paths. These are only candidates: a reference becomes
// a link once the runner confirms it's a file in the project (or one the session changed), so
// prose like "and/or", "Node.js" or "e.g." never links (components/FileRefs.tsx).

export interface FileRef {
  /** as written (relative to the project, or absolute), without the line suffix */
  path: string;
  line?: number;
  /** last line of a range (`:42-50`, `#L42-L50`) */
  endLine?: number;
  col?: number;
}

export interface FoundRef {
  /** offset of the match in the text, and its length (line suffix included, trailing punctuation not) */
  index: number;
  length: number;
  ref: FileRef;
}

// A path: optional ./, ../ or / in front, then segments of word characters, dots, dashes, @ and +.
// Never starts right after another path character, a colon or a slash, so the middle of a URL
// (https://host/a.ts), an email or a longer word can't start a match.
const PATH = String.raw`(?:\.{1,2}/|/)?[\w@+.-]+(?:/[\w@+.-]+)*`;
const SUFFIX = String.raw`(?::(\d+)(?:([:-])(\d+))?|#L(\d+)(?:-L?(\d+))?)?`;
/** The candidate pattern (use with the "g" flag), for Markdown inline plugins; check each match with `matchRef`. */
export const REF_SOURCE = String.raw`(?<![\w@+./:~\\$%-])(${PATH})${SUFFIX}(?![\w/@])`;
const REF_RE = new RegExp(REF_SOURCE, "g");

/** A file name worth asking about: has an extension with a letter in it (`a.ts`, not `1.2.3`), or is a dotfile (`.gitignore`). */
const FILE_NAME = /^(?:[\w@+-][\w@+.-]*\.[A-Za-z][\w-]{0,15}|\.[A-Za-z][\w.-]*)$/;
const EMAIL = /^[^\s/@]+@[^\s/@]+\.[A-Za-z]{2,}$/;
const MAX_LINE = 10_000_000;

/** Checks a candidate path (no line suffix) and returns it cleaned up, or undefined if it can't be a file reference. */
export function candidatePath(raw: string): string | undefined {
  let p = raw;
  // Trailing dots are sentence punctuation ("see src/a.ts."), not part of the name.
  p = p.replace(/\.+$/, "");
  if (!p || p.length > 1024) return undefined;
  if (p.includes("//") || /^www\./i.test(p) || EMAIL.test(p)) return undefined;
  const segs = p.split("/");
  const last = segs[segs.length - 1]!;
  if (!last || last === "." || last === "..") return undefined; // a directory ("src/") or just dots
  if (segs.some((s, i) => !s && i > 0)) return undefined;
  const hasDir = segs.filter(Boolean).length > 1;
  if (!hasDir && !FILE_NAME.test(last)) return undefined;
  // Something with a slash still needs a letter somewhere (not "1/2", "24/7").
  if (!/[A-Za-z]/.test(p)) return undefined;
  // Bare "/" segments only: "/", "/usr" — an absolute path needs at least a file under a directory.
  if (p.startsWith("/") && segs.filter(Boolean).length < 2) return undefined;
  return p;
}

function toRef(path: string, m: RegExpExecArray | RegExpMatchArray): FileRef {
  const ref: FileRef = { path };
  const num = (s?: string) => {
    const n = s === undefined ? NaN : Number(s);
    return Number.isInteger(n) && n > 0 && n <= MAX_LINE ? n : undefined;
  };
  const line = num(m[2] ?? m[5]);
  if (line) {
    ref.line = line;
    if (m[3] === ":") {
      const col = num(m[4]);
      if (col) ref.col = col;
    } else {
      const end = num(m[4] ?? m[6]);
      if (end && end >= line) ref.endLine = end;
    }
  }
  return ref;
}

/** A match of REF_SOURCE as a file reference, or undefined when it can't be one. */
export function matchRef(m: RegExpMatchArray): FoundRef | undefined {
  const raw = m[1]!;
  const path = candidatePath(raw);
  if (!path) return undefined;
  // Trailing dots dropped from the path ("in a.ts."): the match ends at the path, with no line.
  const ref = path === raw ? toRef(path, m) : { path };
  return { index: m.index ?? 0, length: ref.line !== undefined ? m[0].length : path.length, ref };
}

/** Every candidate file reference in plain text (prose, shell output), in order. */
export function findRefs(text: string): FoundRef[] {
  const out: FoundRef[] = [];
  REF_RE.lastIndex = 0;
  for (let m: RegExpExecArray | null; (m = REF_RE.exec(text)); ) {
    const f = matchRef(m);
    if (f) out.push(f);
  }
  return out;
}

/** A single token (inline code, a link target) that is exactly a file reference, give or take wrapping quotes and punctuation. */
export function parseRefToken(token: string): FileRef | undefined {
  let t = token.trim();
  // quotes, brackets and trailing sentence punctuation around the whole token
  for (let prev = ""; prev !== t; ) {
    prev = t;
    t = t.replace(/^["'`([{<]+/, "").replace(/["'`)\]}>,;!?]+$/, "");
    if (/:$/.test(t)) t = t.slice(0, -1);
  }
  if (!t || /\s/.test(t)) return undefined;
  const found = findRefs(t);
  if (found.length !== 1) return undefined;
  const f = found[0]!;
  if (f.index !== 0) return undefined;
  // Everything after the match may only be trailing dots (already dropped from the path).
  if (!/^\.*$/.test(t.slice(f.length))) return undefined;
  return f.ref;
}

/**
 * A markdown link target that points at a local file: `src/a.ts`, `./a.ts#L42`, `/abs/path.ts`,
 * `file:///abs/path.ts`. URLs with any other scheme (or protocol-relative ones) are not files.
 */
export function refFromHref(href: string): FileRef | undefined {
  let h = href.trim();
  if (/^file:\/\//i.test(h)) h = h.replace(/^file:\/\/(localhost)?/i, "");
  else if (/^[a-z][a-z0-9+.-]*:/i.test(h) || h.startsWith("//") || h.startsWith("#") || h.startsWith("?")) return undefined;
  h = h.replace(/\?[^#]*/, "");
  try {
    h = decodeURI(h);
  } catch {
    return undefined;
  }
  return parseRefToken(h);
}

/** "src/a.ts:42-50" */
export function formatRef(ref: FileRef): string {
  return ref.line ? `${ref.path}:${ref.line}${ref.endLine && ref.endLine !== ref.line ? `-${ref.endLine}` : ref.col ? `:${ref.col}` : ""}` : ref.path;
}
