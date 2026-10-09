// Git checkpoints of the working tree, taken before each turn so any agent run can be undone.
// They never touch your index, branch or stash: the snapshot is built in a temporary index and
// stored as a commit under refs/tether/checkpoints/, which `git log --all` and GC respect.

import { mkdtempSync, rmSync, copyFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionDiff, SessionFileDiff } from "../../web/src/shared/protocol";

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

async function root(cwd: string): Promise<string | undefined> {
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

/**
 * Lists the current working-tree changes against a Tether session's starting snapshot. The
 * snapshot is assembled through a temporary index, so reading diffs never changes the user's
 * real index. Untracked, non-ignored files are included just like they are in checkpoints.
 */
export async function workingTreeDiff(cwd: string, sessionBase?: string): Promise<SessionDiff> {
  const top = await root(cwd);
  if (!top) throw new Error("This project is not a Git repository.");

  const tree = await snapshotTree(top);
  let base = "";
  let kind: SessionDiff["base"] = "empty";
  if (sessionBase && (await git(top, ["cat-file", "-e", `${sessionBase}^{commit}`]).then(() => true).catch(() => false))) {
    base = sessionBase;
    kind = "session";
  } else {
    base = await git(top, ["rev-parse", "--verify", "-q", "HEAD"]).catch(() => "");
    if (base) kind = "HEAD";
    else base = await gitInput(top, ["mktree"], "");
  }

  const names = (await git(top, ["diff", "--name-status", "-z", "--no-renames", base, tree, "--"]))
    .split("\0")
    .filter(Boolean);
  const entries: { code: string; path: string }[] = [];
  for (let i = 0; i + 1 < names.length; i += 2) entries.push({ code: names[i]!, path: names[i + 1]! });

  const files: SessionFileDiff[] = [];
  let remaining = 500_000;
  const listed = entries.slice(0, 200);
  let truncated = listed.length < entries.length;
  for (const entry of listed) {
    const full = await git(top, [
      "--literal-pathspecs",
      "diff",
      "--no-ext-diff",
      "--no-color",
      "--no-renames",
      "--unified=3",
      base,
      tree,
      "--",
      entry.path,
    ]);
    const lines = full.split("\n");
    const additions = lines.filter((line) => line.startsWith("+") && !line.startsWith("+++ ")).length;
    const deletions = lines.filter((line) => line.startsWith("-") && !line.startsWith("--- ")).length;
    const isTruncated = full.length > remaining;
    const patch = full.slice(0, Math.max(0, remaining));
    remaining -= patch.length;
    if (isTruncated) truncated = true;
    const status = entry.code === "A" ? "added" : entry.code === "D" ? "deleted" : entry.code === "T" ? "typechanged" : entry.code === "M" ? "modified" : "unknown";
    files.push({ path: entry.path, status, additions, deletions, patch, ...(isTruncated ? { truncated: true } : {}) });
    if (remaining <= 0) {
      truncated = true;
      break;
    }
  }
  return { base: kind, files, truncated };
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

/**
 * Restores the working tree to a checkpoint: files are rewritten to their snapshot content and
 * files created since are removed (ignored files are left alone). The index and HEAD are not
 * changed, so the restore shows up as ordinary working-tree changes.
 */
export async function restore(cwd: string, commit: string): Promise<{ written: number; removed: number }> {
  const top = await root(cwd);
  if (!top) throw new Error("Not a git repository");
  const want = new Set((await git(top, ["ls-tree", "-r", "-z", "--name-only", commit])).split("\0").filter(Boolean));
  const have = (await git(top, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])).split("\0").filter(Boolean);
  let removed = 0;
  for (const f of have)
    if (!want.has(f)) {
      try {
        unlinkSync(join(top, f));
        removed++;
      } catch {}
    }
  await withTempIndex(top, async (env) => {
    await git(top, ["read-tree", commit], env);
    await git(top, ["checkout-index", "-a", "-f"], env);
  });
  return { written: want.size, removed };
}
