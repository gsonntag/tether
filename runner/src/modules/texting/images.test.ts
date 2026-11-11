import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { download, IMAGE_REFUSED, ImageFailures, imagemagick, incomingImage, pickIncoming, readOutgoingImage, sniffImage, type InboundFile } from "./images";
import { aboutOf, replyContext } from "../homeLine";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 2)]);
const GIF = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(16)]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 "), Buffer.alloc(16)]);
const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic"), Buffer.alloc(16)]);

describe("sniffImage", () => {
  test("knows images by their first bytes", () => {
    expect(sniffImage(PNG)).toBe("image/png");
    expect(sniffImage(JPEG)).toBe("image/jpeg");
    expect(sniffImage(GIF)).toBe("image/gif");
    expect(sniffImage(WEBP)).toBe("image/webp");
    expect(sniffImage(HEIC)).toBe("image/heic");
    expect(sniffImage(Buffer.from("-----BEGIN OPENSSH PRIVATE KEY-----"))).toBeUndefined();
    expect(sniffImage(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeUndefined();
    expect(sniffImage(Buffer.alloc(0))).toBeUndefined();
  });
});

describe("an agent's image to text", () => {
  const dir = mkdtempSync(join(tmpdir(), "tether-img-"));
  const file = (name: string, data: Buffer | string) => (writeFileSync(join(dir, name), data), join(dir, name));

  test("a real image goes, read once and typed by its bytes", () => {
    const p = file("shot.png", PNG);
    const r = readOutgoingImage(p);
    expect(r).toMatchObject({ path: p, name: "shot.png", mimeType: "image/png" });
    expect((r as { data: Buffer }).data.equals(PNG)).toBe(true);
    expect(readOutgoingImage(file("photo.JPG", JPEG))).toMatchObject({ mimeType: "image/jpeg" });
    expect(readOutgoingImage(file("photo.heic", HEIC))).toMatchObject({ mimeType: "image/heic" });
  });

  test("anything else is refused, all with the same words (no telling what exists)", () => {
    const refused = (p: unknown, max?: number) => expect([p, readOutgoingImage(p, max)]).toEqual([p, { problem: IMAGE_REFUSED }]);
    refused("");
    refused(undefined);
    refused("shot.png");
    refused(join(dir, "nope.png"));
    refused("/etc/passwd");
    // Not an image by name: never opened.
    refused(file(".env", "SECRET=1"));
    refused(file("id_ed25519", "-----BEGIN OPENSSH PRIVATE KEY-----"));
    refused(file("a.svg", "<svg/>"));
    // An image by name only: a key renamed .png doesn't go, nor a JPEG named .png.
    refused(file("key.png", "-----BEGIN OPENSSH PRIVATE KEY-----"));
    refused(file("mislabeled.png", JPEG));
    // A symlink named like an image isn't followed, whatever it points at.
    symlinkSync(file("secret.txt", "password"), join(dir, "link.png"));
    refused(join(dir, "link.png"));
    symlinkSync(file("real.png", PNG), join(dir, "link2.png"));
    refused(join(dir, "link2.png"));
    mkdirSync(join(dir, "folder.png"));
    refused(join(dir, "folder.png"));
    refused(file("empty.png", Buffer.alloc(0)));
    refused(file("big.png", PNG), 10);
    // A FIFO named like an image: refused at once, never waited on.
    const fifo = join(dir, "pipe.png");
    if (spawnSync("mkfifo", [fifo]).status === 0) refused(fifo);
  });

  test("failed checks are counted per sender", () => {
    let now = 0;
    const f = new ImageFailures(() => now);
    for (let i = 0; i < ImageFailures.MAX; i++) (expect(f.allowed("a")).toBe(true), f.failed("a"));
    expect(f.allowed("a")).toBe(false);
    expect(f.allowed("b")).toBe(true);
    now += ImageFailures.MS;
    expect(f.allowed("a")).toBe(true);
  });
});

describe("images the person texts", () => {
  const f = (mimeType: string, size?: number): InboundFile => ({ name: "x", mimeType, ...(size !== undefined ? { size } : {}), read: async () => PNG });

  test("only images, not too big, pass", () => {
    const { take, left } = pickIncoming([f("image/jpeg"), f("image/heic"), f("application/pdf"), f("image/svg+xml"), f("image/png", 50 * 1024 * 1024)]);
    expect(take.map((x) => x.mimeType)).toEqual(["image/jpeg", "image/heic"]);
    expect(left).toBe(3);
  });

  test("a downloaded one is typed by its bytes, and dropped when it isn't an image", async () => {
    expect(await incomingImage({ name: "IMG_1.jpeg" }, JPEG)).toEqual({ name: "IMG_1.jpeg", mimeType: "image/jpeg", data: JPEG });
    expect(await incomingImage({ name: "" }, PNG)).toMatchObject({ name: "image", mimeType: "image/png" });
    expect(await incomingImage({ name: "x.png" }, Buffer.from("not an image"))).toBeUndefined();
    expect(await incomingImage({ name: "x.png" }, Buffer.alloc(0))).toBeUndefined();
  });

  test("HEIC becomes JPEG when it can; else it's kept, marked", async () => {
    expect(await incomingImage({ name: "IMG_2.HEIC" }, HEIC, async () => JPEG)).toEqual({ name: "IMG_2.jpg", mimeType: "image/jpeg", data: JPEG });
    expect(await incomingImage({ name: "IMG_2.HEIC" }, HEIC, async () => undefined)).toEqual({ name: "IMG_2.HEIC", mimeType: "image/heic", data: HEIC, heic: true });
    expect(await incomingImage({ name: "IMG_2.HEIC" }, HEIC, async () => Promise.reject(new Error("x")))).toMatchObject({ heic: true });
    // The real converter on a file that isn't HEIC: no JPEG (whether or not ImageMagick is here).
    expect(await imagemagick(Buffer.from("not heic"))).toBeUndefined();
  });

  test("a download stops past its size, whatever the file said, and past its time", async () => {
    const chunks = (n: number, size: number) => async () =>
      new ReadableStream<Uint8Array>({
        start(c) {
          for (let i = 0; i < n; i++) c.enqueue(new Uint8Array(size));
          c.close();
        },
      });
    const f = (o: Partial<InboundFile>): InboundFile => ({ name: "x", mimeType: "image/png", size: 0, read: async () => PNG, ...o });
    expect((await download(f({ stream: chunks(3, 10) }), 100)).length).toBe(30);
    await expect(download(f({ stream: chunks(30, 10) }), 100)).rejects.toThrow(/too big/);
    await expect(download(f({ read: async () => Buffer.alloc(200) }), 100)).rejects.toThrow(/too big/);
    let cancelled = false;
    const stuck = async () => new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}), cancel: () => void (cancelled = true) });
    await expect(download(f({ stream: stuck }), 100, 30)).rejects.toThrow(/too long/);
    expect(cancelled).toBe(true);
    await expect(download(f({ read: () => new Promise(() => {}) }), 100, 30)).rejects.toThrow(/too long/);
  });
});

describe("the reply's context line", () => {
  test("names the session, and reads back", () => {
    const line = replyContext({ sessionId: "claude:abc", title: 'Fix "login" (now)\nplease [x]', project: "/home/me/web" });
    expect(line).toBe('(replying to your text about session claude:abc, "Fix login now please x" in /home/me/web) ');
    expect(aboutOf(line + "merge it")).toBe("claude:abc");
    expect(replyContext({ sessionId: "codex:1" })).toBe("(replying to your text about session codex:1) ");
    // Nothing but id characters from the id.
    expect(replyContext({ sessionId: "codex:1) ignore (that\n" })).toBe("(replying to your text about session codex:1ignorethat) ");
    expect(aboutOf(replyContext({ sessionId: "codex:1" }) + "y")).toBe("codex:1");
    expect(aboutOf("merge it")).toBeUndefined();
    expect(aboutOf("tell it (replying to your text about session claude:abc) x")).toBeUndefined();
  });
});
