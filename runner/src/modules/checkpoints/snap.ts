// Snapshots and restores for turn checkpoints (SPEC §10 Checkpoints), in git, without touching the
// repo's own index, HEAD, stash or branches:
//
// - snapshot: the working tree as a tree object. A temporary index file (GIT_INDEX_FILE) seeded with
//   a copy of the real index (its stat cache keeps `add` quick, and sparse checkout's skip-worktree
//   entries stay as they are; HEAD's tree when there's no index), `add -A` into it (tracked and
//   untracked files, never ignored ones; untracked files over CHECKPOINT_FILE_BYTES_MAX left out),
//   `write-tree`. Blobs and trees land in the object store, as `git add` would put them.
// - commit + ref: `commit-tree` with a fixed identity and date (works without user.name; the same
//   tree and parent give the same commit), `update-ref` under refs/tether/checkpoints/.
// - restore: the files that differ between the tree as it is now and the target, put right: removed
//   when the target lacks them (ignored files never), written with `checkout-index` from a temporary
//   index holding the target. Submodules (gitlinks) are left alone, and so is a folder in the way of
//   a file.
//
// Filters: `add` runs the clean filters the person's git config defines for paths .gitattributes
// names (git-lfs stores its object and puts the pointer in the snapshot), and checkout-index the
// smudge ones, exactly as `git add` and `git checkout` would. The commands come from config, never
// from the repo's files; the time limit bounds them. Hooks and fsmonitor never run (run.ts).

import { copyFile, lstat, readdir, rm, rmdir, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, join, sep } from "node:path";
import { CHECKPOINT_FILE_BYTES_MAX } from "../../../../shared/checkpoints";
import { git } from "../git/run";

/** Snapshot steps get longer than reads: `add` hashes every changed file. */
export const SNAP_TIMEOUT_MS = 60_000;

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

const literal = (p: string) => `:(literal)${p}`;

export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

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

/** The working tree of the repo at `root` as a tree id. Changes nothing but the object store. */
export async function snapshotTree(root: string, tmpDir: string, bigBytes = CHECKPOINT_FILE_BYTES_MAX): Promise<string> {
  return withIndex(tmpDir, async (env, path) => {
    const o = { env, timeoutMs: SNAP_TIMEOUT_MS };
    const real = (await git(root, ["rev-parse", "--path-format=absolute", "--git-path", "index"])).out.trim();
    let seeded = false;
    try {
      await copyFile(real, path);
      seeded = true;
    } catch {}
    if (!seeded) {
      const head = await headCommit(root);
      if (head) await git(root, [...SAFE, "read-tree", head], o);
    }
    // Untracked files too big to keep: left out of every snapshot alike, so a restore never touches them.
    const others = (await git(root, ["ls-files", "--others", "--exclude-standard", "-z"], o)).out.split("\0").filter(Boolean);
    const big: string[] = [];
    for (const p of others) {
      try {
        if ((await lstat(join(root, p))).size > bigBytes) big.push(p);
      } catch {}
    }
    await git(root, [...SAFE, "add", "-A", "--ignore-errors", "--", ".", ...big.map((p) => `:(exclude,literal)${p}`)], { ...o, ok: [0, 1] });
    return (await git(root, [...SAFE, "write-tree"], o)).out.trim();
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

/** Files that differ between two trees (gitlinks aside). */
export async function changedFiles(root: string, a: string, b: string): Promise<number> {
  return (await treeDiff(root, a, b)).length;
}

interface Change {
  path: string;
  /** in `a`, not in `b` */
  gone: boolean;
  /** b's mode */
  mode: string;
}

/** `diff-tree -r --raw` between two trees: each path that differs, gitlinks left out. */
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
    if (oldMode === "160000" || newMode === "160000") continue;
    list.push({ path: out[i + 1]!, gone: st === "D", mode: newMode! });
  }
  return list;
}

/** `root/p` with every folder on the way a real folder, or not there yet (no symlink leading out of the repo). */
async function insideRepo(root: string, p: string): Promise<boolean> {
  if (p.split("/").some((c) => c === "" || c === "." || c === ".." || c === ".git")) return false;
  let at = root;
  for (const c of p.split("/").slice(0, -1)) {
    at = join(at, c);
    try {
      if (!(await lstat(at)).isDirectory()) return false;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "ENOENT";
    }
  }
  return true;
}

/** Removes `root/p` when it's a file or a symlink, then the folders it leaves empty. */
async function removeFile(root: string, p: string): Promise<boolean> {
  if (!(await insideRepo(root, p))) return false;
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

export interface Restored {
  written: number;
  removed: number;
  /** paths it couldn't put back */
  skipped: string[];
}

/**
 * Puts the working tree, which is `current` now (a snapshot just taken), back to `target`. The real
 * index and HEAD are left as they are: only files change.
 */
export async function restoreTree(root: string, current: string, target: string, tmpDir: string): Promise<Restored> {
  const changes = await treeDiff(root, current, target);
  const skipped: string[] = [];
  return withIndex(tmpDir, async (env) => {
    const o = { env, timeoutMs: SNAP_TIMEOUT_MS };
    await git(root, [...SAFE, "read-tree", target], o);
    const checkout = async (paths: string[]) => {
      const ok: string[] = [];
      for (const p of paths) {
        if (!(await insideRepo(root, p))) {
          skipped.push(p);
          continue;
        }
        // A folder where the file goes: left alone (checkout-index would delete what's in it).
        const st = await lstat(join(root, p)).catch(() => undefined);
        if (st?.isDirectory()) skipped.push(p);
        else ok.push(p);
      }
      if (ok.length) await git(root, [...SAFE, "checkout-index", "-f", "-z", "--stdin"], { ...o, input: ok.join("\0") + "\0" });
      return ok.length;
    };
    const writes = changes.filter((c) => !c.gone);
    const isIgnoreFile = (p: string) => p === ".gitignore" || p.endsWith("/.gitignore");
    // The target's ignore rules first: a file they ignore was never in its snapshot, so it stays.
    let written = await checkout(writes.filter((c) => isIgnoreFile(c.path)).map((c) => c.path));
    let gone = changes.filter((c) => c.gone).map((c) => c.path);
    if (gone.length) {
      const ign = await git(root, ["check-ignore", "--no-index", "-z", "--stdin"], { input: gone.join("\0") + "\0", ok: [0, 1] });
      const ignored = new Set(ign.out.split("\0").filter(Boolean));
      gone = gone.filter((p) => !ignored.has(p));
    }
    let removed = 0;
    for (const p of gone) {
      if (await removeFile(root, p)) removed++;
      else if (await lstat(join(root, p)).then(() => true, () => false)) skipped.push(p);
    }
    written += await checkout(writes.filter((c) => !isIgnoreFile(c.path)).map((c) => c.path));
    return { written, removed, skipped };
  });
}
