// The git module against real temporary repos: both scopes, untracked files, renames, binary files,
// the caps, a folder that isn't a repo, and that nothing in the repo changes.

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DIFF_FILE_LINES_MAX } from "../../../../shared/gitDiff";
import { FRAME_BYTES_MAX, utf8Length } from "../../../../shared/limits";
import { OpRegistry } from "../../core/ops";
import { defaultBranch, gitDiff } from "./diff";
import { gitModule } from ".";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const sh = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString();
};
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "tether-git-"));
  dirs.push(d);
  return d;
};
function repo(branch = "main") {
  const d = temp();
  sh(d, "init", "-q", "-b", branch);
  writeFileSync(join(d, "a.txt"), "one\ntwo\nthree\n");
  writeFileSync(join(d, "old.txt"), "keep\nthis\nfile\nas it\nis\n");
  writeFileSync(join(d, "gone.txt"), "bye\n");
  writeFileSync(join(d, ".gitignore"), "ignored.log\n");
  sh(d, "add", ".");
  sh(d, "commit", "-qm", "first");
  return d;
}
const byPath = (d: Awaited<ReturnType<typeof gitDiff>>) => Object.fromEntries(d.files.map((f) => [f.path, f]));

test("uncommitted: edits, staged and not, renames, deletions, untracked, never ignored", async () => {
  const d = repo();
  writeFileSync(join(d, "a.txt"), "one\nTWO\nthree\nfour\n");
  sh(d, "mv", "old.txt", "new.txt");
  sh(d, "rm", "-q", "gone.txt");
  writeFileSync(join(d, "staged.txt"), "s\n");
  sh(d, "add", "staged.txt");
  mkdirSync(join(d, "dir"));
  writeFileSync(join(d, "dir", "fresh name.ts"), "x\ny\n");
  writeFileSync(join(d, "ignored.log"), "noise\n");
  writeFileSync(join(d, "blob.bin"), Buffer.from([0, 1, 2, 3]));
  const indexBefore = readFileSync(join(d, ".git", "index"));
  const mtime = statSync(join(d, ".git", "index")).mtimeMs;

  const r = await gitDiff(d, "uncommitted");
  expect(r.state).toBe("ok");
  expect(r.branch).toBe("main");
  const f = byPath(r);
  expect(Object.keys(f).sort()).toEqual(["a.txt", "blob.bin", "dir/fresh name.ts", "gone.txt", "new.txt", "staged.txt"]);
  expect(f["a.txt"]).toMatchObject({ status: "modified", added: 2, removed: 1 });
  expect(f["a.txt"]!.hunks![0]!.lines).toEqual([" one", "-two", "+TWO", " three", "+four"]);
  expect(f["new.txt"]).toMatchObject({ status: "renamed", oldPath: "old.txt", added: 0, removed: 0 });
  expect(f["gone.txt"]).toMatchObject({ status: "deleted", removed: 1 });
  expect(f["gone.txt"]!.hunks![0]!.lines).toEqual(["-bye"]);
  expect(f["staged.txt"]).toMatchObject({ status: "added", added: 1 });
  expect(f["dir/fresh name.ts"]).toMatchObject({ status: "untracked", added: 2 });
  expect(f["dir/fresh name.ts"]!.hunks![0]!.lines).toEqual(["+x", "+y"]);
  expect(f["blob.bin"]).toMatchObject({ status: "untracked", binary: true });
  expect(f["blob.bin"]!.hunks).toBeUndefined();
  expect(r.added).toBe(2 + 1 + 2);
  expect(r.removed).toBe(1 + 1);
  // Read-only: the index is as it was, untracked files stay untracked.
  expect(readFileSync(join(d, ".git", "index")).equals(indexBefore)).toBe(true);
  expect(statSync(join(d, ".git", "index")).mtimeMs).toBe(mtime);
  expect(sh(d, "status", "--porcelain")).toContain("?? dir/");
});

