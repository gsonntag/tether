// Managed blocks: the only part of a user's own memory file Tether writes. Everything outside the
// markers is the user's and is kept byte for byte.

export const BEGIN = "<!-- tether:begin (managed, edits here are overwritten) -->";
export const END = "<!-- tether:end -->";

const BEGIN_RE = /<!--\s*tether:begin\b[^>]*-->/;
const END_RE = /<!--\s*tether:end\s*-->/;

/** The file's text with the managed block removed: what importers read as the user's own. */
export function outsideBlock(text: string): string {
  const b = BEGIN_RE.exec(text);
  if (!b) return text;
  const rest = text.slice(b.index + b[0].length);
  const e = END_RE.exec(rest);
  // Drop the blank lines we added around the block, so stripping is the inverse of inserting.
  const head = text.slice(0, b.index).replace(/\n+$/, "");
  const tail = (e ? rest.slice(e.index + e[0].length) : "").replace(/^\n+/, "");
  if (!head) return tail;
  return tail ? `${head}\n\n${tail}` : `${head}\n`;
}

export function blockContent(text: string): string | undefined {
  const b = BEGIN_RE.exec(text);
  if (!b) return undefined;
  const rest = text.slice(b.index + b[0].length);
  const e = END_RE.exec(rest);
  return (e ? rest.slice(0, e.index) : rest).replace(/^\n/, "").replace(/\n$/, "");
}

/**
 * Inserts or replaces the managed block. A new block goes at the end, after a blank line; an
 * existing one is replaced in place. `content` undefined removes the block.
 */
export function upsertBlock(text: string, content: string | undefined): string {
  const block = content === undefined ? "" : `${BEGIN}\n${content.trim()}\n${END}`;
  const b = BEGIN_RE.exec(text);
  if (b) {
    const rest = text.slice(b.index + b[0].length);
    const e = END_RE.exec(rest);
    const head = text.slice(0, b.index);
    const tail = e ? rest.slice(e.index + e[0].length) : "";
    if (block) return head + block + tail;
    return outsideBlock(text);
  }
  if (!block) return text;
  if (!text.trim()) return block + "\n";
  return text.replace(/\n*$/, "") + "\n\n" + block + "\n";
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
    const end = e >= 0 ? e : lines.length - 1;
    lines.splice(b, end - b + 1, ...block);
    return lines.join("\n").replace(/\n{3,}$/, "\n\n");
  }
  if (!block.length) return text;
  return (text.trim() ? text.replace(/\n*$/, "") + "\n\n" : "") + block.join("\n") + "\n";
}
