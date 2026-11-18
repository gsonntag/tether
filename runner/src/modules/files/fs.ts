// Reading a session's folder for the Files tab (SPEC §10 Files): list a folder, read a file. Only
// inside the folder. A path is checked by name first (shared/files.ts splitPath: relative, no `..`,
// no NUL), then by where it really is (realpath resolves every link) against the folder's real path,
// for a plain error. That check is on a path, which can change before it's opened, so what counts
// is the open handle: a file is opened O_NOFOLLOW | O_NONBLOCK (a FIFO never blocks), a folder
// O_DIRECTORY | O_NOFOLLOW, and then, on Linux, where the handle really is (/proc/self/fd/N) must
// be inside; a folder is then listed, and its entries looked at, through that handle. A link
// swapped in anywhere on the path meanwhile is refused. Elsewhere (macOS: no /proc, and F_GETPATH
// needs a variadic fcntl that bun:ffi can't call) it's best effort: the real path is resolved again
// after opening and must be inside and name the same file. Linux without /proc is refused outright.
// Never writes; runs only `git rev-parse` and `git check-ignore` (run.ts's hardened git), in the
// folder through its handle. Opens, stats, realpaths and readlinks are waited on FS_MS at most (a
// handle that opens later is closed); reading an open file isn't timed.

import { constants, existsSync } from "node:fs";
import { lstat, open, opendir, readlink, realpath, stat, type FileHandle } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { DIR_ENTRIES_MAX, FILE_VIEW_MAX, HEAVY_DIRS, imageType, isHidden, splitPath, TEXT_JSON_MAX, type DirList, type FileEntry, type FileRead } from "../../../../shared/files";
import { jsonBytes } from "../../../../shared/limits";
import { git } from "../git/run";

/** Entries a folder is read for before the rest are only counted. */
const DIR_READ_MAX = 10_000;
/** A folder's listing stops reading after this long. */
const DIR_READ_MS = 3000;
/** Bytes looked at for a NUL (a binary file). */
const SNIFF_BYTES = 8000;
/** One filesystem call (a stat, a realpath) is waited on this long at most (a hung network mount). */
const FS_MS = 5000;

/** Where open handles can be asked where they are. */
const PROC_FD = process.platform === "linux" && existsSync("/proc/self/fd");
/** Linux, but /proc isn't there (a container without it): nothing is read, rather than reading unchecked. */
export const noProc = (platform: string, procFd: boolean) => platform === "linux" && !procFd;
const NO_PROC = noProc(process.platform, PROC_FD);
const NO_PROC_ERROR = "Files can't be read here: /proc isn't mounted, so where a file really is can't be checked.";

export const within = (root: string, p: string) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

/**
 * `p`, or a rejection once `ms` pass (the call itself may go on; nothing waits for it). `late` gets
 * what it resolves to after the time ran out (an open handle, to close).
 */
export function timed<T>(p: Promise<T>, ms = FS_MS, late?: (v: T) => unknown): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  let over = false;
  if (late) void p.then((v) => over && late(v), () => {});
  return Promise.race([
    p,
    new Promise<never>(
      (_, no) =>
        (t = setTimeout(() => {
          over = true;
          no(new Error("The disk took too long to answer."));
        }, ms)),
    ),
  ]).finally(() => clearTimeout(t));
}
/** An open that gives up after FS_MS, closing the handle if it comes later. */
const openTimed = (p: string, flags: number) => timed(open(p, flags), FS_MS, (fh) => fh.close().catch(() => {}));
/** An opendir likewise. */
export const opendirTimed = (p: string) => timed(opendir(p, { bufferSize: 256 }), FS_MS, (d) => d.close().catch(() => {}));

const why = (e: unknown): Error => {
  const code = (e as NodeJS.ErrnoException).code;
  if (code === "ENOENT") return new Error("It isn't there any more.");
  if (code === "ENOTDIR") return new Error("That isn't a folder.");
  if (code === "ELOOP") return new Error("That link loops, or was a link where none may be.");
  if (code === "ENAMETOOLONG") return new Error("That path is too long.");
  if (code === "EACCES" || code === "EPERM") return new Error("Not allowed to read it.");
  return e instanceof Error ? e : new Error(String(e));
};
const OUTSIDE = "That's outside the session's folder.";

