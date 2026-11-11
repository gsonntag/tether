// Add project (New session dialog): browse the runner's folders for one to start in, or clone a
// GitHub repo into a new one. Cloning always goes over SSH (git@github.com:org/repo.git), so the
// machine's own SSH key is what signs in, whatever form the repo was typed in.

import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CloneStatus, FolderList } from "../../../shared/protocol";
import { parseRepo } from "../../../shared/repo";
import { expandPath } from "./sessions";

const MAX_FOLDERS = 500;

const rooted = (p: string) => {
  const t = p.trim();
  return t.startsWith("/") || t === "~" || t.startsWith("~/");
};

/** The folders inside one folder, by name; dot folders left out. Only reads. */
export function listFolders(path: string): FolderList {
  if (!rooted(path)) throw new Error("Use a full path, like ~/code.");
  const abs = expandPath(path);
  let entries;
  try {
    entries = readdirSync(abs, { withFileTypes: true });
  } catch (e: any) {
    if (e?.code === "ENOENT") throw new Error(`${abs} doesn't exist.`);
    if (e?.code === "ENOTDIR") throw new Error(`${abs} isn't a folder.`);
    if (e?.code === "EACCES" || e?.code === "EPERM") throw new Error(`No permission to read ${abs}.`);
    throw new Error(`Can't read ${abs}: ${e?.message ?? e}`);
  }
  const linkToDir = (name: string) => {
    try {
      return statSync(join(abs, name)).isDirectory();
    } catch {
      return false;
    }
  };
  const folders = entries
    .filter((e) => !e.name.startsWith(".") && (e.isDirectory() || (e.isSymbolicLink() && linkToDir(e.name))))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }));
  const parent = dirname(abs);
  return { path: abs, ...(parent !== abs ? { parent } : {}), folders: folders.slice(0, MAX_FOLDERS), ...(folders.length > MAX_FOLDERS ? { more: true } : {}) };
}

/** Whether `dir` is itself a clone of `url` (not just inside one). */
function sameRepo(dir: string, url: string): boolean {
  if (!existsSync(join(dir, ".git"))) return false;
  const origin = Bun.spawnSync(["git", "-C", dir, "remote", "get-url", "origin"], { stdout: "pipe", stderr: "ignore" }).stdout.toString().trim();
  try {
    return parseRepo(origin).url === url;
  } catch {
    return false;
  }
}

/** How far a running `git clone --progress` is, from its stderr (`Receiving objects:  45% (450/1000)`). */
const PHASES: Record<string, [number, number]> = {
  "Receiving objects": [0, 75],
  "Resolving deltas": [75, 90],
  "Updating files": [90, 100],
};
export function readProgress(line: string): { phase: string; percent?: number; detail?: string } | undefined {
  const m = line.match(/^(?:remote: )?([A-Z][a-z]+(?: [a-z]+)*):\s+(\d+)%/);
  if (!m) return undefined;
  const span = PHASES[m[1]!];
  // Counted in objects, so one big file holds the bar still: how much came, and how fast, says more.
  const bytes = line.match(/,\s*([\d.]+ [KMGT]?i?B)(?:\s*\|\s*([\d.]+ [KMGT]?i?B\/s))?/);
  const detail = bytes ? [bytes[1], bytes[2]].filter(Boolean).join(" · ") : undefined;
  // The server's counting and compressing come first: shown, but not yet part of the bar.
  return { phase: m[1]!, ...(span ? { percent: Math.round(span[0] + ((span[1] - span[0]) * Number(m[2])) / 100) } : {}), ...(detail ? { detail } : {}) };
}

/** A clone's whole life is capped so a stalled connection can't hold one forever. */
export const CLONE_TIMEOUT_MS = 30 * 60_000;
/** A finished clone's status is kept this long for the dialog to read. */
const KEEP_MS = 10 * 60_000;

interface Job {
  status: CloneStatus;
  kill?: () => void;
}

/**
 * Clones run in the background: `start` checks what it can right away and answers with an id,
 * `status` is polled for progress, `cancel` stops one (and removes what it wrote).
 */
