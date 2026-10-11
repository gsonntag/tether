// Project files for the transcript's file references: which referenced paths are real project
// files, one file's diff, and a file's contents. Read-only, and never outside the project: a path
// is resolved against the project directory, its real path (symlinks followed) must stay inside,
// and nothing under a .git directory is ever served.

import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync, constants } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { FILE_VIEW_LIMITS, type Checkpoint, type FileContents, type FileDiffResult, type PathCheck } from "../../web/src/shared/protocol";
import { changedPaths, computeDiff, pathTurnStats, root } from "./checkpoint";
import { isSensitive } from "./guard";

const inside = (p: string, dir: string) => p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep);
const hasGitSegment = (rel: string) => rel.split(/[\\/]/).some((s) => s.toLowerCase() === ".git");

/** The project directory with symlinks resolved (the directory itself may be a symlink). */
function realRoot(projectPath: string): string {
  return realpathSync(resolve(projectPath));
}

export interface Resolved {
  /** relative to the project directory, normalized, "/"-separated */
  rel: string;
  /** the real path when the file exists, else the path it would have */
  real: string;
  exists: boolean;
  /** a credential or secrets file by the guard's rules (as named, or what a symlink points at) */
  sensitive: boolean;
}

/**
 * A path from the transcript (relative to the project, or absolute) resolved inside the project,
 * or undefined when it points outside it (lexically or through a symlink), into a .git directory,
 * or at the project directory itself.
 */
export function resolveInProject(projectPath: string, input: string): Resolved | undefined {
  if (typeof input !== "string" || !input || input.length > 4096 || input.includes("\0")) return undefined;
  const root = resolve(projectPath);
  let rootReal: string;
  try {
    rootReal = realRoot(projectPath);
  } catch {
    return undefined;
  }
  const abs = isAbsolute(input) ? resolve(input) : resolve(root, input);
  // An absolute path may be written against either spelling of the project directory.
  const base = inside(abs, root) ? root : inside(abs, rootReal) ? rootReal : undefined;
  if (!base) return undefined;
  const rel = relative(base, abs).split(sep).join("/");
  if (!rel || rel === ".." || rel.startsWith("../") || hasGitSegment(rel)) return undefined;

  // Follow symlinks: the deepest part of the path that exists must really be inside the project.
  const lexical = join(rootReal, rel);
  let probe = lexical;
  while (!exists(probe)) {
    const up = resolve(probe, "..");
    if (up === probe) return undefined;
    probe = up;
  }
  let real: string;
  try {
    real = realpathSync(probe);
  } catch {
    return undefined;
  }
  if (!inside(real, rootReal) || hasGitSegment(relative(rootReal, real))) return undefined;
  const found = probe === lexical;
  const target = found ? real : join(real, relative(probe, lexical));
  return { rel, real: target, exists: found, sensitive: isSensitive(rel) || isSensitive(target) };
}

function exists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Repository-relative spelling of a project-relative path (the project may be a subdirectory). */
function toRepo(top: string, projectPath: string, rel: string): string {
  return relative(realpathSync(top), join(realRoot(projectPath), rel)).split(sep).join("/");
}

/** A transcript checks its references in a few batches as it renders: one snapshot serves them all. */
const changedCache = new Map<string, { at: number; value: Promise<Awaited<ReturnType<typeof changedPaths>>> }>();
function changedCached(projectPath: string, base?: string) {
  const key = `${projectPath}\0${base ?? ""}`;
  const hit = changedCache.get(key);
  if (hit && Date.now() - hit.at < 2000) return hit.value;
  for (const [k, v] of changedCache) if (Date.now() - v.at >= 2000) changedCache.delete(k);
  const value = changedPaths(projectPath, base).catch(() => undefined);
  changedCache.set(key, { at: Date.now(), value });
  return value;
}

/** Paths answered per checkPaths call (the rest are left out); the web app asks in batches of 300. */
export const MAX_CHECK_PATHS = 500;

/**
 * Which of `paths` are files in the project now, or changed since `base` (deleted files too).
 * Keyed by the path as given; paths that are neither (or outside the project) are left out.
 */
export async function checkPaths(projectPath: string, paths: string[], base?: string): Promise<Record<string, PathCheck>> {
  const out: Record<string, PathCheck> = {};
  const unique = [...new Set(paths.slice(0, MAX_CHECK_PATHS * 4).filter((p) => typeof p === "string"))].slice(0, MAX_CHECK_PATHS);
  const resolved = unique.map((p) => [p, resolveInProject(projectPath, p)] as const);
  if (!resolved.some(([, r]) => r)) return out;
  const changed = await changedCached(projectPath, base);
  for (const [input, r] of resolved) {
    if (!r) continue;
    const isFile = r.exists && statSync(r.real, { throwIfNoEntry: false })?.isFile() === true;
    const wasChanged = !!changed && changed.paths.has(toRepo(changed.top, projectPath, r.rel));
    if (isFile || wasChanged) out[input] = { path: r.rel, exists: isFile, changed: wasChanged };
  }
  return out;
}

/** Caps for a single file's diff: looser than the Changes view's, which shows many files. */
const FILE_DIFF_LIMITS = { fileBytes: 512_000, fileLines: 20_000, totalBytes: 512_000 };

