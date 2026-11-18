// GitHub through `gh` (SPEC §10 Git actions): a session's PR and Open PR. gh as an argv in the repo,
// never prompting, no color, no pager, no update check, in its own process group with a time limit
// (the group is killed, and its pipes not waited on, past it); GH_REPO and git's location variables
// aren't inherited, and the repo is named from origin's URL (`--repo`), so nothing else decides it.
// gh is asked as little as possible: a lookup is cached per session for a minute (`fresh`: unless it's
// under 10 s old), one in flight is shared, and a folder with no origin, or on its default branch with
// no PR recorded, asks nothing. Which PR is the session's: the one recorded (Open PR made it, or an
// earlier lookup found it; prs.json beside the module's other files), unless the session is on
// another branch that has a PR of its own (`owner:branch` in origin's repo), which is recorded then.
// Records not looked at for 30 days (sessions gone or archived) are dropped, and at most 500 kept.

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { outputTail, parsePr, PR_FIELDS, type PrInfo, type PrLookup } from "../../../../shared/gitActions";
import { childEnv } from "../../childEnv";
import { killGroup } from "./run";

export const GH_MS = 20_000;
export const CREATE_MS = 60_000;
const CACHE_MS = 60_000;
const FRESH_MS = 10_000;
const AUTH_MS = 5 * 60_000;
const KEEP_MS = 30 * 24 * 60 * 60_000;
const KEEP_MAX = 500;
const TOUCH_MS = 24 * 60 * 60_000;

export interface GhOut {
  code: number;
  out: string;
  err: string;
}

/** `gh <args>` in `cwd`. `bin`: which gh. Never throws for an exit code; a timeout is code -1. */
export async function gh(bin: string, cwd: string, args: string[], timeoutMs = GH_MS): Promise<GhOut> {
  const p = Bun.spawn([bin, ...args], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
    env: childEnv({
      GH_PROMPT_DISABLED: "1",
      GH_NO_UPDATE_NOTIFIER: "1",
      GH_SPINNER_DISABLED: "1",
      GH_PAGER: "cat",
      PAGER: "cat",
      NO_COLOR: "1",
      CLICOLOR: "0",
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "never",
      GH_REPO: undefined,
      GIT_DIR: undefined,
      GIT_WORK_TREE: undefined,
      GIT_INDEX_FILE: undefined,
      GIT_COMMON_DIR: undefined,
      GIT_CONFIG_PARAMETERS: undefined,
      GIT_CONFIG_COUNT: undefined,
    }),
  });
  let stopNow!: () => void;
  const stop = new Promise<void>((r) => (stopNow = r));
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup(p);
    stopNow();
  }, timeoutMs);
  const all = Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  const r = await Promise.race([all, stop.then(() => undefined)]);
  clearTimeout(timer);
  if (timedOut || !r) return { code: -1, out: "", err: "gh took too long." };
  const [out, err, code] = r;
  return { code, out: out.slice(0, 1 << 20), err: err.slice(0, 64 * 1024) };
}

/** What gh's failure means for the chip. */
export function ghTrouble(err: string): Pick<PrLookup, "gh" | "error"> | "none" {
  if (/no (open )?pull requests? found/i.test(err)) return "none";
  if (/gh auth login|not logged in|authentication required|HTTP 401|bad credentials/i.test(err)) return { gh: "unauthed" };
  if (/none of the git remotes|no git remotes|not a git repository|could not determine (base|current) repo|unable to determine/i.test(err)) return { gh: "notGithub" };
  return { gh: "error", error: outputTail(err.trim().split("\n")[0] || "gh failed.", 300) };
}

export interface Origin {
  host: string;
  owner: string;
  repo: string;
}

/** origin's URL as a GitHub-style repo (https, ssh or scp-like); undefined when it isn't one. Credentials in it are never kept. */
export function parseOrigin(url: string): Origin | undefined {
  const u = url.trim();
  let host: string | undefined;
  let path: string | undefined;
  const scp = !u.includes("://") && u.match(/^(?:[^@/]+@)?([^:/]+):(.+)$/);
  if (scp) [host, path] = [scp[1], scp[2]];
  else {
    try {
      const x = new URL(u);
      if (!/^(https?|ssh|git):$/.test(x.protocol)) return undefined;
      [host, path] = [x.hostname, x.pathname];
    } catch {
      return undefined;
    }
  }
  const m = path?.replace(/^\/+|\/+$/g, "").match(/^([^/]+)\/([^/]+?)(?:\.git)?$/);
  return host && m ? { host: host.toLowerCase(), owner: m[1]!, repo: m[2]! } : undefined;
}