/** The session folder's real path. */
export async function realRoot(projectPath: string): Promise<string> {
  try {
    return await timed(realpath(projectPath));
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
    real = await timed(realpath(join(root, ...names)));
  } catch (e) {
    throw why(e);
  }
  if (!within(root, real)) throw new Error(OUTSIDE);
  return real;
}

/**
 * Where the open handle `fh` really is, required inside `root`. Linux: the kernel's answer for the
 * handle. Elsewhere: `real` resolved again, required to be the same file as the handle.
 */
async function handleInside(root: string, fh: FileHandle, real: string): Promise<string> {
  if (NO_PROC) throw new Error(NO_PROC_ERROR);
  if (PROC_FD) {
    const at = (await timed(readlink(`/proc/self/fd/${fh.fd}`))).replace(/ \(deleted\)$/, "");
    if (!within(root, at)) throw new Error(OUTSIDE);
    return at;
  }
  const st = await fh.stat();
  const again = await timed(realpath(real)).catch(() => "");
  const now = again && (await timed(stat(again)).catch(() => undefined));
  if (!again || !within(root, again) || !now || now.ino !== st.ino || now.dev !== st.dev) throw new Error("It changed while it was opened.");
  return again;
}

/**
 * A folder opened inside `root`: `via` reaches it through its handle (Linux) in this process, `cwd`
 * in a child (git), `at` is where it is.
 */
