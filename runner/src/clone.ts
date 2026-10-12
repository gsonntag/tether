// Cloning a repository into a new project. GitHub repos go over SSH (git@github.com:org/repo.git)
// so the machine's own SSH key is what authenticates, whatever form the URL was typed in.

import { existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

/** Clones must finish inside the relay's RPC timeout (server RPC_TIMEOUT_MS, 120 s). */
const CLONE_TIMEOUT_MS = 110_000;

const NAME = /^[A-Za-z0-9_.-]+$/;

/**
 * The SSH URL and folder name for what was typed: `org/repo`, `github.com/org/repo`,
 * `https://github.com/org/repo(.git)` or `git@github.com:org/repo(.git)`. Any other
 * ssh://, git@host: or https:// URL is cloned as given.
 */
export function parseRepo(input: string): { url: string; name: string } {
  const s = input.trim().replace(/\/+$/, "");
  const gh = s.match(/^(?:(?:https?:\/\/|ssh:\/\/git@|git@)?(?:www\.)?github\.com[:/])?([^/:\s]+)\/([^/:\s]+?)(?:\.git)?$/);
  if (gh && NAME.test(gh[1]!) && NAME.test(gh[2]!) && !gh[2]!.startsWith(".")) {
    return { url: `git@github.com:${gh[1]}/${gh[2]}.git`, name: gh[2]! };
  }
  if (/^(?:ssh|https?|git):\/\/\S+$/.test(s) || /^[\w.-]+@[\w.-]+:\S+$/.test(s)) {
    const name = s.replace(/\.git$/, "").split(/[/:]/).pop() ?? "";
    if (NAME.test(name) && !name.startsWith(".")) return { url: s, name };
  }
  throw new Error(`Not a repository: ${input.trim() || "(empty)"}. Use org/repo or git@github.com:org/repo.git`);
}

function sameRepo(dir: string, url: string): boolean {
  // Only the folder's own repo; `git -C` alone would answer for an enclosing one.
  if (!existsSync(join(dir, ".git"))) return false;
  const origin = Bun.spawnSync(["git", "-C", dir, "remote", "get-url", "origin"]).stdout.toString().trim();
  try {
    return parseRepo(origin).url === url;
  } catch {
    return false;
  }
}

/** Clones into `parent/<repo name>` and returns that directory. An existing clone of the same repo is reused. */
export async function cloneRepo(input: string, parent: string): Promise<string> {
  const { url, name } = parseRepo(input);
  const dest = join(resolve(parent), name);
  if (existsSync(dest)) {
    if (sameRepo(dest, url)) return dest;
    throw new Error(`${dest} already exists`);
  }
  const proc = Bun.spawn(["git", "clone", "--", url, dest], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      // No passphrase or password prompts (nobody can answer them); trust a host seen for the first time.
      GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new",
    },
  });
  const timer = setTimeout(() => proc.kill(), CLONE_TIMEOUT_MS);
  const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  clearTimeout(timer);
  if (code !== 0) {
    rmSync(dest, { recursive: true, force: true });
    if (proc.signalCode) throw new Error(`Cloning ${url} took over ${CLONE_TIMEOUT_MS / 1000} s. Clone it in a terminal, then add the folder.`);
    const lines = err.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("Cloning into"));
    throw new Error(`git clone ${url} failed: ${lines.slice(-3).join(" ") || `exit ${code}`}`);
  }
  return dest;
}
