import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHUNK_BYTES, withAttachments, type Attachment } from "../../web/src/shared/attachments";
import { acpImages } from "./adapters/acp";
import { claudeContent } from "./adapters/claude";
import { codexInput, imageItems } from "./adapters/codex";
import { piImages } from "./adapters/pi";
import {
  attachmentsDir,
  checkAttachments,
  discard,
  isAttachmentPath,
  planDelivery,
  readChunk,
  receiveChunk,
  resolveStored,
  sessionKey,
  sweepAttachments,
} from "./attachments";
import { attachmentWrite, rules } from "./guard";
import { renderTranscript } from "./handoff";
import { userParts } from "../../web/src/shared/bash";

const SID = "claude-code:abc-123";
let n = 0;
const uid = () => `upload${Date.now()}${n++}`;

function bytes(size: number, seed = 7): Buffer {
  const b = Buffer.alloc(size);
  for (let i = 0; i < size; i++) b[i] = (i * seed + (i >> 8)) & 0xff;
  return b;
}

/** Uploads `buf` chunk by chunk in the given order of chunk indexes; returns each chunk's answer. */
async function put(buf: Buffer, opts: { name?: string; mimeType?: string; order?: number[]; uploadId?: string; sessionId?: string } = {}) {
  const uploadId = opts.uploadId ?? uid();
  const count = Math.ceil(buf.length / CHUNK_BYTES);
  const order = opts.order ?? [...Array(count).keys()];
  const out = [];
  for (const i of order) {
    const offset = i * CHUNK_BYTES;
    out.push(
      await receiveChunk({
        sessionId: opts.sessionId ?? SID,
        uploadId,
        name: opts.name ?? "data.bin",
        mimeType: opts.mimeType ?? "application/octet-stream",
        size: buf.length,
        offset,
        data: buf.subarray(offset, offset + CHUNK_BYTES).toString("base64"),
      }),
    );
  }
  return out;
}

beforeEach(() => rmSync(attachmentsDir(), { recursive: true, force: true }));
afterEach(() => rmSync(attachmentsDir(), { recursive: true, force: true }));

describe("storage", () => {
  test("lives under TETHER_CONFIG_DIR/attachments/<session>", () => {
    expect(attachmentsDir()).toBe(join(process.env.TETHER_CONFIG_DIR!, "attachments"));
    expect(sessionKey(SID)).toBe("claude-code_abc-123");
    expect(sessionKey("../../etc")).toBe("______etc");
    expect(sessionKey("..")).toBe("__");
  });
});

describe("chunk reassembly", () => {
  test("in order", async () => {
    const buf = bytes(CHUNK_BYTES * 2 + 1234);
    const answers = await put(buf, { name: "blob.bin" });
    expect(answers.slice(0, -1).every((a) => !a.attachment)).toBe(true);
    const a = answers.at(-1)!.attachment!;
    expect(a.name).toBe("blob.bin");
    expect(a.size).toBe(buf.length);
    expect(a.path.startsWith(join(attachmentsDir(), "claude-code_abc-123") + "/")).toBe(true);
    expect(readFileSync(a.path).equals(buf)).toBe(true);
  });

  test("out of order, with a retried chunk", async () => {
    const buf = bytes(CHUNK_BYTES * 3 + 10, 13);
    const answers = await put(buf, { order: [2, 0, 0, 3, 1] });
    const a = answers.find((x) => x.attachment)!.attachment!;
    expect(readFileSync(a.path).equals(buf)).toBe(true);
    // no partial file left behind
    expect(readdirSync(join(attachmentsDir(), sessionKey(SID))).filter((f) => f.endsWith(".partial"))).toEqual([]);
  });

  test("a retried last chunk gets the same file", async () => {
    const buf = bytes(100);
    const uploadId = uid();
    const [first] = await put(buf, { uploadId });
    const [again] = await put(buf, { uploadId });
    expect(again!.attachment!.path).toBe(first!.attachment!.path);
  });

  test("names are sanitized and images get their extension", async () => {
    const [a] = await put(bytes(50), { name: "../../../etc/passwd" });
    expect(a!.attachment!.path.split("/").pop()).toMatch(/^[0-9a-f]{8}-passwd$/);
    const [b] = await put(bytes(50), { name: "image", mimeType: "image/png" });
    expect(b!.attachment!.name).toBe("image.png");
    expect(b!.attachment!.mimeType).toBe("image/png");
  });

  test("refuses bad chunks and sizes", async () => {
    const base = { sessionId: SID, name: "a.txt", mimeType: "text/plain", data: "" };
    await expect(receiveChunk({ ...base, uploadId: "bad/id!", size: 5, offset: 0, data: "aGVsbG8=" })).rejects.toThrow("Bad upload id");
    await expect(receiveChunk({ ...base, uploadId: uid(), size: 26 * 1024 * 1024, offset: 0 })).rejects.toThrow("Too large");
    await expect(receiveChunk({ ...base, uploadId: uid(), mimeType: "image/png", name: "a.png", size: 11 * 1024 * 1024, offset: 0 })).rejects.toThrow("Too large");
    await expect(receiveChunk({ ...base, uploadId: uid(), size: 0, offset: 0 })).rejects.toThrow("empty");
    const id = uid();
    await expect(receiveChunk({ ...base, uploadId: id, size: 10, offset: 0, data: "aGVsbG8=" })).rejects.toThrow("Bad upload chunk"); // 5 bytes, not 10
    await expect(receiveChunk({ ...base, uploadId: id, size: 10, offset: 3, data: "aGVsbG8=" })).rejects.toThrow("Bad upload chunk"); // unaligned
    await expect(receiveChunk({ ...base, uploadId: id, size: 11, offset: 0, data: "aGVsbG8=" })).rejects.toThrow("changed size");
  });

  test("discard drops an unfinished upload and an unsent file", async () => {
    const buf = bytes(CHUNK_BYTES + 5);
    const uploadId = uid();
    await put(buf, { uploadId, order: [0] });
    await discard(SID, { uploadId });
    expect(readdirSync(join(attachmentsDir(), sessionKey(SID)))).toEqual([]);
    const [done] = await put(bytes(10));
    await discard(SID, { path: done!.attachment!.path });
    expect(existsSync(done!.attachment!.path)).toBe(false);
  });

  test("discard won't delete another session's file", async () => {
    const [done] = await put(bytes(10), { sessionId: "codex:other" });
    await discard(SID, { path: done!.attachment!.path });
    expect(existsSync(done!.attachment!.path)).toBe(true);
  });
});

