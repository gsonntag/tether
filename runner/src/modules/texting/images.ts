// Images over text, both ways (Photon Spectrum carries iMessage attachments: link.ts). The runner
// reads these files itself, outside any session's sandbox, and they go only to the person's own
// phone (out) or into the session the person texted (in).
//
// Out: an agent's text_person may send one image file after its words. The file is opened once,
// without following a symlink at the end of the path and without blocking on a FIFO, and checked on
// that handle: a regular file, not empty, at most OUT_IMAGE_MAX; an image by its extension AND by
// its first bytes (PNG, JPEG, GIF, WebP, HEIC). The bytes checked are the bytes sent. Every refusal
// says the same thing (IMAGE_REFUSED), so the tool can't tell an agent whether a path exists, and
// failed tries count (texting/index.ts takes a text from the rate cap first; peers counts them with
// failedImages).
//
// In: images the person texts go to the session (or Home agent) the text goes to, as attachments
// (the runner stores them like an upload: core/attachments.ts). Each is downloaded within DOWNLOAD.ms
// and at most IN_IMAGE_MAX bytes (counted as it streams), checked by its bytes; HEIC is turned into
// JPEG when ImageMagick can (the agents can't read HEIC), and an image too big for the agent to see
// (over ATTACH_IMAGE_EDGE, or NATIVE_IMAGE_MAX bytes) is scaled down the same way; when that fails it
// goes as it came. Other files are left out, and the person is told.

import { spawn } from "node:child_process";
import { closeSync, constants, fstatSync, mkdtempSync, openSync, readdirSync, readSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, isAbsolute, join } from "node:path";
import { ATTACH_IMAGE_EDGE, ATTACH_IMAGE_MAX, ATTACH_MAX } from "../../../../shared/limits";
import { NATIVE_IMAGE_MAX } from "../../core/attachments";
import type { TextedFile } from "../homeLine";

/** The biggest image an agent can text. */
export const OUT_IMAGE_MAX = 10 * 1024 * 1024;
/** The biggest image the person can text in that Tether passes on (an upload's cap). */
export const IN_IMAGE_MAX = ATTACH_IMAGE_MAX;
/**
 * How long one incoming image may take to download, and to be converted (waiting for a slot and
 * running, together): at most a minute in all before its text goes on. Tests shorten them.
 */
export const DOWNLOAD = { ms: 30_000, convertMs: 30_000 };

/** What every refused outgoing image says. */
export const IMAGE_REFUSED = "That isn't an image Tether can text: give the absolute path of a .png, .jpg, .gif, .webp or .heic image of at most 10 MB.";

/** The image types that go both ways, by extension. No SVG: it's text (a script, anything) and has no magic bytes. */
const BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".heif": "image/heif",
};

