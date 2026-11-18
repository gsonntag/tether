// GitHub through `gh` (SPEC §10 Git actions): a session's PR and Open PR. gh as an argv in the repo,
// never prompting, no color, no pager, no update check, with a time limit; GH_REPO and git's location
// variables aren't inherited, so the folder's own remotes decide the repo. gh is asked as little as
// possible: a lookup is cached per session for a minute (`fresh`: unless it's under 10 s old), one in
// flight is shared, and a folder with no origin, or on its default branch with no PR recorded, asks
// nothing. Which PR is the session's: the one recorded when Open PR made it (prs.json, beside the
// module's other files), else the open-or-not PR whose head is the current branch, which is recorded
// then too.

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { outputTail, parsePr, PR_FIELDS, type PrInfo, type PrLookup } from "../../../../shared/gitActions";
import { childEnv } from "../../childEnv";

export const GH_MS = 20_000;
const CREATE_MS = 60_000;
const CACHE_MS = 60_000;
const FRESH_MS = 10_000;
const AUTH_MS = 5 * 60_000;

export interface GhOut {
  code: number;
  out: string;
  err: string;
}

/** `gh <args>` in `cwd`. `bin`: which gh (undefined: none installed). Never throws for an exit code. */
export async function gh(bin: string, cwd: string, args: string[], timeoutMs = GH_MS): Promise<GhOut> {
  const p = Bun.spawn([bin, ...args], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: childEnv({
      GH_PROMPT_DISABLED: "1",
      GH_NO_UPDATE_NOTIFIER: "1",
      GH_SPINNER_DISABLED: "1",
      GH_PAGER: "cat",
      PAGER: "cat",
      NO_COLOR: "1",
      CLICOLOR: "0",
      GIT_TERMINAL_PROMPT: "0",
      GH_REPO: undefined,
      GIT_DIR: undefined,
      GIT_WORK_TREE: undefined,
      GIT_INDEX_FILE: undefined,
      GIT_COMMON_DIR: undefined,
      GIT_CONFIG_PARAMETERS: undefined,
      GIT_CONFIG_COUNT: undefined,
    }),
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    p.kill();
  }, timeoutMs);
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  clearTimeout(timer);
  if (timedOut) return { code: -1, out: "", err: "gh took too long." };
  return { code, out: out.slice(0, 1 << 20), err: err.slice(0, 64 * 1024) };
}

/** What gh's failure means for the chip. */
export function ghTrouble(err: string): Pick<PrLookup, "gh" | "error"> | "none" {
  if (/no (open )?pull requests? found/i.test(err)) return "none";
  if (/gh auth login|not logged in|authentication required|HTTP 401|bad credentials/i.test(err)) return { gh: "unauthed" };
  if (/none of the git remotes|no git remotes|not a git repository|could not determine (base|current) repo|unable to determine/i.test(err)) return { gh: "notGithub" };
  return { gh: "error", error: outputTail(err.trim().split("\n")[0] || "gh failed.", 300) };
}

interface Recorded {
  number: number;
  url: string;
  root: string;
}

