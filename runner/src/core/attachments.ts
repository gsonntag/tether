// Files attached to messages (SPEC §9; shared/attachments.ts has the format, shared/limits.ts the
// caps). Uploads arrive in chunks over rpc and are written to a hidden partial file beside their
// final place; the chunk that completes a file renames it into place, read-only. Everything lives
// under <config dir>/attachments/<session>/, never in a project, and every attachment a message
// names is checked to be a file there (symlinks resolved) before it goes to a harness.

import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { chmod, open, rename, unlink, type FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";
import { cleanMime, displayName, NATIVE_IMAGE_TYPES, safeName, sizeProblem, type Attachment } from "../../../shared/attachments";
import { ATTACH_CHUNK, ATTACH_IMAGE_MAX, ATTACH_MAX, ATTACH_SESSION_MAX } from "../../../shared/limits";

/** A session id as one folder name. */
export const sessionKey = (sessionId: string) => String(sessionId).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 160) || "_";

const inside = (p: string, dir: string) => p.startsWith(dir.replace(/\/$/, "") + "/");

/** Extensions for image types whose names lack one (a pasted screenshot named "image"). */
const IMAGE_EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

interface Upload {
  tmp: string;
  final: string;
  name: string;
  mimeType: string;
  size: number;
  got: Set<number>;
  received: number;
  file: Promise<FileHandle>;
  touched: number;
  done?: Promise<Attachment>;
}

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

const MAX_OPEN = 40;
/** Raw bytes of an image sent as an image: 5 MB once base64 (the Anthropic API's per-image cap). */
export const NATIVE_IMAGE_MAX = Math.floor((5 * 1024 * 1024 * 3) / 4) - 1024;
/** Raw bytes of all images sent as images with one message; the rest go by path. */
export const NATIVE_IMAGES_TOTAL = 15 * 1024 * 1024;

/** The images of a message that go to the harness as images (within the caps), in order. */
export function nativeImages(list: Attachment[]): { attachment: Attachment; mimeType: string; data: string }[] {
  const out: { attachment: Attachment; mimeType: string; data: string }[] = [];
  let total = 0;
  for (const a of list) {
    if (total + a.size > NATIVE_IMAGES_TOTAL) continue;
    const img = AttachmentStore.nativeImage(a);
    if (!img) continue;
    total += a.size;
    out.push({ attachment: a, ...img });
  }
  return out;
}
const IDLE_MS = 10 * 60_000;

/**
 * An image Tether attached, read back for a transcript (Codex keeps only its path), or undefined
 * when the path isn't one of this runner's attachments.
 */
export const attachedImage = (path: string) => AttachmentStore.current?.imageOf(path);

/** The attachments of one runner. */
export class AttachmentStore {
  /** the runner's store (live.ts sets it), for transcripts that name attachments by path */
  static current?: AttachmentStore;

  private uploads = new Map<string, Upload>();
  private sweeper?: ReturnType<typeof setInterval>;

  readonly dir: string;

