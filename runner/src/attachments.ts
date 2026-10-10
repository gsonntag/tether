// Files attached to messages (web/src/shared/attachments.ts has the format and the limits).
//
// Uploads arrive in fixed-size chunks over the RPC channel and are written straight to a hidden
// partial file next to their final place; the chunk that completes a file renames it into place.
// Everything lives under TETHER_CONFIG_DIR/attachments/<session>/, never in a repository, and every
// path that comes back from a browser is checked to resolve (symlinks too) inside that folder.

import { randomBytes } from "node:crypto";
import { closeSync, constants, existsSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, rmSync, statfsSync, statSync, unlinkSync } from "node:fs";
import { chmod, open, rename, unlink, type FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  CHUNK_BYTES,
  cleanMime,
  displayName,
  isImageType,
  maxBytes,
  mimeFromName,
  NATIVE_IMAGE_TYPES,
  MAX_IMAGE_BYTES,
  safeName,
  sizeProblem,
  splitAttachments,
  type Attachment,
} from "../../web/src/shared/attachments";
import { CONFIG_DIR } from "./config";

export function attachmentsDir(): string {
  return join(CONFIG_DIR, "attachments");
}

/** One session's folder (it may not exist yet). */
export function sessionDir(sessionId: string): string {
  return join(attachmentsDir(), sessionKey(sessionId));
}

/** The folder name for a session: its id with anything but letters, digits, `_` and `-` replaced. */
export function sessionKey(sessionId: string): string {
  const k = String(sessionId).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 160);
  return k || "_";
}

export const inside = (p: string, dir: string) => p === dir || p.startsWith(dir.replace(/\/$/, "") + "/");

/** Is this absolute path inside the attachments folder (as written; see resolveStored for symlinks)? */
export function isAttachmentPath(p: string): boolean {
  return inside(resolve(p), attachmentsDir());
}

// ---------------- uploads ----------------

interface Upload {
  key: string;
  tmp: string;
  final: string;
  name: string;
  mimeType: string;
  size: number;
  /** chunk offsets written so far */
  got: Set<number>;
  received: number;
  file: Promise<FileHandle>;
  touched: number;
  done?: Promise<Attachment>;
}

const uploads = new Map<string, Upload>();
const MAX_OPEN_UPLOADS = 40;
const UPLOAD_IDLE_MS = 10 * 60_000;

/** Extension for image types whose names lack one (a pasted screenshot named "image"). */
const IMAGE_EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

export interface ChunkArgs {
  sessionId: string;
  uploadId: string;
  name: string;
  mimeType: string;
  size: number;
  offset: number;
  /** base64 */
  data: string;
}

/**
 * Writes one chunk. Chunks are CHUNK_BYTES long (the last one shorter) and start at multiples of
 * it, so the file is complete exactly when every chunk has been written once.
 */
export async function receiveChunk(a: ChunkArgs): Promise<{ attachment?: Attachment }> {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(String(a.uploadId))) throw new Error("Bad upload id.");
  const size = Number(a.size);
  const offset = Number(a.offset);
  if (!Number.isSafeInteger(size) || !Number.isSafeInteger(offset)) throw new Error("Bad upload size.");
  const key = `${sessionKey(a.sessionId)}/${a.uploadId}`;
  let u = uploads.get(key);
  if (!u) {
    let name = safeName(a.name);
    const mimeType = cleanMime(a.mimeType, name);
    const problem = sizeProblem(size, mimeType);
    if (problem) throw new Error(problem);
    if (IMAGE_EXT[mimeType] && mimeFromName(name) !== mimeType) name = `${name.replace(/\.[A-Za-z0-9]{1,10}$/, "")}.${IMAGE_EXT[mimeType]}`;
    if (uploads.size >= MAX_OPEN_UPLOADS) sweepUploads(0);
    if (uploads.size >= MAX_OPEN_UPLOADS) throw new Error("Too many uploads at once; try again in a moment.");
    const dir = sessionDir(a.sessionId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    roomFor(dir, size);
    const id = randomBytes(4).toString("hex");
    const tmp = join(dir, `.${id}.partial`);
    u = {
      key,
      tmp,
      final: join(dir, `${id}-${name}`),
      name,
      mimeType,
      size,
      got: new Set(),
      received: 0,
      file: open(tmp, "w", 0o600),
      touched: Date.now(),
    };
    uploads.set(key, u);
  } else if (u.size !== size) throw new Error("The upload changed size.");
  u.touched = Date.now();
  if (u.done) return { attachment: await u.done };
  const buf = Buffer.from(String(a.data ?? ""), "base64");
  const expected = Math.min(CHUNK_BYTES, size - offset);
  if (offset < 0 || offset >= size || offset % CHUNK_BYTES !== 0 || buf.length !== expected) throw new Error("Bad upload chunk.");
  if (u.got.has(offset)) return {}; // a retry of a chunk already written (or being written)
  u.got.add(offset);
  let fh: FileHandle;
  try {
    fh = await u.file;
    await fh.write(buf, 0, buf.length, offset);
  } catch (e) {
    u.got.delete(offset); // a retry writes it again
    throw e;
  }
  u.received += buf.length;
  if (u.received < u.size) return {};
  const up = u;
  up.done = (async () => {
    await fh.close();
    // Read-only on disk too: a stray `>` from an agent's shell fails even where the guard can't see it.
    await chmod(up.tmp, 0o400).catch(() => {});
    await rename(up.tmp, up.final);
    return { path: up.final, name: up.name, mimeType: up.mimeType, size: up.size };
  })();
  try {
    return { attachment: await up.done };
  } finally {
    // Kept a moment so a retried last chunk still gets the answer.
    setTimeout(() => uploads.get(key) === up && uploads.delete(key), 60_000);
  }
}

