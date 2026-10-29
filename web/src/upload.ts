// Attaching files to a message (SPEC §9): photos are scaled down first (a phone's 12 MP shot is
// mostly wasted on an agent), then everything uploads to the runner in chunks over rpc.

import { cleanMime, sizeProblem, type Attachment } from "../../shared/attachments";
import { ATTACH_CHUNK, ATTACH_IMAGE_EDGE } from "../../shared/limits";
import { rpc } from "./connection";

/** Images the browser can redraw smaller (HEIC and SVG upload as they are). */
const SCALABLE = new Set(["image/jpeg", "image/png", "image/webp"]);
/** Smaller than this and within the edge: sent as it is. */
const SMALL = 1.5 * 1024 * 1024;

export interface Prepared {
  blob: Blob;
  name: string;
  mimeType: string;
}

/** A photo scaled to ATTACH_IMAGE_EDGE (JPEG, unless it's a PNG that stays small); anything else as is. */
export async function prepare(file: File): Promise<Prepared> {
  const mimeType = cleanMime(file.type, file.name || "file");
  const name = file.name || (mimeType === "image/png" ? "pasted.png" : mimeType === "image/jpeg" ? "photo.jpg" : "file");
  if (!SCALABLE.has(mimeType) || typeof createImageBitmap !== "function") return { blob: file, name, mimeType };
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    return { blob: file, name, mimeType };
  }
  const scale = Math.min(1, ATTACH_IMAGE_EDGE / Math.max(bmp.width, bmp.height));
  if (scale === 1 && file.size <= SMALL) {
    bmp.close();
    return { blob: file, name, mimeType };
  }
  const w = Math.round(bmp.width * scale);
  const h = Math.round(bmp.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d")!.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const keepPng = mimeType === "image/png" && w * h < 1024 * 1024;
  const type = keepPng ? "image/png" : "image/jpeg";
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, type, 0.85));
  if (!blob || blob.size >= file.size) return { blob: file, name, mimeType };
  return { blob, name: keepPng ? name : name.replace(/\.[A-Za-z0-9]+$/, "") + ".jpg", mimeType: type };
}

function b64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Uploads one file to a session's runner; `progress` gets 0..1. */
export async function upload(runnerId: string, sessionId: string, p: Prepared, progress: (f: number) => void): Promise<Attachment> {
  const problem = sizeProblem(p.blob.size, p.mimeType);
  if (problem) throw new Error(problem);
  const uploadId = crypto.randomUUID().replace(/-/g, "");
  const offsets: number[] = [];
  for (let o = 0; o < p.blob.size; o += ATTACH_CHUNK) offsets.push(o);
  let done = 0;
  let result: Attachment | undefined;
  const one = async (offset: number) => {
    const bytes = new Uint8Array(await p.blob.slice(offset, offset + ATTACH_CHUNK).arrayBuffer());
    let r: { attachment?: Attachment } | undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        r = await rpc(runnerId, "uploadAttachment", { sessionId, uploadId, name: p.name, mimeType: p.mimeType, size: p.blob.size, offset, data: b64(bytes) });
        break;
      } catch (e) {
        if (attempt >= 2) throw e;
        await new Promise((res) => setTimeout(res, 500 * (attempt + 1)));
      }
    }
    if (r?.attachment) result = r.attachment;
    progress(++done / offsets.length);
  };
  // The first chunk alone (it checks the size and type), then three at a time.
  await one(offsets[0]!);
  const rest = offsets.slice(1);
  for (let i = 0; i < rest.length; i += 3) await Promise.all(rest.slice(i, i + 3).map(one));
  if (!result) throw new Error("The upload didn't finish. Try again.");
  return result;
}
