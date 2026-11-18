// Running git for the git module: an argv (never a shell), in a folder, with a time limit and a cap
// on what it may print. Optional locks are off so even `git diff` leaves the index alone, the repo's
// external diff and textconv programs never run, and neither does fsmonitor, nor its hooks unless
// asked (`hooks`: Commit and Push, which run them as git would). Checkpoints
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
  /** the repo's hooks run (Commit's pre-commit, Push's pre-push): only for what the person asked git to do */
  hooks?: boolean;
  /** stdout goes here as it comes (a big blob), not into `out`; no maxBytes */
  sink?: (chunk: Uint8Array) => Promise<unknown>;
}

export const GIT_TIMEOUT_MS = 15_000;
/** How long pipes are read after git exits (a hook's background child may hold them). */
const EXIT_GRACE_MS = 2_000;

/** The same in every call: plain paths, no color, no pager, no prompts, no fsmonitor hook. */
const CONFIG = ["-c", "core.quotepath=off", "-c", "color.ui=never", "-c", "core.fsmonitor=false", "-c", "core.pager=cat"];
const NO_HOOKS = ["-c", "core.hooksPath=/dev/null"];

export class GitError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly stderr: string,
  ) {
    super(message);
  }
}

/** Kills a child started `detached` and everything in its process group (a hook's children, ssh). */
export function killGroup(p: { pid: number; kill(sig?: number | NodeJS.Signals): void }) {
  try {
    process.kill(-p.pid, "SIGKILL");
  } catch {
    try {
      p.kill("SIGKILL");
    } catch {}
  }
}

/** Resolves when `stop` does, else with `p`: a pipe a grandchild still holds is never waited on past a kill. */
const until = <T>(p: Promise<T>, stop: Promise<void>, dflt: T): Promise<T> => Promise.race([p, stop.then(() => dflt)]);

/**
 * `git <args>` in `cwd`. Throws GitError on an exit code outside `ok`, a timeout, or no git. git runs
 * in its own process group: a timeout kills the group (hooks, ssh, a pinentry) and stops waiting on
 * pipes their children may still hold.
 */
export async function git(cwd: string, args: string[], opts: GitOpts = {}): Promise<GitOut> {
  const { timeoutMs = GIT_TIMEOUT_MS, maxBytes = 16 * 1024 * 1024, ok = [0] } = opts;
  let p: ReturnType<typeof Bun.spawn<"ignore" | "pipe", "pipe", "pipe">>;
  try {
    p = Bun.spawn(["git", ...CONFIG, ...(opts.hooks ? [] : NO_HOOKS), ...args], {
      cwd,
      stdin: opts.input === undefined ? "ignore" : "pipe",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
      // The folder decides the repo: nothing inherited points git elsewhere.
      // No lazy fetch: a partial clone never goes to the network for a diff. Hooks (what the person
      // asked git to do) get the person's own locale and fetching.
      env: childEnv({
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
        ...(opts.hooks ? {} : { GIT_NO_LAZY_FETCH: "1", LC_ALL: "C" }),
        GIT_PAGER: "cat",
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
    try {
      w.write(opts.input);
      void Promise.resolve(w.end()).catch(() => {});
    } catch {}
  }
  let timedOut = false;
  let stopNow!: () => void;
  const stop = new Promise<void>((r) => (stopNow = r));
  const kill = () => {
    killGroup(p);
    stopNow();
  };
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, timeoutMs);
  // git is done but something it started (a hook's background child) still holds a pipe: a moment
  // later its group goes, and what was read is the answer.
  let finished = false;
  void p.exited.then(() => Bun.sleep(EXIT_GRACE_MS)).then(() => {
    if (finished) return;
    killGroup(p);
    stopNow();
  });
  const chunks: Uint8Array[] = [];
  let size = 0;
  let cut = false;
  const reader = p.stdout.getReader();
  // stderr as it comes, so a timeout still has what a hook printed before it
  let errSoFar = "";
  const dec = new TextDecoder();
  const errText = (async () => {
    const r = p.stderr.getReader();
    try {
      for (;;) {
        const { done, value } = await r.read();
        if (done) break;
        if (errSoFar.length < 1 << 20) errSoFar += dec.decode(value, { stream: true });
      }
    } catch {}
    return errSoFar;
  })();
  try {
    for (;;) {
      const { done, value } = await until(reader.read(), stop, { done: true, value: undefined });
      if (done || !value) break;
      if (opts.sink) {
        await opts.sink(value);
        continue;
      }
      if (size + value.length > maxBytes) {
        chunks.push(value.subarray(0, maxBytes - size));
        size = maxBytes;
        cut = true;
        kill();
        break;
      }
      chunks.push(value);
      size += value.length;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }
  const err = await until(errText, stop, "").then((e) => e || errSoFar);
  const code = await until(p.exited, stop.then(() => Bun.sleep(1000)), -1);
  finished = true;
  clearTimeout(timer);
  if (timedOut) throw new GitError("git took too long.", code, err);
  const bytes = Buffer.concat(chunks);
  const out = bytes.toString("utf8");
  if (!cut && !ok.includes(code)) throw new GitError(err.trim().split("\n")[0] || `git exited with ${code}.`, code, err);
  return { code, out, err, cut, bytes };
}