describe("path safety", () => {
  test("only regular, finished files inside the attachments folder", async () => {
    const [a] = await put(bytes(10), { name: "ok.txt" });
    expect(resolveStored(a!.attachment!.path).name).toBe("ok.txt");
    const outside = join(process.env.HOME!, "secret.txt");
    writeFileSync(outside, "s");
    const dir = join(attachmentsDir(), sessionKey(SID));
    expect(() => resolveStored(outside)).toThrow("Not an attachment");
    expect(() => resolveStored(join(dir, "..", "..", "runner.json"))).toThrow();
    expect(() => resolveStored(`${dir}/../../../secret.txt`)).toThrow();
    expect(() => resolveStored("relative/path.txt")).toThrow("Not an attachment");
    expect(() => resolveStored(dir)).toThrow("Not an attachment");
    expect(() => resolveStored(attachmentsDir())).toThrow("Not an attachment");
    // a symlink inside that points out
    symlinkSync(outside, join(dir, "0000aaaa-link.txt"));
    expect(() => resolveStored(join(dir, "0000aaaa-link.txt"))).toThrow("Not an attachment");
    // an unfinished upload
    writeFileSync(join(dir, ".1234abcd.partial"), "x");
    expect(() => resolveStored(join(dir, ".1234abcd.partial"))).toThrow("Not an attachment");
    await expect(readChunk(outside)).rejects.toThrow();
  });

  test("checkAttachments: every path must be stored", async () => {
    const [a] = await put(bytes(10), { name: "a.csv" });
    expect(checkAttachments([a!.attachment, a!.attachment]).map((x) => x.name)).toEqual(["a.csv"]);
    expect(checkAttachments(undefined)).toEqual([]);
    expect(() => checkAttachments([{ path: "/etc/passwd" }])).toThrow();
    expect(() => checkAttachments("x")).toThrow("Bad attachments");
  });

  test("readChunk reads a range", async () => {
    const buf = bytes(1000);
    const [a] = await put(buf, { name: "r.bin" });
    const r = await readChunk(a!.attachment!.path, 100, 50);
    expect(r.size).toBe(1000);
    expect(Buffer.from(r.data, "base64").equals(buf.subarray(100, 150))).toBe(true);
  });
});

// ---------------- delivery ----------------

const img = (name: string, mimeType = "image/png", size = 1000): Attachment => ({ path: `/x/${name}`, name, mimeType, size });

describe("planDelivery", () => {
  const files = [img("a.png"), img("b.heic", "image/heic"), img("c.pdf", "application/pdf"), img("d.txt", "text/plain"), img("e.jpg", "image/jpeg", 11 * 1024 * 1024)];
  test("no image input: nothing native", () => expect(planDelivery(files, { images: false })).toEqual({ images: [], documents: [] }));
  test("images: only the types models read, within the cap", () => expect(planDelivery(files, { images: true }).images.map((f) => f.name)).toEqual(["a.png"]));
  test("Claude: images and small PDFs", () => {
    const p = planDelivery([...files, img("big.pdf", "application/pdf", 5 * 1024 * 1024)], { images: true, pdf: true });
    expect(p.documents.map((f) => f.name)).toEqual(["c.pdf"]);
  });
  test("at most maxImages, newest kept", () =>
    expect(planDelivery([img("1.png"), img("2.png"), img("3.png")], { images: true, maxImages: 2 }).images.map((f) => f.name)).toEqual(["2.png", "3.png"]));
});

