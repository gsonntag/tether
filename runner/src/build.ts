// Reads the runner's build from git at startup (commit, date, branch, local changes).
// Outside a git checkout or when git fails, returns undefined so the runner falls back to package.json version.

import type { RunnerBuild } from "../../shared/protocol";
import { childEnv } from "./childEnv";

export type GitRunner = (argv: string[], cwd: string, timeoutMs?: number) => Promise<{ code: number; stdout: string }>;

/** Default git runner using Bun.spawn, stripping secrets from the environment. */
export const defaultGit: GitRunner = async (argv, cwd, timeoutMs = 15_000) => {
  try {
    const proc = Bun.spawn(["git", ...argv], {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: childEnv({ GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" }),
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeoutMs);
    const stdout = await new Response(proc.stdout).text();
    const code = await proc.exited;
    clearTimeout(timer);
    return { code: timedOut ? -1 : code, stdout };
  } catch {
    return { code: -1, stdout: "" };
  }
};

/**
 * Reads the build stamp from git in `cwd` (or its enclosing repo).
 * Returns undefined if there is no .git or git fails.
 */
export async function readBuildInfo(cwd: string, git: GitRunner = defaultGit): Promise<RunnerBuild | undefined> {
  const log = await git(["log", "-1", "--format=%h%x00%cs"], cwd);
  if (log.code !== 0) return undefined;
  const parts = log.stdout.trim().split("\0");
  const commit = parts[0]?.trim();
  const date = parts[1]?.trim();
  if (!commit || !date) return undefined;

  const branchRes = await git(["branch", "--show-current"], cwd);
  const branchName = branchRes.code === 0 ? branchRes.stdout.trim() : "";
  const branch = branchName || "detached";

  const status = await git(["status", "--porcelain"], cwd);
  const dirty = status.code === 0 ? status.stdout.trim().length > 0 : false;

  let behind: number | undefined;
  // Compute behind only when the branch has an upstream:
  const upstreamCheck = await git(["rev-parse", "--verify", "--quiet", "@{upstream}"], cwd);
  if (upstreamCheck.code === 0) {
    const fetch = await git(["fetch", "--quiet"], cwd, 20_000);
    if (fetch.code === 0) {
      const revList = await git(["rev-list", "--count", "HEAD..@{upstream}"], cwd);
      if (revList.code === 0) {
        const count = parseInt(revList.stdout.trim(), 10);
        if (Number.isSafeInteger(count) && count >= 0) behind = count;
      }
    }
  }

  return { commit, date, branch, dirty, ...(behind !== undefined ? { behind } : {}) };
}
