// Snapshots and restores for turn checkpoints (SPEC §10 Checkpoints), in git, without touching the
// repo's own index, HEAD, stash or branches:
//
// - snapshot: the working tree as a tree object. A temporary index file (GIT_INDEX_FILE) seeded with
//   a copy of the real index, its mtime kept (its stat cache keeps `add` quick and racy entries stay
//   racy; sparse checkout's skip-worktree entries stay as they are; HEAD's tree when there's no
//   index), `add -A` into it (tracked and untracked files, never ignored ones), `write-tree`. Untracked
//   files over CHECKPOINT_FILE_BYTES_MAX or unreadable are left out and listed (`left`); past the
//   listing cap no untracked file is taken (`noUntracked`). Blobs and trees land in the object store,
//   as `git add` would put them.
// - commit + ref: `commit-tree` with a fixed identity and date (works without user.name; the same
//   tree and parent give the same commit), `update-ref` under refs/tether/checkpoints/.
// - restore: a snapshot of the files as they are (the undo), then every path that differs from the
//   target forced into that snapshot exactly as it is on disk (whatever the size, ignore rules or
//   index bits say; gone when it's gone), so the undo puts back byte for byte whatever the restore
//   touches. A path that can't be read into it is left alone, and so are: paths the target left out
//   (or every untracked path, when it took none), files the target's ignore rules ignore, nested
//   repositories and anything in them, a folder in the way of a file, a path under a symlink. Each
//   is reported. Then removals, and writes with `checkout-index` from a temporary index holding the
//   target. The real index and HEAD are never touched.
//
// Filters: `add` runs the clean filters the person's git config defines for paths .gitattributes
// names (git-lfs stores its object and puts the pointer in the snapshot), and checkout-index the
// smudge ones, exactly as `git add` and `git checkout` would. The commands come from config, never
// from the repo's files; the time limit bounds them. Hooks and fsmonitor never run (run.ts).

import { access, constants, copyFile, lstat, mkdir, readdir, readlink, rm, rmdir, stat, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, join, sep } from "node:path";
import { CHECKPOINT_FILE_BYTES_MAX, type Skipped } from "../../../../shared/checkpoints";
import { git, GitError } from "../git/run";

/** Snapshot steps get longer than reads: `add` hashes every changed file. */
export const SNAP_TIMEOUT_MS = 60_000;
/** Each step of a restore (forcing paths into its undo, writing files): it holds sessions meanwhile. */
const FORCE_TIMEOUT_MS = 60_000;
/** Untracked paths a snapshot may leave out; past it, it takes no untracked file. */
export const LEFT_MAX = 2000;
/** Of those, the ones a checkpoint keeps (with their count): past them, a restore to it removes no untracked file. */
export const LEFT_KEPT = 200;
/** `ls-files --others` output read at most; past it untracked files aren't taken. */
const OTHERS_BYTES_MAX = 16 * 1024 * 1024;

const IDENTITY = {
  GIT_AUTHOR_NAME: "Tether",
  GIT_AUTHOR_EMAIL: "tether@localhost",
  GIT_COMMITTER_NAME: "Tether",
  GIT_COMMITTER_EMAIL: "tether@localhost",
  GIT_AUTHOR_DATE: "1700000000 +0000",
  GIT_COMMITTER_DATE: "1700000000 +0000",
};

/** For commands on a temporary index: no split index or maintenance written beside the real one. */
const SAFE = ["-c", "core.splitIndex=false", "-c", "gc.auto=0", "-c", "maintenance.auto=false"];

const ZERO = "0000000000000000000000000000000000000000";

/** A snapshot: its tree, and what it didn't take. */
export interface Snap {
  tree: string;
  /** untracked paths left out (too big, unreadable), the first LEFT_KEPT */
  left?: string[];
  /** how many were left out */
  leftCount?: number;
  /** paths held as raw bytes, no filters or line-ending conversion (a restore's undo): written back as such */
  raw?: string[];
  /** no untracked file was taken (too many to list, or `left` past LEFT_MAX) */
  noUntracked?: true;
}

