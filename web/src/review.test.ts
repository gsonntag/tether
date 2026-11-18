import { expect, test } from "bun:test";
import { numberLines, type DiffHunk } from "../../shared/gitDiff";
import { cleanComments, location, readComments, reviewKey, reviewMessage, selectionOf, writeComments, type LineComment } from "./review";

const hunk: DiffHunk = { header: "@@ -10,4 +10,5 @@", oldStart: 10, oldLines: 4, newStart: 10, newLines: 5, lines: [" a", "-b", "+B", "+C", " d", " e", "\\ No newline at end of file"] };
const lines = numberLines(hunk);

test("a selection points at new line numbers when it has any", () => {
  expect(selectionOf(lines, 0, 0)).toEqual({ side: "new", start: 10, end: 10, lines: [" a"] });
  // Dragged upward: the same range.
  expect(selectionOf(lines, 3, 1)).toEqual({ side: "new", start: 11, end: 12, lines: ["-b", "+B", "+C"] });
  expect(selectionOf(lines, 1, 1)).toEqual({ side: "old", start: 11, end: 11, lines: ["-b"] });
  // The no-newline marker isn't a line.
  expect(selectionOf(lines, 5, 6)).toEqual({ side: "new", start: 14, end: 14, lines: [" e"] });
  expect(selectionOf(lines, 6, 6)).toBeUndefined();
});

test("locations: a line, a range, removed lines", () => {
  expect(location({ path: "src/a.ts", side: "new", start: 12, end: 12 })).toBe("src/a.ts:12");
  expect(location({ path: "src/a.ts", side: "new", start: 12, end: 15 })).toBe("src/a.ts:12-15");
  expect(location({ path: "src/a.ts", side: "old", start: 3, end: 4 })).toBe("src/a.ts:3-4 (removed)");
});

const c = (over: Partial<LineComment>): LineComment => ({ id: "x", path: "a.ts", side: "new", start: 1, end: 1, lines: ["+x"], text: "why?", scope: "uncommitted", ...over });

test("one message: each comment's place and lines, in file order, empty ones left out", () => {
  const msg = reviewMessage([
    c({ id: "2", path: "b.ts", start: 4, end: 5, lines: [" keep", "+add"], text: "Name this better." }),
    c({ id: "1", path: "a.ts", start: 9, end: 9, lines: ["-gone"], side: "old", text: "  Bring this back.  " }),
    c({ id: "3", path: "a.ts", start: 2, end: 2, text: "   " }),
  ]);
  expect(msg).toBe(
    [
      "Comments on the changes:",
      "",
      "`a.ts:9 (removed)`",
      "```diff",
      "-gone",
      "```",
      "Bring this back.",
      "",
      "`b.ts:4-5`",
      "```diff",
      " keep",
      "+add",
      "```",
      "Name this better.",
    ].join("\n"),
  );
  expect(reviewMessage([c({ text: "" })])).toBe("");
  expect(reviewMessage([c({})]).startsWith("A comment on the changes:")).toBe(true);
});

test("lines with backticks get a longer fence", () => {
  const msg = reviewMessage([c({ lines: ["+```js", "+x"] })]);
  expect(msg).toContain("````diff\n+```js\n+x\n````");
});

const memory = () => {
  const m = new Map<string, string>();
  return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
};

test("drafts are kept per session and dropped when empty", () => {
  const s = memory();
  const k1 = reviewKey("r1", "s1");
  const k2 = reviewKey("r1", "s2");
  expect(k1).not.toBe(k2);
  expect(readComments(s, k1)).toEqual([]);
  writeComments(s, k1, [c({})]);
  expect(readComments(s, k1)).toEqual([c({})]);
  expect(readComments(s, k2)).toEqual([]);
  writeComments(s, k1, []);
  expect(s.m.has(k1)).toBe(false);
});

test("what's stored is cleaned: junk dropped, fields defaulted", () => {
  const s = memory();
  s.setItem("k", "not json");
  expect(readComments(s, "k")).toEqual([]);
  expect(cleanComments([null, { id: "a" }, { id: "b", path: "p", text: "t", start: "x", end: 1 }, { id: "c", path: "p", text: "t", start: 2, end: 3, lines: ["+a", 5], side: "weird", scope: "branch" }])).toEqual([
    { id: "c", path: "p", side: "new", start: 2, end: 3, lines: ["+a"], text: "t", scope: "branch" },
  ]);
});
