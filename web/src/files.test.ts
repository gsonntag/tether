import { expect, test } from "bun:test";
import type { DirList, FileEntry } from "../../shared/files";
import { canOpen, isFolder, lineNumbers, loadedOpen, pruneOpen, treeRows, viewOf, withMention, type DirState } from "./files";

const list = (path: string, entries: FileEntry[], more?: number): DirState => ({ list: { path, entries, repo: true, ...(more ? { more } : {}) } satisfies DirList });
const dir = (name: string): FileEntry => ({ name, kind: "dir" });
const file = (name: string, size = 1): FileEntry => ({ name, kind: "file", size });

test("treeRows: open folders show their entries, unloaded ones a loading row, failures their error", () => {
  const dirs = {
    "": list("", [dir("src"), dir("docs"), { name: "lib", kind: "link", to: "dir" }, file("README.md")], 3),
    src: list("src", [dir("deep"), file("a.ts")]),
    docs: { error: "It isn't there any more." },
  };
  const rows = treeRows(dirs, new Set(["src", "src/deep", "docs", "lib"]));
  expect(rows.map((r) => [r.t, r.path, r.depth])).toEqual([
    ["entry", "src", 0],
    ["entry", "src/deep", 1],
    ["loading", "src/deep", 2],
    ["entry", "src/a.ts", 1],
    ["entry", "docs", 0],
    ["error", "docs", 1],
    ["entry", "lib", 0],
    ["loading", "lib", 1],
    ["entry", "README.md", 0],
    ["more", "", 0],
  ]);
  expect(treeRows({}, new Set())).toEqual([{ t: "loading", path: "", depth: 0 }]);
  expect(treeRows({ "": list("", []) }, new Set())).toEqual([{ t: "empty", path: "", depth: 0 }]);
  // A closed folder's loaded entries stay out.
  expect(treeRows(dirs, new Set()).length).toBe(5);
});

test("folders and files: links by where they point, names that aren't UTF-8 never open", () => {
  expect(isFolder({ name: "x", kind: "link", to: "dir" })).toBe(true);
  expect(isFolder({ name: "x", kind: "link", to: "outside" })).toBe(false);
  expect(canOpen({ name: "x", kind: "link", to: "file" })).toBe(true);
  expect(canOpen({ name: "x", kind: "link", to: "outside" })).toBe(false);
  expect(canOpen({ name: "x", kind: "link", to: "broken" })).toBe(false);
  expect(canOpen({ name: "x�", kind: "file", badName: true })).toBe(false);
  expect(canOpen({ name: "fifo", kind: "other" })).toBe(false);
});

test("loadedOpen: the top and each open folder whose parents are open", () => {
  expect(loadedOpen(new Set(["a", "a/b", "c/d", "e"]))).toEqual(["", "a", "a/b", "e"]);
});

test("pruneOpen: folders that failed or left their parent close", () => {
  const dirs = { "": list("", [dir("a"), file("b")]), a: list("a", []), gone: { error: "x" } };
  expect([...pruneOpen(new Set(["a", "b", "gone", "x/y"]), dirs)]).toEqual(["a", "x/y"]);
});

test("viewOf: markdown, text, images as data URLs (SVG too), binary, too big", () => {
  expect(viewOf({ path: "a/README.md", size: 3, kind: "text", text: "# x" })).toEqual({ t: "markdown", text: "# x", cut: false });
  expect(viewOf({ path: "a.ts", size: 3, kind: "text", text: "x", cut: true })).toEqual({ t: "text", text: "x", cut: true });
  expect(viewOf({ path: "p.svg", size: 3, kind: "image", mime: "image/svg+xml", data: "PHN2Zz4=" })).toEqual({ t: "image", src: "data:image/svg+xml;base64,PHN2Zz4=" });
  expect(viewOf({ path: "b", size: 9, kind: "binary" })).toEqual({ t: "binary", size: 9 });
  expect(viewOf({ path: "c", size: 9e6, kind: "tooBig" })).toEqual({ t: "tooBig", size: 9e6 });
});

test("lineNumbers: one per line, a last newline ends a line", () => {
  expect(lineNumbers("")).toBe("1");
  expect(lineNumbers("a")).toBe("1");
  expect(lineNumbers("a\n")).toBe("1");
  expect(lineNumbers("a\nb")).toBe("1\n2");
  expect(lineNumbers("a\n\nb\n")).toBe("1\n2\n3");
});

test("withMention: on the box's last line, a space between", () => {
  expect(withMention("", "@a.ts")).toBe("@a.ts ");
  expect(withMention("look at", "@a.ts")).toBe("look at @a.ts ");
  expect(withMention("look at @a.ts ", "@b.ts")).toBe("look at @a.ts @b.ts ");
  expect(withMention("first line\n", "@a.ts")).toBe("first line\n@a.ts ");
});

test("the viewer never puts a file's markup in the page (SVG shows only as an <img>)", async () => {
  const src = await Bun.file(new URL("./components/FilesView.tsx", import.meta.url)).text();
  for (const bad of ["dangerouslySetInnerHTML", "<iframe", "<object", "<embed", "innerHTML"]) expect(src).not.toContain(bad);
  expect(src).toContain("<img src={v.src}");
});