/** Disk the uploads may use: each session's folder, and what's left on the disk. */
export const MAX_SESSION_BYTES = 2 * 1024 * 1024 * 1024;
const MIN_FREE_BYTES = 1024 * 1024 * 1024;

function folderBytes(dir: string): number {
  let n = 0;
  for (const f of readdirSync(dir)) {
    try {
      n += statSync(join(dir, f)).size;
    } catch {}
  }
  return n;
}

/** Refuses an upload that would fill the session's share or the disk. */
function roomFor(dir: string, size: number) {
  const pending = [...uploads.values()].filter((u) => !u.done && u.tmp.startsWith(dir + "/")).reduce((n, u) => n + u.size, 0);
  if (folderBytes(dir) + pending + size > MAX_SESSION_BYTES)
    throw new Error("This session's attachments already use 2 GB on the runner; start a new session to attach more.");
  let free = Infinity;
  try {
    const fs = statfsSync(dir);
    free = Number(fs.bavail) * Number(fs.bsize);
  } catch {}
  if (free - pending - size < MIN_FREE_BYTES) throw new Error("The runner's disk is nearly full.");
}

/** Drops an unfinished upload (by id) or a finished file that was never sent (by path). */
export async function discard(sessionId: string, opts: { uploadId?: string; path?: string }) {
  if (opts.uploadId) {
    const key = `${sessionKey(sessionId)}/${opts.uploadId}`;
    const u = uploads.get(key);
    if (u) {
      uploads.delete(key);
      if (!u.done) {
        await (await u.file.catch(() => undefined))?.close().catch(() => {});
        await unlink(u.tmp).catch(() => {});
      } else await unlink(u.final).catch(() => {});
    }
  }
  if (opts.path) {
    // Only a file in this session's own folder: another session's message may still list it.
    const own = join(attachmentsDir(), sessionKey(sessionId));
    const a = resolveStored(opts.path);
    if (existsSync(own) && inside(a.path, realpathSync(own))) await unlink(a.path).catch(() => {});
  }
}

/** Closes and deletes uploads nobody has added to for a while. */
export function sweepUploads(idleMs = UPLOAD_IDLE_MS) {
  const now = Date.now();
  for (const [key, u] of uploads)
    if (!u.done && now - u.touched >= idleMs) {
      uploads.delete(key);
      void u.file.then((fh) => fh.close()).catch(() => {}).finally(() => unlink(u.tmp).catch(() => {}));
    }
}

// ---------------- stored files ----------------

/**
 * A stored attachment from a path a browser (or a message) names: it must resolve, symlinks
 * included, to a regular file inside the attachments folder that isn't an unfinished upload.
 */
