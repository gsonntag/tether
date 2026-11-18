// The Files tab's change marks (SPEC §10 Files): which files in the session's folder differ from
// HEAD, from one `git status --porcelain=v2 -z --untracked-files=all` run in the folder through its
// handle (fs.ts openDirInside), limited to it (`-- .`), through run.ts's hardened git. Paths come
// back relative to the folder; anything git names outside it is dropped. Outside a repo: no marks.

import { CHANGES_MAX, type ChangeMark, type FileChanges } from "../../../../shared/files";
import { git } from "../git/run";
import { openDirInside } from "./fs";

/** Bytes of status output read at most. */
const STATUS_BYTES_MAX = 8 * 1024 * 1024;

/** What XY (index, worktree) of an ordinary or unmerged entry means for the tree. */
function markOf(xy: string): ChangeMark {
  const [x, y] = [xy[0], xy[1]];
  if (y === "D" || x === "D") return "deleted";
  if (x === "A") return "added";
  return "modified";
}

/** A deleted mark gives way to any other (`git rm --cached`: deleted in the index, there untracked). */
function put(files: Map<string, ChangeMark>, path: string, m: ChangeMark) {
  const had = files.get(path);
  if (!had || had === "deleted") files.set(path, m);
}

/**
 * `git status --porcelain=v2 -z` output (paths from the repo's top) as marks on paths under
 * `prefix` (the folder's place in the repo, "" or ending in "/"), relative to it. `cut`: the output
 * stopped early, so its last record may be half of one.
 */
export function parseStatus(out: string, prefix: string, cut = false, max = CHANGES_MAX): FileChanges {
  const files = new Map<string, ChangeMark>();
  const recs = out.split("\0");
  if (cut || recs[recs.length - 1] === "") recs.pop();
  let over = cut;
  const add = (p: string | undefined, m: ChangeMark) => {
    if (!p) return;
    // A nested repo or a folder git didn't list into ends in "/".
    const path = p.replace(/\/+$/, "");
    if (!path.startsWith(prefix) || path.length === prefix.length || path.includes("�")) return;
    if (files.size >= max && !files.has(path.slice(prefix.length))) {
      over = true;
      return;
    }
    put(files, path.slice(prefix.length), m);
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
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i]!;
    switch (r[0]) {
      case "1":
        add(after(r, 8), markOf(r.slice(2, 4)));
        break;
      case "2": {
        // A rename or copy: the next record is where it came from.
        const xy = r.slice(2, 4);
        const orig = recs[++i];
        if (xy[1] === "D") add(after(r, 9), "deleted");
        else add(after(r, 9), xy[0] === "C" ? "added" : "renamed");
        if (xy[0] === "R") add(orig, "deleted");
        break;
      }
      case "u":
        add(after(r, 10), "modified");
        break;
      case "?":
        add(r.slice(2), "untracked");
        break;
    }
  }
  return { repo: true, files: Object.fromEntries(files), ...(over ? { cut: true } : {}) };
}

/** The session folder's changes against HEAD; `{ repo: false }` outside a repo. */
export async function fileChanges(root: string): Promise<FileChanges> {
  const dir = await openDirInside(root, root);
  try {
    const pre = await git(dir.cwd, ["rev-parse", "--show-prefix"], { timeoutMs: 5000, ok: [0, 128] }).catch(() => undefined);
    if (!pre || pre.code !== 0) return { repo: false, files: {} };
    const r = await git(dir.cwd, ["status", "--porcelain=v2", "-z", "--untracked-files=all", "--find-renames", "--ignore-submodules=dirty", "--", "."], {
      maxBytes: STATUS_BYTES_MAX,
      timeoutMs: 10_000,
    });
    return parseStatus(r.out, pre.out.replace(/\n$/, ""), r.cut);
  } finally {
    await dir.close();
  }
}
