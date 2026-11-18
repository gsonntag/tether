// The Changes pane's diff (SPEC §10 Changes): what the runner's git module sends for a session's
// folder, and the pure parsing of git's output into it. The runner runs git; this reads what git
// printed. Nothing here touches a repo.
//
// Scopes: `uncommitted` is the working tree and index against HEAD, untracked files included;
// `branch` is everything since the merge base with the default branch, committed or not; `turn` is
// what one turn changed, between its checkpoints (shared/checkpoints.ts), or from its start to the
// working tree while it runs.

export type DiffScope = "uncommitted" | "branch" | "turn";
export const DIFF_SCOPES: readonly { id: DiffScope; label: string }[] = [
  { id: "uncommitted", label: "Uncommitted" },
  { id: "branch", label: "Branch" },
  { id: "turn", label: "Turn" },
];
export const isDiffScope = (v: unknown): v is DiffScope => v === "uncommitted" || v === "branch" || v === "turn";

export type FileStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "typechange" | "untracked";

/** One hunk: `lines` are git's own, each starting with " ", "+", "-" or "\" (no newline at end of file). */
export interface DiffHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

export interface DiffFile {
  /** from the repo's root; for a deleted file, the path it had */
  path: string;
  /** renamed or copied from */
  oldPath?: string;
  status: FileStatus;
  added: number;
  removed: number;
  binary?: true;
  /** no hunks: the file alone is over the caps, or the diff as a whole is ("total") */
  tooLarge?: "file" | "total";
  /** none when binary or too large */
  hunks?: DiffHunk[];
}

export interface GitDiff {
  scope: DiffScope;
  /** `notRepo`: the folder isn't in a git repo. `noBase`: the branch scope has no default branch to compare with, the turn scope no such checkpoint */
  state: "ok" | "notRepo" | "noBase";
  /** the turn scope: the checkpoint shown */
  checkpoint?: string;
  /** the repo's top folder */
  root?: string;
  /** the checked-out branch; none when detached or not a repo */
  branch?: string;
  /** what `branch` compares with, e.g. "origin/main"; the turn scope: which pair, e.g. "turn 3: before → after" */
  base?: string;
  files: DiffFile[];
  /** files left out past DIFF_FILES_MAX */
  more?: number;
  added: number;
  removed: number;
}

/** A file with more changed lines than this shows its counts only. */
export const DIFF_FILE_LINES_MAX = 3000;
/** Nor a file whose hunks come to more than this (UTF-16 code units, near enough bytes). */
export const DIFF_FILE_BYTES_MAX = 512 * 1024;
/** Hunks across all files: past this, the rest show their counts only (well inside a frame). */
export const DIFF_TOTAL_BYTES_MAX = 1536 * 1024;
/** Files listed at most. */
export const DIFF_FILES_MAX = 1000;

// ---------- git's quoting ----------

