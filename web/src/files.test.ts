import { expect, test } from "bun:test";
import type { DirList, FileChanges, FileEntry } from "../../shared/files";
import { canOpen, changedList, changeMarks, changesResult, isFolder, lineNumbers, loadedOpen, markAt, markText, pruneOpen, treeRows, viewOf, withMention, type DirState } from "./files";

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
  expect(viewOf({ path: "a/README.md", size: 3, kind: "text", text: "# x" })).toEqual({ t: "markdown", text: "# x", cut: false, lossy: false });
  expect(viewOf({ path: "a.ts", size: 3, kind: "text", text: "x", cut: true, lossy: true })).toEqual({ t: "text", text: "x", cut: true, lossy: true });
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
  // One focusable control per treeitem: the Mention button isn't a tab stop.
  const tree = await Bun.file(new URL("./components/FileTree.tsx", import.meta.url)).text();
  expect(tree).toContain('role="treeitem"');
  expect(tree.match(/<button/g)?.length).toBe(1);
  expect(tree).toContain("tabIndex={-1}");
});

test("treeKey: arrows move and open and close, Enter opens files and toggles folders", async () => {
  const { treeKey } = await import("./files");
  const dirs = { "": list("", [dir("src"), file("README.md"), { name: "out", kind: "link", to: "outside" }]), src: list("src", [file("a.ts")]) };
  const closed = treeRows(dirs, new Set());
  const open = treeRows(dirs, new Set(["src"]));
  expect(treeKey(closed, 0, "ArrowRight")).toEqual({ t: "toggle", path: "src" });
  expect(treeKey(open, 0, "ArrowRight")).toEqual({ t: "focus", index: 1 });
  expect(treeKey(open, 1, "ArrowLeft")).toEqual({ t: "focus", index: 0 });
  expect(treeKey(open, 0, "ArrowLeft")).toEqual({ t: "toggle", path: "src" });
  expect(treeKey(open, 0, "ArrowDown")).toEqual({ t: "focus", index: 1 });
  expect(treeKey(open, 3, "ArrowDown")).toBeUndefined();
  expect(treeKey(open, 2, "ArrowUp")).toEqual({ t: "focus", index: 1 });
  expect(treeKey(open, 2, "Home")).toEqual({ t: "focus", index: 0 });
  expect(treeKey(open, 0, "End")).toEqual({ t: "focus", index: 3 });
  expect(treeKey(open, 2, "Enter")).toEqual({ t: "open", path: "README.md" });
  expect(treeKey(open, 0, " ")).toEqual({ t: "toggle", path: "src" });
  expect(treeKey(open, 3, "Enter")).toBeUndefined();
});

test("linkTarget: relative links open files in the folder, never outside it", async () => {
  const { linkTarget } = await import("./files");
  expect(linkTarget("docs/README.md", "guide.md")).toEqual({ t: "file", path: "docs/guide.md" });
  expect(linkTarget("docs/README.md", "./img/a%20b.png?raw=1#top")).toEqual({ t: "file", path: "docs/img/a b.png" });
  expect(linkTarget("docs/README.md", "../src/app.ts")).toEqual({ t: "file", path: "src/app.ts" });
  expect(linkTarget("docs/README.md", "/LICENSE")).toEqual({ t: "file", path: "LICENSE" });
  expect(linkTarget("README.md", "../../etc/passwd")).toEqual({ t: "outside" });
  expect(linkTarget("README.md", "#install")).toEqual({ t: "anchor", id: "install" });
  expect(linkTarget("README.md", "https://example.com/x.md")).toEqual({ t: "away" });
  expect(linkTarget("README.md", "mailto:a@b.c")).toEqual({ t: "away" });
  expect(linkTarget("README.md", "//cdn.example.com/x")).toEqual({ t: "away" });
});

test("oddChars and mapLimit", async () => {
  const { oddChars, mapLimit } = await import("./files");
  expect(oddChars("plain\ttext\r\n")).toEqual([]);
  expect(oddChars("if (a ‮) {}")).toHaveLength(1);
  expect(oddChars("bell\u0007")).toEqual(["control characters"]);
  let running = 0;
  let most = 0;
  const r = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (x) => {
    most = Math.max(most, ++running);
    await Bun.sleep(5);
    running--;
    return x * 2;
  });
  expect(r).toEqual([2, 4, 6, 8, 10, 12, 14]);
  expect(most).toBe(3);
});

test("change marks: files keep their own, folders count what's under them, hidden paths only with the eye", () => {
  const c: FileChanges = {
    repo: true,
    files: { "src/a.ts": "modified", "src/deep/b.ts": "untracked", "top.md": "added", "src/old.ts": "deleted", ".github/ci.yml": "modified", "lib/.env": "untracked", nested: "untracked", "c.ts": "conflict" },
    folders: ["nested"],
  };
  const m = changeMarks(c, false);
  expect(m.files.get("src/a.ts")).toBe("modified");
  expect(m.files.get("top.md")).toBe("added");
  expect([...m.dirs].sort()).toEqual([
    ["src", 3],
    ["src/deep", 1],
  ]);
  expect([...changeMarks(c, true).dirs].sort()).toEqual([
    [".github", 1],
    ["lib", 1],
    ["src", 3],
    ["src/deep", 1],
  ]);
  // an untracked folder is named once: what's under it is untracked too
  expect(markAt(m, "nested")).toBe("untracked");
  expect(markAt(m, "nested/a/b.txt")).toBe("untracked");
  expect(markAt(m, "src/deep/other.ts")).toBeUndefined();
  // an entry git ignores under an untracked folder isn't a change
  expect(markAt(m, "nested/node_modules", true)).toBeUndefined();
  expect(markText(m, "nested/debug.log", false, true)).toBe("");
  expect(markAt(m, "nested", true)).toBe("untracked");
  // words, not colour alone
  expect(markText(m, "src/a.ts", false)).toBe("modified");
  expect(markText(m, "c.ts", false)).toBe("conflict");
  expect(markText(m, "src", true)).toBe("3 changes inside");
  expect(markText(m, "src/deep", true)).toBe("1 change inside");
  expect(markText(m, "nested", true)).toBe("untracked");
  expect(markText(m, "nested/x", true)).toBe("untracked");
  expect(markText(m, "lib", true)).toBe("");
  expect(markText(m, "README.md", false)).toBe("");
  // outside a repo, or not known: none
  expect(changeMarks({ repo: false, files: {} }, true).files.size).toBe(0);
  expect(changeMarks(undefined, true).dirs.size).toBe(0);
  expect(changedList(c, false).map((x) => `${x.mark[0]}${x.folder ? "/" : ""} ${x.path}`)).toEqual(["c c.ts", "u/ nested", "m src/a.ts", "u src/deep/b.ts", "d src/old.ts", "a top.md"]);
  expect(changedList(c, true)).toHaveLength(8);
});

test("changesResult: marks, a failure said, an older runner without the op silent", () => {
  const c = { repo: true, files: { "a.ts": "modified" as const } };
  expect(changesResult({ ok: true, data: c })).toEqual({ changes: c });
  expect(changesResult({ ok: false, error: "git took too long." })).toEqual({ error: "git took too long." });
  expect(changesResult({ ok: false, error: 'This runner doesn\'t know "fileChanges". Update and restart it.' })).toEqual({});
});
