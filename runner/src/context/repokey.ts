// Repo keys: one name for a repository however it is checked out. The normalized git remote URL
// when there is one, else the main checkout's absolute path; worktrees resolve through
// `git rev-parse --git-common-dir`, so `foliation-wt/*` and `foliation` share a key. Paths that
// no longer exist key by the path itself.
//
// Claude's per-project memory dirs are named after the session cwd with every non-alphanumeric
// character turned into `-`, which can't be decoded unambiguously. claudeProjectScope() recovers
// the cwd from the project's transcripts, then from the filesystem, and otherwise gives the dir an
// opaque key of its own rather than guess.

import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { home } from "./paths";

async function git(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const p = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
    return code === 0 ? out.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** `git@github.com:Foo/bar.git`, `https://user@github.com/Foo/bar` → `github.com/Foo/bar`. */
export function normalizeRemote(url: string): string {
  let u = url.trim();
  const scp = /^(?:[\w.-]+@)?([\w.-]+):(?!\/\/)(.+)$/.exec(u); // scp-like ssh syntax
  if (scp && !/^[a-z]+:\/\//i.test(u)) u = `${scp[1]}/${scp[2]}`;
  else u = u.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/^[^@/]+@/, "");
  u = u.replace(/\/+$/, "").replace(/\.git$/, "").replace(/:\d+(?=\/)/, "");
  const slash = u.indexOf("/");
  return slash < 0 ? u.toLowerCase() : u.slice(0, slash).toLowerCase() + u.slice(slash);
}

const cache = new Map<string, string>();

/** Whether `a` is `b` or one of its ancestors. */
const isAncestorOrSelf = (a: string, b: string) => a === b || b.startsWith(a.endsWith("/") ? a : a + "/");

export async function repoKey(path: string): Promise<string> {
  const abs = resolve(path);
  const hit = cache.get(abs);
  if (hit) return hit;
  let key = abs;
  if (existsSync(abs)) {
    const common = await git(abs, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const root = common ? (common.endsWith("/.git") ? dirname(common) : common) : undefined;
    // A dotfiles repo in $HOME (or above it) isn't the project's repo: key by the path.
    if (root && !(isAncestorOrSelf(root, resolve(home())) && abs !== resolve(home()))) {
      const remotes = (await git(abs, ["remote"]))?.split("\n").filter(Boolean) ?? [];
      const remote = remotes.includes("origin") ? "origin" : remotes[0];
      const url = remote ? await git(abs, ["remote", "get-url", remote]) : undefined;
      key = url ? normalizeRemote(url) : root;
    }
  }
  cache.set(abs, key);
  return key;
}

/** Whether a path is the user's home (Claude's `-home-ubuntu` project = global memory). */
export const isHome = (p: string) => resolve(p) === resolve(home());

/** Directory name for a repo key inside `memory/repos/`. */
export function keyDir(key: string): string {
  return (
    key
      .replace(/^\/+/, "")
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^[-.]+|-+$/g, "")
      .slice(0, 120) || "repo"
  );
}

/** Claude's project dir name for a cwd: every character outside [A-Za-z0-9-] becomes `-`. */
export const claudeDirName = (cwd: string) => resolve(cwd).replace(/[^A-Za-z0-9-]/g, "-");

/** Claude Code's throwaway scratchpad sessions (/tmp/claude-<uid>/…). */
export const isScratch = (cwd: string) => /^\/tmp\/claude-\d+(\/|$)/.test(cwd);
const isScratchName = (name: string) => /^-tmp-claude-\d+(-|$)/.test(name);

/** Whether a recorded cwd is the one a project dir name was made from (long names are truncated). */
function nameMatches(cwd: string, name: string): boolean {
  const enc = claudeDirName(cwd);
  if (enc === name) return true;
  // Claude shortens very long names to a prefix plus a hash suffix.
  const prefix = name.replace(/-[a-z0-9]+$/i, "");
  return name.length >= 100 && prefix.length >= 80 && enc.startsWith(prefix);
}

/**
 * The cwd behind a Claude project dir, or undefined when it can't be known. Session transcripts
 * record it exactly (a cwd only counts if it encodes to this dir's name: sessions can `cd`
 * elsewhere); without one, the name is decoded against the filesystem.
 */
export function claudeDirCwd(projectDir: string): string | undefined {
  const name = basename(projectDir);
  let files: string[] = [];
  try {
    files = readdirSync(projectDir).filter((f) => f.endsWith(".jsonl"));
  } catch {}
  for (const f of files.slice(0, 50)) {
    for (const cwd of transcriptCwds(join(projectDir, f))) if (nameMatches(cwd, name)) return cwd;
  }
  return decodeDirName(name);
}

function transcriptCwds(file: string): string[] {
  try {
    const fd = openSync(file, "r");
    const buf = Buffer.alloc(64 * 1024);
    let n = 0;
    try {
      n = readSync(fd, buf, 0, buf.length, 0);
    } finally {
      closeSync(fd);
    }
    const out = new Set<string>();
    for (const m of buf.subarray(0, n).toString("utf8").matchAll(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
      try {
        out.add(JSON.parse(`"${m[1]}"`));
      } catch {}
      if (out.size > 20) break;
    }
    return [...out];
  } catch {
    return [];
  }
}

const SEPS = ["-", ".", "_", " "];

/**
 * `-home-ubuntu-web-coder` → `/home/ubuntu/web-coder` if that exists. Each `-` may stand for `/`,
 * `-`, `.`, `_` or a space; the path is rebuilt one existing directory at a time. Undefined when
 * no existing directory matches the whole name: never a guess, since a wrong one could file global
 * memory under a repo or one repo's memory under another.
 */
export function decodeDirName(name: string): string | undefined {
  const parts = name.replace(/^-/, "").split("-");
  let budget = 5000; // stat calls; names are short, but a pathological one mustn't spin
  const segs = (i: number, j: number): string[] => {
    let out = [parts[i]!];
    for (let k = i + 1; k < j; k++) out = out.flatMap((s) => SEPS.map((sep) => s + sep + parts[k]));
    return out;
  };
  const walk = (i: number, base: string): string | undefined => {
    if (i >= parts.length) return base;
    for (let j = Math.min(parts.length, i + 5); j > i; j--) {
      for (const seg of segs(i, j)) {
        if (!seg || seg.includes("/") || --budget < 0) continue;
        const p = join(base, seg);
        let isDir = false;
        try {
          isDir = statSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false;
        } catch {}
        if (isDir) {
          const rest = walk(j, p);
          if (rest) return rest;
        }
      }
    }
    return undefined;
  };
  return walk(0, "/");
}

export type ClaudeProjectScope = { kind: "global" } | { kind: "scratch" } | { kind: "repo"; key: string; cwd?: string };

/**
 * Where a Claude project dir's memory belongs. The home dir is global (matched by name first, so
 * it holds whatever the home path looks like); scratchpads are skipped; everything else is a
 * repo. A dir whose cwd can't be recovered gets an opaque key of its own
 * (`claude-project:<dir name>`): never global, never merged into another repo by a wrong guess.
 */
export async function claudeProjectScope(projectDir: string): Promise<ClaudeProjectScope> {
  const name = basename(projectDir);
  if (name === claudeDirName(home())) return { kind: "global" };
  if (isScratchName(name)) return { kind: "scratch" };
  const cwd = claudeDirCwd(projectDir);
  if (!cwd) return { kind: "repo", key: `claude-project:${name}` };
  if (isHome(cwd)) return { kind: "global" };
  if (isScratch(cwd)) return { kind: "scratch" };
  return { kind: "repo", key: await repoKey(cwd), cwd };
}
