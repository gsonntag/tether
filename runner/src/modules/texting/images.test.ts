import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONVERT_MAX, MAGICK, download, IMAGE_REFUSED, inSlot, sweepMagickTemp, ImageFailures, imageDims, imagemagick, incomingImage, pickIncoming, readOutgoingImage, sniffImage, tooBigToSee, type InboundFile } from "./images";
import { NATIVE_IMAGE_MAX } from "../../core/attachments";
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
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
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
    expect(await incomingImage({ name: "IMG_2.HEIC" }, HEIC, async () => undefined)).toEqual({ name: "IMG_2.heic", mimeType: "image/heic", data: HEIC, heic: true });
    expect(await incomingImage({ name: "IMG_2.HEIC" }, HEIC, async () => Promise.reject(new Error("x")))).toMatchObject({ heic: true });
    // The real converter on a file that isn't HEIC: no JPEG (whether or not ImageMagick is here).
    expect(await imagemagick(Buffer.from("not heic"), "heic")).toBeUndefined();
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

describe("scaling texted images down", () => {
  const png = (w: number, h: number) => {
    const b = Buffer.alloc(40);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
    b.writeUInt32BE(w, 16);
    b.writeUInt32BE(h, 20);
    return b;
  };

  test("sizes from the first bytes, and when an image is too big to see", () => {
    expect(imageDims(png(3000, 1500))).toEqual({ w: 3000, h: 1500 });
    expect(tooBigToSee(png(3000, 1500))).toBe(true);
    expect(tooBigToSee(png(2048, 1024))).toBe(false);
    expect(tooBigToSee(Buffer.concat([png(10, 10), Buffer.alloc(NATIVE_IMAGE_MAX)]))).toBe(true);
  });

  test("a big PNG becomes a scaled JPEG; when that fails it goes as it came", async () => {
    const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]);
    const asked: string[] = [];
    expect(await incomingImage({ name: "shot.png" }, png(4000, 3000), async (_d, from) => (asked.push(from), JPEG))).toEqual({ name: "shot.jpg", mimeType: "image/jpeg", data: JPEG });
    expect(asked).toEqual(["png"]);
    expect(await incomingImage({ name: "shot.png" }, png(4000, 3000), async () => undefined)).toMatchObject({ name: "shot.png", mimeType: "image/png" });
    // A small one isn't touched.
    expect(await incomingImage({ name: "s.png" }, png(100, 100), async () => (asked.push("x"), JPEG))).toMatchObject({ mimeType: "image/png" });
    expect(asked).toEqual(["png"]);
  });

  test("with ImageMagick here: really scaled to the edge, several at once, its temp folders removed", async () => {
    if (spawnSync("convert", ["-version"]).status !== 0) return;
    const big = spawnSync("convert", ["-size", "3000x1500", "gradient:red-blue", "png:-"]).stdout as Buffer;
    // Its temp folders in a folder of this test's own (others' runs share /tmp).
    const parent = mkdtempSync(join(tmpdir(), "tether-magick-test-"));
    const was = MAGICK.parent;
    MAGICK.parent = () => parent;
    try {
      const outs = await Promise.all([1, 2, 3].map(() => imagemagick(big, "png")));
      for (const o of outs) expect(imageDims(o!)).toEqual({ w: 2048, h: 1024 });
      expect(readdirSync(parent)).toEqual([]);
    } finally {
      MAGICK.parent = was;
      rmSync(parent, { recursive: true, force: true });
    }
  });
});

describe("round 4", () => {
  test("never more than CONVERT_MAX at once, a finished one handing its slot straight on; a wait for a slot is bounded", async () => {
    let now = 0;
    let peak = 0;
    const gates: (() => void)[] = [];
    const job = () =>
      inSlot(async () => {
        now++;
        peak = Math.max(peak, now);
        await new Promise<void>((go) => gates.push(go));
        now--;
        return true;
      }, 5_000);
    const all = Array.from({ length: 6 }, job);
    for (let i = 0; i < 20 && gates.length < 6; i++) {
      await Bun.sleep(5);
      // Let one finish whenever two run: a third must never start before.
      expect(now).toBeLessThanOrEqual(CONVERT_MAX);
      gates.shift()?.();
    }
    while (gates.length) gates.shift()!();
    expect(await Promise.all(all)).toEqual([true, true, true, true, true, true]);
    expect(peak).toBe(CONVERT_MAX);
    // Both slots busy: a third gives up after its wait (the image then goes as it came).
    const hold: (() => void)[] = [];
    const busy = [1, 2].map(() => inSlot(() => new Promise<void>((go) => hold.push(go)), 5_000));
    await expect(inSlot(async () => 1, 20)).rejects.toThrow(/no conversion slot/);
    hold.forEach((go) => go());
    await Promise.all(busy);
    expect(await inSlot(async (left) => left > 0, 1_000)).toBe(true);
  });

  test("old ImageMagick temp folders are swept at start; new ones stay", () => {
    const dir = mkdtempSync(join(tmpdir(), "tether-sweep-"));
    mkdirSync(join(dir, "tether-magick-old"));
    mkdirSync(join(dir, "tether-magick-new"));
    mkdirSync(join(dir, "other-old"));
    const now = Date.now() + 2 * 60 * 60_000;
    utimesSync(join(dir, "tether-magick-new"), new Date(now), new Date(now));
    sweepMagickTemp(dir, now);
    expect(readdirSync(dir).sort()).toEqual(["other-old", "tether-magick-new"]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("an unconverted HEIC is named .heic, whatever the sender called it", async () => {
    const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic"), Buffer.alloc(16)]);
    expect(await incomingImage({ name: "x.html" }, HEIC, async () => undefined)).toMatchObject({ name: "x.heic", mimeType: "image/heic", heic: true });
    expect(await incomingImage({ name: "" }, HEIC, async () => undefined)).toMatchObject({ name: "image.heic" });
  });
});