export class CloneJobs {
  private jobs = new Map<string, Job>();
  constructor(private o: { timeoutMs?: number; keepMs?: number } = {}) {}

  /**
   * `git clone git@github.com:org/repo.git <path>`; parent folders are made as needed. A folder
   * that is already a clone of the same repo is used as it is; any other existing folder is refused.
   */
  start(repo: string, path: string): { cloneId: string } {
    const { url } = parseRepo(repo);
    if (!rooted(path)) throw new Error("Use a full path, like ~/projects/app.");
    const dest = expandPath(path);
    for (const j of this.jobs.values()) if (j.status.state === "running" && j.status.path === dest) throw new Error(`${dest} is already being cloned.`);
    const cloneId = crypto.randomUUID();
    if (existsSync(dest)) {
      if (!(statSync(dest).isDirectory() && sameRepo(dest, url))) throw new Error(`${dest} already exists. Pick another folder.`);
      this.finish(cloneId, { state: "done", path: dest, percent: 100 });
      return { cloneId };
    }
    const job: Job = { status: { state: "running", path: dest, phase: "Connecting" } };
    this.jobs.set(cloneId, job);
    void this.run(job, url, dest);
    return { cloneId };
  }

  status(cloneId: string): CloneStatus {
    const j = this.jobs.get(cloneId);
    if (!j) throw new Error("That clone is gone. Start it again.");
    return j.status;
  }

  cancel(cloneId: string) {
    const j = this.jobs.get(cloneId);
    if (j?.status.state === "running") {
      j.status = { ...j.status, state: "failed", error: "Canceled." };
      j.kill?.();
    }
  }

  private finish(cloneId: string, status: CloneStatus) {
    this.jobs.set(cloneId, { status });
    setTimeout(() => this.jobs.delete(cloneId), this.o.keepMs ?? KEEP_MS).unref?.();
  }

  private async run(job: Job, url: string, dest: string) {
    const proc = Bun.spawn(["git", "clone", "--progress", "--", url, dest], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
      // Its own process group, so stopping it stops ssh too (which would hold the pipe open).
      detached: true,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        // Nobody can answer a passphrase prompt; a host seen for the first time is trusted.
        GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new",
      },
    });
    let timedOut = false;
    job.kill = () => {
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch {
        proc.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => ((timedOut = true), job.kill?.()), this.o.timeoutMs ?? CLONE_TIMEOUT_MS);
    const lines: string[] = [];
    let rest = "";
    const decoder = new TextDecoder();
    const read = (async () => {
      // git redraws its progress with \r: each piece is the latest state of a line.
      for await (const chunk of proc.stderr) {
        const parts = (rest + decoder.decode(chunk, { stream: true })).split(/[\r\n]/);
        rest = parts.pop() ?? "";
        for (const line of parts.map((l) => l.trim()).filter(Boolean)) {
          const p = readProgress(line);
          if (p && job.status.state === "running") job.status = { ...job.status, phase: p.phase, detail: p.detail, ...(p.percent !== undefined ? { percent: Math.max(p.percent, job.status.percent ?? 0) } : {}) };
          else if (!p && !line.startsWith("Cloning into")) lines.push(line), lines.length > 5 && lines.shift();
        }
      }
    })().catch(() => {});
    const code = await proc.exited;
    // Its last words, but never waiting on a pipe something else still holds.
    await Promise.race([read, Bun.sleep(1000)]);
    clearTimeout(timer);
    const id = [...this.jobs].find(([, j]) => j === job)?.[0];
    if (code === 0 && job.status.state === "running") {
      if (id) this.finish(id, { state: "done", path: dest, percent: 100 });
      return;
    }
    rmSync(dest, { recursive: true, force: true });
    const error =
      job.status.state === "failed" ? job.status.error! : timedOut ? `Cloning ${url} took over ${Math.round((this.o.timeoutMs ?? CLONE_TIMEOUT_MS) / 60_000)} min.` : `git clone ${url} failed: ${lines.slice(-3).join(" ") || `exit ${code}`}`;
    if (id) this.finish(id, { state: "failed", path: dest, error });
  }
}
