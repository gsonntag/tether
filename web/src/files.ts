// The Files tab's state, apart from React (SPEC §10 Files): folders loaded so far and which are
// open, the rows the tree shows, what the viewer shows for a file, and what Mention puts in the box.

import { isHidden, isMarkdown, type ChangeMark, type DirList, type FileChanges, type FileEntry, type FileRead } from "../../shared/files";

export interface DirState {
  list?: DirList;
  error?: string;
  loading?: boolean;
}

export type Row =
  | { t: "entry"; path: string; entry: FileEntry; depth: number; open: boolean }
  | { t: "loading"; path: string; depth: number }
  | { t: "empty"; path: string; depth: number }
  | { t: "error"; path: string; depth: number; error: string }
  | { t: "more"; path: string; depth: number; more: number };

export const joinPath = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
export const parentOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));
export const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** A folder, or a link to a folder inside: it opens in the tree. */
export const isFolder = (e: FileEntry) => e.kind === "dir" || (e.kind === "link" && e.to === "dir");
/** A file the viewer can open: a file, or a link to a file inside; never a name that isn't UTF-8. */
export const canOpen = (e: FileEntry) => !e.badName && (e.kind === "file" || (e.kind === "link" && e.to === "file"));

/** The tree's rows: the folder's entries, and under each open folder its own, as far as loaded. */
export function treeRows(dirs: Readonly<Record<string, DirState>>, open: ReadonlySet<string>, dir = "", depth = 0, out: Row[] = []): Row[] {
  const d = dirs[dir];
  if (!d?.list) {
    if (d?.error) out.push({ t: "error", path: dir, depth, error: d.error });
    else out.push({ t: "loading", path: dir, depth });
    return out;
  }
  if (!d.list.entries.length && !d.list.more) out.push({ t: "empty", path: dir, depth });
  for (const entry of d.list.entries) {
    const path = joinPath(dir, entry.name);
    const isOpen = isFolder(entry) && open.has(path);
    out.push({ t: "entry", path, entry, depth, open: isOpen });
    if (isOpen) treeRows(dirs, open, path, depth + 1, out);
  }
  if (d.list.more) out.push({ t: "more", path: dir, depth, more: d.list.more });
  return out;
}

/** A change mark's badge letter (as editors show them) and the words said for it. */
export const MARKS: Readonly<Record<ChangeMark, { letter: string; label: string }>> = {
  modified: { letter: "M", label: "modified" },
  added: { letter: "A", label: "added" },
  untracked: { letter: "U", label: "untracked" },
  renamed: { letter: "R", label: "renamed" },
  deleted: { letter: "D", label: "deleted" },
  conflict: { letter: "C", label: "conflict" },
};

export interface Marks {
  /** a path's own mark (a file; a folder git names whole: untracked, a nested repo, a submodule) */
  files: ReadonlyMap<string, ChangeMark>;
  /** the paths in `files` that are folders */
  folders: ReadonlySet<string>;
  /** folders with changed paths under them, and how many */
  dirs: ReadonlyMap<string, number>;
}

/**
 * The tree's marks from fileChanges' answer. Without `hidden`, paths the tree hides (a dot-named
 * part) count for no folder, so a folder's mark never points at nothing to see.
 */
export function changeMarks(c: FileChanges | undefined, hidden: boolean): Marks {
  const files = new Map<string, ChangeMark>();
  const dirs = new Map<string, number>();
  if (!c?.repo) return { files, folders: new Set(), dirs };
  for (const [path, m] of Object.entries(c.files)) {
    files.set(path, m);
    if (!hidden && path.split("/").some(isHidden)) continue;
    for (let up = parentOf(path); up; up = parentOf(up)) dirs.set(up, (dirs.get(up) ?? 0) + 1);
  }
  return { files, folders: new Set(c.folders ?? []), dirs };
}

/** The mark on `path`: its own, else untracked when a folder above it is (git names an untracked folder once). */
export function markAt(marks: Marks, path: string): ChangeMark | undefined {
  const own = marks.files.get(path);
  if (own) return own;
  for (let up = parentOf(path); up; up = parentOf(up)) if (marks.folders.has(up) && marks.files.get(up) === "untracked") return "untracked";
  return undefined;
}