/** `--repo` for gh: OWNER/REPO on github.com, HOST/OWNER/REPO elsewhere. */
export const repoArg = (o: Origin) => (o.host === "github.com" ? `${o.owner}/${o.repo}` : `${o.host}/${o.owner}/${o.repo}`);

/** gh's text when a PR for the branch is there already: the URL is on the line after. */
export const existingPrUrl = (err: string) => err.match(/already exists[\s\S]*?(https?:\/\/\S+\/pull\/\d+)/i)?.[1];

interface Recorded {
  number: number;
  url: string;
  root: string;
  /** when it was last looked up or made (ms) */
  at: number;
}

export interface PrsOpts {
  dir: string;
  /** the gh to run (tests: a fake); looked up on PATH when absent */
  bin?: () => string | undefined;
  now?: () => number;
}

export interface Where {
  root: string;
  branch?: string;
  defaultBranch?: string;
  /** origin's URL; none: no origin */
  originUrl?: string;
}

export class Prs {
  private recorded: Record<string, Recorded> = {};
  private cache = new Map<string, { at: number; sig: string; v: Promise<PrLookup> }>();
  private auth = new Map<string, { at: number; ok: Promise<boolean> }>();
  private file: string;
  private now: () => number;
  readonly bin: () => string | undefined;

  constructor(o: PrsOpts) {
    mkdirSync(o.dir, { recursive: true });
    this.file = join(o.dir, "prs.json");
    this.now = o.now ?? Date.now;
    this.bin = o.bin ?? (() => Bun.which("gh") ?? undefined);
    try {
      const saved = JSON.parse(readFileSync(this.file, "utf8"));
      if (saved && typeof saved === "object") this.recorded = saved;
    } catch {}
    if (this.prune()) this.save();
  }