  /** `dir` is resolved (symlinks too), so files checked by their real path compare against it. */
  constructor(dir: string) {
    let real = dir;
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      real = realpathSync(dir);
    } catch {}
    this.dir = real;
  }

  sessionDir(sessionId: string) {
    return join(this.dir, sessionKey(sessionId));
  }

  /** Writes one chunk; the one that completes the file answers with the stored attachment. */
  async receive(a: ChunkArgs): Promise<{ attachment?: Attachment }> {
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(String(a.uploadId))) throw new Error("Bad upload id.");
    const size = Number(a.size);
    const offset = Number(a.offset);
    if (!Number.isSafeInteger(size) || !Number.isSafeInteger(offset)) throw new Error("Bad upload size.");
    const key = `${sessionKey(a.sessionId)}/${a.uploadId}`;
    const buf = Buffer.from(String(a.data ?? ""), "base64");
    const badChunk = () => offset < 0 || offset >= size || offset % ATTACH_CHUNK !== 0 || buf.length !== Math.min(ATTACH_CHUNK, size - offset);
    let u = this.uploads.get(key);
    if (!u) {
      let name = safeName(a.name);
      const mimeType = cleanMime(a.mimeType, name);
      const problem = sizeProblem(size, mimeType);
      if (problem) throw new Error(problem);
      if (badChunk()) throw new Error("Bad upload chunk.");
      if (IMAGE_EXT[mimeType] && !name.toLowerCase().endsWith(`.${IMAGE_EXT[mimeType]}`) && !(mimeType === "image/jpeg" && /\.jpe?g$/i.test(name)))
        name = `${name.replace(/\.[A-Za-z0-9]{1,10}$/, "")}.${IMAGE_EXT[mimeType]}`;
      this.sweep();
      if (this.uploads.size >= MAX_OPEN) throw new Error("Too many uploads at once; try again in a moment.");
      const dir = this.sessionDir(a.sessionId);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      this.roomFor(dir, size);
      const id = randomBytes(4).toString("hex");
      const tmp = join(dir, `.${id}.partial`);
      u = { tmp, final: join(dir, `${id}-${name}`), name, mimeType, size, got: new Set(), received: 0, file: open(tmp, "w", 0o600), touched: Date.now() };
      this.uploads.set(key, u);
      this.startSweeper();
    } else if (u.size !== size) throw new Error("The upload changed size.");
    u.touched = Date.now();
    if (u.done) return { attachment: await u.done };
    if (badChunk()) throw new Error("Bad upload chunk.");
    if (u.got.has(offset)) return {};
    u.got.add(offset);
    let fh: FileHandle;
    try {
      fh = await u.file;
      await fh.write(buf, 0, buf.length, offset);
    } catch (e) {
      u.got.delete(offset);
      throw e;
    }
    u.received += buf.length;
    if (u.received < u.size) return {};
    const up = u;
    up.done = (async () => {
      await fh.close();
      // Read-only on disk too: an agent's shell can't overwrite what you attached.
      await chmod(up.tmp, 0o400).catch(() => {});
      await rename(up.tmp, up.final);
      return { path: up.final, name: up.name, mimeType: up.mimeType, size: up.size };
    })();
    try {
      return { attachment: await up.done };
    } finally {
      // Kept a moment, so a retried last chunk still gets the answer.
      setTimeout(() => this.uploads.get(key) === up && this.uploads.delete(key), 60_000).unref?.();
    }
  }

  /**
   * The attachments a message names, checked: each a file under this session's folder (or, for a
   * subagent, its main session's), as it is on disk. Anything else fails the message.
   */
  check(sessionIds: string[], list: unknown): Attachment[] {
    if (list === undefined || list === null) return [];
    if (!Array.isArray(list)) throw new Error("Attachments must be a list.");
    if (list.length > ATTACH_MAX) throw new Error(`At most ${ATTACH_MAX} attachments on one message.`);
    const dirs = sessionIds.map((id) => this.sessionDir(id));
    return list.map((a: any) => {
      const p = resolve(String(a?.path ?? ""));
      let real: string;
      try {
        real = realpathSync(p);
      } catch {
        throw new Error(`The attachment ${displayName(p)} is gone from the runner. Attach it again.`);
      }
      if (!dirs.some((d) => inside(real, d))) throw new Error("That attachment doesn't belong to this session.");
      const st = statSync(real);
      if (!st.isFile()) throw new Error("That attachment isn't a file.");
      const name = displayName(real);
      return { path: real, name, mimeType: cleanMime(typeof a?.mimeType === "string" ? a.mimeType : undefined, name), size: st.size };
    });
  }

  /**
   * An image attachment's bytes as base64, when it is one a harness takes natively and small enough
   * for the model APIs (5 MB of base64 per image); a bigger one goes by its path only.
   */
  static nativeImage(a: Attachment): { mimeType: string; data: string } | undefined {
    if (!NATIVE_IMAGE_TYPES.has(a.mimeType) || a.size > NATIVE_IMAGE_MAX) return undefined;
    try {
      return { mimeType: a.mimeType, data: readFileSync(a.path).toString("base64") };
    } catch {
      return undefined;
    }
  }

  /**
   * An image file under this store as an image part's data (Codex keeps only the path of an image
   * it was given): undefined when it isn't one of ours, is gone, or is too big to show inline.
   */
  imageOf(path: string): { mimeType: string; data: string } | undefined {
    let real: string;
    try {
      real = realpathSync(path);
    } catch {
      return undefined;
    }
    if (!inside(real, this.dir)) return undefined;
    const mimeType = cleanMime(undefined, real);
    if (!NATIVE_IMAGE_TYPES.has(mimeType)) return undefined;
    try {
      if (statSync(real).size > ATTACH_IMAGE_MAX) return undefined;
      return { mimeType, data: readFileSync(real).toString("base64") };
    } catch {
      return undefined;
    }
  }

  stop() {
    clearInterval(this.sweeper);
  }

  private startSweeper() {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref?.();
  }

  /** Uploads nobody finished in a while are dropped with their partial files. */
  private sweep(idleMs = IDLE_MS) {
    const now = Date.now();
    for (const [k, u] of this.uploads) {
      if (u.done || now - u.touched < idleMs) continue;
      this.uploads.delete(k);
      void u.file.then((f) => f.close()).catch(() => {});
      void unlink(u.tmp).catch(() => {});
    }
  }

  private roomFor(dir: string, size: number) {
    let used = 0;
    for (const f of readdirSync(dir)) {
      try {
        used += statSync(join(dir, f)).size;
      } catch {}
    }
    for (const u of this.uploads.values()) if (!u.done && u.tmp.startsWith(dir + "/")) used += u.size;
    if (used + size > ATTACH_SESSION_MAX) throw new Error("This session's attachments already use 2 GB on the runner. Start a new session to attach more.");
  }
}