export function resolveStored(path: string): Attachment {
  if (typeof path !== "string" || !path.startsWith("/")) throw new Error("Not an attachment.");
  let real: string;
  let root: string;
  try {
    real = realpathSync(resolve(path));
    root = realpathSync(attachmentsDir());
  } catch {
    throw new Error("That attachment is no longer on the runner.");
  }
  if (!inside(real, root) || real === root) throw new Error("Not an attachment.");
  const base = real.split("/").pop()!;
  if (base.startsWith(".")) throw new Error("Not an attachment.");
  const st = statSync(real);
  if (!st.isFile()) throw new Error("Not an attachment.");
  return { path: real, name: displayName(real), mimeType: mimeFromName(base), size: st.size };
}

/**
 * Opens a stored attachment for reading. The last component isn't followed if it was swapped for
 * a symlink after resolveStored looked, and the open file must be the regular file it checked.
 */
async function openStored(path: string): Promise<{ a: Attachment; fh: FileHandle }> {
  const a = resolveStored(path);
  const fh = await open(a.path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => {
    throw new Error("That attachment is no longer on the runner.");
  });
  try {
    const st = await fh.stat();
    const was = statSync(a.path, { throwIfNoEntry: false });
    if (!st.isFile() || !was || was.ino !== st.ino || was.dev !== st.dev) throw new Error("Not an attachment.");
    return { a: { ...a, size: st.size }, fh };
  } catch (e) {
    await fh.close();
    throw e;
  }
}

/** A whole stored file (a native image or PDF). */
async function readStored(path: string): Promise<Buffer> {
  const { fh } = await openStored(path);
  try {
    return await fh.readFile();
  } finally {
    await fh.close();
  }
}

/** Part of a stored file, base64, for thumbnails and downloads. */
export async function readChunk(path: string, offset = 0, length = CHUNK_BYTES): Promise<{ data: string; size: number; mimeType: string }> {
  offset = Number(offset);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Bad range.");
  const { a, fh } = await openStored(path);
  try {
    if (offset > a.size) throw new Error("Bad range.");
    const len = Math.max(0, Math.min(Number(length) || CHUNK_BYTES, 2 * CHUNK_BYTES, a.size - offset));
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, offset);
    return { data: buf.subarray(0, bytesRead).toString("base64"), size: a.size, mimeType: a.mimeType };
  } finally {
    await fh.close();
  }
}

/** The attachments a message goes out with, checked against the folder (unknown paths refused). */
export function checkAttachments(list: unknown): Attachment[] {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new Error("Bad attachments.");
  if (list.length > 20) throw new Error("Too many attachments.");
  const seen = new Set<string>();
  return list.flatMap((x: any) => {
    const a = resolveStored(String(x?.path ?? ""));
    if (seen.has(a.path)) return [];
    seen.add(a.path);
    // The browser knows the type it uploaded; the name decides only when it didn't say.
    return [{ ...a, mimeType: a.mimeType === "application/octet-stream" ? cleanMime(x?.mimeType, a.name) : a.mimeType }];
  });
}

// ---------------- delivery ----------------

/** What a harness can take natively alongside the message text. */
export interface NativeCaps {
  /** image input (png, jpeg, gif, webp) */
  images: boolean;
  /** PDFs as document input (Claude) */
  pdf?: boolean;
  /** at most this many images per message (the newest win) */
  maxImages?: number;
}

/**
 * Native input is capped well below the upload limits. A file a model API refuses (an image over
 * 5 MB or 8000 px, a PDF over 100 pages or the context) would be refused again with every later
 * turn, since it stays in the session's history; anything over these caps the agent opens by path
 * instead (Claude Code's Read tool resizes images and pages through PDFs itself).
 */
export const MAX_NATIVE_IMAGE_BYTES = 3.75 * 1024 * 1024; // 5 MB as base64
export const MAX_NATIVE_IMAGE_EDGE = 8000;
export const MAX_NATIVE_PDF_BYTES = 4 * 1024 * 1024;
export const MAX_NATIVE_PDF_PAGES = 20;
/** All native files of one message together (requests are capped at 32 MB). */
export const MAX_NATIVE_TOTAL_BYTES = 12 * 1024 * 1024;

/**
 * Which listed attachments also go to the harness natively (types and sizes as checked by
 * probeNative). Every attachment stays in the text block either way, so an agent can always open
 * the file by its path.
 */
