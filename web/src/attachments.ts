// The browser side of attachments (web/src/shared/attachments.ts has the format and limits):
// downscaling photos, chunked uploads to the runner, and reading stored files back for thumbnails
// and downloads. Everything goes over the RPC channel, so it needs no endpoint of its own.

import { useEffect, useState, useSyncExternalStore } from "react";
import {
  CHUNK_BYTES,
  cleanMime,
  formatSize,
  IMAGE_MAX_EDGE,
  isImageType,
  MAX_ATTACHMENTS,
  sizeProblem,
  splitAttachments,
  type Attachment,
} from "./shared/attachments";
import { rpc } from "./store";

/** One file in the composer: uploading, uploaded, or refused. */
export interface Draft {
  key: string;
  name: string;
  mimeType: string;
  size: number;
  /** local preview (object URL) for images */
  preview?: string;
  /** 0..1 while uploading */
  progress: number;
  attachment?: Attachment;
  error?: string;
  uploadId: string;
}

/** Images the model can read; others (HEIC, SVG, …) are sent as plain files. */
const RASTER = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const UPLOAD_PARALLEL = 3;

/**
 * A photo with a long edge over IMAGE_MAX_EDGE, re-encoded at that size (JPEG unless it was PNG
 * and stays small); GIFs (animation) and small images go as they are.
 */
export async function downscale(file: File): Promise<File> {
  if (!RASTER.has(file.type) || file.type === "image/gif" || typeof createImageBitmap !== "function") return file;
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    return file;
  }
  const edge = Math.max(bmp.width, bmp.height);
  const scale = IMAGE_MAX_EDGE / edge;
  if (scale >= 1) {
    bmp.close();
    return file;
  }
  const w = Math.round(bmp.width * scale);
  const h = Math.round(bmp.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d")!.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const toBlob = (type: string, q?: number) => new Promise<Blob | null>((r) => canvas.toBlob(r, type, q));
  let blob = file.type === "image/png" ? await toBlob("image/png") : null;
  let type = "image/png";
  if (!blob || blob.size > 4 * 1024 * 1024) {
    blob = await toBlob("image/jpeg", 0.88);
    type = "image/jpeg";
  }
  if (!blob) return file;
  // A smooth screenshot can come out larger at fewer pixels; the original is fine then, as long as
  // it isn't so large the models refuse it.
  if (blob.size >= file.size && edge <= 8000) return file;
  const name = type === "image/jpeg" ? file.name.replace(/\.(png|webp|jpe?g)$/i, "") + ".jpg" : file.name;
  return new File([blob], name, { type });
}

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Uploads a file in chunks (a few at a time); resolves with the stored attachment. */
export async function upload(sessionId: string, uploadId: string, file: File, mimeType: string, onProgress: (p: number) => void, cancelled: () => boolean): Promise<Attachment> {
  const size = file.size;
  const offsets: number[] = [];
  for (let o = 0; o < size; o += CHUNK_BYTES) offsets.push(o);
  let sent = 0;
  let result: Attachment | undefined;
  const worker = async () => {
    while (offsets.length) {
      if (cancelled()) throw new Error("cancelled");
      const offset = offsets.shift()!;
      const data = toBase64(await file.slice(offset, offset + CHUNK_BYTES).arrayBuffer());
      let tries = 0;
      for (;;) {
        try {
          const r = await rpc("uploadAttachment", { sessionId, uploadId, name: file.name, mimeType, size, offset, data });
          if (r.attachment) result = r.attachment;
          break;
        } catch (e: any) {
          // A dropped connection gets a few retries; a refusal (too large, bad file) doesn't.
          if (++tries >= 3 || !/connected|in time/i.test(e?.message ?? "")) throw e;
          await new Promise((r) => setTimeout(r, 1000 * tries));
        }
      }
      sent += Math.min(CHUNK_BYTES, size - offset);
      onProgress(sent / size);
    }
  };
  await Promise.all(Array.from({ length: Math.min(UPLOAD_PARALLEL, offsets.length) }, worker));
  if (!result) throw new Error("The upload didn't complete.");
  return result;
}

// ---------------- the composer's attachments, per session ----------------
// Kept outside React so a drop on the transcript, a paste and the picker all add to the same
// list, and switching sessions keeps what was attached.

const drafts = new Map<string, Draft[]>();
const listeners = new Set<() => void>();
const EMPTY: Draft[] = [];
const cancelledKeys = new Set<string>();

function setDrafts(sessionId: string, list: Draft[]) {
  if (list.length) drafts.set(sessionId, list);
  else drafts.delete(sessionId);
  for (const l of listeners) l();
}

function patch(sessionId: string, key: string, change: Partial<Draft>) {
  const list = drafts.get(sessionId) ?? [];
  if (!list.some((d) => d.key === key)) return;
  setDrafts(sessionId, list.map((d) => (d.key === key ? { ...d, ...change } : d)));
}

export function useDrafts(sessionId: string): Draft[] {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => drafts.get(sessionId) ?? EMPTY,
  );
}

let keyN = 0;
const newUploadId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

