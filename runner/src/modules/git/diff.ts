// A session folder's changes for the Changes pane (SPEC §10 Changes), from git, read-only: `git diff`
// against a base for tracked files, `git ls-files --others --exclude-standard` for untracked ones
// (each diffed against /dev/null with --no-index). Never `git add -N`, a stash or anything that
// writes. Capped per file and overall (shared/gitDiff.ts): what's over shows its counts only.
//
// `diffRange` is the general part: the working tree (or a commit) against a base. Scopes are bases:
// HEAD, the merge base with the default branch; a turn's checkpoints would be two commits.

import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import {
  DIFF_FILE_BYTES_MAX,
  DIFF_FILE_LINES_MAX,
  DIFF_FILES_MAX,
  DIFF_TOTAL_BYTES_MAX,
  parseNameStatus,
  parseNumstat,
  parsePatch,
  type DiffFile,
  type DiffScope,
  type GitDiff,
} from "../../../../shared/gitDiff";
import { git, GitError } from "./run";

/** Flags every diff gets, so the repo's config can't change what we parse. */
const DIFF = ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-relative", "-M", "--src-prefix=a/", "--dst-prefix=b/"];

/** A pathspec that means exactly this path (no globbing, no magic). */
const literal = (p: string) => `:(literal)${p}`;

/** The repo's top folder, or undefined when `cwd` isn't in one. */
export async function repoRoot(cwd: string): Promise<string | undefined> {
  try {
    return (await git(cwd, ["rev-parse", "--show-toplevel"])).out.trim() || undefined;
  } catch (e) {
    if (e instanceof GitError && /not a git repository/i.test(e.stderr)) return undefined;
    throw e;
  }
}

const verify = async (root: string, ref: string) => {
  try {
    return (await git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).out.trim() || undefined;
  } catch {
    return undefined;
  }
};

/** The checked-out branch; undefined when detached. */
export async function currentBranch(root: string): Promise<string | undefined> {
  const r = await git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], { ok: [0, 1, 128] });
  return r.code === 0 ? r.out.trim() || undefined : undefined;
}

/** The default branch to compare with: origin's HEAD, else main or master (local, then origin's). */
export async function defaultBranch(root: string): Promise<string | undefined> {
  const head = await git(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], { ok: [0, 1, 128] });
  const o = head.code === 0 ? head.out.trim() : "";
  if (o && (await verify(root, o))) return o;
  for (const r of ["main", "master", "origin/main", "origin/master"]) if (await verify(root, r)) return r;
  return undefined;
}

/** HEAD's commit, or the empty tree in a repo with no commits yet. */
async function headOrEmpty(root: string): Promise<string> {
  return (await verify(root, "HEAD")) ?? (await git(root, ["hash-object", "-t", "tree", "/dev/null"])).out.trim();
}

/** Lines in a file and whether it looks binary (a NUL in its first 8000 bytes, as git decides). */
async function countLines(path: string, cap = 64 * 1024 * 1024): Promise<{ lines: number; binary: boolean }> {
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(64 * 1024);
    let lines = 0;
    let read = 0;
    let last = 10;
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, null);
      if (!bytesRead) break;
      if (read === 0 && buf.subarray(0, Math.min(bytesRead, 8000)).includes(0)) return { lines: 0, binary: true };
      for (let i = 0; i < bytesRead; i++) if (buf[i] === 10) lines++;
      last = buf[bytesRead - 1]!;
      read += bytesRead;
      if (read >= cap) break;
    }
    return { lines: read && last !== 10 ? lines + 1 : lines, binary: false };
  } finally {
    await fh.close();
  }
}

/** Runs `f` over `items`, `n` at a time. */
async function pool<T>(items: T[], n: number, f: (t: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await f(items[i++]!);
  }));
}

export interface RangeOpts {
  /** a commit to compare with instead of the working tree */
  to?: string;
  /** include untracked files (only against the working tree) */
  untracked?: boolean;
  /** the caps (tests make them small) */
  caps?: Partial<Caps>;
}

export interface Caps {
  fileLines: number;
  fileBytes: number;
  totalBytes: number;
  files: number;
}
const CAPS: Caps = { fileLines: DIFF_FILE_LINES_MAX, fileBytes: DIFF_FILE_BYTES_MAX, totalBytes: DIFF_TOTAL_BYTES_MAX, files: DIFF_FILES_MAX };

/**
 * The changes from `base` to the working tree (or `to`): files sorted by path, hunks within the
 * caps. `root` is the repo's top folder.
 */
