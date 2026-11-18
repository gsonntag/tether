// The Files tab's change marks against real temporary repos: modified, staged, untracked, renamed,
// deleted, a session folder deeper in the repo (relative paths, nothing from outside it), no repo,
// odd names, the cap, and the op.

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileChanges } from "../../../../shared/files";
import { EventBus } from "../../core/bus";
import { OpRegistry } from "../../core/ops";
import { fileChanges, parseStatus } from "./changes";
import { realRoot } from "./fs";
import { filesModule } from ".";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "tether-changes-"));
  dirs.push(d);
  return d;
};
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const sh = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
};
const write = (d: string, p: string, text = `${p}\n`) => {
  mkdirSync(join(d, p, ".."), { recursive: true });
  writeFileSync(join(d, p), text);
};

/** A repo with a commit: top.txt, keep.txt, gone.txt, old name.txt, sub/a.txt, sub/b.txt, sub/deep/c.txt. */
function repo() {
  const d = temp();
  sh(d, "init", "-q", "-b", "main");
  for (const p of ["top.txt", "keep.txt", "gone.txt", "old name.txt", "sub/a.txt", "sub/b.txt", "sub/deep/c.txt", "sub/unstage.txt"]) write(d, p, `${p} has some lines\nthat stay the same\nso renames are found\n`);
  write(d, ".gitignore", "*.log\n");
  sh(d, "add", "-A");
  sh(d, "-c", "user.name=T", "-c", "user.email=t@t", "commit", "-qm", "one");
  return d;
}

test("modified, staged, untracked, renamed, deleted; ignored never", async () => {
  const d = repo();
  write(d, "top.txt", "changed\n");
  write(d, "sub/deep/c.txt", "staged change\n");
  sh(d, "add", "sub/deep/c.txt");
  write(d, "new file.txt");
  write(d, "newdir/x/y.txt");
  write(d, "staged-new.txt");
  sh(d, "add", "staged-new.txt");
  sh(d, "mv", "old name.txt", "sub/new name.txt");
  unlinkSync(join(d, "gone.txt"));
  write(d, "debug.log");
  sh(d, "rm", "-q", "--cached", "sub/unstage.txt");
  const c = await fileChanges(await realRoot(d));
  expect(c).toEqual({
    repo: true,
    files: {
      "top.txt": "modified",
      "sub/deep/c.txt": "modified",
      "new file.txt": "untracked",
      // an untracked folder is one path (git's normal listing)
      newdir: "untracked",
      "staged-new.txt": "added",
      "sub/new name.txt": "renamed",
      "old name.txt": "deleted",
      "gone.txt": "deleted",
      // deleted in the index, still there untracked: shown as untracked
      "sub/unstage.txt": "untracked",
    },
    folders: ["newdir"],
  });
});

test("a session folder deeper in the repo: its own changes, relative to it, nothing from outside", async () => {
  const d = repo();
  write(d, "top.txt", "changed\n");
  write(d, "sub/a.txt", "changed\n");
  write(d, "sub/deep/new.txt");
  sh(d, "mv", "keep.txt", "sub/moved-in.txt");
  sh(d, "mv", "sub/b.txt", "moved-out.txt");
  // moved in from outside: renamed, its old path (outside) not said; moved out: deleted here
  const c = await fileChanges(await realRoot(join(d, "sub")));
  expect(c).toEqual({ repo: true, files: { "a.txt": "modified", "deep/new.txt": "untracked", "moved-in.txt": "renamed", "b.txt": "deleted" } });
});

test("no repo: no marks; a clean repo: none either", async () => {
  const d = temp();
  write(d, "a.txt");
  expect(await fileChanges(await realRoot(d))).toEqual({ repo: false, files: {} });
  expect(await fileChanges(await realRoot(repo()))).toEqual({ repo: true, files: {} });
});

test("a nested repo is one untracked folder", async () => {
  const d = repo();
  const n = join(d, "nested");
  mkdirSync(n);
  sh(n, "init", "-q");
  write(n, "inner.txt");
  expect(await fileChanges(await realRoot(d))).toEqual({ repo: true, files: { nested: "untracked" }, folders: ["nested"] });
});

