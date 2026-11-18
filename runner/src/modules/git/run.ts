// Running git for the git module: an argv (never a shell), in a folder, with a time limit and a cap
// on what it may print. Optional locks are off so even `git diff` leaves the index alone, the repo's
// external diff and textconv programs never run, and neither do its hooks or fsmonitor. Checkpoints
// (../checkpoints) write through here too, with their own index file (`env`).

import { childEnv } from "../../childEnv";

export interface GitOut {
  code: number;
  out: string;
  err: string;
  /** stopped at maxBytes: `out` is what came before */
  cut: boolean;
  /** stdout as it came (a blob's bytes) */
  bytes: Buffer;
}

export interface GitOpts {
  timeoutMs?: number;
  /** stdout kept at most; past it git is stopped and the result is `cut` */
  maxBytes?: number;
  /** exit codes that aren't failures (`diff --no-index` exits 1 when the files differ) */
  ok?: number[];
  /** more environment (GIT_INDEX_FILE, an identity): set after the defaults */
  env?: Record<string, string>;
  /** written to git's stdin */
  input?: string;
}

export const GIT_TIMEOUT_MS = 15_000;

/** The same in every call: plain paths, no color, no pager, no prompts, no fsmonitor hook. */
const CONFIG = ["-c", "core.quotepath=off", "-c", "color.ui=never", "-c", "core.fsmonitor=false", "-c", "core.pager=cat", "-c", "core.hooksPath=/dev/null"];

export class GitError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly stderr: string,
  ) {
    super(message);
  }
}

/** `git <args>` in `cwd`. Throws GitError on an exit code outside `ok`, a timeout, or no git. */
export async function git(cwd: string, args: string[], opts: GitOpts = {}): Promise<GitOut> {
  const { timeoutMs = GIT_TIMEOUT_MS, maxBytes = 16 * 1024 * 1024, ok = [0] } = opts;
  let p: ReturnType<typeof Bun.spawn<"ignore" | "pipe", "pipe", "pipe">>;
  try {
    p = Bun.spawn(["git", ...CONFIG, ...args], {
      cwd,
      stdin: opts.input === undefined ? "ignore" : "pipe",
      stdout: "pipe",
      stderr: "pipe",
      // The folder decides the repo: nothing inherited points git elsewhere.
      // No lazy fetch: a partial clone never goes to the network for a diff.
      env: childEnv({
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
        GIT_NO_LAZY_FETCH: "1",
        GIT_PAGER: "cat",
        LC_ALL: "C",
        GIT_DIR: undefined,
        GIT_WORK_TREE: undefined,
        GIT_INDEX_FILE: undefined,
        GIT_OBJECT_DIRECTORY: undefined,
        GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
        GIT_COMMON_DIR: undefined,
        GIT_EXTERNAL_DIFF: undefined,
        GIT_CONFIG_PARAMETERS: undefined,
        GIT_CONFIG_COUNT: undefined,
        ...opts.env,
      }),
    });
  } catch (e) {
    throw new GitError((e as NodeJS.ErrnoException).code === "ENOENT" ? "The session's folder isn't there, or git isn't installed." : String((e as Error).message), -1, "");
  }
  if (opts.input !== undefined) {
    const w = p.stdin as import("bun").FileSink;
    w.write(opts.input);
    void Promise.resolve(w.end()).catch(() => {});
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    p.kill();
  }, timeoutMs);
  const chunks: Uint8Array[] = [];
  let size = 0;
  let cut = false;
  const reader = p.stdout.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.length > maxBytes) {
        chunks.push(value.subarray(0, maxBytes - size));
        size = maxBytes;
        cut = true;
        p.kill();
        break;
      }
      chunks.push(value);
      size += value.length;
    }
  } finally {
    reader.releaseLock();
  }
  const err = await new Response(p.stderr).text().catch(() => "");
  const code = await p.exited;
  clearTimeout(timer);
  if (timedOut) throw new GitError("git took too long.", code, err);
  const bytes = Buffer.concat(chunks);
  const out = bytes.toString("utf8");
  if (!cut && !ok.includes(code)) throw new GitError(err.trim().split("\n")[0] || `git exited with ${code}.`, code, err);
  return { code, out, err, cut, bytes };
}