/** An image's type from its first bytes, else undefined. */
export function sniffImage(b: Uint8Array): string | undefined {
  const at = (i: number, bytes: number[]) => bytes.every((x, k) => b[i + k] === x);
  const ascii = (i: number, s: string) => at(i, [...s].map((c) => c.charCodeAt(0)));
  if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (at(0, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) return "image/gif";
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
  if (ascii(4, "ftyp")) {
    const brand = String.fromCharCode(...b.slice(8, 12));
    if (["heic", "heix", "hevc", "hevx", "heim", "heis"].includes(brand)) return "image/heic";
    if (["mif1", "msf1", "heif"].includes(brand)) return "image/heif";
  }
  return undefined;
}

const isHeif = (t: string) => /^image\/hei[cf]$/.test(t);
/** Whether two image types are the same kind (HEIC and HEIF are one container). */
const sameKind = (a: string, b: string) => a === b || (isHeif(a) && isHeif(b));

export type OutImage = TextedFile & { path: string };

/** The image at `path`, read once and checked, for texting: or the one refusal (IMAGE_REFUSED). */
export function readOutgoingImage(path: unknown, max = OUT_IMAGE_MAX): OutImage | { problem: string } {
  const no = { problem: IMAGE_REFUSED };
  if (typeof path !== "string" || !path.trim()) return no;
  const p = path.trim();
  if (!isAbsolute(p)) return no;
  const declared = BY_EXT[extname(p).toLowerCase()];
  if (!declared) return no;
  let fd: number;
  try {
    fd = openSync(p, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  } catch {
    return no;
  }
  let data: Buffer;
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size === 0 || st.size > max) return no;
    // At most max + 1 bytes from this handle: a file that grew since is caught, not read whole.
    const buf = Buffer.alloc(Math.min(st.size, max) + 1);
    let got = 0;
    for (;;) {
      const n = readSync(fd, buf, got, buf.length - got, null);
      if (n <= 0) break;
      got += n;
      if (got >= buf.length) break;
    }
    if (got === 0 || got > max) return no;
    data = buf.subarray(0, got);
  } catch {
    return no;
  } finally {
    closeSync(fd);
  }
  const sniffed = sniffImage(data);
  if (!sniffed || !sameKind(sniffed, declared)) return no;
  return { path: p, name: basename(p), mimeType: sniffed, data };
}

/** Failed image checks per sender (peers' pre-check): past FAILS_MAX in FAILS_MS, every check fails. */
export class ImageFailures {
  private fails: { from: string; at: number }[] = [];
  constructor(private now: () => number = Date.now) {}
  static readonly MAX = 5;
  static readonly MS = 10 * 60_000;
  /** Whether `from` may try another image now. */
  allowed(from: string): boolean {
    const at = this.now();
    this.fails = this.fails.filter((f) => at - f.at < ImageFailures.MS);
    return this.fails.filter((f) => f.from === from).length < ImageFailures.MAX;
  }
  failed(from: string) {
    this.fails.push({ from, at: this.now() });
  }
}

/** A file the person texted, before it's downloaded (link.ts). */
export interface InboundFile {
  name: string;
  mimeType: string;
  size?: number;
  read(): Promise<Buffer>;
  stream?(): Promise<ReadableStream<Uint8Array>>;
}

/** Which of the person's files Tether can pass on (images, not too big, at most ATTACH_MAX), and how many it can't. */
export function pickIncoming(files: InboundFile[]): { take: InboundFile[]; left: number } {
  const take = files.filter((f) => /^image\//i.test(f.mimeType) && !/svg/i.test(f.mimeType) && !(typeof f.size === "number" && f.size > IN_IMAGE_MAX)).slice(0, ATTACH_MAX);
  return { take, left: files.length - take.length };
}

/**
 * A file's bytes, within `ms` and at most `max` (counted as they stream, whatever its size says):
 * throws past either, and stops the download.
 */
export async function download(f: InboundFile, max = IN_IMAGE_MAX, ms = DOWNLOAD.ms): Promise<Buffer> {
  let stop: () => void = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, no) => {
    timer = setTimeout(() => (stop(), no(new Error("the download took too long"))), ms);
  });
  const work = (async () => {
    if (f.stream) {
      const reader = (await f.stream()).getReader();
      stop = () => void reader.cancel().catch(() => {});
      const parts: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > max) {
          stop();
          throw new Error("the image is too big");
        }
        parts.push(value);
      }
      return Buffer.concat(parts);
    }
    const b = await f.read();
    if (b.length > max) throw new Error("the image is too big");
    return b;
  })();
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
    work.catch(() => {});
  }
}