export interface PrsOpts {
  dir: string;
  /** the gh to run (tests: a fake); looked up on PATH when absent */
  bin?: () => string | undefined;
  now?: () => number;
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
      this.recorded = JSON.parse(readFileSync(this.file, "utf8")) ?? {};
    } catch {}
  }

  /** The PR recorded for a session (by Open PR or a lookup). */
  of(sessionId: string): Recorded | undefined {
    return this.recorded[sessionId];
  }

  record(sessionId: string, root: string, pr: PrInfo) {
    const had = this.recorded[sessionId];
    if (had && had.number === pr.number && had.url === pr.url && had.root === root) return;
    this.recorded[sessionId] = { number: pr.number, url: pr.url, root };
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.recorded), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
  }

  /** A session's lookup is stale: the next one asks gh. */
  forget(sessionId: string) {
    this.cache.delete(sessionId);
  }

  /** The session's PR: the recorded one, else by branch. Cached (see the top). */
  lookup(sessionId: string, w: { root: string; branch?: string; defaultBranch?: string; origin: boolean }, fresh = false): Promise<PrLookup> {
    // Another folder or branch than the cached answer's is asked again.
    const sig = `${w.root}\0${w.branch ?? ""}\0${w.origin}`;
    const c = this.cache.get(sessionId);
    const age = c && c.sig === sig ? this.now() - c.at : Infinity;
    if (c && age < (fresh ? FRESH_MS : CACHE_MS)) return c.v;
    const v = this.ask(sessionId, w);
    const entry = { at: this.now(), sig, v };
    this.cache.set(sessionId, entry);
    v.catch(() => this.cache.get(sessionId) === entry && this.cache.delete(sessionId));
    return v;
  }

  private async ask(sessionId: string, w: { root: string; branch?: string; defaultBranch?: string; origin: boolean }): Promise<PrLookup> {
    const at = this.now();
    const bin = this.bin();
    if (!bin) return { gh: "missing", at };
    if (!w.origin) return { gh: "noRemote", at };
    const rec = this.recorded[sessionId]?.root === w.root ? this.recorded[sessionId] : undefined;
    const targets = [...(w.branch && w.branch !== w.defaultBranch ? [w.branch] : []), ...(rec ? [String(rec.number)] : [])];
    for (const t of targets) {
      const r = await gh(bin, w.root, ["pr", "view", t, "--json", PR_FIELDS]);
      if (r.code === 0) {
        let pr: PrInfo | undefined;
        try {
          pr = parsePr(JSON.parse(r.out));
        } catch {}
        if (!pr) return { gh: "error", error: "gh answered with something that isn't a PR.", at };
        this.record(sessionId, w.root, pr);
        return { gh: "ok", pr, at };
      }
      const why = ghTrouble(r.err);
      if (why !== "none") return { ...why, at };
    }
    return { gh: "ok", at };
  }

  /** Whether gh is signed in for the repo's host (cached a few minutes). */
  signedIn(bin: string, root: string): Promise<boolean> {
    const c = this.auth.get(bin);
    if (c && this.now() - c.at < AUTH_MS) return c.ok;
    const ok = gh(bin, root, ["auth", "status"]).then((r) => r.code === 0);
    this.auth.set(bin, { at: this.now(), ok });
    return ok;
  }

  /** `gh pr create`, then the PR as gh shows it, recorded as the session's. */
  async create(sessionId: string, root: string, a: { base: string; head: string; title: string; body: string }): Promise<{ pr?: PrInfo; error?: string; output?: string }> {
    const bin = this.bin();
    if (!bin) return { error: "gh isn't installed on this computer. Install GitHub's gh and run gh auth login there." };
    if (!(await this.signedIn(bin, root))) {
      this.auth.delete(bin);
      return { error: "gh isn't signed in on this computer. Run gh auth login there." };
    }
    this.forget(sessionId);
    const r = await gh(bin, root, ["pr", "create", "--base", a.base, "--head", a.head, "--title", a.title, "--body", a.body], CREATE_MS);
    const url = r.out.trim().split("\n").reverse().find((l) => /^https?:\/\//.test(l.trim()))?.trim();
    const exists = r.code !== 0 && r.err.match(/already exists[^\n]*?(https?:\/\/\S+)/i)?.[1];
    const target = url ?? exists;
    if (!target) {
      const why = ghTrouble(r.err);
      return { error: why !== "none" && why.gh === "unauthed" ? "gh isn't signed in on this computer. Run gh auth login there." : "gh couldn't open the PR.", output: outputTail(r.err || r.out) };
    }
    const v = await gh(bin, root, ["pr", "view", target, "--json", PR_FIELDS]);
    let pr: PrInfo | undefined;
    try {
      pr = v.code === 0 ? parsePr(JSON.parse(v.out)) : undefined;
    } catch {}
    pr ??= { number: Number(target.match(/\/pull\/(\d+)/)?.[1] ?? 0), url: target, title: a.title, state: "open", checks: "none", branch: a.head };
    this.record(sessionId, root, pr);
    return exists ? { pr, error: `There's already a PR for ${a.head}: #${pr.number}.` } : { pr };
  }
}