export async function openDirInside(root: string, real: string): Promise<{ via: string; cwd: string; at: string; close: () => Promise<void> }> {
  if (NO_PROC) throw new Error(NO_PROC_ERROR);
  let fh: FileHandle;
  try {
    fh = await openTimed(real, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    throw why(e);
  }
  const close = () => fh.close().catch(() => {});
  try {
    const at = await handleInside(root, fh, real);
    return { via: PROC_FD ? `/proc/self/fd/${fh.fd}` : at, cwd: PROC_FD ? `/proc/${process.pid}/fd/${fh.fd}` : at, at, close };
  } catch (e) {
    await close();
    throw e;
  }
}

/**
 * What a link at `p` (in the folder `dir`, really at `at`) points to, as the tree shows it: a file
 * or folder inside, else `outside`; `broken` only when its target would be inside by its text
 * (nothing there, a loop), so nothing outside is said to exist or not.
 */
async function linkTo(root: string, p: string, at: string): Promise<FileEntry["to"]> {
  try {
    const real = await timed(realpath(p));
    if (!within(root, real)) return "outside";
    const st = await timed(stat(real));
    return st.isDirectory() ? "dir" : st.isFile() ? "file" : "broken";
  } catch {
    const target = await timed(readlink(p)).catch(() => undefined);
    return target !== undefined && within(root, resolve(at, target)) ? "broken" : "outside";
  }
}

/**
 * Which of `names` (in the folder `dir`, a path to it through its handle on Linux) git ignores;
 * undefined outside a repo, empty when git can't say.
 */
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
 * (outside a repo: HEAVY_DIRS) are left out. `.git` is never listed. Read through the folder's
 * handle (openDirInside).
 */
export async function listDir(root: string, path: unknown, hidden: boolean): Promise<DirList> {
  const dir = await openDirInside(root, await resolveInside(root, path));
  try {
    const raw: { name: string; dirent: import("node:fs").Dirent }[] = [];
    let uncounted = 0;
    const until = Date.now() + DIR_READ_MS;
    try {
      const d = await opendirTimed(dir.via);
      for await (const e of d) {
        if (e.name === ".git") continue;
        if (raw.length >= DIR_READ_MAX) uncounted++;
        else raw.push({ name: e.name, dirent: e });
        if (Date.now() > until) break;
      }
    } catch (e) {
      throw why(e);
    }
    const ignored = await ignoredIn(dir.cwd, raw.filter((r) => !r.name.includes("\ufffd")).map((r) => r.name));
    const repo = ignored !== undefined;
    const entries: FileEntry[] = [];
    for (const { name, dirent } of raw) {
      const folder = dirent.isDirectory();
      const ign = repo ? ignored!.has(name) : folder && HEAVY_DIRS.has(name);
      if (!hidden && (isHidden(name) || ign)) continue;
      const e: FileEntry = { name, kind: folder ? "dir" : dirent.isFile() ? "file" : dirent.isSymbolicLink() ? "link" : "other" };
      if (ign) e.ignored = true;
      // Bun gives names that aren't UTF-8 with U+FFFD in them: a path built from one names nothing.
      if (name.includes("\ufffd")) e.badName = true;
      entries.push(e);
    }
    const byName = (a: FileEntry, b: FileEntry) => {
      const x = a.name.toLowerCase();
      const y = b.name.toLowerCase();
      return x < y ? -1 : x > y ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    };
    entries.sort((a, b) => (a.kind === "dir" ? 0 : 1) - (b.kind === "dir" ? 0 : 1) || byName(a, b));
    const shown = entries.slice(0, DIR_ENTRIES_MAX);
    // Where links point and sizes, for what's listed only; a link to a folder inside then sorts with the folders.
    await Promise.all(
      shown.map(async (e) => {
        if (e.badName) return;
        const p = join(dir.via, e.name);
        if (e.kind === "link") e.to = await linkTo(root, p, dir.at);
        else if (e.kind === "file") {
          const size = await timed(lstat(p)).then((st) => st.size, () => undefined);
          if (size !== undefined) e.size = size;
        }
      }),
    );
    const rank = (e: FileEntry) => (e.kind === "dir" || e.to === "dir" ? 0 : 1);
    shown.sort((a, b) => rank(a) - rank(b) || byName(a, b));
    const more = entries.length - shown.length + uncounted;
    return { path: typeof path === "string" ? path.replace(/^\.$/, "").replace(/\/+$/, "") : "", entries: shown, ...(more > 0 ? { more } : {}), repo };
  } finally {
    await dir.close();
  }
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
 * text file's first bytes; those show even when they aren't UTF-8 or are mostly escapes (`lossy`).
 * Only as many bytes as the file says it has are read (a /proc file says 0), but for `head`.
 */
export async function readFile(root: string, path: unknown, opts: { maxBytes?: number; head?: boolean } = {}): Promise<FileRead> {
  const real = await resolveInside(root, path);
  const max = Math.max(1, Math.min(FILE_VIEW_MAX, typeof opts.maxBytes === "number" && opts.maxBytes > 0 ? Math.floor(opts.maxBytes) : FILE_VIEW_MAX));
  let fh: FileHandle;
  try {
    if (NO_PROC) throw new Error(NO_PROC_ERROR);
    fh = await openTimed(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    throw why(e);
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new Error("That isn't a file.");
    await handleInside(root, fh, real);
    const rel = (path as string).replace(/\/+$/, "");
    const size = st.size;
    const mime = imageType(rel);
    if (mime) {
      if (size > max) return { path: rel, size, kind: "tooBig" };
      const b = await readHead(fh, Math.min(size, max));
      if (looksLike(mime, b)) return { path: rel, size, kind: "image", mime, data: b.toString("base64") };
      // Named like an image but isn't one: shown as what it is.
      return textOrBinary(rel, size, b, false, false);
    }
    if (size > max && !opts.head) return { path: rel, size, kind: "tooBig" };
    const b = await readHead(fh, opts.head ? max : Math.min(size, max));
    return textOrBinary(rel, size, b, size > b.length, !!opts.head);
  } finally {
    await fh.close().catch(() => {});
  }
}

/** Text, or "binary". `lossy`: text that isn't UTF-8 shows decoded with U+FFFD, too many escapes cut. */
export function textOrBinary(path: string, size: number, b: Buffer, cut: boolean, lossy: boolean): FileRead {
  if (b.subarray(0, SNIFF_BYTES).includes(0)) return { path, size, kind: "binary" };
  let text: string;
  let bad = false;
  try {
    // stream: a character the cut split stays out, rather than failing.
    text = new TextDecoder("utf-8", { fatal: true }).decode(b, { stream: cut });
  } catch {
    if (!lossy) return { path, size, kind: "binary" };
    text = new TextDecoder("utf-8").decode(b, { stream: cut });
    bad = true;
  }
  if (jsonBytes(text) > TEXT_JSON_MAX) {
    if (!lossy) return { path, size, kind: "binary" };
    while (jsonBytes(text) > TEXT_JSON_MAX) {
      text = text.slice(0, Math.floor((text.length * TEXT_JSON_MAX) / jsonBytes(text)) - 1);
      if (/[\ud800-\udbff]$/.test(text)) text = text.slice(0, -1);
    }
    bad = true;
    cut = true;
  }
  return { path, size, kind: "text", text, ...(cut ? { cut: true } : {}), ...(bad ? { lossy: true } : {}) };
}
