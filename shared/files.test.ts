import { expect, test } from "bun:test";
import { imageType, matchScore, mentionOf, rankMatches, sizeLabel, splitPath } from "./files";

test("splitPath: relative names only", () => {
  expect(splitPath("")).toEqual([]);
  expect(splitPath(".")).toEqual([]);
  expect(splitPath("a/b c/d.txt")).toEqual(["a", "b c", "d.txt"]);
  expect(splitPath("dir/")).toEqual(["dir"]);
  expect(splitPath("ünï/文件.md")).toEqual(["ünï", "文件.md"]);
  expect(splitPath("..file")).toEqual(["..file"]);
  for (const bad of ["/etc/passwd", "../x", "a/../../x", "a/./b", "a//b", "a/..", "~/x", "C:\\x", "\\\\server\\x", "a\0b", "x".repeat(5000), 3, undefined, null])
    expect(Array.isArray(splitPath(bad))).toBe(false);
});

test("matchScore: name over path, in-order letters last", () => {
  expect(matchScore("src/a.ts", "")).toBe(0);
  expect(matchScore("src/a.ts", "zzz")).toBe(0);
  const exact = matchScore("web/App.tsx", "app.tsx");
  const prefix = matchScore("web/Apple.ts", "app");
  const inName = matchScore("web/MyApp.ts", "app");
  const inPath = matchScore("app/x.ts", "app");
  const words = matchScore("web/components/ChangesPane.tsx", "comp pane");
  const letters = matchScore("web/ChangesPane.tsx", "cpane");
  expect(exact).toBeGreaterThan(prefix);
  expect(prefix).toBeGreaterThan(inName);
  expect(inName).toBeGreaterThan(inPath);
  expect(inPath).toBeGreaterThan(words);
  expect(words).toBeGreaterThan(letters);
  expect(letters).toBeGreaterThan(0);
  // Case doesn't matter.
  expect(matchScore("README.md", "readme")).toBeGreaterThan(0);
});

test("rankMatches: best first, shorter paths first among equals, capped", () => {
  const r = rankMatches(["a/b/c/index.ts", "index.ts", "x/index.ts", "nope.md"], "index");
  expect(r.paths).toEqual(["index.ts", "x/index.ts", "a/b/c/index.ts"]);
  expect(r.more).toBe(false);
  const many = Array.from({ length: 300 }, (_, i) => `f${i}.ts`);
  const c = rankMatches(many, "f", 200);
  expect(c.paths.length).toBe(200);
  expect(c.more).toBe(true);
});

test("mentionOf: @path, quoted with spaces", () => {
  expect(mentionOf("src/a.ts")).toBe("@src/a.ts");
  expect(mentionOf("my docs/a b.md")).toBe('@"my docs/a b.md"');
  expect(mentionOf('we"ird.txt')).toBe('@"we\\"ird.txt"');
});

test("imageType and sizeLabel", () => {
  expect(imageType("a/b.PNG")).toBe("image/png");
  expect(imageType("x.svg")).toBe("image/svg+xml");
  expect(imageType("x.txt")).toBeUndefined();
  expect(imageType("png")).toBeUndefined();
  expect(imageType("dir.png/readme")).toBeUndefined();
  expect(sizeLabel(1)).toBe("1 byte");
  expect(sizeLabel(2048)).toBe("2.0 KB");
  expect(sizeLabel(5 * 1024 * 1024)).toBe("5.0 MB");
});