test("uncommitted in a repo with no commits yet", async () => {
  const d = temp();
  sh(d, "init", "-q", "-b", "main");
  writeFileSync(join(d, "x.txt"), "1\n");
  sh(d, "add", "x.txt");
  writeFileSync(join(d, "y.txt"), "2\n");
  const r = await gitDiff(d, "uncommitted");
  expect(r.files.map((f) => [f.path, f.status])).toEqual([["x.txt", "added"], ["y.txt", "untracked"]]);
});

test("branch: commits since the merge base with main, plus what isn't committed", async () => {
  const d = repo();
  sh(d, "checkout", "-qb", "feature");
  writeFileSync(join(d, "a.txt"), "one\ntwo\nthree\nfeature\n");
  sh(d, "commit", "-qam", "feature work");
  // main moves on: its change isn't the branch's.
  sh(d, "checkout", "-q", "main");
  writeFileSync(join(d, "main-only.txt"), "m\n");
  sh(d, "add", ".");
  sh(d, "commit", "-qm", "main work");
  sh(d, "checkout", "-q", "feature");
  writeFileSync(join(d, "wip.txt"), "w\n");

  const unc = await gitDiff(d, "uncommitted");
  expect(unc.files.map((f) => f.path)).toEqual(["wip.txt"]);
  const r = await gitDiff(d, "branch");
  expect(r).toMatchObject({ state: "ok", branch: "feature", base: "main" });
  expect(r.files.map((f) => [f.path, f.status])).toEqual([["a.txt", "modified"], ["wip.txt", "untracked"]]);
});

test("the default branch: origin's HEAD first, else main or master", async () => {
  const d = repo("master");
  expect(await defaultBranch(d)).toBe("master");
  const clone = temp();
  sh(clone, "clone", "-q", d, "c");
  expect(await defaultBranch(join(clone, "c"))).toBe("origin/master");
  const none = repo("trunk");
  expect(await defaultBranch(none)).toBeUndefined();
  expect((await gitDiff(none, "branch")).state).toBe("noBase");
});

test("a folder outside any repo says so", async () => {
  const d = temp();
  const r = await gitDiff(d, "uncommitted");
  expect(r).toMatchObject({ state: "notRepo", files: [] });
});

test("a session in a subfolder sees the whole repo, paths from its root", async () => {
  const d = repo();
  mkdirSync(join(d, "pkg"));
  writeFileSync(join(d, "pkg", "p.ts"), "p\n");
  writeFileSync(join(d, "a.txt"), "changed\n");
  const r = await gitDiff(join(d, "pkg"), "uncommitted");
  expect(r.files.map((f) => f.path)).toEqual(["a.txt", "pkg/p.ts"]);
});

test("caps: a file over the line cap shows counts only, tracked or not", async () => {
  const d = repo();
  const big = Array.from({ length: DIFF_FILE_LINES_MAX + 5 }, (_, i) => `line ${i}`).join("\n") + "\n";
  writeFileSync(join(d, "big.txt"), big);
  sh(d, "add", "big.txt");
  sh(d, "commit", "-qm", "big");
  writeFileSync(join(d, "big.txt"), big.replaceAll("line", "LINE"));
  writeFileSync(join(d, "huge-new.txt"), big);
  writeFileSync(join(d, "a.txt"), "small\n");
  const f = byPath(await gitDiff(d, "uncommitted"));
  expect(f["big.txt"]).toMatchObject({ tooLarge: "file", added: DIFF_FILE_LINES_MAX + 5, removed: DIFF_FILE_LINES_MAX + 5 });
  expect(f["big.txt"]!.hunks).toBeUndefined();
  expect(f["huge-new.txt"]).toMatchObject({ tooLarge: "file", added: DIFF_FILE_LINES_MAX + 5 });
  expect(f["a.txt"]!.hunks).toBeDefined();
});

