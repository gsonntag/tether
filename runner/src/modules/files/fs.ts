// Reading a session's folder for the Files tab (SPEC §10 Files): list a folder, read a file. Only
// inside the folder: the path is checked by name first (shared/files.ts splitPath: relative, no
// `..`, no NUL), then by where it really is (realpath, which resolves every link on the way) against
// the folder's own real path. A file is opened without following a last link (O_NOFOLLOW), without
// blocking (a FIFO), and checked again once open: the opened file must still be what the real path
// names and still inside, so a link swapped in between the check and the open is refused. Never
// writes, never runs anything but `git check-ignore` (run.ts's hardened git).

import { constants } from "node:fs";
import { lstat, open, opendir, realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { DIR_ENTRIES_MAX, FILE_VIEW_MAX, HEAVY_DIRS, imageType, isHidden, splitPath, TEXT_JSON_MAX, type DirList, type FileEntry, type FileRead } from "../../../../shared/files";
import { jsonBytes } from "../../../../shared/limits";
import { git } from "../git/run";

/** Entries a folder is read for before the rest are only counted. */
const DIR_READ_MAX = 10_000;
/** A folder's listing stops reading after this long. */
const DIR_READ_MS = 3000;
/** Bytes looked at for a NUL (a binary file). */
const SNIFF_BYTES = 8000;

export const within = (root: string, p: string) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

const why = (e: unknown): Error => {
  const code = (e as NodeJS.ErrnoException).code;
  if (code === "ENOENT" || code === "ENOTDIR") return new Error("It isn't there any more.");
  if (code === "ELOOP") return new Error("That link loops.");
  if (code === "ENAMETOOLONG") return new Error("That path is too long.");
  if (code === "EACCES" || code === "EPERM") return new Error("Not allowed to read it.");
  return e instanceof Error ? e : new Error(String(e));
};

/** The session folder's real path. */
export async function realRoot(projectPath: string): Promise<string> {
  try {
    return await realpath(projectPath);
  } catch (e) {
    throw why(e);
  }
}

/** The real path of `path` under `root` (a real path), refused when it's anywhere else. */
export async function resolveInside(root: string, path: unknown): Promise<string> {
  const names = splitPath(path);
  if (!Array.isArray(names)) throw new Error(names.error);
  let real: string;
  try {
    real = await realpath(join(root, ...names));
  } catch (e) {
    throw why(e);
  }
  if (!within(root, real)) throw new Error("That's outside the session's folder.");
  return real;
}

/** What a link at `p` points to, as the tree shows it. */
async function linkTo(root: string, p: string): Promise<FileEntry["to"]> {
  try {
    const real = await realpath(p);
    if (!within(root, real)) return "outside";
    const st = await stat(real);
    return st.isDirectory() ? "dir" : st.isFile() ? "file" : "broken";
  } catch {
    return "broken";
  }
}

/** Which of `names` (in the folder `dir`) git ignores; empty outside a repo or when git can't say. */
async function ignoredIn(dir: string, names: string[]): Promise<Set<string> | undefined> {
  try {
    const top = await git(dir, ["rev-parse", "--show-toplevel"], { timeoutMs: 5000, ok: [0, 128] });
    if (top.code !== 0) return undefined;
  } catch {
    return undefined;
  }
  if (!names.length) return new Set();
  try {
    // "./name": a name like ":(glob)x" is a name, not pathspec magic. git says them back as given.
    const r = await git(dir, ["check-ignore", "--stdin", "-z"], { input: names.map((n) => `./${n}\0`).join(""), ok: [0, 1], timeoutMs: 10_000 });
    return new Set(r.out.split("\0").filter(Boolean).map((n) => n.replace(/^\.\//, "")));
  } catch {
    // A submodule, a folder inside .git, a git that refuses: nothing is said to be ignored.
    return new Set();
  }
}

/**
 * The folder at `path`, folders first then by name. Without `hidden`, dot files and what git ignores
 * (outside a repo: HEAVY_DIRS) are left out. `.git` is never listed.
 */
export async function listDir(root: string, path: unknown, hidden: boolean): Promise<DirList> {
  const dir = await resolveInside(root, path);
  try {
    if (!(await stat(dir)).isDirectory()) throw new Error("That isn't a folder.");
  } catch (e) {
    throw why(e);
  }
  const raw: { name: string; dirent: import("node:fs").Dirent }[] = [];
  let uncounted = 0;
  const until = Date.now() + DIR_READ_MS;
  let d: Awaited<ReturnType<typeof opendir>>;
  try {
    d = await opendir(dir, { bufferSize: 256 });
  } catch (e) {
    throw why(e);
  }
  try {
    for await (const e of d) {
      if (e.name === ".git") continue;
      if (raw.length >= DIR_READ_MAX) {
        uncounted++;
        if (Date.now() > until) break;
        continue;
      }
      raw.push({ name: e.name, dirent: e });
      if (Date.now() > until) break;
    }
  } catch (e) {
    throw why(e);
  }
  const ignored = await ignoredIn(dir, raw.filter((r) => !r.name.includes("\ufffd")).map((r) => r.name));
  const repo = ignored !== undefined;
  const entries: FileEntry[] = [];
  for (const { name, dirent } of raw) {
    const isDir = dirent.isDirectory();
    const ign = repo ? ignored!.has(name) : isDir && HEAVY_DIRS.has(name);
    if (!hidden && (isHidden(name) || ign)) continue;
    const e: FileEntry = { name, kind: isDir ? "dir" : dirent.isFile() ? "file" : dirent.isSymbolicLink() ? "link" : "other" };
    if (ign) e.ignored = true;
    // Bun gives names that aren't UTF-8 with U+FFFD in them: a path built from one names nothing.
    if (name.includes("\ufffd")) e.badName = true;
    entries.push(e);
  }
  // Where links point first: a link to a folder inside sorts with the folders.
  await Promise.all(entries.map(async (e) => e.kind === "link" && !e.badName && (e.to = await linkTo(root, join(dir, e.name)))));
  const rank = (e: FileEntry) => (e.kind === "dir" || e.to === "dir" ? 0 : 1);
  entries.sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    const x = a.name.toLowerCase();
    const y = b.name.toLowerCase();
    return x < y ? -1 : x > y ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  const shown = entries.slice(0, DIR_ENTRIES_MAX);
  // Sizes for what's listed only.
  await Promise.all(shown.map(async (e) => e.kind === "file" && !e.badName && (e.size = await lstat(join(dir, e.name)).then((s) => s.size, () => undefined))));
  const more = entries.length - shown.length + uncounted;
  return { path: typeof path === "string" ? path.replace(/^\.$/, "").replace(/\/+$/, "") : "", entries: shown, ...(more > 0 ? { more } : {}), repo };
}

/** Reads up to `n` bytes from the start. */
async function readHead(fh: import("node:fs/promises").FileHandle, n: number): Promise<Buffer> {
  const buf = Buffer.alloc(n);
  let got = 0;
  while (got < n) {
    const { bytesRead } = await fh.read(buf, got, n - got, got);
    if (!bytesRead) break;
    got += bytesRead;
  }
  return buf.subarray(0, got);
}

/** The bytes look like an image of that type (or SVG is text with an <svg in it). */
function looksLike(mime: string, b: Buffer): boolean {
  const hex = b.subarray(0, 12).toString("hex");
  switch (mime) {
    case "image/png":
      return hex.startsWith("89504e470d0a1a0a");
    case "image/jpeg":
      return hex.startsWith("ffd8ff");
    case "image/gif":
      return b.subarray(0, 4).toString("latin1") === "GIF8";
    case "image/webp":
      return b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP";
    case "image/svg+xml":
      return !b.includes(0) && /<svg[\s>]/i.test(b.subarray(0, 64 * 1024).toString("utf8"));
    default:
      return true;
  }
}

/**
 * The file at `path`: its text (UTF-8, no NUL in its first 8 KB), an image as base64, else
 * "binary". Over FILE_VIEW_MAX (or `maxBytes`, never more) it's `tooBig`, unless `head` asks for a
 * text file's first bytes.
 */
export async function readFile(root: string, path: unknown, opts: { maxBytes?: number; head?: boolean } = {}): Promise<FileRead> {
  const real = await resolveInside(root, path);
  const max = Math.max(1, Math.min(FILE_VIEW_MAX, typeof opts.maxBytes === "number" && opts.maxBytes > 0 ? Math.floor(opts.maxBytes) : FILE_VIEW_MAX));
  let fh: import("node:fs/promises").FileHandle;
  try {
    fh = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    throw why(e);
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new Error("That isn't a file.");
    // Checked again now it's open: still the file the real path names, and that path still inside.
    const again = await realpath(real).catch(() => "");
    const now = again && (await stat(again).catch(() => undefined));
    if (!again || !within(root, again) || !now || now.ino !== st.ino || now.dev !== st.dev) throw new Error("The file changed while it was opened.");
    const rel = (path as string).replace(/\/+$/, "");
    const size = st.size;
    const mime = imageType(rel);
    if (mime) {
      if (size > max) return { path: rel, size, kind: "tooBig" };
      const b = await readHead(fh, max);
      if (looksLike(mime, b)) return { path: rel, size, kind: "image", mime, data: b.toString("base64") };
      // Named like an image but isn't one: shown as what it is.
      return textOrBinary(rel, size, b, false);
    }
    if (size > max && !opts.head) return { path: rel, size, kind: "tooBig" };
    const b = await readHead(fh, max);
    return textOrBinary(rel, size, b, size > b.length);
  } finally {
    await fh.close().catch(() => {});
  }
}

function textOrBinary(path: string, size: number, b: Buffer, cut: boolean): FileRead {
  if (b.subarray(0, SNIFF_BYTES).includes(0)) return { path, size, kind: "binary" };
  let text: string;
  try {
    // stream: a character the cut split stays out, rather than failing.
    text = new TextDecoder("utf-8", { fatal: true }).decode(b, { stream: cut });
  } catch {
    return { path, size, kind: "binary" };
  }
  if (jsonBytes(text) > TEXT_JSON_MAX) return { path, size, kind: "binary" };
  return { path, size, kind: "text", text, ...(cut ? { cut: true } : {}) };
}