export function planDelivery(files: Attachment[], caps: NativeCaps): { images: Attachment[]; documents: Attachment[] } {
  let images = caps.images ? files.filter((f) => NATIVE_IMAGE_TYPES.has(f.mimeType) && f.size <= MAX_NATIVE_IMAGE_BYTES).slice(-(caps.maxImages ?? 8)) : [];
  let documents = caps.pdf ? files.filter((f) => f.mimeType === "application/pdf" && f.size <= MAX_NATIVE_PDF_BYTES).slice(-4) : [];
  // Within the budget, newest first.
  let left = MAX_NATIVE_TOTAL_BYTES;
  const fits = (f: Attachment) => (f.size <= left ? ((left -= f.size), true) : false);
  const keep = new Set([...images, ...documents].reverse().filter(fits));
  images = images.filter((f) => keep.has(f));
  documents = documents.filter((f) => keep.has(f));
  return { images, documents };
}

/** Big-endian / little-endian readers that never throw. */
const be16 = (b: Buffer, i: number) => (i + 2 <= b.length ? b.readUInt16BE(i) : 0);
const be32 = (b: Buffer, i: number) => (i + 4 <= b.length ? b.readUInt32BE(i) : 0);
const le16 = (b: Buffer, i: number) => (i + 2 <= b.length ? b.readUInt16LE(i) : 0);
const le24 = (b: Buffer, i: number) => (i + 3 <= b.length ? b.readUIntLE(i, 3) : 0);

