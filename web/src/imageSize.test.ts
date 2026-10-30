import { expect, test } from "bun:test";
import { imageSize } from "./imageSize";

const b64 = (bytes: number[]) => Buffer.from(bytes).toString("base64");

test("PNG, GIF and WebP headers", () => {
  // PNG: signature, IHDR length and type, then width 640 and height 480 (big-endian)
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 2, 128, 0, 0, 1, 224, 8, 6, 0, 0, 0];
  expect(imageSize("image/png", b64(png))).toEqual({ w: 640, h: 480 });
  expect(imageSize("image/gif", b64([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 10, 0, 20, 0, 0]))).toEqual({ w: 10, h: 20 });
  // WebP VP8X: canvas width-1 and height-1 in 24 bits each
  const riff = (kind: string, body: number[]) => [..."RIFF"].map((c) => c.charCodeAt(0)).concat([0, 0, 0, 0], [..."WEBP"].map((c) => c.charCodeAt(0)), [...kind].map((c) => c.charCodeAt(0)), body);
  expect(imageSize("image/webp", b64(riff("VP8X", [10, 0, 0, 0, 0, 0, 0, 0, 99, 0, 0, 49, 0, 0, 0])))).toEqual({ w: 100, h: 50 });
});

test("JPEG: the start-of-frame after other segments", () => {
  const app0 = [0xff, 0xe0, 0, 6, 1, 2, 3, 4];
  const sof0 = [0xff, 0xc0, 0, 11, 8, 0, 120, 0, 160, 3, 1, 0x22, 0];
  expect(imageSize("image/jpeg", b64([0xff, 0xd8, ...app0, ...sof0, 0, 0]))).toEqual({ w: 160, h: 120 });
});

test("SVG: width and height, else the viewBox", () => {
  const svg = (s: string) => Buffer.from(s).toString("base64");
  expect(imageSize("image/svg+xml", svg('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect/></svg>'))).toEqual({ w: 600, h: 400 });
  expect(imageSize("image/svg+xml", svg('<?xml version="1.0"?><svg viewBox="0 0 30 15"></svg>'))).toEqual({ w: 30, h: 15 });
  expect(imageSize("image/svg+xml", svg('<svg width="100%" height="100%"></svg>'))).toBeUndefined();
});

test("unknown or broken data", () => {
  expect(imageSize("image/png", "!!!")).toBeUndefined();
  expect(imageSize("image/png", b64([1, 2, 3]))).toBeUndefined();
});
