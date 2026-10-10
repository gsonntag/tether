// Managed blocks: the only part of a user's own memory file Tether writes. Everything outside the
// markers is the user's and is kept byte for byte. A begin marker without an end marker (the
// user deleted it) only claims the marker line itself: nothing after it is ever treated as ours.

export const BEGIN = "<!-- tether:begin (managed, edits here are overwritten) -->";
export const END = "<!-- tether:end -->";

const BEGIN_RE = /<!--\s*tether:begin\b[^>]*-->/;
const END_RE = /<!--\s*tether:end\s*-->/;

interface Split {
  head: string;
  inner: string;
  tail: string;
}

function split(text: string): Split | undefined {
  const b = BEGIN_RE.exec(text);
  if (!b) return undefined;
  const head = text.slice(0, b.index);
  const rest = text.slice(b.index + b[0].length);
  const e = END_RE.exec(rest);
  if (!e) return { head, inner: "", tail: rest };
  return { head, inner: rest.slice(0, e.index), tail: rest.slice(e.index + e[0].length) };
}

/** head + tail without the blank line insertion added around the block. */
function join2(head: string, tail: string): string {
  // Insertion adds one "\n" before the block (plus one more if the user's text had no final
  // newline) and one after it; take exactly one back from each side.
  const h = head.endsWith("\n\n") ? head.slice(0, -1) : head;
  const t = tail.startsWith("\n") ? tail.slice(1) : tail;
  if (!h) return t.replace(/^\n+/, "");
  return h + t;
}

/** The file's text with the managed block removed: what importers read as the user's own. */
export function outsideBlock(text: string): string {
  const s = split(text);
  return s ? join2(s.head, s.tail) : text;
}

export function blockContent(text: string): string | undefined {
  const s = split(text);
  return s ? s.inner.replace(/^\n/, "").replace(/\n$/, "") : undefined;
}

/**
 * Inserts or replaces the managed block. A new block goes at the end, after a blank line; an
 * existing one is replaced in place. `content` undefined removes the block.
 */
export function upsertBlock(text: string, content: string | undefined): string {
  const block = content === undefined ? "" : `${BEGIN}\n${content.trim()}\n${END}`;
  const s = split(text);
  if (s) return block ? s.head + block + s.tail : join2(s.head, s.tail);
  if (!block) return text;
  if (!text.trim()) return block + "\n";
  return text + (text.endsWith("\n") ? "\n" : "\n\n") + block + "\n";
}

/** Same for TOML (codex config.toml): `#` comment markers. */
export const TOML_BEGIN = "# tether:begin (managed, edits here are overwritten)";
export const TOML_END = "# tether:end";

export function upsertTomlBlock(text: string, content: string | undefined): string {
  const lines = text.split("\n");
  const b = lines.findIndex((l) => l.trim().startsWith("# tether:begin"));
  const e = b >= 0 ? lines.findIndex((l, i) => i > b && l.trim() === TOML_END) : -1;
  const block = content === undefined ? [] : [TOML_BEGIN, ...content.trim().split("\n"), TOML_END];
  if (b >= 0) {
    // Without an end marker only the begin line is ours: never swallow the user's config.
    const end = e >= 0 ? e : b;
    lines.splice(b, end - b + 1, ...block);
    if (!block.length && b > 0 && lines[b - 1] === "" && (lines[b] === "" || b === lines.length)) lines.splice(b - 1, 1);
    return lines.join("\n");
  }
  if (!block.length) return text;
  if (!text.trim()) return block.join("\n") + "\n";
  return text + (text.endsWith("\n") ? "\n" : "\n\n") + block.join("\n") + "\n";
}

/**
 * Whole files Tether owns inside harness dirs (Claude's per-project tether.md, Kiro's steering
 * file) carry this front-matter line. A file of the same name without it is the user's: it is
 * imported like any other and never overwritten or deleted.
 */
export const OWNED_MARK = "managed-by: tether";

export function isTetherOwned(text: string | undefined): boolean {
  if (!text) return false;
  const fm = /^---\n([\s\S]*?)\n---/.exec(text.replace(/\r\n/g, "\n"));
  if (!fm) return false;
  // Exports before the mark existed had only this description.
  return /^managed-by:\s*tether\s*$/m.test(fm[1]!) || fm[1]!.includes("description: Shared repository memory from Tether (managed; edits are overwritten)");
}

/** Whether `text` has the TOML block (for undo). */
export const hasTomlBlock = (text: string) => text.split("\n").some((l) => l.trim().startsWith("# tether:begin"));