/** A temporary index file in `tmpDir`, removed after `f`. */
async function withIndex<T>(tmpDir: string, f: (env: Record<string, string>, path: string) => Promise<T>): Promise<T> {
  const path = join(tmpDir, `index-${randomBytes(6).toString("hex")}`);
  try {
    return await f({ GIT_INDEX_FILE: path, ...IDENTITY }, path);
  } finally {
    await rm(path, { force: true });
    await rm(`${path}.lock`, { force: true });
  }
}

async function headCommit(root: string): Promise<string | undefined> {
  const r = await git(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], { ok: [0, 1, 128] });
  return r.code === 0 ? r.out.trim() || undefined : undefined;
}

/** Fills the temporary index at `path` with the working tree; what it left out. */
async function snapInto(root: string, env: Record<string, string>, path: string): Promise<Omit<Snap, "tree">> {
  const o = { env, timeoutMs: SNAP_TIMEOUT_MS };
  const real = (await git(root, ["rev-parse", "--path-format=absolute", "--git-path", "index"])).out.trim();
  let seeded = false;
  try {
    await copyFile(real, path);
    // The real index's own mtime: entries written in the same second as it stay "racy", so a
    // same-size edit right after `git add` is hashed again rather than taken as unchanged.
    const st = await stat(real);
    await utimes(path, st.atime, st.mtime);
    seeded = true;
  } catch {}
  if (!seeded) {
    await rm(path, { force: true });
    const head = await headCommit(root);
    if (head) await git(root, [...SAFE, "read-tree", head], o);
  }
  const others = await git(root, ["ls-files", "--others", "--exclude-standard", "-z"], { ...o, maxBytes: OTHERS_BYTES_MAX });
  if (others.cut) {
    await git(root, [...SAFE, "add", "-u", "--ignore-errors", "--", "."], { ...o, ok: [0, 1] });
    return { noUntracked: true };
  }
  // Untracked files too big to keep or unreadable: left out, and listed so a restore never removes them.
  const left: string[] = [];
  for (const p of others.out.split("\0").filter(Boolean)) {
    try {
      const st = await lstat(join(root, p));
      if (st.size > CHECKPOINT_FILE_BYTES_MAX || (st.isFile() && !(await access(join(root, p), constants.R_OK).then(() => true, () => false)))) left.push(p);
    } catch {}
  }
  if (left.length > LEFT_MAX) {
    await git(root, [...SAFE, "add", "-u", "--ignore-errors", "--", "."], { ...o, ok: [0, 1] });
    return { noUntracked: true };
  }
  await git(root, [...SAFE, "add", "-A", "--ignore-errors", "--", ".", ...left.map((p) => `:(exclude,literal)${p}`)], { ...o, ok: [0, 1] });
  return left.length ? { left: left.slice(0, LEFT_KEPT), leftCount: left.length } : {};
}

/** The working tree of the repo at `root` as a tree. Changes nothing but the object store. */
export async function snapshot(root: string, tmpDir: string): Promise<Snap> {
  return withIndex(tmpDir, async (env, path) => {
    const rest = await snapInto(root, env, path);
    return { tree: (await git(root, [...SAFE, "write-tree"], { env })).out.trim(), ...rest };
  });
}

