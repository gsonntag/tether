// Cloning a repository into a new project. GitHub repos go over SSH (git@github.com:org/repo.git)
// so the machine's own SSH key is what authenticates, whatever form the URL was typed in. Without
// a key GitHub takes, a logged-in GitHub CLI clones it instead (HTTPS).

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
  const deadline = Date.now() + CLONE_TIMEOUT_MS;
  let how = `git clone ${url}`;
  let r = await spawn(["git", "clone", "--", url, dest], deadline);
  // No SSH key GitHub takes: the GitHub CLI's login (HTTPS) may still get in.
  const gh = url.match(/^git@github\.com:(.+)\.git$/)?.[1];
  if (r.code !== 0 && !r.timedOut && gh && sshRefused(r.err) && (await ghLoggedIn())) {
    rmSync(dest, { recursive: true, force: true });
    how = `gh repo clone ${gh}`;
    r = await spawn(["gh", "repo", "clone", gh, dest], deadline);
  }
  if (r.code !== 0) {
    rmSync(dest, { recursive: true, force: true });
    if (r.timedOut) throw new Error(`Cloning ${url} took over ${CLONE_TIMEOUT_MS / 1000} s. Clone it in a terminal, then add the folder.`);
    const lines = r.err.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("Cloning into"));
    throw new Error(`${how} failed: ${lines.slice(-3).join(" ") || `exit ${r.code}`}`);
  }
  return dest;
}

/** git's complaint when GitHub turned the SSH connection away (no key, a key without access, an unknown host). */
export const sshRefused = (err: string) => /Permission denied \(publickey|Host key verification failed|Repository not found|Could not read from remote repository/i.test(err);

async function ghLoggedIn(): Promise<boolean> {
  if (!Bun.which("gh")) return false;
  return (await spawn(["gh", "auth", "status"], Date.now() + 10_000)).code === 0;
}

async function spawn(cmd: string[], deadline: number): Promise<{ code: number; err: string; timedOut: boolean }> {
  const proc = Bun.spawn(cmd, {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GH_PROMPT_DISABLED: "1",
      // No passphrase or password prompts (nobody can answer them); trust a host seen for the first time.
      GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new",
    },
  });
  const timer = setTimeout(() => proc.kill(), Math.max(0, deadline - Date.now()));
  const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  clearTimeout(timer);
  return { code, err, timedOut: !!proc.signalCode };
}
