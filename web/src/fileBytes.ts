// A project file's raw bytes, fetched from the runner a piece at a time: for previewing what
// isn't text (a PDF, an image) and for downloading any file.

import { FILE_DOWNLOAD_LIMITS } from "./shared/protocol";
import { rpc } from "./store";

/** The file as a Blob; `withheld` when it's a secrets file the user hasn't asked to see. */
export async function fetchFileBlob(sessionId: string, path: string, reveal = false): Promise<{ blob?: Blob; withheld?: boolean; size: number }> {
  const parts: BlobPart[] = [];
  let offset = 0;
  let size = Infinity;
  let type = "application/octet-stream";
  while (offset < size) {
    const r = await rpc("readFileChunk", { sessionId, path, offset, length: FILE_DOWNLOAD_LIMITS.chunk, ...(reveal ? { reveal } : {}) });
    if (r.withheld) return { withheld: true, size: r.size };
    size = r.size;
    type = r.mimeType;
    const bin = atob(r.data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    if (!bytes.length) break;
    parts.push(bytes);
    offset += bytes.length;
  }
  return { blob: new Blob(parts, { type }), size: Number.isFinite(size) ? size : 0 };
}

/** Saves a Blob as a download named `name`. */
export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** What the panel can show itself from the bytes. */
export function previewKind(path: string): "pdf" | "image" | undefined {
  const ext = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase() ?? "";
  if (ext === "pdf") return "pdf";
  if (/^(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/.test(ext)) return "image";
  return undefined;
}
