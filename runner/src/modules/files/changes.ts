// The Files tab's change marks (SPEC §10 Files): which paths in the session's folder differ from
// HEAD, from one `git status --porcelain=v2 -z --untracked-files=normal` run in the folder through
// its handle (fs.ts openDirInside), limited to it (`-- .`), through run.ts's hardened git. `normal`
// names an untracked folder once (never each file in a huge one); a repo set to
// status.showUntrackedFiles=no gets `no`, as its own git status would. Paths come back relative to
// the folder; anything git names outside it is dropped. Outside a repo: no marks. Like any git
// status, it may run the repo's configured clean filters on files whose stat looks changed.

import { CHANGES_MAX, type ChangeMark, type FileChanges } from "../../../../shared/files";
import { git } from "../git/run";
import { openDirInside } from "./fs";

/** Bytes of status output read at most. */
const STATUS_BYTES_MAX = 8 * 1024 * 1024;

/** What XY (index, worktree) of an ordinary entry means for the tree (`.A`: intent to add). */
function markOf(xy: string): ChangeMark {
  const [x, y] = [xy[0], xy[1]];
  if (y === "D" || x === "D") return "deleted";
  if (x === "A" || y === "A") return "added";
  return "modified";
}

/**
 * `git status --porcelain=v2 -z` output (paths from the repo's top) as marks on paths under
 * `prefix` (the folder's place in the repo, "" or ending in "/"), relative to it. `cut`: the output
 * stopped early, so its last record may be half of one.
 */
export function parseStatus(out: string, prefix: string, cut = false, max = CHANGES_MAX): FileChanges {
  const files = new Map<string, ChangeMark>();
  const folders = new Set<string>();
  const recs = out.split("\0");
  if (cut || recs[recs.length - 1] === "") recs.pop();
  let over = cut;
  const add = (p: string | undefined, m: ChangeMark, folder = false) => {
    if (!p) return;
    // An untracked folder or nested repo ends in "/".
    if (p.endsWith("/")) folder = true;
    const path = p.replace(/\/+$/, "");
    if (!path.startsWith(prefix) || path.length === prefix.length) return;
    const rel = path.slice(prefix.length);
    // A name that isn't UTF-8 names nothing the tree can show.
    if (rel.includes("\ufffd")) return;
    const had = files.get(rel);
    if (!had && files.size >= max) {
      over = true;
      return;
    }
    // A deleted mark gives way to any other (`git rm --cached`: deleted in the index, there untracked).
    if (!had || had === "deleted") files.set(rel, m);
    if (folder) folders.add(rel);
  };
  /** the text after the n-th space: a path may have spaces of its own */
  const after = (r: string, n: number) => {
    let i = -1;
    for (let k = 0; k < n; k++) {
      i = r.indexOf(" ", i + 1);
      if (i < 0) return undefined;
    }
    return r.slice(i + 1);
  };
  /** the entry is a submodule (its `sub` field starts with S) */
  const sub = (r: string) => r[5] === "S";
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i]!;
    const xy = r.slice(2, 4);
    switch (r[0]) {
      case "1":
        add(after(r, 8), markOf(xy), sub(r));
        break;
      case "2": {
        // A rename or copy, staged (R.) or in the worktree (.R, after an intent to add): the next record is where it came from.
        const orig = recs[++i];
        add(after(r, 9), xy[1] === "D" ? "deleted" : xy.includes("C") ? "added" : "renamed", sub(r));
        if (xy.includes("R")) add(orig, "deleted");
        break;
      }
      case "u":
        // Both deleted: nothing on disk to open.
        add(after(r, 10), xy === "DD" ? "deleted" : "conflict", sub(r));
        break;
      case "?":
        add(r.slice(2), "untracked");
        break;
    }
  }
  const f = [...folders].filter((p) => files.has(p));
  return { repo: true, files: Object.fromEntries(files), ...(f.length ? { folders: f } : {}), ...(over ? { cut: true } : {}) };
}

/** Whether status.showUntrackedFiles turns untracked files off (a bool `false` or `no`). */
const untrackedOff = (v: string) => /^(no|false|off|0)$/i.test(v.trim());

/** The session folder's changes against HEAD; `{ repo: false }` outside a repo. */
export async function fileChanges(root: string, o: { maxBytes?: number; max?: number } = {}): Promise<FileChanges> {
  const dir = await openDirInside(root, root);
  try {
    const pre = await git(dir.cwd, ["rev-parse", "--show-prefix"], { timeoutMs: 5000, ok: [0, 128] }).catch(() => undefined);
    if (!pre || pre.code !== 0) return { repo: false, files: {} };
    const conf = await git(dir.cwd, ["config", "--get", "status.showUntrackedFiles"], { timeoutMs: 5000, ok: [0, 1] }).catch(() => undefined);
    const untracked = conf && conf.code === 0 && untrackedOff(conf.out) ? "no" : "normal";
    const r = await git(dir.cwd, ["status", "--porcelain=v2", "-z", `--untracked-files=${untracked}`, "--find-renames", "--ignore-submodules=dirty", "--", "."], {
      maxBytes: o.maxBytes ?? STATUS_BYTES_MAX,
      timeoutMs: 10_000,
    });
    return parseStatus(r.out, pre.out.replace(/\n$/, ""), r.cut, o.max);
  } finally {
    await dir.close();
  }
}
