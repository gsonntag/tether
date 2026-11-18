// The Files tab's state, apart from React (SPEC §10 Files): folders loaded so far and which are
// open, the rows the tree shows, what the viewer shows for a file, and what Mention puts in the box.

import { isMarkdown, type DirList, type FileEntry, type FileRead } from "../../shared/files";

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
  | { t: "markdown"; text: string; cut: boolean }
  | { t: "text"; text: string; cut: boolean }
  | { t: "image"; src: string }
  | { t: "binary"; size: number }
  | { t: "tooBig"; size: number };

/** What the viewer shows for a file. Images become a data: URL for an <img> (SVG too: never inline). */
export function viewOf(r: FileRead): View {
  switch (r.kind) {
    case "text":
      return { t: isMarkdown(r.path) ? "markdown" : "text", text: r.text, cut: !!r.cut };
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