describe("per-harness delivery", () => {
  async function message() {
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    const [i] = await put(png, { name: "shot.png", mimeType: "image/png" });
    const [d] = await put(Buffer.from("%PDF-1.4\n%%EOF"), { name: "doc.pdf", mimeType: "application/pdf" });
    const [t] = await put(Buffer.from("hello"), { name: "notes.txt", mimeType: "text/plain" });
    const files = [i!.attachment!, d!.attachment!, t!.attachment!];
    return { text: withAttachments("Describe these", files), files, png };
  }

  test("Claude Code: image and document blocks after the text", async () => {
    const { text, png } = await message();
    const c = (await claudeContent(text)) as any[];
    expect(c[0]).toEqual({ type: "text", text });
    expect(c[1]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } });
    expect(c[2].type).toBe("document");
    expect(c[2].source.media_type).toBe("application/pdf");
    expect(c).toHaveLength(3);
    expect(await claudeContent("no files")).toBe("no files");
  });

  test("Codex: localImage items by path", async () => {
    const { text, files } = await message();
    expect(imageItems(text)).toEqual([{ type: "localImage", path: files[0]!.path }]);
    const items = codexInput(text, new Map());
    expect(items[0].type).toBe("text");
    expect(items.at(-1)).toEqual({ type: "localImage", path: files[0]!.path });
  });

  test("pi: images on the prompt", async () => {
    const { text, png } = await message();
    expect(await piImages(text)).toEqual({ images: [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }] });
    expect(await piImages("plain")).toEqual({});
  });

  test("ACP: image blocks only when the agent advertises image prompts", async () => {
    const { text } = await message();
    expect(await acpImages(text, { promptCapabilities: { image: true } })).toHaveLength(1);
    expect(await acpImages(text, { promptCapabilities: {} })).toEqual([]);
    expect(await acpImages(text, undefined)).toEqual([]);
  });

  test("a typed block naming files outside the attachments folder sends nothing native", async () => {
    const outside = join(process.env.HOME!, "x.png");
    writeFileSync(outside, "img");
    const text = withAttachments("look", [{ path: outside, name: "x.png", mimeType: "image/png", size: 3 }]);
    expect(await claudeContent(text)).toBe(text);
    expect(imageItems(text)).toEqual([]);
  });
});

describe("handoff", () => {
  test("the brief lists a message's attachments by path, and the stored image isn't also [image]", async () => {
    const [i] = await put(Buffer.from("png"), { name: "shot.png", mimeType: "image/png" });
    const text = withAttachments("what is this", [i!.attachment!]);
    const parts = [...userParts(text, "u1"), { type: "image" as const, mimeType: "image/png", data: "cG5n" }];
    const brief = renderTranscript([{ id: "u1", role: "user", parts, ts: 1 }]);
    expect(brief).toContain(i!.attachment!.path);
    expect(brief).toContain("what is this");
    expect(brief).not.toContain("[image]");
    // and the new harness gets the image natively again
    expect(imageItems(brief)).toEqual([{ type: "localImage", path: i!.attachment!.path }]);
  });
});

// ---------------- guard ----------------

