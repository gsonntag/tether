// "Update the runner when all agents idle" (Settings → Updates): off by default. When on, the
// runner fetches origin/main every half hour. When there's a newer commit, it waits until every
// session has been idle for a while (auto.ts's sessionBusy, except that a terminal doesn't hold it:
// tmux outlives a restart). Then it checks the commit out, installs dependencies and test-builds
// the runner. If any step fails, it goes back to the old commit and doesn't try that commit again
// for a day. If they all work, it stops the runner as SIGTERM does; systemd's Restart=always starts
// it again on the new code.
//
// Only a runner that can come back by itself updates: one started by systemd (INVOCATION_ID) from a
// pinned checkout (detached HEAD, no local changes, HEAD an ancestor of origin/main), as the README
// installs it. A dev checkout or a branch is never touched.

import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerUpdateStatus } from "../../../../shared/harnessUpdates";
import type { SessionLook } from "..";
import { childEnv } from "../../childEnv";
import { defaultGit, type GitRunner } from "../../build";
import { sessionBusy, TICK_MS } from "./auto";

/** How often origin/main is fetched. */
export const SELF_CHECK_EVERY_MS = 30 * 60_000;
/** How long every session must have been idle before the runner restarts. */
export const SELF_IDLE_FOR_MS = 5 * 60_000;
/** A commit whose update failed isn't tried again for this long. */
export const SELF_FAILED_BACKOFF_MS = 24 * 60 * 60_000;
const BRANCH = "main";
/** The runner's entry points: its own, and the scripts it starts as processes of their own. */
const BUILD_ENTRIES = ["src/index.ts", "src/adapters/codex/privateHost.ts", "src/modules/peers/mcp.ts"];
const OUTPUT_KEEP = 2000;

export type Run = (argv: string[], cwd: string, timeoutMs?: number) => Promise<{ code: number; output: string }>;

/** Runs a command with secrets stripped from its environment: its exit code and the end of its output. */
export const defaultRun: Run = async (argv, cwd, timeoutMs = 10 * 60_000) => {
  try {
    const p = Bun.spawn(argv, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: childEnv({ CI: "1" }) });
    const timer = setTimeout(() => p.kill(), timeoutMs);
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    const code = await p.exited;
    clearTimeout(timer);
    return { code, output: `${out}${err}`.slice(-OUTPUT_KEEP) };
  } catch (e) {
    return { code: -1, output: (e as Error)?.message ?? String(e) };
  }
};

/** Why the runner isn't idle for a restart ("2 sessions are busy"), or undefined when it is. */
export function restartBusy(looks: SessionLook[]): string | undefined {
  const busy = looks.map((l) => ({ l, why: sessionBusy(l) })).filter((b) => b.why && b.why !== "open in a terminal");
  if (!busy.length) return undefined;
  if (busy.length > 1) return `${busy.length} sessions are busy`;
  const { l, why } = busy[0]!;
  return `"${l.summary.title || "Untitled"}" is ${why}`;
}

interface Saved {
  enabled?: boolean;
  lastCheckAt?: number;
  last?: RunnerUpdateStatus["last"];
  /** the commit that failed to update, and when */
  failed?: { commit: string; at: number };
  /** set just before the restart: the next start says whether it came back on `to` */
  restarting?: { from: string; to: string; at: number };
}

export interface SelfUpdaterOptions {
  /** the repo checkout the runner runs from */
  repo: string;
  /** every session in memory */
  looks: () => SessionLook[];
  /** a harness auto-update is installing: no restart under it */
  otherBusy?: () => boolean;
  /** why this runner can't update itself, or undefined when it can (systemd, from a pinned checkout) */
  supported?: () => string | undefined;
  /** stops the runner (it comes back on the new code) */
  restart: () => void;
  file?: string;
  git?: GitRunner;
  run?: Run;
  /** the bun to install and test-build with */
  bun?: string;
  now?: () => number;
  log?: (line: string) => void;
}

export class SelfUpdater {
  private saved: Saved = {};
  private available?: { commit: string; behind: number };
  private current?: string;
  private unsupported?: string;
  private idleSince?: number;
  private waiting?: RunnerUpdateStatus["waiting"];
  private ticking = false;
  private timer?: ReturnType<typeof setInterval>;
  private now: () => number;
  private git: GitRunner;
  private run: Run;