test("caps: past the overall budget the rest show counts only; past the file cap, the rest are counted as more", async () => {
  const d = repo();
  for (const n of ["f1", "f2", "f3"]) writeFileSync(join(d, `${n}.txt`), "x\n".repeat(50));
  sh(d, "add", ".");
  sh(d, "commit", "-qm", "three");
  for (const n of ["f1", "f2", "f3"]) writeFileSync(join(d, `${n}.txt`), "y\n".repeat(50));
  const r = await gitDiff(d, "uncommitted", { totalBytes: 800 });
  expect(r.files.map((f) => [f.path, f.tooLarge ?? "shown", f.added, f.removed])).toEqual([
    ["f1.txt", "shown", 50, 50],
    ["f2.txt", "total", 50, 50],
    ["f3.txt", "total", 50, 50],
  ]);
  writeFileSync(join(d, "u.txt"), "u\n");
  const few = await gitDiff(d, "uncommitted", { files: 2 });
  expect(few.files.map((f) => f.path)).toEqual(["f1.txt", "f2.txt"]);
  expect(few.more).toBe(2);
});

test("paths with spaces: tracked, renamed and untracked files all get their hunks", async () => {
  const d = repo();
  writeFileSync(join(d, "my notes.txt"), "a\nb\n");
  writeFileSync(join(d, "old name.txt"), "1\n2\n3\n4\n5\n6\n");
  sh(d, "add", ".");
  sh(d, "commit", "-qm", "spaces");
  writeFileSync(join(d, "my notes.txt"), "a\nB\n");
  sh(d, "mv", "old name.txt", "new name.txt");
  writeFileSync(join(d, "new name.txt"), "1\n2\n3\n4\n5\nsix\n");
  writeFileSync(join(d, "fresh file.md"), "hi\n");
  const f = byPath(await gitDiff(d, "uncommitted"));
  expect(f["my notes.txt"]!.hunks?.[0]!.lines).toEqual([" a", "-b", "+B"]);
  expect(f["new name.txt"]).toMatchObject({ status: "renamed", oldPath: "old name.txt" });
  expect(f["new name.txt"]!.hunks).toBeDefined();
  expect(f["fresh file.md"]!.hunks?.[0]!.lines).toEqual(["+hi"]);
  expect(Object.values(f).some((x) => x.tooLarge)).toBe(false);
});

test("one file with a huge line is too large on its own; the files after it still show", async () => {
  const d = repo();
  writeFileSync(join(d, "a.min.js"), "x\n");
  writeFileSync(join(d, "b.txt"), "b\n");
  writeFileSync(join(d, "c.txt"), "c\n");
  sh(d, "add", ".");
  sh(d, "commit", "-qm", "three");
  writeFileSync(join(d, "a.min.js"), "y".repeat(4 * 1024 * 1024) + "\n");
  writeFileSync(join(d, "b.txt"), "B\n");
  writeFileSync(join(d, "c.txt"), "C\n");
  writeFileSync(join(d, "a0-new.min.js"), "z".repeat(2 * 1024 * 1024) + "\n");
  const f = byPath(await gitDiff(d, "uncommitted"));
  expect(f["a.min.js"]).toMatchObject({ tooLarge: "file", added: 1, removed: 1 });
  expect(f["a0-new.min.js"]).toMatchObject({ tooLarge: "file", added: 1 });
  expect(f["b.txt"]!.hunks).toBeDefined();
  expect(f["c.txt"]!.hunks).toBeDefined();
});

test("CJK text: the answer stays inside a frame, measured in UTF-8 JSON", async () => {
  const d = repo();
  const text = (n: number) => Array.from({ length: 2500 }, (_, i) => `${n}:${i} ` + "漢字かなカナ한글".repeat(8)).join("\n") + "\n";
  for (let n = 0; n < 5; n++) writeFileSync(join(d, `t${n}.txt`), "old\n");
  sh(d, "add", ".");
  sh(d, "commit", "-qm", "cjk");
  for (let n = 0; n < 5; n++) writeFileSync(join(d, `t${n}.txt`), text(n));
  for (let n = 0; n < 5; n++) writeFileSync(join(d, `u${n}.txt`), text(n + 5));
  const r = await gitDiff(d, "uncommitted");
  expect(r.files.filter((f) => f.hunks).length).toBeGreaterThan(0);
  expect(r.files.filter((f) => f.tooLarge === "total").length).toBeGreaterThan(0);
  expect(utf8Length(JSON.stringify(r))).toBeLessThan(FRAME_BYTES_MAX);
  // Path order fills the budget: every shown file comes before every cut one.
  const firstCut = r.files.findIndex((f) => f.tooLarge === "total");
  expect(r.files.slice(firstCut).every((f) => !f.hunks)).toBe(true);
});