test("parse: renames and copies, unmerged, spaces, the cap, a cut last record", () => {
  const h = "100644 100644 100644 aaaa bbbb";
  const u = "100644 100644 100644 100644 a b c";
  const out = [
    `1 .M N... ${h} a b.txt`,
    `2 R. N... ${h} R100 x/new.txt`,
    "x/old.txt",
    `2 C. N... ${h} C90 copy.txt`,
    "orig.txt",
    `u UU N... ${u} conflict.txt`,
    `u DD N... ${u} both-gone.txt`,
    `1 .M S.M. 160000 160000 160000 a b mod`,
    "? dir/",
    "! ignored.txt",
    "",
  ].join("\0");
  expect(parseStatus(out, "")).toEqual({
    repo: true,
    files: { "a b.txt": "modified", "x/new.txt": "renamed", "x/old.txt": "deleted", "copy.txt": "added", "conflict.txt": "conflict", "both-gone.txt": "deleted", mod: "modified", dir: "untracked" },
    folders: ["mod", "dir"],
  });
  // a worktree rename (after an intent to add) also leaves its old path deleted
  expect(parseStatus([`2 .R N... ${h} R100 b.txt`, "a.txt", ""].join("\0"), "").files).toEqual({ "b.txt": "renamed", "a.txt": "deleted" });
  // a folder whose own name isn't UTF-8 keeps its marks; only names under it that aren't are dropped
  expect(parseStatus("? f\ufffd/x.txt\0? f\ufffd/\ufffd.txt\0", "f\ufffd/").files).toEqual({ "x.txt": "untracked" });
  // under a prefix: only what's in it, without it
  expect(parseStatus(out, "x/").files).toEqual({ "new.txt": "renamed", "old.txt": "deleted" });
  expect(parseStatus(out, "", false, 2)).toEqual({ repo: true, files: { "a b.txt": "modified", "x/new.txt": "renamed" }, cut: true });
  expect(parseStatus("? one.txt\0? two.t", "", true)).toEqual({ repo: true, files: { "one.txt": "untracked" }, cut: true });
});

test("intent to add, a worktree rename, a conflict", async () => {
  const d = repo();
  const commit = (m: string) => sh(d, "-c", "user.name=T", "-c", "user.email=t@t", "commit", "-qam", m);
  // a conflict: both sides change top.txt
  sh(d, "checkout", "-q", "-b", "other");
  write(d, "top.txt", "other\n");
  commit("other");
  sh(d, "checkout", "-q", "main");
  write(d, "top.txt", "main\n");
  commit("main");
  Bun.spawnSync(["git", "-c", "user.name=T", "-c", "user.email=t@t", "merge", "-q", "other"], { cwd: d, env, stdout: "pipe", stderr: "pipe" });
  // an intent to add (.A)
  write(d, "ita.txt");
  sh(d, "add", "-N", "ita.txt");
  // moved by hand, the new name intended to add: a rename in the worktree (.R)
  sh(d, "mv", "keep.txt", "kept.txt");
  sh(d, "reset", "-q", "--", "keep.txt", "kept.txt");
  sh(d, "add", "-N", "kept.txt");
  expect((await fileChanges(await realRoot(d))).files).toEqual({ "ita.txt": "added", "kept.txt": "renamed", "keep.txt": "deleted", "top.txt": "conflict" });
});

test("status.showUntrackedFiles=no is honoured; a huge untracked folder is one path", async () => {
  const d = repo();
  mkdirSync(join(d, "big"));
  for (let i = 0; i < 3000; i++) writeFileSync(join(d, "big", `f${i}.txt`), "x");
  write(d, "top.txt", "changed\n");
  expect(await fileChanges(await realRoot(d))).toEqual({ repo: true, files: { "top.txt": "modified", big: "untracked" }, folders: ["big"] });
  sh(d, "config", "status.showUntrackedFiles", "no");
  expect(await fileChanges(await realRoot(d))).toEqual({ repo: true, files: { "top.txt": "modified" } });
});

test("git's output past its byte cap: what came before, cut", async () => {
  const d = repo();
  for (let i = 0; i < 50; i++) write(d, `n${String(i).padStart(2, "0")}.txt`);
  const c = await fileChanges(await realRoot(d), { maxBytes: 100 });
  expect(c.cut).toBe(true);
  // "? n00.txt\0" is 10 bytes: ten whole records fit, none half
  expect(Object.keys(c.files)).toEqual(Array.from({ length: 10 }, (_, i) => `n0${i}.txt`));
});

test("the op answers for the session's folder", async () => {
  const d = repo();
  write(d, "top.txt", "changed\n");
  const ops = new OpRegistry();
  const look = { summary: { projectPath: d } } as never;
  await filesModule.start({ ops, bus: new EventBus(), dataDir: temp(), log: () => {}, session: () => look, sessions: { open: async () => look, list: () => [] } } as never);
  const r = await ops.handle("fileChanges", { sessionId: "s" });
  expect(r.ok && (r.data as FileChanges)).toEqual({ repo: true, files: { "top.txt": "modified" } });
  expect(await ops.handle("fileChanges", {})).toEqual({ ok: false, error: "sessionId is required." });
});