/** A path as git prints it: C-quoted ("a\tb", octal bytes) when it has unusual characters. */
export function unquote(s: string): string {
  if (!s.startsWith('"') || !s.endsWith('"') || s.length < 2) return s;
  const bytes: number[] = [];
  const enc = new TextEncoder();
  const ESC: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };
  for (let i = 1; i < s.length - 1; i++) {
    const c = s[i]!;
    if (c !== "\\") {
      bytes.push(...enc.encode(c));
      continue;
    }
    const n = s[++i]!;
    if (/[0-7]/.test(n)) {
      bytes.push(parseInt(s.slice(i, i + 3), 8));
      i += 2;
    } else bytes.push(ESC[n] ?? n.charCodeAt(0));
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

// ---------- name-status and numstat (-z) ----------

const STATUS: Record<string, FileStatus> = { A: "added", M: "modified", D: "deleted", R: "renamed", C: "copied", T: "typechange" };

/** `git diff --name-status -z`: each file's status and paths, in git's order. */
export function parseNameStatus(out: string): Pick<DiffFile, "path" | "oldPath" | "status">[] {
  const t = out.split("\0");
  const files: Pick<DiffFile, "path" | "oldPath" | "status">[] = [];
  for (let i = 0; i < t.length; ) {
    const code = t[i++];
    if (!code) continue;
    const status = STATUS[code[0]!] ?? "modified";
    if (status === "renamed" || status === "copied") {
      const oldPath = t[i++]!;
      files.push({ path: t[i++]!, oldPath, status });
    } else files.push({ path: t[i++]!, status });
  }
  return files;
}

/** `git diff --numstat -z`: lines added and removed per (new) path; binary files have "-". */
export function parseNumstat(out: string): Map<string, { added: number; removed: number; binary: boolean }> {
  const t = out.split("\0");
  const m = new Map<string, { added: number; removed: number; binary: boolean }>();
  for (let i = 0; i < t.length; ) {
    const rec = t[i++];
    if (!rec) continue;
    const [a, r, p] = rec.split("\t");
    // A rename: the paths follow as their own fields, old then new.
    const path = p ? p : (i++, t[i++]!);
    m.set(path, { added: a === "-" ? 0 : Number(a) || 0, removed: r === "-" ? 0 : Number(r) || 0, binary: a === "-" });
  }
  return m;
}

// ---------- unified patches ----------

export interface PatchFile {
  path: string;
  oldPath?: string;
  status: FileStatus;
  added: number;
  removed: number;
  binary: boolean;
  hunks: DiffHunk[];
  /** the hunks' text length */
  size: number;
  /** cut off where the output ended */
  partial: boolean;
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** "a/P" from a `diff --git a/P b/P` line, when the path is the same on both sides (prefix not stripped yet) */
function gitLinePath(rest: string): string | undefined {
  if (rest.startsWith('"')) {
    const end = rest.indexOf('" ');
    return end > 0 ? unquote(rest.slice(0, end + 1)) : undefined;
  }
  // "a/P b/P": P is half of what's left once the prefixes and the space are taken out.
  const n = (rest.length - 5) / 2;
  return Number.isInteger(n) && n > 0 ? rest.slice(0, 2 + n) : undefined;
}

const strip = (p: string, prefix: string) => (p.startsWith(prefix) ? p.slice(prefix.length) : p);

/**
 * `git diff -p` (prefixes a/ and b/) as files with their hunks. Lines are counted from the hunks.
 * A hunk's end is found by its counts, so content that looks like a header stays content. Output
 * that was cut short marks its last file `partial`.
 */
export function parsePatch(out: string): PatchFile[] {
  const lines = out.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const files: PatchFile[] = [];
  let f: PatchFile | undefined;
  let hunk: DiffHunk | undefined;
  let oldLeft = 0;
  let newLeft = 0;
  let minus: string | undefined;
  let plus: string | undefined;
  let named = false;
  const finish = () => {
    if (!f) return;
    if (!named) {
      const p = plus && plus !== "/dev/null" ? strip(plus, "b/") : minus && minus !== "/dev/null" ? strip(minus, "a/") : undefined;
      if (p) f.path = p;
    }
    if (hunk && (oldLeft > 0 || newLeft > 0)) f.partial = true;
    files.push(f);
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (hunk && (oldLeft > 0 || newLeft > 0 || l.startsWith("\\"))) {
      const op = l[0] ?? " ";
      if (op === "\\") {
        hunk.lines.push(l);
        f!.size += l.length + 1;
        continue;
      }
      if (op === "+") (newLeft--, f!.added++);
      else if (op === "-") (oldLeft--, f!.removed++);
      else (oldLeft--, newLeft--);
      const line = l === "" ? " " : l;
      hunk.lines.push(line);
      f!.size += line.length + 1;
      continue;
    }
    hunk = undefined;
    if (l.startsWith("diff --git ")) {
      finish();
      f = { path: gitLinePath(l.slice(11)) ?? "", status: "modified", added: 0, removed: 0, binary: false, hunks: [], size: 0, partial: false };
      f.path = strip(f.path, "a/");
      minus = plus = undefined;
      named = false;
      continue;
    }
    if (!f) continue;
    const m = HUNK.exec(l);
    if (m) {
      hunk = { header: l, oldStart: +m[1]!, oldLines: m[2] === undefined ? 1 : +m[2], newStart: +m[3]!, newLines: m[4] === undefined ? 1 : +m[4], lines: [] };
      oldLeft = hunk.oldLines;
      newLeft = hunk.newLines;
      f.hunks.push(hunk);
      f.size += l.length + 1;
    } else if (l.startsWith("--- ")) minus = unquote(l.slice(4));
    else if (l.startsWith("+++ ")) plus = unquote(l.slice(4));
    else if (l.startsWith("new file mode")) f.status = "added";
    else if (l.startsWith("deleted file mode")) f.status = "deleted";
    else if (l.startsWith("rename from ") || l.startsWith("copy from ")) {
      f.oldPath = unquote(l.slice(l.indexOf(" from ") + 6));
      f.status = l.startsWith("rename") ? "renamed" : "copied";
    } else if (l.startsWith("rename to ") || l.startsWith("copy to ")) {
      f.path = unquote(l.slice(l.indexOf(" to ") + 4));
      named = true;
    } else if (l.startsWith("Binary files ") || l === "GIT binary patch") f.binary = true;
  }
  finish();
  return files;
}

// ---------- reading a hunk ----------

export interface NumberedLine {
  op: " " | "+" | "-" | "\\";
  text: string;
  /** line number in the old file (context and removed lines) */
  old?: number;
  /** line number in the new file (context and added lines) */
  new?: number;
}

/** A hunk's lines with their old and new line numbers. */
export function numberLines(h: DiffHunk): NumberedLine[] {
  let o = h.oldStart;
  let n = h.newStart;
  return h.lines.map((l) => {
    const op = (l[0] ?? " ") as NumberedLine["op"];
    const text = l.slice(1);
    if (op === "+") return { op, text, new: n++ };
    if (op === "-") return { op, text, old: o++ };
    if (op === "\\") return { op, text: l.slice(2) };
    return { op: " ", text, old: o++, new: n++ };
  });
}
