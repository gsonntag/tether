// Files attached to messages (web/src/shared/attachments.ts has the format and the limits).
//
// Uploads arrive in fixed-size chunks over the RPC channel and are written straight to a hidden
// partial file next to their final place; the chunk that completes a file renames it into place.
// Everything lives under TETHER_CONFIG_DIR/attachments/<session>/, never in a repository, and every
// path that comes back from a browser is checked to resolve (symlinks too) inside that folder.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, unlinkSync } from "node:fs";
import { open, readFile, rename, unlink, type FileHandle } from "node:fs/promises";
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

/** The folder name for a session: its id with anything but letters, digits, `_` and `-` replaced. */
export function sessionKey(sessionId: string): string {
  const k = String(sessionId).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 160);
  return k || "_";
}

const inside = (p: string, dir: string) => p === dir || p.startsWith(dir.replace(/\/$/, "") + "/");

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
    const dir = join(attachmentsDir(), sessionKey(a.sessionId));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
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
  if (u.got.has(offset)) return {}; // a retry of a chunk already written
  u.got.add(offset);
  const fh = await u.file;
  await fh.write(buf, 0, buf.length, offset);
  u.received += buf.length;
  if (u.received < u.size) return {};
  const up = u;
  up.done = (async () => {
    await fh.close();
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

/** Part of a stored file, base64, for thumbnails and downloads. */
export async function readChunk(path: string, offset = 0, length = CHUNK_BYTES): Promise<{ data: string; size: number; mimeType: string }> {
  const a = resolveStored(path);
  const len = Math.max(0, Math.min(Number(length) || CHUNK_BYTES, 2 * CHUNK_BYTES, a.size - offset));
  if (!Number.isSafeInteger(offset) || offset < 0 || (offset > a.size)) throw new Error("Bad range.");
  const fh = await open(a.path, "r");
  try {
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

/** Native PDFs are capped well below the upload limit: each one stays in the context for the session. */
export const MAX_NATIVE_PDF_BYTES = 4 * 1024 * 1024;

/**
 * Which listed attachments also go to the harness natively. Every attachment stays in the text
 * block either way, so an agent can always open the file by its path.
 */
export function planDelivery(files: Attachment[], caps: NativeCaps): { images: Attachment[]; documents: Attachment[] } {
  const images = caps.images ? files.filter((f) => NATIVE_IMAGE_TYPES.has(f.mimeType) && f.size <= MAX_IMAGE_BYTES).slice(-(caps.maxImages ?? 8)) : [];
  const documents = caps.pdf ? files.filter((f) => f.mimeType === "application/pdf" && f.size <= MAX_NATIVE_PDF_BYTES).slice(-4) : [];
  return { images, documents };
}

export interface NativeFile extends Attachment {
  /** base64 */
  data: string;
}

/**
 * The attachments listed in a message that go natively to a harness with these capabilities,
 * read from disk. Files that are gone or outside the attachments folder (a block someone typed)
 * are skipped: the text still lists them.
 */
export async function nativeAttachments(text: string, caps: NativeCaps): Promise<{ images: NativeFile[]; documents: NativeFile[] }> {
  if (!caps.images && !caps.pdf) return { images: [], documents: [] };
  const listed = splitAttachments(text).files.flatMap((f) => {
    try {
      const a = resolveStored(f.path);
      return [{ ...a, mimeType: isImageType(f.mimeType) || f.mimeType === "application/pdf" ? f.mimeType : a.mimeType }];
    } catch {
      return [];
    }
  });
  const plan = planDelivery(listed, caps);
  const load = (list: Attachment[]) => Promise.all(list.map(async (a) => ({ ...a, data: (await readFile(a.path)).toString("base64") })));
  return { images: await load(plan.images), documents: await load(plan.documents) };
}

/** Image paths a message lists that can go natively (Codex reads them itself). */
export function nativeImagePaths(text: string, maxImages = 8): Attachment[] {
  const listed = splitAttachments(text).files.flatMap((f) => {
    try {
      return [{ ...resolveStored(f.path), mimeType: f.mimeType }];
    } catch {
      return [];
    }
  });
  return planDelivery(listed, { images: true, maxImages }).images;
}

// ---------------- cleanup ----------------

export const KEEP_DONE_DAYS = 7;
export const KEEP_ANY_DAYS = 90;
const DAY = 86_400_000;

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
 * is live, and partial uploads older than a day. Returns the folders removed.
 */
export function sweepAttachments(opts: { archived: string[]; live: string[]; now?: number }): string[] {
  const root = attachmentsDir();
  if (!existsSync(root)) return [];
  const now = opts.now ?? Date.now();
  const done = new Set(opts.archived.map(sessionKey));
  const live = new Set(opts.live.map(sessionKey));
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
