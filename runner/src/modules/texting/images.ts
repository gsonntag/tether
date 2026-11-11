// Images over text, both ways (Photon Spectrum carries iMessage attachments: link.ts).
//
// Out: an agent's text_person may send one image file after its words. The path is checked before
// anything goes: an absolute path to a regular file (symlinks resolved), an image by its extension
// AND by its first bytes (PNG, JPEG, GIF, WebP, HEIC), at most OUT_IMAGE_MAX. So a session can't text
// a key file, a .env or a database to the phone by naming it, whatever it calls it; and the bytes
// sent are the bytes checked (read once, here).
//
// In: images the person texts go to the session (or Home agent) the text goes to, as attachments
// (the runner stores them like an upload: core/attachments.ts). Other files are left out, and the
// person is told.

import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, extname, isAbsolute } from "node:path";
import { ATTACH_IMAGE_MAX, ATTACH_MAX } from "../../../../shared/limits";
import type { TextedFile } from "../homeLine";

/** The biggest image an agent can text. */
export const OUT_IMAGE_MAX = 10 * 1024 * 1024;
/** The biggest image the person can text in that Tether passes on (an upload's cap). */
export const IN_IMAGE_MAX = ATTACH_IMAGE_MAX;

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

/** Whether two image types are the same kind (HEIC and HEIF are one container). */
const sameKind = (a: string, b: string) => a === b || (/^image\/hei[cf]$/.test(a) && /^image\/hei[cf]$/.test(b));

export type OutImage = TextedFile & { path: string };

/**
 * The image at `path`, read and checked, for texting: or why it can't go. Never names more of the
 * file than the agent already did.
 */
export function readOutgoingImage(path: unknown, max = OUT_IMAGE_MAX): OutImage | { problem: string } {
  if (typeof path !== "string" || !path.trim()) return { problem: "The image path is empty." };
  const p = path.trim();
  if (!isAbsolute(p)) return { problem: "Give the image as an absolute path." };
  let real: string;
  try {
    real = realpathSync(p);
  } catch {
    return { problem: "There's no file at that image path." };
  }
  const declared = BY_EXT[extname(real).toLowerCase()];
  if (!declared) return { problem: "Only images can be texted: a .png, .jpg, .gif, .webp or .heic file." };
  let st;
  try {
    st = lstatSync(real);
  } catch {
    return { problem: "There's no file at that image path." };
  }
  if (!st.isFile()) return { problem: "That image path isn't a file." };
  if (st.size === 0) return { problem: "That image is empty." };
  if (st.size > max) return { problem: `That image is too big to text (at most ${Math.round(max / 1024 / 1024)} MB).` };
  let data: Buffer;
  try {
    data = readFileSync(real);
  } catch {
    return { problem: "That image can't be read." };
  }
  if (data.length > max) return { problem: `That image is too big to text (at most ${Math.round(max / 1024 / 1024)} MB).` };
  const sniffed = sniffImage(data);
  if (!sniffed || !sameKind(sniffed, declared)) return { problem: "That file isn't the image its name says: only real images can be texted." };
  return { path: real, name: basename(real), mimeType: sniffed, data };
}

/** A file the person texted, before it's downloaded (link.ts). */
export interface InboundFile {
  name: string;
  mimeType: string;
  size?: number;
  read(): Promise<Buffer>;
}

/** Which of the person's files Tether can pass on (images, not too big, at most ATTACH_MAX), and how many it can't. */
export function pickIncoming(files: InboundFile[]): { take: InboundFile[]; left: number } {
  const take = files.filter((f) => /^image\//i.test(f.mimeType) && !/svg/i.test(f.mimeType) && !(typeof f.size === "number" && f.size > IN_IMAGE_MAX)).slice(0, ATTACH_MAX);
  return { take, left: files.length - take.length };
}

/** A downloaded file as one to pass on: its real type from its bytes, or undefined when it isn't an image after all. */
export function incomingImage(f: Pick<InboundFile, "name">, data: Buffer): TextedFile | undefined {
  if (!data.length || data.length > IN_IMAGE_MAX) return undefined;
  const mimeType = sniffImage(data);
  if (!mimeType) return undefined;
  return { name: f.name || "image", mimeType, data };
}