  /** Drops records not looked at for KEEP_MS, and past KEEP_MAX the oldest. True when it dropped any. */
  private prune(): boolean {
    const before = Object.keys(this.recorded).length;
    const keep = Object.entries(this.recorded)
      .filter(([, r]) => r && typeof r.number === "number" && typeof r.at === "number" && this.now() - r.at < KEEP_MS)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, KEEP_MAX);
    this.recorded = Object.fromEntries(keep);
    return keep.length !== before;
  }

  private save() {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.recorded), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
  }

  /** The PR recorded for a session. */
  of(sessionId: string): Recorded | undefined {
    return this.recorded[sessionId];
  }

  record(sessionId: string, root: string, pr: PrInfo) {
    const had = this.recorded[sessionId];
    if (had && had.number === pr.number && had.url === pr.url && had.root === root && this.now() - had.at < TOUCH_MS) return;
    this.recorded[sessionId] = { number: pr.number, url: pr.url, root, at: this.now() };
    this.prune();
    this.save();
  }

  /** A session's lookup is stale: the next one asks gh. */
  forget(sessionId: string) {
    this.cache.delete(sessionId);
  }

  /** The session's PR (see the top). Cached. */
  lookup(sessionId: string, w: Where, fresh = false): Promise<PrLookup> {
    // Another folder or branch than the cached answer's is asked again.
    const sig = `${w.root}\0${w.branch ?? ""}\0${w.originUrl ?? ""}`;
    const c = this.cache.get(sessionId);
    const age = c && c.sig === sig ? this.now() - c.at : Infinity;
    if (c && age < (fresh ? FRESH_MS : CACHE_MS)) return c.v;
    const v = this.ask(sessionId, w);
    const entry = { at: this.now(), sig, v };
    this.cache.set(sessionId, entry);
    v.catch(() => this.cache.get(sessionId) === entry && this.cache.delete(sessionId));
    return v;
  }

  private async view(bin: string, root: string, target: string, origin: Origin | undefined): Promise<{ pr?: PrInfo; trouble?: Pick<PrLookup, "gh" | "error"> }> {
    const r = await gh(bin, root, ["pr", "view", target, "--json", PR_FIELDS, ...(origin ? ["--repo", repoArg(origin)] : [])]);
    if (r.code === 0) {
      try {
        const pr = parsePr(JSON.parse(r.out));
        if (pr) return { pr };
      } catch {}
      return { trouble: { gh: "error", error: "gh answered with something that isn't a PR." } };
    }
    const why = ghTrouble(r.err);
    return why === "none" ? {} : { trouble: why };
  }

  private async ask(sessionId: string, w: Where): Promise<PrLookup> {
    const at = this.now();
    const bin = this.bin();
    if (!bin) return { gh: "missing", at };
    if (!w.originUrl) return { gh: "noRemote", at };
    const origin = parseOrigin(w.originUrl);
    const rec = this.recorded[sessionId]?.root === w.root ? this.recorded[sessionId] : undefined;
    let found: PrInfo | undefined;
    if (rec) {
      const r = await this.view(bin, w.root, String(rec.number), origin);
      if (r.trouble) return { ...r.trouble, at };
      found = r.pr;
    }
    // On another branch than the recorded PR's (not the default one): that branch's own PR, if it has one.
    if (w.branch && w.branch !== w.defaultBranch && found?.branch !== w.branch) {
      const r = await this.view(bin, w.root, origin ? `${origin.owner}:${w.branch}` : w.branch, origin);
      if (r.trouble && !found) return { ...r.trouble, at };
      if (r.pr) found = r.pr;
    }
    if (found) this.record(sessionId, w.root, found);
    return { gh: "ok", ...(found ? { pr: found } : {}), at };
  }

  /** Whether gh is signed in to origin's host (cached a few minutes). */
  signedIn(bin: string, root: string, host: string): Promise<boolean> {
    const key = `${bin}\0${host}`;
    const c = this.auth.get(key);
    if (c && this.now() - c.at < AUTH_MS) return c.ok;
    const ok = gh(bin, root, ["auth", "status", "--hostname", host]).then((r) => r.code === 0);
    this.auth.set(key, { at: this.now(), ok });
    return ok;
  }

  /** `gh pr create` (no `--base`: the repo's own default), then the PR as gh shows it, recorded as the session's. An existing PR for the branch is recorded and named. */
  async create(sessionId: string, root: string, a: { originUrl: string; base?: string; head: string; title: string; body: string }): Promise<{ pr?: PrInfo; error?: string; output?: string }> {
    const bin = this.bin();
    if (!bin) return { error: "gh isn't installed on this computer. Install GitHub's gh and run gh auth login there." };
    const origin = parseOrigin(a.originUrl);
    if (!origin) return { error: "origin isn't a GitHub repository gh can open a PR on." };
    if (!(await this.signedIn(bin, root, origin.host))) {
      this.auth.delete(`${bin}\0${origin.host}`);
      return { error: `gh isn't signed in to ${origin.host} on this computer. Run gh auth login there.` };
    }
    this.forget(sessionId);
    const repo = ["--repo", repoArg(origin)];
    const r = await gh(bin, root, ["pr", "create", ...repo, ...(a.base ? ["--base", a.base] : []), "--head", a.head, "--title", a.title, "--body", a.body], CREATE_MS);
    const url = r.code === 0 ? r.out.trim().split("\n").reverse().find((l) => /^https?:\/\//.test(l.trim()))?.trim() : undefined;
    const exists = r.code !== 0 ? existingPrUrl(r.err) : undefined;
    const target = url ?? exists;
    if (!target) {
      const why = ghTrouble(r.err);
      return { error: why !== "none" && why.gh === "unauthed" ? "gh isn't signed in on this computer. Run gh auth login there." : r.code === -1 ? "gh took too long to open the PR." : "gh couldn't open the PR.", output: outputTail(r.err || r.out) };
    }
    const v = await this.view(bin, root, target, undefined);
    const pr = v.pr ?? { number: Number(target.match(/\/pull\/(\d+)/)?.[1] ?? 0), url: target, title: a.title, state: "open" as const, checks: "none" as const, branch: a.head };
    this.record(sessionId, root, pr);
    return exists ? { pr, error: `There's already a PR for ${a.head}: #${pr.number}. It's this session's PR now.` } : { pr };
  }
}
