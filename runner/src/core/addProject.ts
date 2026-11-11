// Add project (New session dialog): browse the runner's folders for one to start in, or clone a
// GitHub repo into a new one. Cloning always goes over SSH (git@github.com:org/repo.git), so the
// machine's own SSH key is what signs in, whatever form the repo was typed in.

import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { FolderList } from "../../../shared/protocol";
import { parseRepo } from "../../../shared/repo";
import { expandPath } from "./sessions";

/** A clone has to finish inside the relay's rpc timeout (server relay.ts, 120 s). */
export const CLONE_TIMEOUT_MS = 110_000;
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

/**
 * `git clone git@github.com:org/repo.git <path>`; parent folders are made as needed. A folder that
 * is already a clone of the same repo is used as it is; any other existing folder is refused.
 */
export async function cloneRepo(repo: string, path: string, timeoutMs = CLONE_TIMEOUT_MS): Promise<{ path: string }> {
  const { url } = parseRepo(repo);
  if (!rooted(path)) throw new Error("Use a full path, like ~/projects/app.");
  const dest = expandPath(path);
  if (existsSync(dest)) {
    if (statSync(dest).isDirectory() && sameRepo(dest, url)) return { path: dest };
    throw new Error(`${dest} already exists. Pick another folder.`);
  }
  const proc = Bun.spawn(["git", "clone", "--", url, dest], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      // Nobody can answer a passphrase prompt; a host seen for the first time is trusted.
      GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new",
    },
  });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  clearTimeout(timer);
  if (code !== 0) {
    rmSync(dest, { recursive: true, force: true });
    if (proc.signalCode) throw new Error(`Cloning ${url} took over ${Math.round(timeoutMs / 1000)} s. Clone it in a terminal, then choose the folder.`);
    const lines = err.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("Cloning into"));
    throw new Error(`git clone ${url} failed: ${lines.slice(-3).join(" ") || `exit ${code}`}`);
  }
  return { path: dest };
}
