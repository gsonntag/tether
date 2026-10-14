// New projects: a fresh folder (git init), optionally with a GitHub repo made through the `gh` CLI,
// and the GitHub account `gh` is logged in to, for picking a repo to clone.

import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const NAME = /^[A-Za-z0-9_.-]+$/;
/** gh calls must finish inside the relay's RPC timeout (server RPC_TIMEOUT_MS, 120 s). */
const GH_TIMEOUT_MS = 60_000;

/** A folder / repo name GitHub would accept as is. */
export function checkName(name: string): string {
  const n = name.trim();
  if (!n || !NAME.test(n) || n.startsWith(".")) throw new Error(`"${name.trim()}" can't be a project name. Use letters, digits, - _ and .`);
  return n;
}

async function run(cmd: string[], cwd?: string): Promise<string> {
  const proc = Bun.spawn(cmd, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" } });
  const timer = setTimeout(() => proc.kill(), GH_TIMEOUT_MS);
  const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  clearTimeout(timer);
  if (code !== 0) {
    const why = err.split("\n").map((l) => l.trim()).filter(Boolean).slice(-2).join(" ");
    throw new Error(`${cmd.slice(0, 3).join(" ")} failed: ${why || (proc.signalCode ? "timed out" : `exit ${code}`)}`);
  }
  return out;
}

/** An empty or missing folder is fine to start a project in; anything else is somebody's files. */
function freeFolder(dir: string) {
  if (!existsSync(dir)) return;
  if (!statSync(dir).isDirectory()) throw new Error(`${dir} already exists and isn't a folder`);
  if (readdirSync(dir).length) throw new Error(`${dir} already exists and isn't empty. Add it as an existing folder instead.`);
}

/**
 * Creates `parent/name` with `git init`, and with `github` set a GitHub repo of that name (under
 * `owner`, default the logged-in account) set as its origin. Returns the folder. If GitHub fails,
 * the folder it just made is removed again, so trying again starts clean.
 */
export async function createProject(o: { name: string; parent: string; github?: { owner?: string; private: boolean } }): Promise<string> {
  const name = checkName(o.name);
  const dir = join(resolve(o.parent), name);
  freeFolder(dir);
  const made = !existsSync(dir);
  mkdirSync(dir, { recursive: true });
  try {
    await run(["git", "init", "-q", "-b", "main"], dir);
    if (o.github) {
      const repo = o.github.owner ? `${o.github.owner}/${name}` : name;
      await run(["gh", "repo", "create", repo, o.github.private ? "--private" : "--public", "--source", dir, "--remote", "origin"], dir);
    }
  } catch (e) {
    if (made) rmSync(dir, { recursive: true, force: true });
    else rmSync(join(dir, ".git"), { recursive: true, force: true });
    throw e;
  }
  return dir;
}

export interface GithubAccount {
  login: string;
  orgs: string[];
}

/** The account `gh` is logged in to, or undefined (no gh, or not logged in). */
export async function githubAccount(): Promise<GithubAccount | undefined> {
  if (!Bun.which("gh")) return undefined;
  try {
    const login = (await run(["gh", "api", "user", "--jq", ".login"])).trim();
    if (!login) return undefined;
    const orgs = (await run(["gh", "api", "user/orgs", "--jq", ".[].login"]).catch(() => "")).split("\n").filter(Boolean);
    return { login, orgs };
  } catch {
    return undefined;
  }
}

export interface GithubRepo {
  nameWithOwner: string;
  description?: string;
  isPrivate: boolean;
  updatedAt: string;
}

/** Repos of `owner` (default the logged-in account), most recently updated first. */
export async function githubRepos(owner?: string): Promise<GithubRepo[]> {
  const out = await run(["gh", "repo", "list", ...(owner ? [owner] : []), "--limit", "200", "--json", "nameWithOwner,description,isPrivate,updatedAt"]);
  const repos = JSON.parse(out) as GithubRepo[];
  return repos.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
