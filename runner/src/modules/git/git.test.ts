// The git module against real temporary repos: both scopes, untracked files, renames, binary files,
// the caps, a folder that isn't a repo, and that nothing in the repo changes.

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DIFF_FILE_LINES_MAX } from "../../../../shared/gitDiff";
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
  const r = await gitDiff(d, "uncommitted", { totalBytes: 500 });
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

test("the gitDiff op: the session's folder, a bad scope refused", async () => {
  const d = repo();
  writeFileSync(join(d, "a.txt"), "x\n");
  const ops = new OpRegistry();
  const look = { summary: { projectPath: d } } as never;
  await gitModule.start({ ops, session: () => look, sessions: { open: async () => look } } as never);
  const r = await ops.handle("gitDiff", { sessionId: "s", scope: "uncommitted" });
  expect(r.ok && (r.data as { files: unknown[] }).files.length).toBe(1);
  expect(await ops.handle("gitDiff", { sessionId: "s", scope: "everything" })).toEqual({ ok: false, error: "Unknown diff scope." });
});