export async function diffRange(root: string, base: string, opts: RangeOpts = {}): Promise<Pick<GitDiff, "files" | "more" | "added" | "removed">> {
  const cap = { ...CAPS, ...opts.caps };
  const range = opts.to ? [base, opts.to] : [base];
  const [names, nums] = await Promise.all([git(root, [...DIFF, "--name-status", "-z", ...range]), git(root, [...DIFF, "--numstat", "-z", ...range])]);
  const counts = parseNumstat(nums.out);
  let files: DiffFile[] = parseNameStatus(names.out).map((f) => {
    const c = counts.get(f.path);
    return { ...f, added: c?.added ?? 0, removed: c?.removed ?? 0, ...(c?.binary ? { binary: true as const } : {}) };
  });
  const untracked = opts.untracked && !opts.to ? (await git(root, ["ls-files", "--others", "--exclude-standard", "-z"])).out.split("\0").filter((p) => p && !p.endsWith("/")) : [];
  const all = files.length + untracked.length;
  const room = Math.max(0, cap.files - files.length);
  files = files.slice(0, cap.files);
  const extra: DiffFile[] = untracked.slice(0, room).map((path) => ({ path, status: "untracked", added: 0, removed: 0 }));
  const more = all - files.length - extra.length;

  let budget = cap.totalBytes;

  // Tracked: one patch for every file under the per-file line cap, stopped once it's past the budget.
  const wanted = files.filter((f) => !f.binary && f.added + f.removed > 0 && f.added + f.removed <= cap.fileLines);
  for (const f of files) if (!f.binary && f.added + f.removed > cap.fileLines) f.tooLarge = "file";
  if (wanted.length) {
    const specs = wanted.flatMap((f) => (f.oldPath ? [f.oldPath, f.path] : [f.path])).map(literal);
    const patch = await git(root, [...DIFF, "-p", ...range, "--", ...specs], { maxBytes: cap.totalBytes * 2 });
    const byPath = new Map(parsePatch(patch.out).map((p) => [p.path, p]));
    for (const f of wanted) {
      const p = byPath.get(f.path);
      if (!p || p.partial) f.tooLarge = "total";
      else if (p.size > cap.fileBytes) f.tooLarge = "file";
      else if (p.size > budget) f.tooLarge = "total";
      else {
        budget -= p.size;
        f.hunks = p.hunks;
      }
    }
  }

  // Untracked: counted here, each diffed against /dev/null while the budget lasts.
  await pool(extra, 8, async (f) => {
    const abs = join(root, f.path);
    try {
      const st = await lstat(abs);
      if (st.isSymbolicLink()) f.added = 1;
      else if (!st.isFile()) return;
      else {
        const c = await countLines(abs);
        f.added = c.lines;
        if (c.binary) return void (f.binary = true);
        if (st.size > cap.fileBytes || f.added > cap.fileLines) return void (f.tooLarge = "file");
      }
    } catch {
      return; // gone since it was listed
    }
    if (!f.added) return;
    if (budget <= 0) return void (f.tooLarge = "total");
    const r = await git(root, [...DIFF, "--no-index", "-p", "--", "/dev/null", f.path], { ok: [0, 1], maxBytes: cap.fileBytes * 2 });
    const p = parsePatch(r.out)[0];
    if (!p) return;
    if (p.binary) return void (f.binary = true);
    f.added = p.added;
    if (r.cut || p.partial || p.size > cap.fileBytes) return void (f.tooLarge = "file");
    if (p.size > budget) return void (f.tooLarge = "total");
    budget -= p.size;
    f.hunks = p.hunks;
  });

  const out = [...files, ...extra].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    files: out,
    ...(more > 0 ? { more } : {}),
    added: out.reduce((n, f) => n + f.added, 0),
    removed: out.reduce((n, f) => n + f.removed, 0),
  };
}

/** A folder's changes in one of the pane's scopes. */
export async function gitDiff(cwd: string, scope: DiffScope, caps?: Partial<Caps>): Promise<GitDiff> {
  const root = await repoRoot(cwd);
  if (!root) return { scope, state: "notRepo", files: [], added: 0, removed: 0 };
  const branch = await currentBranch(root);
  const where = { root, ...(branch ? { branch } : {}) };
  if (scope === "uncommitted") {
    return { scope, state: "ok", ...where, base: "HEAD", ...(await diffRange(root, await headOrEmpty(root), { untracked: true, caps })) };
  }
  const def = await defaultBranch(root);
  const mb = def && (await verify(root, "HEAD")) ? (await git(root, ["merge-base", "HEAD", def], { ok: [0, 1] })).out.trim() : def ? await headOrEmpty(root) : "";
  if (!def || !mb) return { scope, state: "noBase", ...where, ...(def ? { base: def } : {}), files: [], added: 0, removed: 0 };
  return { scope, state: "ok", ...where, base: def, ...(await diffRange(root, mb, { untracked: true, caps })) };
}
