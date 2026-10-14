// New projects: a fresh folder (git init), optionally with a GitHub repo made through the `gh` CLI,
// and the GitHub account `gh` is logged in to, for picking a repo to clone.

import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const NAME = /^[A-Za-z0-9_.-]+$/;
/** A GitHub user or organization login. */
const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
/** gh calls must finish inside the relay's RPC timeout (server RPC_TIMEOUT_MS, 120 s), follow-ups included. */
const GH_TIMEOUT_MS = 60_000;
const QUICK_TIMEOUT_MS = 15_000;

/** A folder / repo name GitHub would accept as is (and gh won't read as a flag). */
export function checkName(name: string): string {
  const n = name.trim();
  if (!n || !NAME.test(n) || n.startsWith(".") || n.startsWith("-") || n.length > 100 || /\.git$/i.test(n))
    throw new Error(`"${n}" can't be a project name. Use up to 100 letters, digits, - _ and ., not starting with - or . or ending in .git`);
  return n;
}

/** A GitHub account or organization name. */
export function checkOwner(owner: string): string {
  if (!OWNER.test(owner)) throw new Error(`"${owner}" isn't a GitHub account or organization`);
  return owner;
}

export type Run = (cmd: string[], o?: { cwd?: string; timeout?: number }) => Promise<string>;

const run: Run = async (cmd, { cwd, timeout = GH_TIMEOUT_MS } = {}) => {
  const proc = Bun.spawn(cmd, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" } });
  const timer = setTimeout(() => proc.kill(), timeout);
  const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  clearTimeout(timer);
  if (code !== 0) {
    const why = err.split("\n").map((l) => l.trim()).filter(Boolean).slice(-2).join(" ");
    throw new Error(`${cmd.slice(0, 3).join(" ")} failed: ${why || (proc.signalCode ? "timed out" : `exit ${code}`)}`);
  }
  return out;
};

/** An empty or missing folder is fine to start a project in; anything else is somebody's files. */
function freeFolder(dir: string) {
  if (!existsSync(dir)) return;
  if (!statSync(dir).isDirectory()) throw new Error(`${dir} already exists and isn't a folder`);
  if (readdirSync(dir).length) throw new Error(`${dir} already exists and isn't empty. Add it as an existing folder instead.`);
}

/**
 * `gh repo create` for `dir`. gh can make the repo and still fail or time out after (slow network):
 * then the repo is there and empty, and it's taken as made, with origin added if gh didn't get to it.
 */
async function makeRepo(dir: string, repo: string, isPrivate: boolean, exec: Run) {
  try {
    await exec(["gh", "repo", "create", repo, isPrivate ? "--private" : "--public", "--source", dir, "--remote", "origin"], { cwd: dir });
    return;
  } catch (e) {
    const made = await exec(["gh", "repo", "view", repo, "--json", "url,sshUrl,isEmpty"], { timeout: QUICK_TIMEOUT_MS }).then(
      (j) => JSON.parse(j) as { url: string; sshUrl: string; isEmpty: boolean },
      () => undefined,
    );
    if (!made) throw e;
    if (!made.isEmpty) throw new Error(`${repo} already exists on GitHub. Clone it instead, or pick another name.`);
    if (await exec(["git", "remote", "get-url", "origin"], { cwd: dir }).then(() => true, () => false)) return;
    const ssh = (await exec(["gh", "config", "get", "git_protocol"], { timeout: QUICK_TIMEOUT_MS }).catch(() => "")).trim() === "ssh";
    await exec(["git", "remote", "add", "origin", ssh ? made.sshUrl : `${made.url}.git`], { cwd: dir });
  }
}

/**
 * Creates `parent/name` with `git init`, and with `github` set a GitHub repo of that name (under
 * `owner`, default the logged-in account) set as its origin. Returns the folder. If GitHub fails,
 * the folder it just made is removed again, so trying again starts clean.
 */
export async function createProject(o: { name: string; parent: string; github?: { owner?: string; private: boolean } }, exec: Run = run): Promise<string> {
  const name = checkName(o.name);
  if (o.github?.owner) checkOwner(o.github.owner);
  const dir = join(resolve(o.parent), name);
  freeFolder(dir);
  const made = !existsSync(dir);
  mkdirSync(dir, { recursive: true });
  try {
    await exec(["git", "init", "-q", "-b", "main"], { cwd: dir });
    if (o.github) await makeRepo(dir, o.github.owner ? `${o.github.owner}/${name}` : name, o.github.private, exec);
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

/** The account `gh` is logged in to, or undefined (no gh, or not logged in). Both calls at once, well inside the relay's timeout. */
export async function githubAccount(): Promise<GithubAccount | undefined> {
  if (!Bun.which("gh")) return undefined;
  const [login, orgs] = await Promise.all([
    run(["gh", "api", "user", "--jq", ".login"], { timeout: QUICK_TIMEOUT_MS }).then((s) => s.trim(), () => ""),
    run(["gh", "api", "user/orgs", "--jq", ".[].login"], { timeout: QUICK_TIMEOUT_MS }).catch(() => ""),
  ]);
  return login ? { login, orgs: orgs.split("\n").filter(Boolean) } : undefined;
}

export interface GithubRepo {
  nameWithOwner: string;
  description?: string;
  isPrivate: boolean;
  updatedAt: string;
}

/** Repos of `owner` (default the logged-in account), most recently updated first. */
export async function githubRepos(owner?: string): Promise<GithubRepo[]> {
  const out = await run(["gh", "repo", "list", ...(owner ? [checkOwner(owner)] : []), "--limit", "1000", "--json", "nameWithOwner,description,isPrivate,updatedAt"]);
  const repos = JSON.parse(out) as GithubRepo[];
  return repos.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
