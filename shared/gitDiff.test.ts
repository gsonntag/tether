import { expect, test } from "bun:test";
import { numberLines, parseNameStatus, parseNumstat, parsePatch, unquote } from "./gitDiff";

test("unquotes git's C-style paths, octal bytes as UTF-8", () => {
  expect(unquote("plain.ts")).toBe("plain.ts");
  expect(unquote('"a\\tb.txt"')).toBe("a\tb.txt");
  expect(unquote('"say \\"hi\\".md"')).toBe('say "hi".md');
  expect(unquote('"caf\\303\\251.txt"')).toBe("café.txt");
});

test("name-status -z: statuses, renames with both paths", () => {
  const out = ["M", "src/a.ts", "R087", "old name.ts", "new name.ts", "D", "gone.ts", "A", "new.ts", "T", "link", ""].join("\0");
  expect(parseNameStatus(out)).toEqual([
    { path: "src/a.ts", status: "modified" },
    { path: "new name.ts", oldPath: "old name.ts", status: "renamed" },
    { path: "gone.ts", status: "deleted" },
    { path: "new.ts", status: "added" },
    { path: "link", status: "typechange" },
  ]);
});

test("numstat -z: counts by new path, binary as '-'", () => {
  const out = "3\t1\tsrc/a.ts\0" + "2\t2\t\0old.ts\0new.ts\0" + "-\t-\timg.png\0";
  const m = parseNumstat(out);
  expect(m.get("src/a.ts")).toEqual({ added: 3, removed: 1, binary: false });
  expect(m.get("new.ts")).toEqual({ added: 2, removed: 2, binary: false });
  expect(m.get("img.png")).toEqual({ added: 0, removed: 0, binary: true });
});

const PATCH = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,5 @@ function top() {
 one
-two
+TWO
+--- not a header
 three
 four
@@ -10 +11 @@
-ten
+TEN
\\ No newline at end of file
diff --git a/a/nested.txt b/a/nested.txt
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/a/nested.txt
@@ -0,0 +1,2 @@
+x
+
diff --git a/gone.ts b/gone.ts
deleted file mode 100644
index 4444444..0000000
--- a/gone.ts
+++ /dev/null
@@ -1 +0,0 @@
-bye
diff --git a/old.ts b/new.ts
similarity index 90%
rename from old.ts
rename to new.ts
index 5555555..6666666 100644
--- a/old.ts
+++ b/new.ts
@@ -1 +1 @@
-a
+b
diff --git a/img.png b/img.png
index 7777777..8888888 100644
Binary files a/img.png and b/img.png differ
diff --git "a/sp ace\\303\\251.md" "b/sp ace\\303\\251.md"
new file mode 100644
index 0000000..9999999
Binary files /dev/null and "b/sp ace\\303\\251.md" differ
`;

test("parses a patch: statuses, paths, counts from hunks, header-like content kept", () => {
  const files = parsePatch(PATCH);
  expect(files.map((f) => [f.path, f.status, f.added, f.removed, f.binary])).toEqual([
    ["src/a.ts", "modified", 3, 2, false],
    ["a/nested.txt", "added", 2, 0, false],
    ["gone.ts", "deleted", 0, 1, false],
    ["new.ts", "renamed", 1, 1, false],
    ["img.png", "modified", 0, 0, true],
    ["sp aceé.md", "added", 0, 0, true],
  ]);
  const a = files[0]!;
  expect(a.hunks).toHaveLength(2);
  expect(a.hunks[0]!.lines).toEqual([" one", "-two", "+TWO", "+--- not a header", " three", " four"]);
  expect(a.hunks[1]).toMatchObject({ oldStart: 10, oldLines: 1, newStart: 11, newLines: 1, lines: ["-ten", "+TEN", "\\ No newline at end of file"] });
  // An empty added line is kept as a line.
  expect(files[1]!.hunks[0]!.lines).toEqual(["+x", "+"]);
  expect(files[3]!.oldPath).toBe("old.ts");
  expect(files.every((f) => !f.partial)).toBe(true);
});

test("output cut mid-hunk marks the last file partial", () => {
  const cut = PATCH.slice(0, PATCH.indexOf("+--- not"));
  const files = parsePatch(cut);
  expect(files).toHaveLength(1);
  expect(files[0]!.partial).toBe(true);
});

test("numbers a hunk's lines on both sides", () => {
  const [a] = parsePatch(PATCH);
  expect(numberLines(a!.hunks[0]!)).toEqual([
    { op: " ", text: "one", old: 1, new: 1 },
    { op: "-", text: "two", old: 2 },
    { op: "+", text: "TWO", new: 2 },
    { op: "+", text: "--- not a header", new: 3 },
    { op: " ", text: "three", old: 3, new: 4 },
    { op: " ", text: "four", old: 4, new: 5 },
  ]);
  expect(numberLines(a!.hunks[1]!).at(-1)).toEqual({ op: "\\", text: "No newline at end of file" });
});
