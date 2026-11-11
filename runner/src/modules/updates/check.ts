// The harness update checker: installed versions (`<bin> --version`, or a bundled package's
// package.json), the newest release (the npm registry's dist-tags), how each was installed, and
// updates run one at a time in the background (an npm install can outlast an rpc).
//
// Nothing here stops a session: Claude's native installer and npm keep the old files of a running
// process (a new version goes in beside it, or replaces files a running process still holds open),
// so live sessions go on with the version they started with.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { compareVersions, parseVersion, updateStatus, type HarnessReport, type HarnessVersion, type UpdateRun } from "../../../../shared/harnessUpdates";
import { bundledPackageJson, commandLine, detectInstall, effectNote, updatePlan, type HarnessSpec, type Install, type UpdatePlan } from "./install";

export const HARNESS_SPECS: HarnessSpec[] = [
  { id: "claude", name: "Claude Code", pkg: "@anthropic-ai/claude-code", bin: process.env.CLAUDE_BIN || "claude", brew: "claude-code" },
  { id: "codex", name: "Codex", pkg: "@openai/codex", bin: process.env.CODEX_BIN || "codex", brew: "codex" },
  { id: "claude-agent-sdk", name: "Claude Agent SDK", pkg: "@anthropic-ai/claude-agent-sdk" },
];

/** How long a check is reused before the registry is asked again. */
export const CACHE_MS = 5 * 60_000;
const VERSION_TIMEOUT_MS = 15_000;
const REGISTRY_TIMEOUT_MS = 10_000;
const UPDATE_TIMEOUT_MS = 10 * 60_000;
/** How much of an update's output is kept (its end). */
export const OUTPUT_MAX = 16_000;

export interface RunResult {
  code: number | null;
  output: string;
  timedOut: boolean;
}

export interface CheckerDeps {
  /** a binary's path on PATH, or null */
  which(bin: string): string | null;
  realpath(p: string): string;
  /** runs a command; `onOutput` gets stdout and stderr as they come */
  run(argv: string[], opts: { timeoutMs: number; env?: Record<string, string>; onOutput?: (chunk: string) => void }): Promise<RunResult>;
  fetch(url: string, init: { signal: AbortSignal }): Promise<Response>;
  /** a bundled package's installed version */
  bundledVersion(pkg: string): string | undefined;
  /** Claude's update channel ("latest" or "stable", ~/.claude/settings.json autoUpdatesChannel) */
  claudeChannel(): string;
  now(): number;
}

export const realDeps: CheckerDeps = {
  which: (bin) => (bin.includes("/") ? (existsSync(bin) ? bin : null) : Bun.which(bin)),
  realpath: (p) => realpathSync(p),
  run: runCommand,
  fetch: (url, init) => fetch(url, { ...init, headers: { accept: "application/json" } }),
  bundledVersion: (pkg) => {
    try {
      return JSON.parse(readFileSync(bundledPackageJson(pkg), "utf8")).version;
    } catch {
      return undefined;
    }
  },
  claudeChannel: () => {
    try {
      const c = JSON.parse(readFileSync(join(homedir(), ".claude", "settings.json"), "utf8")).autoUpdatesChannel;
      return c === "stable" ? "stable" : "latest";
    } catch {
      return "latest";
    }
  },
  now: () => Date.now(),
};

/** Runs a command with a time limit; never throws (a missing binary is code null). */
export async function runCommand(argv: string[], opts: { timeoutMs: number; env?: Record<string, string>; onOutput?: (chunk: string) => void }): Promise<RunResult> {
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, ...opts.env, NO_COLOR: "1", CI: "1" } });
  } catch (e) {
    return { code: null, output: (e as Error)?.message ?? String(e), timedOut: false };
  }
  let output = "";
  const take = async (s: ReadableStream<Uint8Array>) => {
    const dec = new TextDecoder();
    for await (const chunk of s) {
      const text = dec.decode(chunk, { stream: true });
      output = (output + text).slice(-OUTPUT_MAX);
      opts.onOutput?.(text);
    }
  };
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, opts.timeoutMs);
  // A wrapper's children can hold the pipes open past a kill: don't wait on them after the exit.
  const reading = Promise.all([take(proc.stdout), take(proc.stderr)]).catch(() => {});
  const code = await proc.exited;
  clearTimeout(timer);
  await Promise.race([reading, Bun.sleep(1000)]);
  return { code: timedOut ? null : code, output, timedOut };
}

/** The newest version of a package on a dist-tag, from the npm registry. Throws a short reason. */
export async function latestFromRegistry(pkg: string, tag: string, deps: Pick<CheckerDeps, "fetch">, timeoutMs = REGISTRY_TIMEOUT_MS): Promise<string> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await deps.fetch(`https://registry.npmjs.org/-/package/${pkg}/dist-tags`, { signal: ctl.signal });
    if (!res.ok) throw new Error(`the npm registry answered ${res.status}`);
    const tags = (await res.json()) as Record<string, unknown>;
    const v = tags[tag] ?? tags.latest;
    if (typeof v !== "string" || compareVersions(v, v) === null) throw new Error(`the npm registry has no "${tag}" version`);
    return v;
  } catch (e) {
    if (ctl.signal.aborted) throw new Error(`the npm registry didn't answer in ${Math.round(timeoutMs / 1000)} s`);
    const m = (e as Error)?.message ?? String(e);
    throw new Error(m.startsWith("the npm registry") ? m : `couldn't reach the npm registry (${m})`);
  } finally {
    clearTimeout(timer);
  }
}

interface Found {
  spec: HarnessSpec;
  installed?: string;
  install: Install;
  /** the binary as found on PATH (what an update runs for native installs) */
  bin?: string;
  path?: string;
}

