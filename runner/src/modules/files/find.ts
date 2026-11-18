// The Files tab's name filter (SPEC §10 Files): every file under the session's folder, ranked by
// shared/files.ts rankMatches. In a repo the list is git's (`ls-files --cached --others
// --exclude-standard`: tracked and untracked, never ignored); outside one, a walk that never follows
// links or enters HEAVY_DIRS, stopped at FIND_FILES_MAX files or FIND_WALK_MS. Without `hidden`,
// paths with a dot-named part are left out. A folder's list is kept a few seconds, so typing doesn't
// list it again for each letter.

import { opendir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { FIND_FILES_MAX, FIND_WALK_MS, HEAVY_DIRS, isHidden, rankMatches, type FindResult } from "../../../../shared/files";
import { git } from "../git/run";
import { within } from "./fs";

const KEEP_MS = 5000;
/** Bytes of `ls-files` output read at most. */
const LS_BYTES_MAX = 16 * 1024 * 1024;

interface Listing {
  paths: string[];
  partial: boolean;
}

/** The folder's files from git, or undefined outside a repo. */
async function fromGit(root: string): Promise<Listing | undefined> {
  const top = await git(root, ["rev-parse", "--show-toplevel"], { timeoutMs: 5000, ok: [0, 128] }).catch(() => undefined);
  if (!top || top.code !== 0) return undefined;
  const r = await git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { maxBytes: LS_BYTES_MAX, timeoutMs: 10_000 });
  const seen = new Set<string>();
  const parts = r.out.split("\0");
  // A cut list's last name may be half a name.
  if (r.cut) parts.pop();
  for (const p of parts) {
    if (!p || seen.has(p)) continue;
    if (seen.size >= FIND_FILES_MAX) return { paths: [...seen], partial: true };
    seen.add(p);
  }
  return { paths: [...seen], partial: r.cut };
}

/** A breadth-first walk of `root`: files only, no links followed, HEAVY_DIRS and `.git` skipped. */
async function walk(root: string, hidden: boolean): Promise<Listing> {
  const until = Date.now() + FIND_WALK_MS;
  const paths: string[] = [];
  const queue: string[] = [""];
  let partial = false;
  while (queue.length) {
    if (Date.now() > until || paths.length >= FIND_FILES_MAX) {
      partial = true;
      break;
    }
    const rel = queue.shift()!;
    let d;
    try {
      // A folder swapped for a link since it was listed is never walked into.
      if (rel && !within(root, await realpath(join(root, rel)))) continue;
      d = await opendir(join(root, rel), { bufferSize: 256 });
    } catch {
      continue;
    }
    try {
      for await (const e of d) {
        if (e.name.includes("\ufffd")) continue;
        if (!hidden && isHidden(e.name)) continue;
        const p = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (!HEAVY_DIRS.has(e.name)) queue.push(p);
        } else if (e.isFile()) {
          paths.push(p);
          if (paths.length >= FIND_FILES_MAX) break;
        }
      }
    } catch {}
  }
  return { paths, partial: partial || queue.length > 0 };
}

export class Finder {
  private kept = new Map<string, { at: number; list: Promise<Listing> }>();

  constructor(private readonly now: () => number = Date.now) {}

  private listing(root: string, hidden: boolean): Promise<Listing> {
    const key = `${hidden ? 1 : 0}${root}`;
    const k = this.kept.get(key);
    if (k && this.now() - k.at < KEEP_MS) return k.list;
    for (const [x, v] of this.kept) if (this.now() - v.at >= KEEP_MS) this.kept.delete(x);
    const list = (async () => {
      const g = await fromGit(root);
      if (!g) return walk(root, hidden);
      return hidden ? g : { paths: g.paths.filter((p) => !p.split("/").some(isHidden)), partial: g.partial };
    })();
    this.kept.set(key, { at: this.now(), list });
    list.catch(() => this.kept.delete(key));
    return list;
  }

  async find(root: string, query: string, hidden: boolean): Promise<FindResult> {
    if (!query.trim()) return { paths: [], more: false };
    const l = await this.listing(root, hidden);
    const r = rankMatches(l.paths, query);
    return { ...r, ...(l.partial ? { partial: true } : {}) };
  }
}
