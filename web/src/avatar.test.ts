import { expect, test } from "bun:test";
import { avatarSrc } from "./avatar";

const pic = "https://foliation.dev/pictures/AbCdEfGhIjKlMnOpQrStUv";

test("a Foliation picture is shown", () => {
  expect(avatarSrc(pic, undefined)).toBe(pic);
});

test("no picture set falls back to the icon", () => {
  expect(avatarSrc(undefined, undefined)).toBeUndefined();
  expect(avatarSrc("", undefined)).toBeUndefined();
});

test("a picture that failed to load falls back to the icon", () => {
  expect(avatarSrc(pic, pic)).toBeUndefined();
});

test("a changed picture is tried again after an earlier one failed", () => {
  const next = "https://foliation.dev/pictures/ZZZZZZZZZZZZZZZZZZZZZZ";
  expect(avatarSrc(next, pic)).toBe(next);
});

test("anything but an http(s) URL falls back to the icon", () => {
  expect(avatarSrc("javascript:alert(1)", undefined)).toBeUndefined();
  expect(avatarSrc("data:image/svg+xml,<svg/>", undefined)).toBeUndefined();
  expect(avatarSrc("/pictures/relative", undefined)).toBeUndefined();
  expect(avatarSrc("not a url", undefined)).toBeUndefined();
});