/** An image's width and height from its first bytes (PNG, GIF, JPEG, WebP), else undefined. */
export function imageDims(b: Uint8Array): { w: number; h: number } | undefined {
  const be16 = (i: number) => (b[i]! << 8) | b[i + 1]!;
  const le16 = (i: number) => b[i]! | (b[i + 1]! << 8);
  const be32 = (i: number) => ((b[i]! << 24) >>> 0) + (b[i + 1]! << 16) + (b[i + 2]! << 8) + b[i + 3]!;
  const ok = (w: number, h: number) => (w > 0 && h > 0 ? { w, h } : undefined);
  const t = sniffImage(b);
  if (t === "image/png" && b.length >= 24) return ok(be32(16), be32(20));
  if (t === "image/gif" && b.length >= 10) return ok(le16(6), le16(8));
  if (t === "image/jpeg") {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return undefined;
      const m = b[i + 1]!;
      if (m === 0xff) {
        i++;
        continue;
      }
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return ok(be16(i + 7), be16(i + 5));
      i += 2 + be16(i + 2);
    }
    return undefined;
  }
  if (t === "image/webp" && b.length >= 30) {
    const kind = String.fromCharCode(...b.slice(12, 16));
    if (kind === "VP8 ") return ok(le16(26) & 0x3fff, le16(28) & 0x3fff);
    if (kind === "VP8L") {
      const v = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24);
      return ok((v & 0x3fff) + 1, ((v >>> 14) & 0x3fff) + 1);
    }
    if (kind === "VP8X") return ok(1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)), 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16)));
  }
  return undefined;
}

/** Whether a texted image is too big for the agent to see as an image: over the edge, or over what the model APIs take. */
export function tooBigToSee(data: Buffer): boolean {
  if (data.length > NATIVE_IMAGE_MAX) return true;
  const d = imageDims(data);
  return !!d && Math.max(d.w, d.h) > ATTACH_IMAGE_EDGE;
}

/** Turns image bytes (`from`: their ImageMagick coder) into a JPEG at most ATTACH_IMAGE_EDGE on its long edge: the JPEG, or undefined when it can't. */
export type Convert = (data: Buffer, from: "heic" | "png" | "jpeg" | "webp") => Promise<Buffer | undefined>;

/** At most this many conversions at once (each is a process that can take a lot of memory). */
export const CONVERT_MAX = 2;
let converting = 0;
const waiting: (() => void)[] = [];

/**
 * Runs `f` in a conversion slot, waiting at most `waitMs` for one (then throws: the image goes as it
 * came). A finished one hands its slot straight to the next in line, so never more than CONVERT_MAX
 * run. `f` gets how long it has left of `waitMs`.
 */
export async function inSlot<T>(f: (leftMs: number) => Promise<T>, waitMs: number): Promise<T> {
  const start = Date.now();
  if (converting < CONVERT_MAX) converting++;
  else
    await new Promise<void>((go, no) => {
      const take = () => (clearTimeout(timer), go());
      const timer = setTimeout(() => {
        const i = waiting.indexOf(take);
        if (i >= 0) waiting.splice(i, 1);
        no(new Error("no conversion slot in time"));
      }, waitMs);
      waiting.push(take);
    });
  try {
    return await f(Math.max(0, waitMs - (Date.now() - start)));
  } finally {
    const next = waiting.shift();
    // The slot goes to the next one as it is: the count stays.
    if (next) next();
    else converting--;
  }
}

/** The prefix of ImageMagick's temporary folders. */
const MAGICK_TMP = "tether-magick-";

/** Removes ImageMagick temporary folders an earlier runner left (older than an hour). */
export function sweepMagickTemp(dir = tmpdir(), now = Date.now()) {
  try {
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(MAGICK_TMP)) continue;
      const p = join(dir, name);
      try {
        if (now - statSync(p).mtimeMs > 60 * 60_000) rmSync(p, { recursive: true, force: true });
      } catch {}
    }
  } catch {}
}

/**
 * ImageMagick (`convert`), told what the input is (never left to guess a coder from the bytes),
 * bounded (memory, map, disk, pixel area and size, time; its temporary files in a folder of its own,
 * removed after), at most CONVERT_MAX at once, waiting and running within DOWNLOAD.convertMs, scaled
 * down to ATTACH_IMAGE_EDGE, output capped. Undefined when it isn't installed, fails, or runs out of
 * time.
 */