/** A commit of `tree` (on `parent`), the same id for the same tree and parent. */
export async function commitTree(root: string, tree: string, message: string, parent?: string): Promise<string> {
  return (await git(root, ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", message], { env: IDENTITY })).out.trim();
}

/** A commit's tree, or undefined when it's gone. */
export async function treeOf(root: string, commit: string): Promise<string | undefined> {
  const r = await git(root, ["rev-parse", "--verify", "--quiet", `${commit}^{tree}`], { ok: [0, 1, 128] });
  return r.code === 0 ? r.out.trim() || undefined : undefined;
}

/** Sets and deletes refs in one transaction. */
export async function updateRefs(root: string, set: Record<string, string>, del: string[] = []): Promise<void> {
  const lines = [...Object.entries(set).map(([r, c]) => `update ${r} ${c}`), ...del.map((r) => `delete ${r}`)];
  if (lines.length) await git(root, ["update-ref", "--no-deref", "--stdin"], { input: lines.join("\n") + "\n" });
}

/** Files that differ between two trees (nested repositories aside). */
export async function changedFiles(root: string, a: string, b: string): Promise<number> {
  return (await treeDiff(root, a, b)).filter((c) => !c.gitlink).length;
}

interface Change {
  path: string;
  /** in `a`, not in `b` */
  gone: boolean;
  /** a nested repository (a gitlink) on either side */
  gitlink: boolean;
}

/** `diff-tree -r --raw` between two trees: each path that differs. */
async function treeDiff(root: string, a: string, b: string): Promise<Change[]> {
  const out = (await git(root, ["diff-tree", "-r", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", a, b], { timeoutMs: SNAP_TIMEOUT_MS })).out.split("\0");
  const list: Change[] = [];
  for (let i = 0; i + 1 < out.length; i += 2) {
    const meta = out[i]!;
    if (!meta.startsWith(":")) {
      i--;
      continue;
    }
    const [oldMode, newMode, , , st] = meta.slice(1).split(" ");
    list.push({ path: out[i + 1]!, gone: st === "D", gitlink: oldMode === "160000" || newMode === "160000" });
  }
  return list;
}

const BAD = (c: string) => c === "" || c === "." || c === ".." || c.toLowerCase() === ".git";

/**
 * Whether `root/p` may be touched: why not, if not. Every folder on the way must be a real folder
 * (or not there yet), never a symlink, a file, or a nested repository.
 */
async function whyNot(root: string, p: string): Promise<Skipped["why"] | undefined> {
  if (p.split("/").some(BAD)) return "outside";
  let at = root;
  for (const c of p.split("/").slice(0, -1)) {
    at = join(at, c);
    try {
      const st = await lstat(at);
      if (st.isSymbolicLink()) return "symlink";
      if (!st.isDirectory()) return "blocked";
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "ENOENT" ? undefined : "unreadable";
    }
    if (await lstat(join(at, ".git")).then(() => true, () => false)) return "nested";
  }
  return undefined;
}

/** Removes `root/p` when it's a file or a symlink, then the folders it leaves empty. */
async function removeFile(root: string, p: string): Promise<boolean> {
  const abs = join(root, p);
  try {
    const st = await lstat(abs);
    if (st.isDirectory()) return false;
    await unlink(abs);
  } catch {
    return false;
  }
  for (let d = dirname(abs); d.startsWith(root + sep); d = dirname(d)) {
    try {
      if ((await readdir(d)).length) break;
      await rmdir(d);
    } catch {
      break;
    }
  }
  return true;
}

/** Writes paths of `tree` as their raw bytes (no smudge filter, no line-ending conversion). */
async function writeRaw(root: string, tree: string, paths: string[]) {
  const ls = (await git(root, ["ls-tree", "-r", "-z", tree, "--", ...paths.map((p) => `:(literal)${p}`)], { timeoutMs: FORCE_TIMEOUT_MS })).out.split("\0");
  for (const l of ls) {
    if (!l) continue;
    const [meta, path] = [l.slice(0, l.indexOf("\t")), l.slice(l.indexOf("\t") + 1)];
    const [mode, , sha] = meta.split(" ");
    const abs = join(root, path);
    const blob = (await git(root, ["cat-file", "blob", sha!], { timeoutMs: FORCE_TIMEOUT_MS, maxBytes: 4 * 1024 * 1024 * 1024 })).bytes;
    // Never through what's there now (a symlink): it goes, then the file is made afresh.
    await unlink(abs).catch(() => {});
    await mkdir(dirname(abs), { recursive: true });
    if (mode === "120000") await symlink(blob.toString("utf8"), abs);
    else {
      // As git checks files out: 666 or 777, less the umask.
      await writeFile(abs, blob, { mode: mode === "100755" ? 0o777 : 0o666 });
    }
  }
}

export interface Restored {
  /** the undo: the files as they were, every path the restore touched exactly as it was */
  undo: Snap;
  written: number;
  removed: number;
  /** paths it left alone, and why */
  skipped: Skipped[];
}

/**
 * Puts the working tree back to `target` (the real index and HEAD stay as they are). Before any file
 * changes, `undo` gets the snapshot that undoes it; it may throw to call the restore off.
 */
export async function restoreTo(root: string, target: Snap, tmpDir: string, undo: (u: Snap) => Promise<void>, hooks: { afterSnap?: () => Promise<void> | void } = {}): Promise<Restored> {
  const skipped = new Map<string, Skipped["why"]>();
  const skip = (path: string, why: Skipped["why"]) => void (skipped.has(path) || skipped.set(path, why));
  const u = await withIndex(tmpDir, async (env, path) => {
    const o = { env, timeoutMs: FORCE_TIMEOUT_MS };
    const rest = await snapInto(root, env, path);
    const first = (await git(root, [...SAFE, "write-tree"], { env })).out.trim();
    await hooks.afterSnap?.();
    // Every path the restore would touch, into the undo exactly as it is on disk now.
    const touched = await treeDiff(root, first, target.tree);
    const fileMode = (await git(root, ["config", "--bool", "core.fileMode"], { ok: [0, 1] })).out.trim() !== "false";
    const modes = new Map<string, string>();
    if (!fileMode) {
      const ls = (await git(root, ["ls-files", "-s", "-z"], o)).out.split("\0");
      for (const l of ls) if (l) modes.set(l.slice(l.indexOf("\t") + 1), l.slice(0, 6));
    }
    const lines: string[] = [];
    const files: { path: string; mode: string }[] = [];
    for (const c of touched) {
      if (c.gitlink) {
        skip(c.path, "nested");
        continue;
      }
      const why = await whyNot(root, c.path);
      if (why && why !== "symlink" && why !== "blocked") {
        skip(c.path, why);
        continue;
      }
      // Under a symlink or a file: not a path in the working tree, so not in the undo either.
      const st = why ? undefined : await lstat(join(root, c.path)).catch(() => undefined);
      if (!st) lines.push(`0 ${ZERO}\t${c.path}`);
      else if (st.isDirectory()) skip(c.path, "folder");
      else if (st.isSymbolicLink()) {
        const sha = (await git(root, ["hash-object", "-w", "--stdin", "--no-filters"], { ...o, input: await readlink(join(root, c.path)) })).out.trim();
        lines.push(`120000 ${sha}\t${c.path}`);
      } else if (!st.isFile() || c.path.includes("\n") || !(await access(join(root, c.path), constants.R_OK).then(() => true, () => false))) skip(c.path, "unreadable");
      else files.push({ path: c.path, mode: fileMode ? (st.mode & 0o111 ? "100755" : "100644") : modes.get(c.path) === "100755" ? "100755" : "100644" });
    }
    if (files.length) {
      // Raw bytes: what's on disk, whatever filters or autocrlf would make of it (written back raw).
      const shas = (await git(root, ["hash-object", "-w", "--no-filters", "--stdin-paths"], { ...o, input: files.map((f) => f.path).join("\n") + "\n" })).out.trim().split("\n");
      if (shas.length !== files.length) throw new GitError("Couldn't read the files to keep for the undo.", 1, "");
      files.forEach((f, i) => lines.push(`${f.mode} ${shas[i]}\t${f.path}`));
    }
    if (lines.length) await git(root, [...SAFE, "update-index", "-z", "--index-info"], { ...o, input: lines.join("\0") + "\0" });
    const tree = (await git(root, [...SAFE, "write-tree"], { env })).out.trim();
    const forced = new Set(touched.map((c) => c.path));
    const left = rest.left?.filter((p) => !forced.has(p) || skipped.has(p));
    const leftCount = (rest.leftCount ?? 0) - ((rest.left?.length ?? 0) - (left?.length ?? 0));
    const raw = [...files.map((f) => f.path), ...lines.filter((l) => l.startsWith("120000 ")).map((l) => l.slice(l.indexOf("\t") + 1))];
    return { tree, ...(left?.length || leftCount > 0 ? { left: left ?? [], leftCount } : {}), ...(rest.noUntracked ? { noUntracked: true as const } : {}), ...(raw.length ? { raw } : {}) };
  });
  await undo(u);

  const changes = (await treeDiff(root, u.tree, target.tree)).filter((c) => !skipped.has(c.path));
  for (const c of changes) if (c.gitlink) skip(c.path, "nested");
  const targetLeft = new Set(target.left);
  const partial = target.noUntracked || (target.leftCount ?? 0) > (target.left?.length ?? 0);
  const tracked = partial ? new Set((await git(root, ["ls-files", "-z"])).out.split("\0")) : undefined;
  let gone = changes.filter((c) => c.gone && !c.gitlink).map((c) => c.path);
  gone = gone.filter((p) => {
    if (targetLeft.has(p) || (tracked && !tracked.has(p))) return void skip(p, "notTaken");
    return true;
  });
  const writes = changes.filter((c) => !c.gone && !c.gitlink).map((c) => c.path);
  const rawSet = new Set(target.raw);
  return withIndex(tmpDir, async (env) => {
    const o = { env, timeoutMs: FORCE_TIMEOUT_MS };
    await git(root, [...SAFE, "read-tree", target.tree], o);
    const checkout = async (paths: string[]) => {
      const ok: string[] = [];
      for (const p of paths) {
        const why = await whyNot(root, p);
        if (why) {
          skip(p, why);
          continue;
        }
        // A folder where the file goes: left alone (checkout-index would delete what's in it).
        const st = await lstat(join(root, p)).catch(() => undefined);
        if (st?.isDirectory()) skip(p, "folder");
        else ok.push(p);
      }
      const raw = ok.filter((p) => rawSet.has(p));
      const filtered = ok.filter((p) => !rawSet.has(p));
      if (filtered.length) await git(root, [...SAFE, "checkout-index", "-f", "-z", "--stdin"], { ...o, input: filtered.join("\0") + "\0" });
      if (raw.length) await writeRaw(root, target.tree, raw);
      return ok.length;
    };
    const isIgnoreFile = (p: string) => p === ".gitignore" || p.endsWith("/.gitignore");
    // The target's ignore rules first: a file they ignore was never in its snapshot, so it stays.
    let written = await checkout(writes.filter(isIgnoreFile));
    if (gone.length) {
      const ign = await git(root, ["check-ignore", "--no-index", "-z", "--stdin"], { input: gone.join("\0") + "\0", ok: [0, 1] });
      const ignored = new Set(ign.out.split("\0").filter(Boolean));
      gone = gone.filter((p) => (ignored.has(p) ? void skip(p, "ignored") : true));
    }
    let removed = 0;
    for (const p of gone) {
      const why = await whyNot(root, p);
      if (why === "symlink" || why === "blocked") continue; // not there as a path
      if (why) skip(p, why);
      else if (await removeFile(root, p)) removed++;
      else if (await lstat(join(root, p)).then((st) => st.isDirectory(), () => false)) skip(p, "folder");
    }
    written += await checkout(writes.filter((p) => !isIgnoreFile(p)));
    return { undo: u, written, removed, skipped: [...skipped].map(([path, why]) => ({ path, why })) };
  });
}
