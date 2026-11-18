// A session folder's changes for the Changes pane (SPEC §10 Changes), from git, read-only: `git diff`
// against a base for tracked files, `git ls-files --others --exclude-standard` for untracked ones
// (each diffed against /dev/null with --no-index). Never `git add -N`, a stash or anything that
// writes. Capped per file and overall (shared/gitDiff.ts): what's over shows its counts only.
//
// `diffRange` is the general part: the working tree (or a commit) against a base. Scopes are bases:
// HEAD, the merge base with the default branch; a turn's checkpoints are two commits (../checkpoints).

import { lstat, open, readlink } from "node:fs/promises";
import { join } from "node:path";
import {
  DIFF_FILE_BYTES_MAX,
  DIFF_FILE_LINES_MAX,
  DIFF_FILES_MAX,
  DIFF_TOTAL_BYTES_MAX,
  isBadPath,
  parseNameStatus,
  parseNumstat,
  parsePatch,
  type DiffFile,
  type DiffScope,
  type GitDiff,
  type PatchFile,
} from "../../../../shared/gitDiff";
import { RESTORE_TMP_EXCLUDE } from "../../../../shared/checkpoints";
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
  /** per file, in JSON bytes */
  fileBytes: number;
  /** all hunks, in JSON bytes */
  totalBytes: number;
  files: number;
  /** for the whole diff: files not reached by then show their counts only */
  timeMs: number;
}
const CAPS: Caps = { fileLines: DIFF_FILE_LINES_MAX, fileBytes: DIFF_FILE_BYTES_MAX, totalBytes: DIFF_TOTAL_BYTES_MAX, files: DIFF_FILES_MAX, timeMs: 30_000 };

/** Files whose patches are asked for in one git call. */
const BATCH = 40;

const byPathThenStatus = (a: DiffFile, b: DiffFile) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.status < b.status ? -1 : a.status > b.status ? 1 : 0);

class OutOfTime extends Error {}

/**
 * The changes from `base` to the working tree (or `to`): files sorted by path, hunks within the
 * caps. `root` is the repo's top folder. Hunks fill the budget in path order, so the same changes
 * always show the same files; a file too big on its own is only that file's loss.
 */