export class UpdateChecker {
  private cache?: { at: number; report: Promise<HarnessReport> };
  private found = new Map<string, Found>();
  private runs = new Map<string, UpdateRun>();
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private deps: CheckerDeps = realDeps,
    private specs: HarnessSpec[] = HARNESS_SPECS,
    private log: (line: string) => void = () => {},
  ) {}

  /** The report, from the cache when it's fresh and not `refresh`. Never throws. */
  async report(refresh = false): Promise<HarnessReport> {
    const now = this.deps.now();
    if (refresh || !this.cache || now - this.cache.at >= CACHE_MS) {
      const report = this.check();
      this.cache = { at: now, report };
      report.catch(() => this.cache?.report === report && (this.cache = undefined));
    }
    return this.withRuns(await this.cache.report);
  }

  private withRuns(r: HarnessReport): HarnessReport {
    return { ...r, harnesses: r.harnesses.map((h) => (this.runs.has(h.id) ? { ...h, update: { ...this.runs.get(h.id)! } } : h)) };
  }

  private async look(spec: HarnessSpec): Promise<Found> {
    if (!spec.bin) {
      const installed = this.deps.bundledVersion(spec.pkg);
      return { spec, installed, install: { method: "bundled" } };
    }
    const bin = this.deps.which(spec.bin);
    if (!bin) return { spec, install: { method: "unknown" } };
    let path = bin;
    try {
      path = this.deps.realpath(bin);
    } catch {}
    const out = await this.deps.run([bin, "--version"], { timeoutMs: VERSION_TIMEOUT_MS });
    const installed = out.code === 0 ? (parseVersion(out.output) ?? undefined) : undefined;
    return { spec, installed, install: detectInstall(path, spec.pkg), bin, path };
  }

  private async check(): Promise<HarnessReport> {
    const rows = await Promise.all(
      this.specs.map(async (spec): Promise<HarnessVersion> => {
        const f = await this.look(spec).catch((): Found => ({ spec, install: { method: "unknown" } }));
        this.found.set(spec.id, f);
        let latest: string | undefined;
        let error: string | undefined;
        if (f.installed) {
          try {
            latest = await latestFromRegistry(spec.pkg, spec.id === "claude" && f.install.method === "native" ? this.deps.claudeChannel() : "latest", this.deps);
          } catch (e) {
            error = (e as Error).message;
          }
        }
        const plan = f.installed ? updatePlan(spec, f.install, latest, f.bin) : undefined;
        return {
          id: spec.id,
          name: spec.name,
          pkg: spec.pkg,
          ...(f.installed ? { installed: f.installed } : {}),
          ...(latest ? { latest } : {}),
          status: updateStatus(f.installed, latest),
          method: f.install.method,
          ...(f.path ? { path: f.path } : {}),
          updatable: !!plan,
          ...(plan ? { command: commandLine(plan) } : {}),
          ...(f.installed ? { note: effectNote(spec, f.install.method) } : {}),
          ...(error ? { error } : {}),
        };
      }),
    );
    return { checkedAt: this.deps.now(), harnesses: rows };
  }

  /**
   * Starts updating a harness (after any update already going) and answers at once with the
   * report; the run shows on its row until the next one. Throws when it can't be updated here.
   */
  async update(id: string): Promise<HarnessReport> {
    const report = await this.report();
    const row = report.harnesses.find((h) => h.id === id);
    if (!row) throw new Error(`There's no harness "${id}".`);
    const prev = this.runs.get(id);
    if (prev && (prev.state === "queued" || prev.state === "running")) return report;
    const f = this.found.get(id);
    if (!f?.installed) throw new Error(`${row.name} isn't installed on this runner.`);
    if (row.status === "current") throw new Error(`${row.name} is up to date.`);
    if (f.install.method === "bundled") throw new Error(`${row.name} is part of Tether's runner: it updates with a Tether release.`);
    const plan = updatePlan(f.spec, f.install, row.latest, f.bin);
    if (!plan) throw new Error(`${row.name} was installed in a way Tether can't update. Update it on the machine.`);
    const run: UpdateRun = { state: "queued", startedAt: this.deps.now(), output: "", command: commandLine(plan), from: f.installed };
    this.runs.set(id, run);
    this.chain = this.chain.then(() => this.execute(f, plan, run));
    return this.withRuns(report);
  }

  private async execute(f: Found, plan: UpdatePlan, run: UpdateRun): Promise<void> {
    run.state = "running";
    run.startedAt = this.deps.now();
    this.log(`updating ${f.spec.name}: ${run.command}`);
    try {
      const r = await this.deps.run(plan.argv, { timeoutMs: UPDATE_TIMEOUT_MS, env: plan.env, onOutput: (t) => (run.output = (run.output + t).slice(-OUTPUT_MAX)) });
      run.output = r.output;
      // The version it's at now, looked up fresh; the next report checks everything again.
      const after = await this.look(f.spec).catch(() => undefined);
      if (after?.installed) run.to = after.installed;
      if (r.timedOut) throw new Error(`It didn't finish in ${UPDATE_TIMEOUT_MS / 60_000} minutes and was stopped.`);
      if (r.code !== 0) throw new Error(r.code === null ? "It couldn't start." : `It exited with code ${r.code}.`);
      run.state = "done";
      this.log(`${f.spec.name} updated: ${run.from} → ${run.to ?? "?"}`);
    } catch (e) {
      run.state = "failed";
      run.error = (e as Error)?.message ?? String(e);
      this.log(`${f.spec.name} update failed: ${run.error}`);
    } finally {
      run.endedAt = this.deps.now();
      // The next report checks again; the runner's own harness list (what browsers see) catches up
      // within its minute.
      this.cache = undefined;
    }
  }
}
