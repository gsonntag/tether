import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { incomingImage, pickIncoming, readOutgoingImage, sniffImage, type InboundFile } from "./images";
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

  test("anything else is refused, with why", () => {
    const problem = (p: unknown, max?: number) => (readOutgoingImage(p, max) as { problem?: string }).problem;
    expect(problem("")).toContain("empty");
    expect(problem(undefined)).toContain("empty");
    expect(problem("shot.png")).toContain("absolute");
    expect(problem(join(dir, "nope.png"))).toContain("no file");
    // Not an image by name: never read.
    expect(problem(file(".env", "SECRET=1"))).toContain("Only images");
    expect(problem(file("id_ed25519", "-----BEGIN OPENSSH PRIVATE KEY-----"))).toContain("Only images");
    expect(problem(file("a.svg", "<svg/>"))).toContain("Only images");
    // An image by name only: a key renamed .png doesn't go.
    expect(problem(file("key.png", "-----BEGIN OPENSSH PRIVATE KEY-----"))).toContain("isn't the image");
    // A JPEG named .png isn't what it says either.
    expect(problem(file("mislabeled.png", JPEG))).toContain("isn't the image");
    // A symlink with an image's name to a secret: judged by what it points at.
    const secret = file("secret.txt", "password");
    symlinkSync(secret, join(dir, "link.png"));
    expect(problem(join(dir, "link.png"))).toContain("Only images");
    mkdirSync(join(dir, "folder.png"));
    expect(problem(join(dir, "folder.png"))).toContain("isn't a file");
    expect(problem(file("empty.png", Buffer.alloc(0)))).toContain("empty");
    expect(problem(file("big.png", PNG), 10)).toContain("too big");
  });
});

describe("images the person texts", () => {
  const f = (mimeType: string, size?: number): InboundFile => ({ name: "x", mimeType, ...(size !== undefined ? { size } : {}), read: async () => PNG });

  test("only images, not too big, pass", () => {
    const { take, left } = pickIncoming([f("image/jpeg"), f("image/heic"), f("application/pdf"), f("image/svg+xml"), f("image/png", 50 * 1024 * 1024)]);
    expect(take.map((x) => x.mimeType)).toEqual(["image/jpeg", "image/heic"]);
    expect(left).toBe(3);
  });

  test("a downloaded one is typed by its bytes, and dropped when it isn't an image", () => {
    expect(incomingImage({ name: "IMG_1.jpeg" }, JPEG)).toEqual({ name: "IMG_1.jpeg", mimeType: "image/jpeg", data: JPEG });
    expect(incomingImage({ name: "" }, PNG)).toMatchObject({ name: "image", mimeType: "image/png" });
    expect(incomingImage({ name: "x.png" }, Buffer.from("not an image"))).toBeUndefined();
    expect(incomingImage({ name: "x.png" }, Buffer.alloc(0))).toBeUndefined();
  });
});

describe("the reply's context line", () => {
  test("names the session, and reads back", () => {
    const line = replyContext({ sessionId: "claude:abc", byHome: true, title: 'Fix "login" (now)\nplease', project: "/home/me/web" });
    expect(line).toBe('(replying to your text about session claude:abc, "Fix login now please" in /home/me/web) ');
    expect(aboutOf(line + "merge it")).toBe("claude:abc");
    expect(replyContext({ sessionId: "codex:1" })).toBe("(replying to Tether's text about session codex:1) ");
    expect(aboutOf(replyContext({ sessionId: "codex:1" }) + "y")).toBe("codex:1");
    expect(aboutOf("merge it")).toBeUndefined();
    expect(aboutOf("tell it (replying to your text about session claude:abc) x")).toBeUndefined();
  });
});
