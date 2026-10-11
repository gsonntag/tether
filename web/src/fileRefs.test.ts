import { describe, expect, test } from "bun:test";
import { findRefs, formatRef, parseRefToken, refFromHref } from "./fileRefs";

/** The matched text of each candidate, with its line info. */
const refs = (text: string) => findRefs(text).map((f) => ({ text: text.slice(f.index, f.index + f.length), ...f.ref }));
const texts = (text: string) => findRefs(text).map((f) => text.slice(f.index, f.index + f.length));

describe("findRefs", () => {
  test("relative paths, ./ and ../, bare file names with an extension, dotfiles", () => {
    expect(texts("I changed web/src/App.tsx and ./x.py, see ../lib/util.ts")).toEqual(["web/src/App.tsx", "./x.py", "../lib/util.ts"]);
    expect(texts("Update README.md and package.json, plus .gitignore")).toEqual(["README.md", "package.json", ".gitignore"]);
    expect(texts("node_modules/@types/node/index.d.ts")).toEqual(["node_modules/@types/node/index.d.ts"]);
    expect(texts("bin/tether-runner and src/c++/x.cc")).toEqual(["bin/tether-runner", "src/c++/x.cc"]);
  });

  test("line, column and range suffixes", () => {
    expect(refs("at src/a.ts:42")).toEqual([{ text: "src/a.ts:42", path: "src/a.ts", line: 42 }]);
    expect(refs("src/a.ts:42-50")).toEqual([{ text: "src/a.ts:42-50", path: "src/a.ts", line: 42, endLine: 50 }]);
    expect(refs("src/foo.ts:12:3")).toEqual([{ text: "src/foo.ts:12:3", path: "src/foo.ts", line: 12, col: 3 }]);
    expect(refs("src/a.ts#L42")).toEqual([{ text: "src/a.ts#L42", path: "src/a.ts", line: 42 }]);
    expect(refs("src/a.ts#L42-L50")).toEqual([{ text: "src/a.ts#L42-L50", path: "src/a.ts", line: 42, endLine: 50 }]);
    expect(refs("src/a.ts#L42-50")).toEqual([{ text: "src/a.ts#L42-50", path: "src/a.ts", line: 42, endLine: 50 }]);
    // a backwards range keeps the first line only; line 0 isn't a line
    expect(refs("a.ts:50-42")).toEqual([{ text: "a.ts:50-42", path: "a.ts", line: 50 }]);
    expect(refs("a.ts:0")).toEqual([{ text: "a.ts", path: "a.ts" }]);
  });

  test("shell output: grep -n, compiler errors, stack traces", () => {
    expect(refs("src/foo.ts:12:3: error TS2322: Type 'x'")).toEqual([{ text: "src/foo.ts:12:3", path: "src/foo.ts", line: 12, col: 3 }]);
    expect(refs("src/a.ts:12:const x = 1;")).toEqual([{ text: "src/a.ts:12", path: "src/a.ts", line: 12 }]);
    expect(refs("    at main (/home/u/proj/src/index.ts:10:5)")).toEqual([{ text: "/home/u/proj/src/index.ts:10:5", path: "/home/u/proj/src/index.ts", line: 10, col: 5 }]);
    expect(texts(" M web/src/a.tsx\n?? runner/src/b.ts\n")).toEqual(["web/src/a.tsx", "runner/src/b.ts"]);
    expect(texts('  File "app/main.py", line 3')).toEqual(["app/main.py"]);
  });

  test("trailing punctuation and wrapping", () => {
    expect(texts("See src/a.ts.")).toEqual(["src/a.ts"]);
    expect(texts("See src/a.ts:42.")).toEqual(["src/a.ts:42"]);
    expect(texts("in src/a.ts, src/b.ts; and src/c.ts!")).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
    expect(texts("(src/a.ts) [src/b.ts] 'src/c.ts' \"src/d.ts\" `src/e.ts`")).toEqual(["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"]);
    expect(texts("edit src/a.ts: it was wrong")).toEqual(["src/a.ts"]);
    expect(texts("files: src/a.ts…")).toEqual(["src/a.ts"]);
  });

  test("URLs, emails, versions and prose are not file references", () => {
    expect(texts("https://example.com/src/a.ts and http://x.io/b.js")).toEqual([]);
    expect(texts("file://host/a.ts")).toEqual([]);
    expect(texts("mail me@example.com or a.b@c.org")).toEqual([]);
    expect(texts("version 1.2.3, v1.2.3, 10.0.0.1 and 3.14")).toEqual([]);
    expect(texts("it was 24/7, 1/2 done")).toEqual([]);
    expect(texts("~/notes.md and $HOME/x.ts and %APPDATA%/y.ts")).toEqual([]);
    expect(texts("/ and /usr are directories, src/ too")).toEqual([]);
    expect(texts("plain words without dots")).toEqual([]);
    expect(texts("a.ts:12abc")).toEqual(["a.ts"]);
  });

  test("ambiguous prose stays a candidate only (the runner decides)", () => {
    // These are asked about but only link if the project really has such a file.
    expect(texts("and/or, Node.js, e.g.")).toEqual(["and/or", "Node.js", "e.g"]);
  });
});

