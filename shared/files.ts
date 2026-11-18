// The Files tab (SPEC §10 Files): what the runner's files module answers about a session's folder,
// its caps, and the parts both sides use (path checks, the name filter's ranking, image types).
// Paths are always relative to the session's folder, with `/` between names; "" is the folder.

/** One entry of a folder. */
export interface FileEntry {
  name: string;
  /** a symlink is `link`, never what it points to (`to` says) */
  kind: "file" | "dir" | "link" | "other";
  /** a file's size in bytes */
  size?: number;
  /**
   * a link: `file` or `dir` when it points inside the folder (opened as that), `outside` when it
   * points out (listed only, never read through), `broken` when nothing's there or it loops
   */
  to?: "file" | "dir" | "outside" | "broken";
  /** git ignores it (outside a repo: a heavy folder like node_modules). Listed only with `hidden` */
  ignored?: boolean;
  /** its name isn't UTF-8: shown, but it can't be opened */
  badName?: boolean;
}

export interface DirList {
  path: string;
  entries: FileEntry[];
  /** entries past the cap, not listed */
  more?: number;
  /** the folder is in a git repo: .gitignore applies */
  repo: boolean;
}

export type FileRead =
  | {
      path: string;
      size: number;
      kind: "text";
      text: string;
      /** only the first `maxBytes` (head) */
      cut?: boolean;
      /** (head only) not UTF-8, shown with U+FFFD, or cut further to fit (control characters escape to 6 bytes each) */
      lossy?: boolean;
    }
  | { path: string; size: number; kind: "image"; mime: string; /** base64 */ data: string }
  | { path: string; size: number; kind: "binary" }
  | { path: string; size: number; kind: "tooBig" };

export interface FindResult {
  /** best first */
  paths: string[];
  /** there were more matches than listed */
  more: boolean;
  /** the folder had more files than were looked at (a walk's or git's cap, or its time) */
  partial?: boolean;
}

/** How a file differs from HEAD, as the tree marks it (git status). Deleted ones aren't on disk: no row. */
export type ChangeMark = "modified" | "added" | "untracked" | "renamed" | "deleted";

export interface FileChanges {
  /** the folder is in a git repo; outside one there are no marks */
  repo: boolean;
  /** each changed path (relative to the session's folder) and how; a nested repo or untracked folder git won't list into is its folder's path */
  files: Record<string, ChangeMark>;
  /** git said more than CHANGES_MAX paths (or too many bytes): only the first are here */
  cut?: boolean;
}

/** Changed paths fileChanges answers with at most. */
export const CHANGES_MAX = 5000;

/** Files bigger than this aren't loaded (a text file's first this-many bytes can be, by asking). */
export const FILE_VIEW_MAX = 1024 * 1024;
/** Entries one folder lists. */
export const DIR_ENTRIES_MAX = 2000;
/** Matches the filter answers with. */
export const FIND_RESULTS_MAX = 200;
/** Paths the filter looks through. */
export const FIND_FILES_MAX = 50_000;
/** A walk outside a repo stops after this long. */
export const FIND_WALK_MS = 3000;
/** A path's length in characters (well under PATH_MAX). */
export const PATH_MAX = 4096;
/** A file's text answer stays under this many JSON bytes (escapes count), else it's binary. */
export const TEXT_JSON_MAX = 3 * 1024 * 1024;

/** Folders never descended into outside a repo, and listed as ignored. */
export const HEAVY_DIRS = new Set(["node_modules", ".git", ".hg", ".svn", "__pycache__", ".venv", "venv", ".next", ".cache", "target", "dist", "build", ".turbo", ".gradle", "Pods", "DerivedData"]);

/** Images the viewer shows, by extension. SVG shows only as an <img> (never inline: no scripts run). */
export const IMAGE_TYPES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
};
export function imageType(path: string): string | undefined {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? IMAGE_TYPES[name.slice(dot + 1).toLowerCase()] : undefined;
}

export const isMarkdown = (path: string) => /\.(md|markdown|mdx)$/i.test(path);
export const isHidden = (name: string) => name.startsWith(".");

/**
 * The path's names, or why it's refused: a relative path with `/` between names, none of them
 * empty, `.` or `..`, no NUL, not absolute, not over PATH_MAX. "" (or ".") is the folder itself.
 */
export function splitPath(p: unknown): string[] | { error: string } {
  if (typeof p !== "string") return { error: "path is required." };
  if (p.length > PATH_MAX) return { error: "That path is too long." };
  if (p.includes("\0")) return { error: "That path isn't valid." };
  if (p === "" || p === ".") return [];
  if (p.startsWith("/") || p.startsWith("~") || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\")) return { error: "Only paths inside the session's folder." };
  const names = p.replace(/\/+$/, "").split("/");
  if (names.some((n) => n === "" || n === "." || n === "..")) return { error: "Only paths inside the session's folder." };
  return names;
}

/** How well `path` matches the filter (higher is better), or 0. Case-insensitive; the name counts most. */
export function matchScore(path: string, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const p = path.toLowerCase();
  const name = p.slice(p.lastIndexOf("/") + 1);
  // Shorter paths first among equals.
  const tie = Math.max(0, 999 - p.length);
  if (name === q) return 5000 + tie;
  if (name.startsWith(q)) return 4000 + tie;
  if (name.includes(q)) return 3000 + tie;
  if (p.includes(q)) return 2000 + tie;
  // Each word somewhere in the path ("comp pane" finds components/ChangesPane.tsx).
  const words = q.split(/\s+/);
  if (words.length > 1 && words.every((w) => p.includes(w))) return 1500 + tie;
  // The letters in order (cpane → ChangesPane), within the name, then the path.
  const inOrder = (s: string) => {
    let i = 0;
    for (const c of s) if (c === q[i]) i++;
    return i === q.length;
  };
  if (q.length > 1 && !q.includes(" ")) {
    if (inOrder(name)) return 1000 + tie;
    if (inOrder(p)) return 500 + tie;
  }
  return 0;
}

/** The best `max` matches of `query` among `paths`; `more` when others matched too. */
export function rankMatches(paths: Iterable<string>, query: string, max = FIND_RESULTS_MAX): { paths: string[]; more: boolean } {
  const hits: { p: string; s: number }[] = [];
  for (const p of paths) {
    const s = matchScore(p, query);
    if (s) hits.push({ p, s });
  }
  hits.sort((a, b) => b.s - a.s || (a.p < b.p ? -1 : a.p > b.p ? 1 : 0));
  return { paths: hits.slice(0, max).map((h) => h.p), more: hits.length > max };
}

/** What Mention puts in the composer: `@path`, `@"path"` when it has spaces (and no `"`, which can't be quoted). */
export const mentionOf = (path: string) => (/\s/.test(path) && !path.includes('"') ? `@"${path}"` : `@${path}`);

/** "12 KB" */
export function sizeLabel(n: number): string {
  if (n < 1024) return `${n} byte${n === 1 ? "" : "s"}`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