export const imagemagick: Convert = (data, from) =>
  inSlot(async (leftMs) => {
    if (leftMs <= 0) return undefined;
    let tmp: string | undefined;
    try {
      tmp = mkdtempSync(join(tmpdir(), MAGICK_TMP));
    } catch {
      return undefined;
    }
    try {
      return await new Promise<Buffer | undefined>((done) => {
        let out: Buffer[] = [];
        let size = 0;
        let p;
        try {
          p = spawn(
            "convert",
            [
              ...["-limit", "memory", "256MiB", "-limit", "map", "512MiB", "-limit", "disk", "256MiB"],
              ...["-limit", "area", "128MP", "-limit", "width", "16KP", "-limit", "height", "16KP", "-limit", "time", String(Math.max(1, Math.ceil(leftMs / 1000)))],
              `${from}:-`,
              ...["-auto-orient", "-resize", `${ATTACH_IMAGE_EDGE}x${ATTACH_IMAGE_EDGE}>`, "-quality", "85", "jpeg:-"],
            ],
            { stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, MAGICK_TEMPORARY_PATH: tmp, MAGICK_TMPDIR: tmp, TMPDIR: tmp } },
          );
        } catch {
          return done(undefined);
        }
        const timer = setTimeout(() => p.kill("SIGKILL"), leftMs);
        p.on("error", () => (clearTimeout(timer), done(undefined)));
        p.stdout.on("data", (c: Buffer) => {
          size += c.length;
          if (size > IN_IMAGE_MAX) {
            out = [];
            p.kill("SIGKILL");
          } else out.push(c);
        });
        p.on("close", (code) => {
          clearTimeout(timer);
          const jpeg = Buffer.concat(out);
          done(code === 0 && size <= IN_IMAGE_MAX && sniffImage(jpeg) === "image/jpeg" ? jpeg : undefined);
        });
        p.stdin.on("error", () => {});
        p.stdin.end(data);
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, DOWNLOAD.convertMs).catch(() => undefined);

const CODER: Record<string, "heic" | "png" | "jpeg" | "webp"> = { "image/heic": "heic", "image/heif": "heic", "image/png": "png", "image/jpeg": "jpeg", "image/webp": "webp" };
const jpgName = (name: string) => `${name.replace(/\.[A-Za-z0-9]{1,10}$/, "")}.jpg`;

/**
 * A downloaded file as one to pass on: its real type from its bytes, or undefined when it isn't an
 * image after all. HEIC becomes JPEG when it can (else `heic`: kept as it is, by path only), and a
 * PNG, JPEG or WebP too big for the agent to see (tooBigToSee) is scaled down to a JPEG (else kept).
 */
export async function incomingImage(f: Pick<InboundFile, "name">, data: Buffer, convert: Convert = imagemagick): Promise<(TextedFile & { heic?: boolean }) | undefined> {
  if (!data.length || data.length > IN_IMAGE_MAX) return undefined;
  const mimeType = sniffImage(data);
  if (!mimeType) return undefined;
  const name = f.name || "image";
  if (isHeif(mimeType)) {
    const jpeg = await convert(data, "heic").catch(() => undefined);
    if (jpeg) return { name: jpgName(name), mimeType: "image/jpeg", data: jpeg };
    // Kept as it came: by its own kind's name, never whatever name the sender gave it.
    return { name: `${name.replace(/\.[A-Za-z0-9]{1,10}$/, "")}.heic`, mimeType, data, heic: true };
  }
  if (CODER[mimeType] && tooBigToSee(data)) {
    const jpeg = await convert(data, CODER[mimeType]!).catch(() => undefined);
    if (jpeg) return { name: jpgName(name), mimeType: "image/jpeg", data: jpeg };
  }
  return { name, mimeType, data };
}