describe("parseRefToken (inline code)", () => {
  test("exactly one reference", () => {
    expect(parseRefToken("web/src/App.tsx")).toEqual({ path: "web/src/App.tsx" });
    expect(parseRefToken("src/a.ts:42")).toEqual({ path: "src/a.ts", line: 42 });
    expect(parseRefToken(" ./x.py ")).toEqual({ path: "./x.py" });
    expect(parseRefToken("'src/a.ts'")).toEqual({ path: "src/a.ts" });
    expect(parseRefToken("src/a.ts:")).toEqual({ path: "src/a.ts" });
    expect(parseRefToken("src/a.ts.")).toEqual({ path: "src/a.ts" });
  });
  test("code that isn't a file", () => {
    expect(parseRefToken("npm run build")).toBeUndefined();
    expect(parseRefToken("a.ts b.ts")).toBeUndefined();
    expect(parseRefToken("foo()")).toBeUndefined();
    expect(parseRefToken("x => x.y")).toBeUndefined();
    expect(parseRefToken("https://example.com/a.ts")).toBeUndefined();
    expect(parseRefToken("1.2.3")).toBeUndefined();
    expect(parseRefToken("me@example.com")).toBeUndefined();
    expect(parseRefToken("src/a.ts:12abc")).toBeUndefined();
    expect(parseRefToken("")).toBeUndefined();
  });
});

describe("refFromHref (markdown links)", () => {
  test("local files", () => {
    expect(refFromHref("src/a.ts")).toEqual({ path: "src/a.ts" });
    expect(refFromHref("./a.ts#L42")).toEqual({ path: "./a.ts", line: 42 });
    expect(refFromHref("/abs/proj/a.ts:3")).toEqual({ path: "/abs/proj/a.ts", line: 3 });
    expect(refFromHref("file:///abs/proj/a.ts")).toEqual({ path: "/abs/proj/a.ts" });
    expect(refFromHref("my%20dir/a.ts")).toBeUndefined(); // spaces never form a reference
  });
  test("not files", () => {
    expect(refFromHref("https://example.com/a.ts")).toBeUndefined();
    expect(refFromHref("mailto:me@example.com")).toBeUndefined();
    expect(refFromHref("//cdn.example.com/a.js")).toBeUndefined();
    expect(refFromHref("#section")).toBeUndefined();
    expect(refFromHref("javascript:alert(1)")).toBeUndefined();
  });
});

test("formatRef", () => {
  expect(formatRef({ path: "a.ts" })).toBe("a.ts");
  expect(formatRef({ path: "a.ts", line: 4 })).toBe("a.ts:4");
  expect(formatRef({ path: "a.ts", line: 4, endLine: 9 })).toBe("a.ts:4-9");
  expect(formatRef({ path: "a.ts", line: 4, col: 2 })).toBe("a.ts:4:2");
});
