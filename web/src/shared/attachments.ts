// Files and images attached to a message. Shared by the runner (storage, delivery to each
// harness) and the browser (composer chips, transcript chips).
//
// The browser uploads each file to the runner in chunks over the usual RPC (uploadAttachment), so
// nothing new has to pass the relay or its edge. The runner keeps it under
// TETHER_CONFIG_DIR/attachments/<session>/<id>-<name>, and the message the agent gets ends with a
// block listing the files by absolute path:
//
//   Attached files (open them with your file-reading tool):
//   - /home/me/.config/tether/attachments/claude-code_abc/1a2b3c4d-photo.png (image/png, 1.2 MB)
//
// The block is plain text, so a message with attachments can wait in the pending list, be edited,
// steered, resent after a restart or carried into a handoff like any other. Harnesses that take
// images natively also get the listed images as image input when the message goes out.

export interface Attachment {
  /** absolute path on the runner */
  path: string;
  /** the file's name as uploaded (sanitized) */
  name: string;
  mimeType: string;
  size: number;
}

/** Images are downscaled in the browser first (long edge ≤ IMAGE_MAX_EDGE), so this is generous. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;
/** Raw bytes per upload/download chunk: ~350 KB of base64 JSON per WebSocket message. */
export const CHUNK_BYTES = 256 * 1024;
export const IMAGE_MAX_EDGE = 2048;

/** Image types every harness with image input accepts (the Anthropic and OpenAI APIs agree on these). */
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
  bmp: "image/bmp",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  html: "text/html",
  xml: "application/xml",
  yaml: "application/yaml",
  yml: "application/yaml",
  zip: "application/zip",
  gz: "application/gzip",
  tar: "application/x-tar",
  log: "text/plain",
};

/** A type from the file name; text/plain for common code files, else application/octet-stream. */
export function mimeFromName(name: string): string {
  const ext = /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase() ?? "";
  if (MIME[ext]) return MIME[ext]!;
  if (/^(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|c|h|cc|cpp|hpp|cs|swift|sh|bash|zsh|sql|toml|ini|cfg|conf|css|scss|vue|svelte|lua|php|pl|r|dart|ex|exs|erl|hs|ml|scala|clj|diff|patch)$/.test(ext))
    return "text/plain";
  return "application/octet-stream";
}

/** A declared type if it looks like one, else from the name. */
export function cleanMime(declared: string | undefined, name: string): string {
  const d = (declared ?? "").trim().toLowerCase();
  return /^[a-z0-9][\w.+-]*\/[a-z0-9][\w.+-]*$/.test(d) && d !== "application/octet-stream" ? d : mimeFromName(name);
}

/**
 * A file name that is safe as one path component: no directories, no `..`, no control or shell
 * characters, no spaces (the block lists paths unquoted), at most 100 characters (keeping the
 * extension). Never empty.
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
  if (s.length > 100) {
    const ext = /\.[\p{L}\p{N}]{1,10}$/u.exec(s)?.[0] ?? "";
    s = s.slice(0, 100 - ext.length) + ext;
  }
  return s || "file";
}

/** Size limit for one attachment of this type. */
export const maxBytes = (mimeType: string) => (isImageType(mimeType) ? MAX_IMAGE_BYTES : MAX_FILE_BYTES);

/** Why this file can't be attached, or undefined when it can. */
export function sizeProblem(size: number, mimeType: string): string | undefined {
  if (size <= 0) return "The file is empty.";
  const max = maxBytes(mimeType);
  if (size > max) return `Too large (${formatSize(size)}): ${isImageType(mimeType) ? "images" : "files"} can be up to ${formatSize(max)}.`;
  return undefined;
}

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** "1.2 MB" → bytes (approximate; for display). */
export function parseSize(s: string): number {
  const m = /^([\d.]+)\s*(B|KB|MB|GB)$/i.exec(s.trim());
  if (!m) return 0;
  const mult = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 }[m[2]!.toUpperCase() as "B"]!;
  return Math.round(parseFloat(m[1]!) * mult);
}

export const BLOCK_HEADER = "Attached files (open them with your file-reading tool):";
const HEADER_RE = /^Attached files \(open them with your file-reading tool\):$/;
const LINE_RE = /^- (\/\S.*?) \(([a-z0-9][\w.+-]*\/[\w.+-]+), ([\d.]+ (?:B|KB|MB|GB))\)$/i;

/** The name shown for a stored attachment: its file name without the `<id>-` prefix. */
export function displayName(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/^[0-9a-f]{8}-/, "");
}

/** The block that goes at the end of a message with attachments. */
export function attachmentBlock(list: Attachment[]): string {
  if (!list.length) return "";
  return [BLOCK_HEADER, ...list.map((a) => `- ${a.path} (${a.mimeType}, ${formatSize(a.size)})`)].join("\n");
}

/** A message with its attachments: the text, a blank line, the block. */
export function withAttachments(text: string, list: Attachment[]): string {
  if (!list.length) return text;
  const t = text.trimEnd();
  return t ? `${t}\n\n${attachmentBlock(list)}` : attachmentBlock(list);
}

/**
 * Takes every attachment block out of a message: the text without them, and the files they list
 * (in order, each path once). Lines that don't look like the runner wrote them end a block.
 */
export function splitAttachments(text: string): { text: string; files: Attachment[] } {
  if (!text.includes("Attached files (")) return { text, files: [] };
  const lines = text.split("\n");
  const keep: string[] = [];
  const files: Attachment[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    if (!HEADER_RE.test(lines[i]!.trimEnd())) {
      keep.push(lines[i]!);
      continue;
    }
    let j = i + 1;
    const found: Attachment[] = [];
    for (; j < lines.length; j++) {
      const m = LINE_RE.exec(lines[j]!.trimEnd());
      if (!m) break;
      found.push({ path: m[1]!, name: displayName(m[1]!), mimeType: m[2]!.toLowerCase(), size: parseSize(m[3]!) });
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