  constructor(private o: SelfUpdaterOptions) {
    this.now = o.now ?? Date.now;
    this.git = o.git ?? defaultGit;
    this.run = o.run ?? defaultRun;
    if (o.file && existsSync(o.file)) {
      try {
        const s = JSON.parse(readFileSync(o.file, "utf8"));
        if (s && typeof s === "object") this.saved = s;
      } catch {}
    }
  }

  status(): RunnerUpdateStatus {
    const why = this.unsupported ?? this.o.supported?.();
    return {
      enabled: this.saved.enabled === true,
      ...(this.current ? { commit: this.current } : {}),
      ...(why ? { unsupported: why } : {}),
      ...(this.available ? { available: this.available } : {}),
      ...(this.waiting && this.saved.enabled ? { waiting: this.waiting } : {}),
      ...(this.saved.last ? { last: this.saved.last } : {}),
    };
  }

  set(on: boolean): RunnerUpdateStatus {
    this.saved.enabled = on;
    if (!on) this.waiting = undefined;
    // Turned on: look at the next tick, not half an hour from the last look.
    else delete this.saved.lastCheckAt;
    this.save();
    return this.status();
  }

  /** At start: what the last restart for an update came back on, then a tick every TICK_MS. */
  async start(): Promise<() => void> {
    this.current = await this.head();
    const r = this.saved.restarting;
    if (r) {
      delete this.saved.restarting;
      const ok = !!this.current && r.to.startsWith(this.current);
      this.saved.last = { at: this.now(), from: r.from, to: r.to, ok, ...(ok ? {} : { error: `It came back on ${this.current ?? "an unknown commit"}.` }) };
      this.save();
      this.o.log?.(`runner update: ${ok ? `restarted on ${short(r.to)} (from ${short(r.from)})` : `expected ${short(r.to)} after the restart, running ${this.current ?? "unknown"}`}`);
    }
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref?.();
    void this.tick();
    return () => clearInterval(this.timer);
  }

  /** One look: fetch when due, then, with a newer commit and every session idle long enough, update. */
  async tick(): Promise<void> {
    if (!this.saved.enabled || this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      if (!this.saved.lastCheckAt || now - this.saved.lastCheckAt >= SELF_CHECK_EVERY_MS) {
        this.saved.lastCheckAt = now;
        this.save();
        await this.check();
      }
      if (!this.available) return void (this.waiting = undefined);
      const f = this.saved.failed;
      if (f && f.commit === this.available.commit && now - f.at < SELF_FAILED_BACKOFF_MS) return void (this.waiting = undefined);
      const why = restartBusy(this.o.looks()) ?? (this.o.otherBusy?.() ? "a harness is updating" : undefined);
      if (why) {
        this.idleSince = undefined;
        this.waiting = { since: this.waiting?.since ?? now, why };
        return;
      }
      this.idleSince ??= now;
      if (now - this.idleSince < SELF_IDLE_FOR_MS) {
        this.waiting = { since: this.waiting?.since ?? now, why: "all agents are idle; waiting a few minutes in case one starts again" };
        return;
      }
      this.waiting = undefined;
      await this.apply(this.available.commit);
    } catch (e) {
      this.o.log?.(`runner update: ${(e as Error)?.message ?? e}`);
    } finally {
      this.ticking = false;
    }
  }

  private async head(): Promise<string | undefined> {
    const r = await this.git(["rev-parse", "HEAD"], this.o.repo);
    return r.code === 0 ? r.stdout.trim() || undefined : undefined;
  }

  /** Fetches origin/main and notes a newer commit, or why this checkout can't take one. */
  private async check() {
    this.available = undefined;
    this.unsupported = this.o.supported?.();
    if (this.unsupported) return;
    const branch = await this.git(["branch", "--show-current"], this.o.repo);
    if (branch.code === 0 && branch.stdout.trim()) return void (this.unsupported = `The runner runs from the branch ${branch.stdout.trim()}, not a pinned checkout.`);
    const status = await this.git(["status", "--porcelain", "--untracked-files=no"], this.o.repo);
    if (status.code !== 0 || status.stdout.trim()) return void (this.unsupported = "The runner's checkout has local changes.");
    if ((await this.git(["fetch", "--quiet", "origin", BRANCH], this.o.repo, 60_000)).code !== 0) throw new Error(`couldn't fetch origin ${BRANCH}`);
    const head = (this.current = await this.head());
    const target = await this.git(["rev-parse", `origin/${BRANCH}`], this.o.repo);
    const commit = target.code === 0 ? target.stdout.trim() : "";
    if (!head || !commit || head === commit) return;
    if ((await this.git(["merge-base", "--is-ancestor", head, commit], this.o.repo)).code !== 0) return void (this.unsupported = `The runner's commit isn't on origin/${BRANCH}.`);
    const count = await this.git(["rev-list", "--count", `${head}..${commit}`], this.o.repo);
    this.available = { commit, behind: Math.max(1, parseInt(count.stdout.trim(), 10) || 1) };
  }