/** The changed paths as a list (the Changed view), by path; dot-named ones only with `hidden`. */
export function changedList(c: FileChanges | undefined, hidden: boolean): { path: string; mark: ChangeMark; folder: boolean }[] {
  if (!c?.repo) return [];
  const folders = new Set(c.folders ?? []);
  return Object.entries(c.files)
    .filter(([p]) => hidden || !p.split("/").some(isHidden))
    .map(([path, mark]) => ({ path, mark, folder: folders.has(path) }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** What a row says of its changes: a mark's word, or a folder's count; "" when none. */
export function markText(marks: Marks, path: string, folder: boolean): string {
  const own = markAt(marks, path);
  if (own) return MARKS[own].label;
  const n = folder ? (marks.dirs.get(path) ?? 0) : 0;
  return n ? `${n} ${n === 1 ? "change" : "changes"} inside` : "";
}

/** What a fileChanges answer or failure means for the tab: marks, else a note; an older runner without the op, neither. */
export function changesResult(r: { ok: true; data: FileChanges } | { ok: false; error: string }): { changes?: FileChanges; error?: string } {
  if (r.ok) return { changes: r.data };
  if (/doesn't know "fileChanges"/.test(r.error)) return {};
  return { error: r.error };
}

/** The folders to load again on Refresh or a hidden toggle: the top and every open one whose parents are open. */
export function loadedOpen(open: ReadonlySet<string>): string[] {
  const out = [""];
  for (const p of [...open].sort()) {
    let up = parentOf(p);
    let shown = true;
    while (up) {
      if (!open.has(up)) shown = false;
      up = parentOf(up);
    }
    if (shown) out.push(p);
  }
  return out;
}

/** Folders whose loads failed or which are gone from their parent's list: closed. */
export function pruneOpen(open: ReadonlySet<string>, dirs: Readonly<Record<string, DirState>>): Set<string> {
  const next = new Set<string>();
  for (const p of open) {
    const parent = dirs[parentOf(p)]?.list;
    if (dirs[p]?.error) continue;
    if (parent && !parent.entries.some((e) => joinPath(parentOf(p), e.name) === p && isFolder(e))) continue;
    next.add(p);
  }
  return next;
}

export type View =
  | { t: "markdown"; text: string; cut: boolean; lossy: boolean }
  | { t: "text"; text: string; cut: boolean; lossy: boolean }
  | { t: "image"; src: string }
  | { t: "binary"; size: number }
  | { t: "tooBig"; size: number };

/** What the viewer shows for a file. Images become a data: URL for an <img> (SVG too: never inline). */
export function viewOf(r: FileRead): View {
  switch (r.kind) {
    case "text":
      return { t: isMarkdown(r.path) ? "markdown" : "text", text: r.text, cut: !!r.cut, lossy: !!r.lossy };
    case "image":
      return { t: "image", src: `data:${r.mime};base64,${r.data}` };
    case "binary":
      return { t: "binary", size: r.size };
    case "tooBig":
      return { t: "tooBig", size: r.size };
  }
}

/** "1\n2\n3": the line numbers beside `text` (a last newline ends a line rather than starting one). */
export function lineNumbers(text: string): string {
  let n = 1;
  for (let i = text.indexOf("\n"); i !== -1 && i < text.length - 1; i = text.indexOf("\n", i + 1)) n++;
  return Array.from({ length: n }, (_, i) => i + 1).join("\n");
}

/** The message box with `mention` added on the same line, a space between. */
export function withMention(draft: string, mention: string): string {
  if (!draft) return `${mention} `;
  return /\s$/.test(draft) ? `${draft}${mention} ` : `${draft} ${mention} `;
}

/** What the tree does with a key on the entry at `rows[i]` (WAI-ARIA tree: arrows, Home, End, Enter, Space). */
export type TreeKey = { t: "focus"; index: number } | { t: "toggle"; path: string } | { t: "open"; path: string };
export function treeKey(rows: readonly Row[], i: number, key: string): TreeKey | undefined {
  const r = rows[i];
  if (!r || r.t !== "entry") return;
  const entries = rows.map((x, k) => (x.t === "entry" ? k : -1)).filter((k) => k >= 0);
  const at = entries.indexOf(i);
  const folder = isFolder(r.entry);
  switch (key) {
    case "ArrowDown":
      return at + 1 < entries.length ? { t: "focus", index: entries[at + 1]! } : undefined;
    case "ArrowUp":
      return at > 0 ? { t: "focus", index: entries[at - 1]! } : undefined;
    case "Home":
      return { t: "focus", index: entries[0]! };
    case "End":
      return { t: "focus", index: entries[entries.length - 1]! };
    case "ArrowRight":
      if (!folder) return;
      if (!r.open) return { t: "toggle", path: r.path };
      return rows[i + 1]?.t === "entry" && rows[i + 1]!.depth > r.depth ? { t: "focus", index: i + 1 } : undefined;
    case "ArrowLeft": {
      if (folder && r.open) return { t: "toggle", path: r.path };
      for (let k = i - 1; k >= 0; k--) if (rows[k]!.t === "entry" && rows[k]!.depth < r.depth) return { t: "focus", index: k };
      return;
    }
    case "Enter":
    case " ":
      return folder ? { t: "toggle", path: r.path } : canOpen(r.entry) ? { t: "open", path: r.path } : undefined;
  }
}

/** Where a Markdown link in the file `from` goes: a file in the folder, a heading on the page, or away. */
export type LinkTo = { t: "file"; path: string } | { t: "anchor"; id: string } | { t: "outside" } | { t: "away" };
export function linkTarget(from: string, href: string): LinkTo {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) return { t: "away" };
  const hash = href.indexOf("#");
  const frag = hash >= 0 ? href.slice(hash + 1) : "";
  let rest = hash >= 0 ? href.slice(0, hash) : href;
  rest = rest.split("?")[0]!;
  const dec = (s: string) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  if (!rest) return frag ? { t: "anchor", id: dec(frag) } : { t: "away" };
  const parts = rest.startsWith("/") ? [] : from.split("/").slice(0, -1);
  for (const seg of dec(rest).split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (!parts.length) return { t: "outside" };
      parts.pop();
    } else parts.push(seg);
  }
  return parts.length ? { t: "file", path: parts.join("/") } : { t: "outside" };
}

/** Characters that may make text read differently from how it's stored: notes for the viewer. */
export function oddChars(text: string): string[] {
  const out: string[] = [];
  if (/[‪-‮⁦-⁩]/.test(text)) out.push("bidirectional controls (text may not read in the order it's stored)");
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) out.push("control characters");
  return out;
}

/** `f` over `items`, at most `n` at a time, results in order. */
export async function mapLimit<T, R>(items: readonly T[], n: number, f: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await f(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}
