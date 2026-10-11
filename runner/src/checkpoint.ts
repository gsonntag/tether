// Git checkpoints of the working tree, taken before each turn so the changes of any turn (or of
// the whole session) can be shown. They never touch your index, branch or stash: the snapshot is
// built in a temporary index and stored as a commit under refs/tether/checkpoints/, which
// `git log --all` and GC respect.

import { mkdtempSync, rmSync, copyFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiffStat, SessionDiff, SessionFileDiff } from "../../web/src/shared/protocol";

async function git(cwd: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`git ${args[0]}: ${err.trim() || out.trim()}`);
  return out.trim();
}

async function gitInput(cwd: string, args: string[], input: string): Promise<string> {
  const p = Bun.spawn(["git", ...args], { cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  p.stdin.write(input);
  p.stdin.end();
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`git ${args[0]}: ${err.trim() || out.trim()}`);
  return out.trim();
}

export async function root(cwd: string): Promise<string | undefined> {
  try {
    return await git(cwd, ["rev-parse", "--show-toplevel"]);
  } catch {
    return undefined;
  }
}

/** A temporary index seeded from the real one (so hashing only touches changed files). */
async function withTempIndex<T>(top: string, fn: (env: Record<string, string>) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "wc-ckpt-"));
  const index = join(dir, "index");
  try {
    const real = await git(top, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
    if (existsSync(real)) copyFileSync(real, index);
    return await fn({ GIT_INDEX_FILE: index });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function snapshotTree(top: string): Promise<string> {
  return withTempIndex(top, async (env) => {
    await git(top, ["add", "-A", "--", "."], env);
    return git(top, ["write-tree"], env);
  });
}

const isCommit = (top: string, sha: string) =>
  git(top, ["cat-file", "-e", `${sha}^{commit}`]).then(
    () => true,
    () => false,
  );

/** Caps, so a vendored directory or a generated file can't flood the browser. */
export const DIFF_LIMITS = { files: 300, fileBytes: 64_000, fileLines: 4_000, totalBytes: 1_000_000 };

type Counts = { additions: number; deletions: number; binary: boolean };

/** Per-file line counts between two trees; `binary` when git can't count lines. `paths` limits it to those (repo-relative) files. */
async function numstat(top: string, from: string, to: string, paths: string[] = []): Promise<Map<string, Counts>> {
  const out = await git(top, ["--literal-pathspecs", "diff", "--numstat", "-z", "--no-renames", from, to, "--", ...paths]);
  const map = new Map<string, Counts>();
  for (const rec of out.split("\0")) {
    const m = rec.match(/^(-|\d+)\t(-|\d+)\t([\s\S]+)$/);
    if (!m) continue;
    const binary = m[1] === "-";
    map.set(m[3]!, { additions: binary ? 0 : Number(m[1]), deletions: binary ? 0 : Number(m[2]), binary });
  }
  return map;
}

/** The commit a diff starts from: `from` when it still exists, else HEAD, else the empty tree. */
async function resolveBase(top: string, from?: string): Promise<{ base: string; kind: SessionDiff["base"] }> {
  if (from && (await isCommit(top, from))) return { base: from, kind: "session" };
  const head = await git(top, ["rev-parse", "--verify", "-q", "HEAD"]).catch(() => "");
  if (head) return { base: head, kind: "HEAD" };
  return { base: await gitInput(top, ["mktree"], ""), kind: "empty" };
}

export interface DiffOptions {
  /** only these files (paths relative to the repository root, taken literally) */
  paths?: string[];
  /** other caps, e.g. looser ones for a single file */
  limits?: Partial<typeof DIFF_LIMITS>;
}

/**
 * Changes between two snapshots of a repository. `from` is a checkpoint (or any commit); when it
 * is missing or gone, HEAD (or the empty tree) stands in. `to` is a later checkpoint, or the
 * working tree as it is now when left out. The working tree is read through a temporary index,
 * so this never changes the user's real index, and untracked non-ignored files count as added.
 */
export async function computeDiff(cwd: string, from?: string, to?: string, opts: DiffOptions = {}): Promise<SessionDiff> {
  const top = await root(cwd);
  if (!top) throw new Error("This project is not a Git repository.");
  const limits = { ...DIFF_LIMITS, ...opts.limits };
  const paths = opts.paths ?? [];

  const { base, kind } = await resolveBase(top, from);
  const target = to && (await isCommit(top, to)) ? to : await snapshotTree(top);

  const names = (await git(top, ["--literal-pathspecs", "diff", "--name-status", "-z", "--no-renames", base, target, "--", ...paths])).split("\0").filter(Boolean);
  const entries: { code: string; path: string }[] = [];
  for (let i = 0; i + 1 < names.length; i += 2) entries.push({ code: names[i]!, path: names[i + 1]! });
  const counts = await numstat(top, base, target, paths);

  const files: SessionFileDiff[] = [];
  let remaining = limits.totalBytes;
  let additions = 0;
  let deletions = 0;
  for (const entry of entries) {
    const c = counts.get(entry.path) ?? { additions: 0, deletions: 0, binary: false };
    additions += c.additions;
    deletions += c.deletions;
    if (files.length >= limits.files) continue;
    const status = entry.code === "A" ? "added" : entry.code === "D" ? "deleted" : entry.code === "T" ? "typechanged" : entry.code === "M" ? "modified" : "unknown";
    const file: SessionFileDiff = { path: entry.path, status, additions: c.additions, deletions: c.deletions, patch: "" };
    files.push(file);
    if (c.binary) {
      file.binary = true;
      continue;
    }
    if (c.additions + c.deletions > limits.fileLines) {
      file.skipped = `${c.additions + c.deletions} changed lines, too many to show`;
      continue;
    }
    if (remaining <= 0) {
      file.skipped = "Not shown: the diff is already very large";
      continue;
    }
    const full = await git(top, ["--literal-pathspecs", "diff", "--no-ext-diff", "--no-color", "--no-renames", "--unified=3", base, target, "--", entry.path]);
    // Hunks only: the header lines repeat what the file entry already says.
    const at = full.search(/^@@/m);
    let patch = at < 0 ? "" : full.slice(at);
    const cap = Math.min(limits.fileBytes, remaining);
    if (patch.length > cap) {
      patch = patch.slice(0, patch.lastIndexOf("\n", cap) + 1 || cap);
      file.truncated = true;
    }
    file.patch = patch;
    remaining -= patch.length;
  }
  return {
    base: kind,
    files,
    fileCount: entries.length,
    additions,
    deletions,
    truncated: files.length < entries.length || files.some((f) => f.truncated || f.skipped),
  };
}

/**
 * The files (repository-relative) that differ between `from` (as in computeDiff) and the working
 * tree now, with the repository's top-level directory. Undefined outside a git repository.
 */
export async function changedPaths(cwd: string, from?: string): Promise<{ top: string; paths: Set<string> } | undefined> {
  const top = await root(cwd);
  if (!top) return undefined;
  const { base } = await resolveBase(top, from);
  const tree = await snapshotTree(top);
  const out = await git(top, ["diff", "--name-only", "-z", "--no-renames", base, tree, "--"]);
  return { top, paths: new Set(out.split("\0").filter(Boolean)) };
}

/**
 * Line counts of one file (repository-relative) for each turn: from `shas[i]` to `shas[i + 1]`,
 * the last one to the working tree now. Undefined where a checkpoint is gone; zero where the file
 * didn't change.
 */
export async function pathTurnStats(cwd: string, shas: string[], path: string): Promise<(Counts | undefined)[]> {
  const top = await root(cwd);
  if (!top || !shas.length) return shas.map(() => undefined);
  const tree = await snapshotTree(top);
  const zero: Counts = { additions: 0, deletions: 0, binary: false };
  return Promise.all(
    shas.map(async (from, i) => {
      const to = shas[i + 1] ?? tree;
      if (from === to) return zero;
      try {
        return (await numstat(top, from, to, [path])).get(path) ?? zero;
      } catch {
        return undefined;
      }
    }),
  );
}

/** Files and lines changed between two commits or trees. */
export async function diffStat(cwd: string, from: string, to: string): Promise<DiffStat> {
  const stat: DiffStat = { files: 0, additions: 0, deletions: 0 };
  for (const c of (await numstat(cwd, from, to)).values()) {
    stat.files++;
    stat.additions += c.additions;
    stat.deletions += c.deletions;
  }
  return stat;
}

/** Line counts from each of `froms` to the working tree as it is now (one snapshot for all). */
export async function workingTreeStats(cwd: string, froms: string[]): Promise<(DiffStat | undefined)[]> {
  const top = await root(cwd);
  if (!top) return froms.map(() => undefined);
  const tree = await snapshotTree(top);
  return Promise.all(froms.map((from) => diffStat(top, from, tree).catch(() => undefined)));
}

/**
 * Snapshots the working tree. Returns the checkpoint commit, or undefined outside a git repo.
 * `previous` is the last checkpoint: when nothing changed since, it is returned as is.
 */
export async function snapshot(cwd: string, ref: string, label: string, previous?: string): Promise<string | undefined> {
  const top = await root(cwd);
  if (!top) return undefined;
  const tree = await snapshotTree(top);
  if (previous) {
    const prevTree = await git(top, ["rev-parse", `${previous}^{tree}`]).catch(() => "");
    if (prevTree === tree) return previous;
  }
  const head = await git(top, ["rev-parse", "--verify", "-q", "HEAD"]).catch(() => "");
  const commit = await git(
    top,
    ["commit-tree", tree, ...(head ? ["-p", head] : []), "-m", `Tether checkpoint: ${label.slice(0, 200)}`],
    { GIT_AUTHOR_NAME: "Tether", GIT_AUTHOR_EMAIL: "tether@localhost", GIT_COMMITTER_NAME: "Tether", GIT_COMMITTER_EMAIL: "tether@localhost" },
  );
  await git(top, ["update-ref", ref, commit]);
  return commit;
}