/**
 * One file's diff: the whole session (from `base` to the working tree), or the turn that started
 * at `checkpointId`. Also lists every turn that changed it, for the scope switch. A secrets file's
 * lines are left out unless `reveal` (the user asked to see them).
 */
export async function fileDiff(
  projectPath: string,
  path: string,
  base: string | undefined,
  checkpoints: Checkpoint[],
  checkpointId?: string,
  reveal = false,
): Promise<FileDiffResult> {
  const r = resolveInProject(projectPath, path);
  if (!r) throw new Error("That file isn't in this project.");
  const top = await root(projectPath);
  if (!top) throw new Error("This project is not a Git repository.");
  const repoPath = toRepo(top, projectPath, r.rel);
  let from = base;
  let to: string | undefined;
  if (checkpointId) {
    const i = checkpoints.findIndex((c) => c.id === checkpointId);
    if (i < 0) throw new Error("That turn's checkpoint is no longer kept.");
    from = checkpoints[i]!.sha;
    to = checkpoints[i + 1]?.sha;
  }
  const [diff, stats] = await Promise.all([
    computeDiff(projectPath, from, to, { paths: [repoPath], limits: FILE_DIFF_LIMITS }),
    pathTurnStats(
      projectPath,
      checkpoints.map((c) => c.sha),
      repoPath,
    ),
  ]);
  const found = diff.files.find((f) => f.path === repoPath);
  const withheld = r.sensitive && !reveal && !!found?.patch;
  const file = found && withheld ? { ...found, patch: "", truncated: undefined } : found;
  const turns = checkpoints.flatMap((c, index) => {
    const s = stats[index];
    if (!s || (!s.additions && !s.deletions && !s.binary)) return [];
    return [{ checkpoint: c.id, index, label: c.label, ts: c.ts, additions: s.additions, deletions: s.deletions, ...(s.binary ? { binary: true } : {}) }];
  });
  return {
    path: r.rel,
    exists: r.exists && statSync(r.real, { throwIfNoEntry: false })?.isFile() === true,
    base: diff.base,
    ...(file ? { file: { ...file, path: r.rel } } : {}),
    turns,
    ...(r.sensitive ? { sensitive: true } : {}),
    ...(withheld ? { withheld: true } : {}),
  };
}

/** Looks like a binary file: a NUL byte in the first 8 KB. */
const isBinary = (b: Buffer) => b.subarray(0, 8192).includes(0);

/**
 * A project file's contents now, cut at `maxBytes` (at most 1 MB) and 20,000 lines. Binary files
 * come back without content, and so do secrets files unless `reveal` (the user asked to see one).
 */
export function readProjectFile(projectPath: string, path: string, maxBytes: number = FILE_VIEW_LIMITS.bytes, reveal = false): FileContents {
  const r = resolveInProject(projectPath, path);
  if (!r) throw new Error("That file isn't in this project.");
  if (!r.exists) throw new Error("That file no longer exists.");
  // Regular files only, checked before opening: opening a device or a FIFO can do things of its own.
  const before = lstatSync(r.real, { throwIfNoEntry: false });
  if (!before?.isFile()) throw new Error(before ? "That's not a regular file." : "That file no longer exists.");
  if (r.sensitive && !reveal) return { path: r.rel, size: before.size, sensitive: true, withheld: true };
  const cap = Math.max(1, Math.min(Number(maxBytes) || FILE_VIEW_LIMITS.bytes, FILE_VIEW_LIMITS.bytes));
  // O_NOFOLLOW: the real path was checked above; refuse if it was swapped for a symlink since.
  const fd = openSync(r.real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error("That's not a regular file.");
    // O_NOFOLLOW covers only the last part of the path: a directory above it swapped for a symlink
    // between the check and the open would open a file elsewhere. So the file opened must be the
    // one the path names now, checked afresh.
    const again = resolveInProject(projectPath, path);
    const now = again?.exists ? statSync(again.real, { throwIfNoEntry: false }) : undefined;
    if (!now || now.dev !== st.dev || now.ino !== st.ino) throw new Error("That file changed while it was being opened; try again.");
    const flag = r.sensitive ? { sensitive: true } : {};
    const want = Math.min(st.size, cap);
    const buf = Buffer.alloc(want);
    let got = 0;
    while (got < want) {
      const n = readSync(fd, buf, got, want - got, got);
      if (!n) break;
      got += n;
    }
    const data = buf.subarray(0, got);
    if (isBinary(data)) return { path: r.rel, size: st.size, binary: true, ...flag };
    let text = data.toString("utf8");
    let truncated: FileContents["truncated"] = st.size > got ? "bytes" : undefined;
    // A cut in the middle of a multi-byte character decodes as U+FFFD at the end: drop it.
    if (truncated) text = text.replace(/�+$/, "");
    let lines = 0;
    for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) {
      if (++lines >= FILE_VIEW_LIMITS.lines) {
        text = text.slice(0, i + 1);
        truncated = "lines";
        break;
      }
    }
    return { path: r.rel, size: st.size, content: text, ...(truncated ? { truncated } : {}), ...flag };
  } finally {
    closeSync(fd);
  }
}
