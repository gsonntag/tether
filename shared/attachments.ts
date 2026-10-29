// Files and images attached to a message (SPEC §9). Shared by the runner (storage, delivery to each
// harness) and the browser (composer chips, transcript chips).
//
// The browser uploads each file to the runner in chunks over rpc (`uploadAttachment`); the runner
// keeps it under <config dir>/attachments/<session>/<id>-<name>. The message the harness gets ends
// with a block listing the files by absolute path, so the agent can open any of them:
//
//   Attached files:
//   - /home/me/.config/tether/attachments/claude_abc/1a2b3c4d-photo.png (image/png, 1.2 MB)
//
// Images the harness reads natively also go to it as images (Claude: image blocks; Codex: local
// image inputs). The block is plain text, so the stored transcript still says what was attached, and
// the transcript shows the block as chips instead of text (splitAttachments).

import { ATTACH_FILE_MAX, ATTACH_IMAGE_MAX, cutBytes, utf8Length } from "./limits";

/** A stored name's UTF-8 bytes at most (with the `<8 hex>-` prefix, far under the 255 a file name may have). */
export const NAME_BYTES_MAX = 120;

export interface Attachment {
  /** absolute path on the runner */
  path: string;
  /** the file's name as uploaded (made safe) */
  name: string;
  mimeType: string;
  size: number;
}

/** Image types both harnesses take as images (the Anthropic and OpenAI APIs agree on these). */
export const NATIVE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export const isImageType = (mimeType: string) => mimeType.startsWith("image/");

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  heic: "image/heic",
  heif: "image/heif",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  xml: "application/xml",
  yaml: "application/yaml",
  yml: "application/yaml",
  zip: "application/zip",
  log: "text/plain",
};

/** A type from the file name: text/plain for common code files, else application/octet-stream. */
export function mimeFromName(name: string): string {
  const ext = /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase() ?? "";
  if (MIME[ext]) return MIME[ext]!;
  if (/^(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|c|h|cc|cpp|hpp|cs|swift|sh|bash|zsh|sql|toml|ini|cfg|conf|css|scss|vue|svelte|lua|php|diff|patch)$/.test(ext)) return "text/plain";
  return "application/octet-stream";
}

/** The declared type when it looks like one, else one from the name. */
export function cleanMime(declared: string | undefined, name: string): string {
  const d = (declared ?? "").trim().toLowerCase();
  return /^[a-z0-9][\w.+-]*\/[a-z0-9][\w.+-]*$/.test(d) && d !== "application/octet-stream" ? d : mimeFromName(name);
}

/**
 * A name safe as one path component: no folders, no `..`, no control characters, no spaces (the
 * block lists paths unquoted), at most NAME_BYTES_MAX bytes of UTF-8 (keeping the extension).
 * Never empty, never hidden (no leading dot).
 */
export function safeName(name: string): string {
  const base = String(name ?? "").split(/[\\/]/).pop() ?? "";
  let s = base
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[^\p{L}\p{N}._-]+/gu, "_")
    .replace(/_+/g, "_")
    .replace(/^[._-]+/, "")
    .replace(/[._]+$/, "");
  if (utf8Length(s) > NAME_BYTES_MAX) {
    let ext = /\.[\p{L}\p{N}]{1,10}$/u.exec(s)?.[0] ?? "";
    if (utf8Length(ext) > 40) ext = "";
    s = cutBytes(s.slice(0, s.length - ext.length), NAME_BYTES_MAX - utf8Length(ext)).replace(/[._-]+$/, "") + ext;
  }
  return s || "file";
}

export const attachMax = (mimeType: string) => (isImageType(mimeType) ? ATTACH_IMAGE_MAX : ATTACH_FILE_MAX);

/** Why a file can't be attached, or undefined when it can. */
export function sizeProblem(size: number, mimeType: string): string | undefined {
  if (!(size > 0)) return "The file is empty.";
  const max = attachMax(mimeType);
  if (size > max) return `Too large (${formatSize(size)}): ${isImageType(mimeType) ? "images" : "files"} can be up to ${formatSize(max)}.`;
  return undefined;
}

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function parseSize(s: string): number {
  const m = /^([\d.]+) (B|KB|MB|GB)$/.exec(s.trim());
  if (!m) return 0;
  return Math.round(parseFloat(m[1]!) * { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 }[m[2] as "B"]);
}

export const BLOCK_HEADER = "Attached files:";
const LINE_RE = /^- (\/\S.*?) \(([a-z0-9][\w.+-]*\/[\w.+-]+), ([\d.]+ (?:B|KB|MB|GB))\)$/;

/** The name shown for a stored attachment: its file name without the `<id>-` prefix. */
export function displayName(path: string): string {
  return (path.split("/").pop() ?? path).replace(/^[0-9a-f]{8}-/, "");
}

/** A message with its attachments: the text, a blank line, the block. */
export function withAttachments(text: string, list: Attachment[] | undefined): string {
  if (!list?.length) return text;
  const block = [BLOCK_HEADER, ...list.map((a) => `- ${a.path} (${a.mimeType}, ${formatSize(a.size)})`)].join("\n");
  const t = text.trimEnd();
  return t ? `${t}\n\n${block}` : block;
}

/**
 * The text of a message without its attachment blocks, and the files they list (in order, each
 * once). Lines that don't look like the runner wrote them end a block.
 */
export function splitAttachments(text: string): { text: string; files: Attachment[] } {
  if (!text.includes(BLOCK_HEADER)) return { text, files: [] };
  const lines = text.split("\n");
  const keep: string[] = [];
  const files: Attachment[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trimEnd() !== BLOCK_HEADER) {
      keep.push(lines[i]!);
      continue;
    }
    let j = i + 1;
    const found: Attachment[] = [];
    for (; j < lines.length; j++) {
      const m = LINE_RE.exec(lines[j]!.trimEnd());
      if (!m) break;
      found.push({ path: m[1]!, name: displayName(m[1]!), mimeType: m[2]!, size: parseSize(m[3]!) });
    }
    if (!found.length) {
      keep.push(lines[i]!);
      continue;
    }
    for (const f of found) if (!seen.has(f.path)) (seen.add(f.path), files.push(f));
    i = j - 1;
  }
  if (!files.length) return { text, files };
  return { text: keep.join("\n").replace(/\n{3,}/g, "\n\n").trim(), files };
}