  /** Checks out `to`, installs and test-builds; restarts on success, goes back on failure. */
  private async apply(to: string) {
    const from = await this.head();
    if (!from) throw new Error("couldn't read the runner's commit");
    // Something may have started during the fetch.
    if (restartBusy(this.o.looks())) return void (this.idleSince = undefined);
    this.o.log?.(`runner update: updating ${short(from)} → ${short(to)}`);
    const fail = async (step: string, output: string) => {
      const back = await this.checkout(from);
      const error = `${step} failed${back ? "" : `, and going back to ${short(from)} failed too`}`;
      this.saved.failed = { commit: to, at: this.now() };
      this.saved.last = { at: this.now(), from, to, ok: false, error, output };
      this.available = undefined;
      this.save();
      this.o.log?.(`runner update: ${error}; it stays on ${short(from)}. ${output.trim().split("\n").slice(-5).join(" | ")}`);
    };
    const co = await this.git(["checkout", "--quiet", "--detach", to], this.o.repo, 60_000);
    if (co.code !== 0) return fail("git checkout", co.stdout);
    const installed = await this.install();
    if (installed.code !== 0) return fail("bun install", installed.output);
    const built = await this.testBuild();
    if (built.code !== 0) return fail("the test build", built.output);
    // The last look: a turn may have started while it installed. Then it goes back, and tries again
    // at the next idle: the scripts this runner starts (privateHost.ts, mcp.ts) must match it.
    if (restartBusy(this.o.looks())) {
      this.idleSince = undefined;
      const back = await this.checkout(from);
      this.o.log?.(`runner update: a session started while ${short(to)} installed; ${back ? `back on ${short(from)} until the next idle` : `going back to ${short(from)} failed`}`);
      if (!back) {
        this.saved.failed = { commit: to, at: this.now() };
        this.saved.last = { at: this.now(), from, to, ok: false, error: `a session started during the update, and going back to ${short(from)} failed` };
        this.save();
      }
      return;
    }
    this.saved.restarting = { from, to, at: this.now() };
    this.save();
    this.o.log?.(`runner update: restarting on ${short(to)}`);
    this.o.restart();
  }

  private async checkout(commit: string): Promise<boolean> {
    if ((await this.git(["checkout", "--quiet", "--detach", commit], this.o.repo, 60_000)).code !== 0) return false;
    return (await this.install()).code === 0;
  }

  private async install() {
    const bun = this.o.bun ?? process.execPath;
    let last = { code: 0, output: "" };
    for (const dir of ["shared", "runner"]) {
      if (!existsSync(join(this.o.repo, dir, "package.json"))) continue;
      last = await this.run([bun, "install", "--frozen-lockfile"], join(this.o.repo, dir));
      if (last.code !== 0) return last;
    }
    return last;
  }

  /** Bundles the runner's entry points: a missing module or package or a syntax error fails here, not at the restart. */
  private async testBuild() {
    const out = mkdtempSync(join(tmpdir(), "tether-runner-build-"));
    try {
      const entries = BUILD_ENTRIES.filter((e) => existsSync(join(this.o.repo, "runner", e)));
      return await this.run([this.o.bun ?? process.execPath, "build", ...entries, "--target=bun", `--outdir=${out}`], join(this.o.repo, "runner"), 5 * 60_000);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }

  private save() {
    if (!this.o.file) return;
    try {
      const tmp = `${this.o.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.saved), { mode: 0o600 });
      renameSync(tmp, this.o.file);
    } catch (e) {
      this.o.log?.(`runner update: couldn't save: ${(e as Error)?.message ?? e}`);
    }
  }
}

const short = (c: string) => c.slice(0, 7);
