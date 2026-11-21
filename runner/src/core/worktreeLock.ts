// The worktree lock (SPEC §4): work on one worktree, by its path, one at a time, runner-wide. In the
// core because a send to an archived session takes it too (live.ts); the worktrees module uses it
// for joining and for removal on archive.

import { resolve } from "node:path";

/** Work on one worktree (joining it, removing it), by its path: one at a time, runner-wide. */
const worktreeLocks = new Map<string, Promise<unknown>>();

/**
 * `f` once earlier work on the worktree at `path` is done. Joining, cleanup on archive and a send
 * that unarchives one of its sessions share it: none happens while the worktree is being removed,
 * and a removal sees what came first.
 */
export async function lockWorktree<T>(path: string, f: () => Promise<T>): Promise<T> {
  const key = resolve(path);
  const run = (worktreeLocks.get(key) ?? Promise.resolve()).catch(() => {}).then(f);
  const tail = run.catch(() => {});
  worktreeLocks.set(key, tail);
  try {
    return await run;
  } finally {
    if (worktreeLocks.get(key) === tail) worktreeLocks.delete(key);
  }
}