/** Adds files to a session's composer and starts uploading them. */
export function addFiles(sessionId: string, files: Iterable<File>) {
  const list = [...(drafts.get(sessionId) ?? [])];
  const started: [Draft, File][] = [];
  for (const raw of files) {
    const key = `a${++keyN}`;
    const mimeType = cleanMime(raw.type, raw.name || "file");
    const d: Draft = { key, name: raw.name || (isImageType(mimeType) ? "pasted-image.png" : "file"), mimeType, size: raw.size, progress: 0, uploadId: newUploadId() };
    if (list.filter((x) => !x.error).length >= MAX_ATTACHMENTS) d.error = `At most ${MAX_ATTACHMENTS} files per message.`;
    if (RASTER.has(mimeType)) d.preview = URL.createObjectURL(raw);
    list.push(d);
    if (!d.error) started.push([d, raw]);
  }
  // Listed first: an upload reports its progress (or a refusal) by updating its chip.
  setDrafts(sessionId, list);
  for (const [d, raw] of started) void start(sessionId, d, raw);
}

async function start(sessionId: string, d: Draft, raw: File) {
  try {
    const file = isImageType(d.mimeType) ? await downscale(raw) : raw;
    const mimeType = file === raw ? d.mimeType : cleanMime(file.type, file.name);
    const problem = sizeProblem(file.size, mimeType);
    if (problem) return patch(sessionId, d.key, { error: problem });
    patch(sessionId, d.key, { size: file.size, mimeType, name: file.name || d.name });
    const attachment = await upload(sessionId, d.uploadId, file, mimeType, (progress) => patch(sessionId, d.key, { progress }), () => cancelledKeys.has(d.key));
    if (cancelledKeys.has(d.key)) return void rpc("discardAttachment", { sessionId, path: attachment.path }).catch(() => {});
    patch(sessionId, d.key, { attachment, progress: 1 });
  } catch (e: any) {
    if (!cancelledKeys.has(d.key)) patch(sessionId, d.key, { error: e?.message ?? String(e) });
  }
}

/** The x on a chip: stops its upload and deletes what the runner already has. */
export function removeDraft(sessionId: string, key: string) {
  const list = drafts.get(sessionId) ?? [];
  const d = list.find((x) => x.key === key);
  if (!d) return;
  cancelledKeys.add(key);
  if (d.preview) URL.revokeObjectURL(d.preview);
  if (!d.error) rpc("discardAttachment", { sessionId, uploadId: d.uploadId, path: d.attachment?.path }).catch(() => {});
  setDrafts(sessionId, list.filter((x) => x.key !== key));
}

/** After a send: the files went with the message (the runner keeps them). */
export function clearDrafts(sessionId: string) {
  for (const d of drafts.get(sessionId) ?? []) if (d.preview) URL.revokeObjectURL(d.preview);
  setDrafts(sessionId, []);
}

/** Files already on the runner (taken back from a waiting message) go back into the composer. */
export function restoreDrafts(sessionId: string, files: Attachment[]) {
  if (!files.length) return;
  const list = [...(drafts.get(sessionId) ?? [])];
  for (const a of files)
    if (!list.some((d) => d.attachment?.path === a.path))
      list.push({ key: `a${++keyN}`, name: a.name, mimeType: a.mimeType, size: a.size, progress: 1, attachment: a, uploadId: newUploadId() });
  setDrafts(sessionId, list);
}

/** A message taken back from the pending list: its text, and its files back as chips. */
export function takeBack(sessionId: string, text: string): string {
  const { text: body, files } = splitAttachments(text);
  restoreDrafts(sessionId, files);
  return body;
}

export const draftLabel = (d: Draft) =>
  d.error ? `${d.name}: ${d.error}` : d.attachment ? `${d.name} · ${formatSize(d.size)}` : `${d.name} · ${Math.round(d.progress * 100)}%`;

// ---------------- stored files, read back ----------------

const blobs = new Map<string, Promise<Blob>>();

/** A stored attachment as a Blob, read from the runner in chunks (cached for the page's life). */
export function fetchAttachment(path: string, mimeType?: string): Promise<Blob> {
  let p = blobs.get(path);
  if (!p) {
    p = (async () => {
      const parts: BlobPart[] = [];
      let offset = 0;
      let size = Infinity;
      let type = mimeType ?? "application/octet-stream";
      while (offset < size) {
        const r = await rpc("readAttachment", { path, offset, length: CHUNK_BYTES });
        size = r.size;
        type = mimeType ?? r.mimeType;
        const bin = atob(r.data);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        if (!bytes.length) break;
        parts.push(bytes);
        offset += bytes.length;
      }
      return new Blob(parts, { type });
    })();
    blobs.set(path, p);
    p.catch(() => blobs.delete(path));
  }
  return p;
}

const urls = new Map<string, string>();

/** An object URL for a stored image (loaded once), or undefined while loading / if it's gone. */
export function useAttachmentUrl(path: string, mimeType: string, enabled = true): { url?: string; error?: string } {
  const [state, setState] = useState<{ url?: string; error?: string }>(() => ({ url: urls.get(path) }));
  useEffect(() => {
    if (!enabled || urls.has(path)) return void (urls.has(path) && setState({ url: urls.get(path) }));
    let live = true;
    fetchAttachment(path, mimeType)
      .then((b) => {
        const u = urls.get(path) ?? URL.createObjectURL(b);
        urls.set(path, u);
        if (live) setState({ url: u });
      })
      .catch((e) => live && setState({ error: e?.message ?? String(e) }));
    return () => void (live = false);
  }, [path, mimeType, enabled]);
  return state;
}

/** Saves a stored attachment through the browser's download. */
export async function download(a: { path: string; name: string; mimeType: string }) {
  // Always as a download, never rendered: an attached .html or .svg must not open as a page on
  // this origin (the type in a message's list is only text anyone could have typed).
  const blob = new Blob([await fetchAttachment(a.path, a.mimeType)], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = a.name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