export async function diffRange(root: string, base: string, opts: RangeOpts = {}): Promise<Pick<GitDiff, "files" | "more" | "added" | "removed" | "timedOut">> {
  const cap = { ...CAPS, ...opts.caps };
  const deadline = Date.now() + cap.timeMs;
  const left = () => {
    const ms = deadline - Date.now();
    if (ms <= 0) throw new OutOfTime();
    return ms;
  };
  const range = opts.to ? [base, opts.to] : [base];
  const [names, nums] = await Promise.all([git(root, [...DIFF, "--name-status", "-z", ...range]), git(root, [...DIFF, "--numstat", "-z", ...range])]);
  const counts = parseNumstat(nums.out);
  const tracked: DiffFile[] = parseNameStatus(names.out).map((f) => {
    const c = counts.get(f.path);
    return { ...f, added: c?.added ?? 0, removed: c?.removed ?? 0, ...(c?.binary ? { binary: true as const } : {}) };
  });
  const untracked: DiffFile[] =
    opts.untracked && !opts.to
      ? (await git(root, ["ls-files", "--others", "--exclude-standard", "-z", "--", ".", RESTORE_TMP_EXCLUDE])).out
          .split("\0")
          .filter((p) => p && !p.endsWith("/"))
          .map((path) => ({ path, status: "untracked", added: 0, removed: 0 }))
      : [];
  const sorted = [...tracked, ...untracked].sort(byPathThenStatus);
  const files = sorted.slice(0, cap.files);
  const more = sorted.length - files.length;
  for (const f of files) if (isBadPath(f.path) || (f.oldPath && isBadPath(f.oldPath))) f.badPath = true;

  let timedOut = false;
  // Untracked files are counted (and binary ones found) first, within the time limit.
  await pool(
    files.filter((f) => f.status === "untracked" && !f.badPath),
    8,
    async (f) => {
      if (Date.now() >= deadline) {
        timedOut = true;
        return void (f.tooLarge = "total");
      }
      try {
        const st = await lstat(join(root, f.path));
        if (st.isSymbolicLink()) {
          f.added = 1;
          f.symlink = await readlink(join(root, f.path));
        } else if (!st.isFile()) return;
        else {
          const c = await countLines(join(root, f.path));
          f.added = c.lines;
          if (c.binary) f.binary = true;
          else if (st.size > cap.fileBytes) f.tooLarge = "file";
        }
      } catch {} // gone since it was listed
    },
  );
  for (const f of files) if (!f.binary && !f.tooLarge && f.added + f.removed > cap.fileLines) f.tooLarge = "file";
  const wanted = files.filter((f) => !f.badPath && !f.binary && !f.tooLarge && !f.symlink && f.added + f.removed > 0);

  /** a tracked file's patch on its own, cut at its cap */
  const one = async (f: DiffFile) => {
    const specs = (f.oldPath ? [f.oldPath, f.path] : [f.path]).map(literal);
    const r = await git(root, [...DIFF, "-p", ...range, "--", ...specs], { maxBytes: cap.fileBytes * 2, timeoutMs: left() });
    const p = parsePatch(r.out).find((p) => p.path === f.path);
    return p && !p.partial && !r.cut ? p : r.cut || p ? undefined : null;
  };
  /** an untracked file against /dev/null ("./" so a file named "-" isn't stdin) */
  const fresh = async (f: DiffFile) => {
    const r = await git(root, [...DIFF, "--no-index", "-p", "--", "/dev/null", `./${f.path}`], { ok: [0, 1], maxBytes: cap.fileBytes * 2, timeoutMs: left() });
    const p = parsePatch(r.out)[0];
    return p && !r.cut ? p : undefined;
  };

  let budget = cap.totalBytes;
  for (let i = 0; i < wanted.length; i += BATCH) {
    const chunk = wanted.slice(i, i + BATCH);
    if (budget <= 0 || timedOut) {
      for (const f of chunk) f.tooLarge = "total";
      continue;
    }
    /** each file's patch: undefined when it's over its own cap, null when git had nothing */
    const got = new Map<DiffFile, PatchFile | undefined | null>();
    try {
      const old = chunk.filter((f) => f.status !== "untracked");
      if (old.length) {
        const specs = old.flatMap((f) => (f.oldPath ? [f.oldPath, f.path] : [f.path])).map(literal);
        const r = await git(root, [...DIFF, "-p", ...range, "--", ...specs], { maxBytes: cap.fileBytes * 4, timeoutMs: left() });
        const patches = parsePatch(r.out);
        // Output cut short ends inside its last file, maybe mid-line: that one isn't whole.
        if (r.cut && patches.length) patches.at(-1)!.partial = true;
        const parsed = new Map(patches.map((p) => [p.path, p]));
        for (const f of old) {
          const p = parsed.get(f.path);
          // Cut short: whatever wasn't whole is asked for again on its own, with its own cap.
          if (p && !p.partial) got.set(f, p);
          else if (!r.cut) got.set(f, null);
        }
        for (const f of old) {
          if (got.has(f)) continue;
          // Asked again only while the budget lasts: what's left over shows its counts.
          const spent = [...got.values()].reduce((n, p) => n + (p ? p.size : 0), 0);
          if (spent >= budget) break;
          got.set(f, await one(f));
        }
      }
      await pool(
        chunk.filter((f) => f.status === "untracked"),
        8,
        async (f) => void got.set(f, await fresh(f)),
      );
    } catch (e) {
      if (!(e instanceof OutOfTime) && !(e instanceof GitError && /too long/.test(e.message))) throw e;
      timedOut = true;
    }
    for (const f of chunk) {
      const p = got.get(f);
      if (p === null) continue;
      if (p === undefined) {
        f.tooLarge = got.has(f) ? "file" : "total";
        continue;
      }
      if (p.binary) {
        f.binary = true;
        continue;
      }
      if (f.status === "untracked") f.added = p.added;
      if (p.partial || p.size > cap.fileBytes) f.tooLarge = "file";
      else if (p.size > budget) {
        f.tooLarge = "total";
        budget = 0;
      } else if (budget > 0) {
        budget -= p.size;
        f.hunks = p.hunks;
      } else f.tooLarge = "total";
    }
  }

  return {
    files,
    ...(more > 0 ? { more } : {}),
    ...(timedOut ? { timedOut: true as const } : {}),
    added: files.reduce((n, f) => n + f.added, 0),
    removed: files.reduce((n, f) => n + f.removed, 0),
  };
}

/** A folder's changes in one of the pane's scopes. */
export async function gitDiff(cwd: string, scope: Exclude<DiffScope, "turn">, caps?: Partial<Caps>): Promise<GitDiff> {
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