test("odd names: '-', a path both deleted and untracked, a name that isn't UTF-8", async () => {
  const d = repo();
  writeFileSync(join(d, "-"), "dash\n");
  sh(d, "rm", "-q", "--cached", "a.txt");
  writeFileSync(Buffer.from([...Buffer.from(join(d, "bad-")), 0xff, 0x2e, 0x74]), "x\n");
  const r = await gitDiff(d, "uncommitted");
  const dash = r.files.find((f) => f.path === "-");
  expect(dash!.hunks?.[0]!.lines).toEqual(["+dash"]);
  expect(r.files.filter((f) => f.path === "a.txt").map((f) => f.status).sort()).toEqual(["deleted", "untracked"]);
  const bad = r.files.find((f) => f.path.startsWith("bad-"));
  expect(bad).toMatchObject({ badPath: true });
  expect(bad!.hunks).toBeUndefined();
});

test("an untracked symlink (to a folder too) says where it points", async () => {
  const d = repo();
  mkdirSync(join(d, "real"));
  writeFileSync(join(d, "real", "x.txt"), "x\n");
  symlinkSync("real", join(d, "to-dir"));
  symlinkSync("a.txt", join(d, "to-file"));
  const f = byPath(await gitDiff(d, "uncommitted"));
  expect(f["to-dir"]).toMatchObject({ status: "untracked", symlink: "real" });
  expect(f["to-dir"]!.tooLarge).toBeUndefined();
  expect(f["to-file"]).toMatchObject({ symlink: "a.txt" });
});

test("a cut batch is asked again file by file only while the budget lasts", async () => {
  const d = repo();
  for (const n of ["a", "b", "c", "d"]) writeFileSync(join(d, `${n}.txt`), "x\n");
  sh(d, "add", ".");
  sh(d, "commit", "-qm", "four");
  writeFileSync(join(d, "a.txt"), "y".repeat(20_000) + "\n");
  for (const n of ["b", "c", "d"]) writeFileSync(join(d, `${n}.txt`), "z\n".repeat(30));
  const r = await gitDiff(d, "uncommitted", { fileBytes: 2000, totalBytes: 300 });
  expect(r.files.filter((f) => /^[abcd]\.txt$/.test(f.path)).map((f) => [f.path, f.tooLarge ?? "shown"])).toEqual([
    ["a.txt", "file"],
    ["b.txt", "shown"],
    ["c.txt", "total"],
    ["d.txt", "total"],
  ]);
});

test("out of time: the files not reached show their counts only", async () => {
  const d = repo();
  writeFileSync(join(d, "a.txt"), "x\n");
  const r = await gitDiff(d, "uncommitted", { timeMs: 0 });
  expect(r.timedOut).toBe(true);
  expect(r.files[0]).toMatchObject({ path: "a.txt", tooLarge: "total", added: 1 });
  writeFileSync(join(d, "new.txt"), "n\n");
  const u = await gitDiff(d, "uncommitted", { timeMs: 0 });
  expect(u.files.find((f) => f.path === "new.txt")).toMatchObject({ status: "untracked", tooLarge: "total" });
});

test("the gitDiff op: the session's folder, a bad scope refused", async () => {
  const d = repo();
  writeFileSync(join(d, "a.txt"), "x\n");
  const ops = new OpRegistry();
  const look = { summary: { projectPath: d } } as never;
  await gitModule.start({ ops, session: () => look, sessions: { open: async () => look } } as never);
  const r = await ops.handle("gitDiff", { sessionId: "s", scope: "uncommitted" });
  expect(r.ok && (r.data as { files: unknown[] }).files.length).toBe(1);
  expect(await ops.handle("gitDiff", { sessionId: "s", scope: "everything" })).toEqual({ ok: false, error: "Unknown diff scope." });
  expect(await ops.handle("gitDiff", { sessionId: 5, scope: "uncommitted" })).toEqual({ ok: false, error: "sessionId is required." });
});