/** An image's real type and size in pixels from its first bytes (PNG, GIF, WebP, JPEG). */
export function imageInfo(b: Buffer): { mimeType: string; width: number; height: number } | undefined {
  if (b.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return { mimeType: "image/png", width: be32(b, 16), height: be32(b, 20) };
  const head = b.subarray(0, 6).toString("latin1");
  if (head === "GIF87a" || head === "GIF89a") return { mimeType: "image/gif", width: le16(b, 6), height: le16(b, 8) };
  if (b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") {
    const kind = b.subarray(12, 16).toString("latin1");
    if (kind === "VP8 ") return { mimeType: "image/webp", width: le16(b, 26) & 0x3fff, height: le16(b, 28) & 0x3fff };
    if (kind === "VP8L" && b.length >= 25) {
      const bits = b.readUInt32LE(21);
      return { mimeType: "image/webp", width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (kind === "VP8X") return { mimeType: "image/webp", width: le24(b, 24) + 1, height: le24(b, 27) + 1 };
    return undefined;
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    // Walk the segments to the frame header (SOFn).
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return undefined;
      const marker = b[i + 1]!;
      if (marker === 0xff) {
        i++;
        continue;
      }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
        return { mimeType: "image/jpeg", width: be16(b, i + 7), height: be16(b, i + 5) };
      i += 2 + be16(b, i + 2);
    }
  }
  return undefined;
}

/** A PDF's page count, when its page objects can be counted (not inside compressed object streams). */
export function pdfPages(b: Buffer): number | undefined {
  if (b.subarray(0, 5).toString("latin1") !== "%PDF-") return undefined;
  const n = b.toString("latin1").match(/\/Type\s*\/Page(?![A-Za-z])/g)?.length ?? 0;
  return n || undefined;
}

/**
 * The file as it may go natively, typed by its content (not by the name or the listed type, which
 * anyone can write), or undefined when it shouldn't: an image models would refuse, a PDF too long
 * or of unknown length.
 */
function probeNative(a: Attachment, data: Buffer): Attachment | undefined {
  const img = imageInfo(data);
  if (img) {
    if (!img.width || !img.height || img.width > MAX_NATIVE_IMAGE_EDGE || img.height > MAX_NATIVE_IMAGE_EDGE) return undefined;
    return { ...a, mimeType: img.mimeType, size: data.length };
  }
  const pages = pdfPages(data);
  if (pages && pages <= MAX_NATIVE_PDF_PAGES) return { ...a, mimeType: "application/pdf", size: data.length };
  return undefined;
}

export interface NativeFile extends Attachment {
  /** base64 */
  data: string;
}

/** The listed files that resolve to stored attachments, as candidates for native input. */
function listedCandidates(text: string): Attachment[] {
  return splitAttachments(text).files.flatMap((f) => {
    try {
      const a = resolveStored(f.path);
      return [{ ...a, mimeType: isImageType(a.mimeType) || a.mimeType === "application/pdf" ? a.mimeType : f.mimeType }];
    } catch {
      return [];
    }
  });
}

/**
 * The attachments listed in a message that go natively to a harness with these capabilities,
 * read from disk. Files that are gone or outside the attachments folder (a block someone typed)
 * are skipped: the text still lists them.
 */
export async function nativeAttachments(text: string, caps: NativeCaps): Promise<{ images: NativeFile[]; documents: NativeFile[] }> {
  if (!caps.images && !caps.pdf) return { images: [], documents: [] };
  // Read what could go (by the stored size), check the content, then plan with what it really is.
  const pre = planDelivery(listedCandidates(text), { ...caps, maxImages: 64 });
  const loaded = new Map<string, NativeFile>();
  for (const a of [...pre.images, ...pre.documents]) {
    const data = await readStored(a.path).catch(() => undefined);
    const ok = data && probeNative(a, data);
    if (ok) loaded.set(a.path, { ...ok, data: data.toString("base64") });
  }
  const plan = planDelivery([...loaded.values()], caps);
  const pick = (list: Attachment[]) => list.map((a) => loaded.get(a.path)!);
  return { images: pick(plan.images), documents: pick(plan.documents) };
}

/** First bytes of a stored file (enough for imageInfo to find a JPEG's frame header behind its metadata). */
function headOf(path: string, bytes = 256 * 1024): Buffer | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(resolveStored(path).path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const buf = Buffer.alloc(bytes);
    return buf.subarray(0, readSync(fd, buf, 0, bytes, 0));
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Image paths a message lists that can go natively (Codex reads them itself). */
export function nativeImagePaths(text: string, maxImages = 8): Attachment[] {
  const checked = listedCandidates(text).flatMap((a) => {
    if (!NATIVE_IMAGE_TYPES.has(a.mimeType) || a.size > MAX_NATIVE_IMAGE_BYTES) return [];
    const head = headOf(a.path);
    const img = head && imageInfo(head);
    if (!img || !img.width || !img.height || img.width > MAX_NATIVE_IMAGE_EDGE || img.height > MAX_NATIVE_IMAGE_EDGE) return [];
    return [{ ...a, mimeType: img.mimeType }];
  });
  return planDelivery(checked, { images: true, maxImages }).images;
}

// ---------------- cleanup ----------------

export const KEEP_DONE_DAYS = 7;
export const KEEP_ANY_DAYS = 90;
const DAY = 86_400_000;

/**
 * The attachment folders (by name) holding files these texts list: a session's own, and those of
 * sessions it was handed off from.
 */
export function referencedFolders(texts: Iterable<string>): Set<string> {
  const root = attachmentsDir();
  const out = new Set<string>();
  for (const t of texts)
    for (const f of splitAttachments(t).files) {
      const p = resolve(f.path);
      if (inside(p, root) && p !== root) out.add(p.slice(root.length + 1).split("/")[0]!);
    }
  return out;
}

function newestMtime(dir: string): number {
  let t = statSync(dir).mtimeMs;
  for (const f of readdirSync(dir)) {
    try {
      t = Math.max(t, statSync(join(dir, f)).mtimeMs);
    } catch {}
  }
  return t;
}

/**
 * Deletes the attachments of sessions removed or marked done more than KEEP_DONE_DAYS ago (by the
 * newest file in their folder), folders nothing has touched in KEEP_ANY_DAYS unless their session
 * is live, and partial uploads older than a day. A folder whose files a live session's messages
 * list (one handed off from it) counts as live. Returns the folders removed.
 */
export function sweepAttachments(opts: { archived: string[]; live: string[]; referenced?: string[]; now?: number }): string[] {
  const root = attachmentsDir();
  if (!existsSync(root)) return [];
  const now = opts.now ?? Date.now();
  const done = new Set(opts.archived.map(sessionKey));
  const live = new Set([...opts.live.map(sessionKey), ...(opts.referenced ?? [])]);
  const removed: string[] = [];
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
      for (const f of readdirSync(dir))
        if (f.endsWith(".partial") && now - statSync(join(dir, f)).mtimeMs > DAY && ![...uploads.values()].some((u) => u.tmp === join(dir, f))) unlinkSync(join(dir, f));
      const age = now - newestMtime(dir);
      if (live.has(name)) continue;
      if ((done.has(name) && age > KEEP_DONE_DAYS * DAY) || age > KEEP_ANY_DAYS * DAY) {
        rmSync(dir, { recursive: true, force: true });
        removed.push(dir);
      }
    } catch {}
  }
  return removed;
}
