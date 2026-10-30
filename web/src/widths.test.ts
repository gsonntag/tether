import { expect, test } from "bun:test";
import { clampWidth, panelMax, readWidth, sidebarMax, SIDEBAR_MAX, TRANSCRIPT_MIN, writeWidth } from "./widths";

const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
};

test("clamps to the bounds and rounds to whole pixels", () => {
  expect(clampWidth(100, 200, 480)).toBe(200);
  expect(clampWidth(900, 200, 480)).toBe(480);
  expect(clampWidth(300.4, 200, 480)).toBe(300);
});

test("the minimum wins when a tiny window crosses the bounds", () => {
  expect(clampWidth(500, 320, panelMax(400))).toBe(320);
  expect(clampWidth(500, 200, sidebarMax(768))).toBe(200);
});

test("the sidebar's limit leaves room for the transcript and a panel, up to its own maximum", () => {
  expect(sidebarMax(2000)).toBe(SIDEBAR_MAX);
  expect(sidebarMax(1024)).toBe(404);
});

test("the panel leaves the transcript its minimum", () => {
  expect(panelMax(1000)).toBe(1000 - TRANSCRIPT_MIN);
});

test("a stored width comes back; a reset forgets it", () => {
  const s = memory();
  expect(readWidth(s, "k")).toBeUndefined();
  writeWidth(s, "k", 333);
  expect(readWidth(s, "k")).toBe(333);
  writeWidth(s, "k", undefined);
  expect(readWidth(s, "k")).toBeUndefined();
});

test("junk in storage is no width", () => {
  const s = memory();
  for (const v of ["", "abc", "-5", "0", "NaN", "Infinity"]) {
    s.setItem("k", v);
    expect(readWidth(s, "k")).toBeUndefined();
  }
});

test("storage that refuses (private mode, quota) neither throws nor returns a width", () => {
  const no = () => {
    throw new Error("denied");
  };
  const s = { getItem: no, setItem: no, removeItem: no };
  expect(readWidth(s, "k")).toBeUndefined();
  expect(() => writeWidth(s, "k", 300)).not.toThrow();
  expect(() => writeWidth(s, "k", undefined)).not.toThrow();
});
