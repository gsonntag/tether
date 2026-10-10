// The store is a git repo: every change is one commit, so any merge can be inspected and reverted.
// Commits use a fixed identity and never sign, so they work on machines without git config.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const IDENTITY = ["-c", "user.name=Tether", "-c", "user.email=tether@localhost", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"];

export async function git(dir: string, args: string[], opts: { allowFail?: boolean } = {}): Promise<string> {
  const p = Bun.spawn(["git", ...IDENTITY, "-C", dir, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" },
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0 && !opts.allowFail) throw new Error(`git ${args[0]} failed: ${err.trim() || out.trim()}`);
  return out;
}

/** Generated or high-churn files stay out of history (they'd make reverts conflict). */
const IGNORE = ["activity.jsonl", "sources.json", "conflicts.json", "exports/", "backup/", "inbox/", ""].join("\n");

export async function ensureRepo(dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  if (existsSync(join(dir, ".git"))) return;
  await git(dir, ["init", "-q", "-b", "main"]);
  writeFileSync(join(dir, ".gitignore"), IGNORE);
  await git(dir, ["add", ".gitignore"]);
  await git(dir, ["commit", "-q", "-m", "context: start the store"]);
}

/** Stages `paths` (adds, edits and deletions) and commits; returns the new sha, or undefined if nothing changed. */
export async function commit(dir: string, paths: string[], message: string): Promise<string | undefined> {
  await git(dir, ["add", "-A", "--", ...paths]);
  const staged = await git(dir, ["diff", "--cached", "--name-only"]);
  if (!staged.trim()) return undefined;
  await git(dir, ["commit", "-q", "-m", message]);
  return (await git(dir, ["rev-parse", "HEAD"])).trim();
}

export interface LogEntry {
  sha: string;
  ts: number;
  message: string;
}

export async function log(dir: string, path: string, limit = 50): Promise<LogEntry[]> {
  const out = await git(dir, ["log", `-n${limit}`, "--follow", "--format=%H%x1f%at%x1f%s", "--", path], { allowFail: true });
  return out
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [sha, at, message] = l.split("\x1f");
      return { sha: sha!, ts: Number(at) * 1000, message: message ?? "" };
    });
}

/** A file's content at a revision, or undefined if it didn't exist there. */
export async function show(dir: string, rev: string, path: string): Promise<string | undefined> {
  const p = Bun.spawn(["git", "-C", dir, "show", `${rev}:${path}`], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  return code === 0 ? out : undefined;
}

export async function patch(dir: string, sha: string, path: string): Promise<string> {
  const out = await git(dir, ["show", "--format=", "--no-color", sha, "--", path], { allowFail: true });
  return out.length > 20_000 ? out.slice(0, 20_000) + "\n…(truncated)" : out;
}

/** Serializes store writes: one commit at a time. */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => {});
    return next;
  }
}
