// Repo keys: one name for a repository however it is checked out. The normalized git remote URL
// when there is one, else the main checkout's absolute path; worktrees resolve through
// `git rev-parse --git-common-dir`, so `foliation-wt/*` and `foliation` share a key. Paths that
// no longer exist (old Claude project dirs) key by the path itself.

import { existsSync, openSync, readSync, closeSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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

export async function repoKey(path: string): Promise<string> {
  const abs = resolve(path);
  const hit = cache.get(abs);
  if (hit) return hit;
  let key = abs;
  if (existsSync(abs)) {
    const remotes = (await git(abs, ["remote"]))?.split("\n").filter(Boolean) ?? [];
    const remote = remotes.includes("origin") ? "origin" : remotes[0];
    const url = remote ? await git(abs, ["remote", "get-url", remote]) : undefined;
    if (url) key = normalizeRemote(url);
    else {
      const common = await git(abs, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
      if (common) key = common.endsWith("/.git") ? dirname(common) : common;
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

/** Claude's project dir name for a cwd: every `/` and `.` becomes `-`. */
export const claudeDirName = (cwd: string) => resolve(cwd).replace(/[/.]/g, "-");

/**
 * The cwd behind a Claude project dir. Session transcripts record it exactly; without one, the
 * name is decoded against the filesystem (dashes are ambiguous), falling back to plain `/`s.
 */
export function claudeDirCwd(projectDir: string): string {
  try {
    for (const f of readdirSync(projectDir)) {
      if (!f.endsWith(".jsonl")) continue;
      const cwd = firstCwd(join(projectDir, f));
      if (cwd) return cwd;
    }
  } catch {}
  return decodeDirName(projectDir.split("/").pop()!);
}

function firstCwd(file: string): string | undefined {
  try {
    const fd = openSync(file, "r");
    const buf = Buffer.alloc(64 * 1024);
    const n = readSync(fd, buf, 0, buf.length, 0);
    closeSync(fd);
    const m = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(buf.subarray(0, n).toString("utf8"));
    return m ? JSON.parse(`"${m[1]}"`) : undefined;
  } catch {
    return undefined;
  }
}

/** `-home-ubuntu-web-coder` → `/home/ubuntu/web-coder` when that exists, else `/home/ubuntu/web/coder`. */
export function decodeDirName(name: string): string {
  const parts = name.replace(/^-/, "").split("-");
  const walk = (i: number, base: string): string | undefined => {
    if (i >= parts.length) return base;
    // Greedily try the longest segment that exists (with '-' or '.' joins), then shorter ones.
    for (let j = parts.length; j > i; j--) {
      for (const sep of ["-", "."]) {
        const seg = parts.slice(i, j).join(sep);
        if (!seg) continue;
        const p = join(base, seg);
        try {
          if (statSync(p).isDirectory()) {
            const rest = walk(j, p);
            if (rest) return rest;
          }
        } catch {}
        if (j - i === 1) break; // single part: separators don't matter
      }
    }
    return undefined;
  };
  return walk(0, "/") ?? "/" + parts.join("/");
}
