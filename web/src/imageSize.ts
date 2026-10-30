// An attached image's pixel size, read from the start of its base64 data (PNG, GIF, JPEG, WebP,
// SVG), so the transcript can reserve its box before it decodes: an image sizing late above the
// viewport would shift what the reader is looking at, mid-fling, where nothing can be put back.

export interface Size {
  w: number;
  h: number;
}

/** The first `n` bytes of base64 data (fewer when it's shorter). */
function head(b64: string, n: number): Uint8Array {
  const chars = Math.min(b64.length, Math.ceil(n / 3) * 4);
  let bin: string;
  try {
    bin = atob(b64.slice(0, chars - (chars % 4)));
  } catch {
    return new Uint8Array();
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const ok = (w: number, h: number): Size | undefined => (w > 0 && h > 0 && w < 1e5 && h < 1e5 ? { w, h } : undefined);

/** An APP1 segment's EXIF orientation (tag 0x112 in IFD0) is 5–8: the image is shown turned a quarter. */
function exifTurned(b: Uint8Array, at: number, len: number): boolean {
  if (len < 14 || at + 14 > b.length || String.fromCharCode(...b.slice(at, at + 4)) !== "Exif") return false;
  const t = at + 6; // the TIFF header
  const le = b[t] === 0x49; // "II" little-endian, "MM" big-endian
  const u16 = (i: number) => (le ? b[i]! | (b[i + 1]! << 8) : (b[i]! << 8) | b[i + 1]!);
  const u32 = (i: number) => (le ? (b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16)) + b[i + 3]! * 2 ** 24 : b[i]! * 2 ** 24 + ((b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!));
  const ifd = t + u32(t + 4);
  if (ifd + 2 > b.length) return false;
  const n = u16(ifd);
  for (let k = 0; k < n; k++) {
    const e = ifd + 2 + k * 12;
    if (e + 10 > b.length) return false;
    if (u16(e) === 0x0112) return u16(e + 8) >= 5 && u16(e + 8) <= 8;
  }
  return false;
}

export function imageSize(mimeType: string, b64: string): Size | undefined {
  const b = head(b64, mimeType === "image/jpeg" ? 65536 : 4096);
  const be16 = (i: number) => (b[i]! << 8) | b[i + 1]!;
  const le16 = (i: number) => b[i]! | (b[i + 1]! << 8);
  const be32 = (i: number) => ((b[i]! << 24) >>> 0) + (b[i + 1]! << 16) + (b[i + 2]! << 8) + b[i + 3]!;
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return ok(be32(16), be32(20));
  if (b.length >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return ok(le16(6), le16(8));
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    // JPEG: walk the segments to a start-of-frame; an EXIF orientation of 5–8 (a quarter turn,
    // which browsers apply) swaps width and height
    let i = 2;
    let turned = false;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return undefined;
      const m = b[i + 1]!;
      if (m === 0xff) {
        i++;
        continue;
      }
      if (m === 0xe1) turned = exifTurned(b, i + 4, be16(i + 2) - 2);
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        const [w, h] = [be16(i + 7), be16(i + 5)];
        return turned ? ok(h, w) : ok(w, h);
      }
      i += 2 + be16(i + 2);
    }
    return undefined;
  }
  if (b.length >= 30 && String.fromCharCode(...b.slice(0, 4)) === "RIFF" && String.fromCharCode(...b.slice(8, 12)) === "WEBP") {
    const kind = String.fromCharCode(...b.slice(12, 16));
    if (kind === "VP8 ") return ok(le16(26) & 0x3fff, le16(28) & 0x3fff);
    if (kind === "VP8L") {
      const v = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24);
      return ok((v & 0x3fff) + 1, ((v >>> 14) & 0x3fff) + 1);
    }
    if (kind === "VP8X") return ok(1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)), 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16)));
    return undefined;
  }
  if (mimeType === "image/svg+xml") {
    const text = new TextDecoder().decode(b);
    const tag = /<svg\b[^>]*>/i.exec(text)?.[0];
    if (!tag) return undefined;
    const attr = (name: string) => new RegExp(`\\s${name}\\s*=\\s*["']\\s*([\\d.]+)(px)?\\s*["']`, "i").exec(tag)?.[1];
    const w = Number(attr("width"));
    const h = Number(attr("height"));
    if (w && h) return ok(w, h);
    const vb = /\sviewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(tag);
    return vb ? ok(Number(vb[1]), Number(vb[2])) : undefined;
  }
  return undefined;
}