describe("guard: attachments are readable, never writable", () => {
  const cwd = "/home/u/proj";
  const decide = (tool: string, input: any) => rules({ tool, input, cwd })?.decision ?? "judge";
  let file: string;
  beforeEach(() => {
    file = join(attachmentsDir(), "codex_t1", "0a1b2c3d-shot.png");
  });

  test("the folder sits under the config dir, which is otherwise off limits", () => {
    expect(isAttachmentPath(file)).toBe(true);
    expect(isAttachmentPath(join(attachmentsDir(), "..", "runner.json"))).toBe(false);
    expect(decide("Read", { file_path: join(attachmentsDir(), "..", "runner.json") })).toBe(process.env.TETHER_CONFIG_DIR!.includes(".config/tether") ? "deny" : "allow");
  });

  test("reads are allowed (Read, view_file, cat)", () => {
    expect(decide("Read", { file_path: file })).toBe("allow");
    expect(decide("view_file", { AbsolutePath: file })).toBe("allow");
    expect(decide("Bash", { command: `cat ${file}` })).toBe("allow");
    expect(decide("Bash", { command: `head -c 100 ${file} | xxd` })).toBe("allow");
  });

  test("PDF and archive readers", () => {
    const pdf = join(attachmentsDir(), "codex_t1", "0a1b2c3d-memo.pdf");
    const zip = join(attachmentsDir(), "codex_t1", "0a1b2c3d-src.zip");
    expect(decide("Bash", { command: `pdftotext ${pdf} -` })).toBe("allow");
    expect(decide("Bash", { command: `pdftotext -layout ${pdf} - | head -50` })).toBe("allow");
    expect(decide("Bash", { command: `pdftotext ${pdf} out/memo.txt` })).toBe("allow");
    expect(decide("Bash", { command: `pdftotext ${pdf}` })).toBe("deny"); // would write memo.txt next to it
    expect(decide("Bash", { command: `pdftotext ${pdf} /home/u/.bashrc` })).toBe("judge");
    expect(decide("Bash", { command: `pdfinfo ${pdf}` })).toBe("allow");
    expect(decide("Bash", { command: `unzip -l ${zip}` })).toBe("allow");
    expect(decide("Bash", { command: `unzip ${zip} -d vendor/src` })).toBe("allow");
    expect(decide("Bash", { command: `unzip ${zip} -d /home/u/elsewhere` })).toBe("judge");
    expect(decide("Bash", { command: `tar -tzf ${zip}` })).toBe("allow");
    expect(decide("Bash", { command: `tar -czf ${zip} src` })).toBe("deny"); // writes the attachment
    expect(decide("Bash", { command: `pdftotext /home/u/other.pdf -` })).toBe("judge"); // not an attachment: unchanged
  });

  test("copying one into the project is fine", () => {
    expect(decide("Bash", { command: `cp ${file} ./assets/shot.png` })).toBe("allow");
  });

  test("writes are denied", () => {
    expect(decide("Edit", { file_path: file })).toBe("deny");
    expect(decide("Write", { file_path: join(attachmentsDir(), "codex_t1", "new.txt") })).toBe("deny");
    expect(decide("write_to_file", { TargetFile: file })).toBe("deny");
    expect(decide("Bash", { command: `rm ${file}` })).toBe("deny");
    expect(decide("Bash", { command: `mv ${file} /tmp/x` })).toBe("deny");
    expect(decide("Bash", { command: `cp evil.png ${file}` })).toBe("deny");
    expect(decide("Bash", { command: `echo hi > ${file}` })).toBe("deny");
    expect(decide("Bash", { command: `sed -i s/a/b/ ${file}` })).toBe("deny");
    expect(decide("Bash", { command: `touch ${file}` })).toBe("deny");
  });

  test("even with full access", () => {
    expect(attachmentWrite({ tool: "Edit", input: { file_path: file }, cwd })?.decision).toBe("deny");
    expect(attachmentWrite({ tool: "Read", input: { file_path: file }, cwd })).toBeUndefined();
    expect(attachmentWrite({ tool: "Edit", input: { file_path: "/home/u/proj/a.ts" }, cwd })).toBeUndefined();
  });

  test("traversal out of the folder isn't treated as an attachment", () => {
    const sneaky = join(attachmentsDir(), "codex_t1", "..", "..", "runner.json");
    expect(isAttachmentPath(sneaky)).toBe(false);
  });
});

// ---------------- cleanup ----------------

describe("sweepAttachments", () => {
  const DAY = 86_400_000;
  function dir(id: string, ageDays: number) {
    const d = join(attachmentsDir(), sessionKey(id));
    mkdirSync(d, { recursive: true });
    const f = join(d, "0a1b2c3d-x.txt");
    writeFileSync(f, "x");
    const t = (Date.now() - ageDays * DAY) / 1000;
    utimesSync(f, t, t);
    utimesSync(d, t, t);
    return d;
  }

  test("done sessions after a week; anything after 90 days unless live", () => {
    const doneOld = dir("claude-code:done-old", 8);
    const doneNew = dir("claude-code:done-new", 2);
    const active = dir("codex:active", 30);
    const ancient = dir("pi:ancient", 100);
    const liveAncient = dir("pi:live", 100);
    const removed = sweepAttachments({ archived: ["claude-code:done-old", "claude-code:done-new"], live: ["pi:live"] });
    expect(removed.sort()).toEqual([ancient, doneOld].sort());
    expect(existsSync(doneNew) && existsSync(active) && existsSync(liveAncient)).toBe(true);
  });

  test("stale partial uploads go after a day", () => {
    const d = dir("codex:x", 0);
    const p = join(d, ".deadbeef.partial");
    writeFileSync(p, "x");
    const t = (Date.now() - 2 * DAY) / 1000;
    utimesSync(p, t, t);
    sweepAttachments({ archived: [], live: [] });
    expect(existsSync(p)).toBe(false);
    expect(existsSync(join(d, "0a1b2c3d-x.txt"))).toBe(true);
  });
});
