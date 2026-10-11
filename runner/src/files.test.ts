import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshot } from "./checkpoint";
import { checkPaths, fileDiff, readProjectFile, resolveInProject } from "./files";
import type { Checkpoint } from "../../web/src/shared/protocol";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function sh(cwd: string, ...args: string[]) {
  const p = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  if (p.exitCode !== 0) throw new Error(p.stderr.toString());
  return p.stdout.toString();
}

const tmp = (prefix: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
};

/** A repo with src/a.ts (5 lines), README.md and gone.txt committed, plus a secret outside it. */
function repo() {
  const dir = tmp("tether-files-");
  sh(dir, "init", "-q", "-b", "main");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src/a.ts"), "one\ntwo\nthree\nfour\nfive\n");
  writeFileSync(join(dir, "README.md"), "# hi\n");
  writeFileSync(join(dir, "gone.txt"), "bye\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-q", "-m", "init");
  return dir;
}

describe("resolveInProject (path safety)", () => {
  const dir = repo();
  const outside = tmp("tether-outside-");
  writeFileSync(join(outside, "secret.txt"), "secret\n");
  symlinkSync(join(outside, "secret.txt"), join(dir, "leak.txt"));
  symlinkSync(outside, join(dir, "linkdir"));
  symlinkSync(join(dir, "src/a.ts"), join(dir, "alias.ts"));

  test("relative, ./ and absolute paths inside the project", () => {
    expect(resolveInProject(dir, "src/a.ts")).toMatchObject({ rel: "src/a.ts", exists: true });
    expect(resolveInProject(dir, "./src/a.ts")).toMatchObject({ rel: "src/a.ts", exists: true });
    expect(resolveInProject(dir, "src/../README.md")).toMatchObject({ rel: "README.md", exists: true });
    expect(resolveInProject(dir, join(dir, "src/a.ts"))).toMatchObject({ rel: "src/a.ts", exists: true });
    expect(resolveInProject(dir, "src/new.ts")).toMatchObject({ rel: "src/new.ts", exists: false });
  });

  test("never outside the project: .., absolute elsewhere, the root itself", () => {
    expect(resolveInProject(dir, "../x")).toBeUndefined();
    expect(resolveInProject(dir, "src/../../x")).toBeUndefined();
    expect(resolveInProject(dir, join(outside, "secret.txt"))).toBeUndefined();
    expect(resolveInProject(dir, "/etc/passwd")).toBeUndefined();
    expect(resolveInProject(dir, dir)).toBeUndefined();
    expect(resolveInProject(dir, ".")).toBeUndefined();
    expect(resolveInProject(dir, "")).toBeUndefined();
    expect(resolveInProject(dir, "src/a.ts\0")).toBeUndefined();
  });

  test("symlinks that escape the project are refused; ones that stay inside are fine", () => {
    expect(resolveInProject(dir, "leak.txt")).toBeUndefined();
    expect(resolveInProject(dir, "linkdir/secret.txt")).toBeUndefined();
    expect(resolveInProject(dir, "linkdir/not-there.txt")).toBeUndefined();
    expect(resolveInProject(dir, "alias.ts")).toMatchObject({ rel: "alias.ts", exists: true, real: join(dir, "src/a.ts") });
  });

  test(".git internals are refused", () => {
    expect(resolveInProject(dir, ".git/config")).toBeUndefined();
    expect(resolveInProject(dir, ".git")).toBeUndefined();
    expect(resolveInProject(dir, "./.git/HEAD")).toBeUndefined();
    expect(resolveInProject(dir, "sub/.git/HEAD")).toBeUndefined();
    expect(resolveInProject(dir, ".GIT/config")).toBeUndefined();
    symlinkSync(join(dir, ".git/config"), join(dir, "gitcfg"));
    expect(resolveInProject(dir, "gitcfg")).toBeUndefined();
    // .gitignore and friends are ordinary files
    writeFileSync(join(dir, ".gitignore"), "*.log\n");
    expect(resolveInProject(dir, ".gitignore")).toMatchObject({ rel: ".gitignore", exists: true });
  });

  test("a project directory reached through a symlink", () => {
    const via = join(tmp("tether-via-"), "proj");
    symlinkSync(dir, via);
    expect(resolveInProject(via, "src/a.ts")).toMatchObject({ rel: "src/a.ts", exists: true });
    expect(resolveInProject(via, join(dir, "src/a.ts"))).toMatchObject({ rel: "src/a.ts" });
    expect(resolveInProject(via, join(via, "src/a.ts"))).toMatchObject({ rel: "src/a.ts" });
    expect(resolveInProject(via, "leak.txt")).toBeUndefined();
  });
});

describe("checkPaths", () => {
  test("files that exist or changed in the session, keyed by the path as asked", async () => {
    const dir = repo();
    const base = (await snapshot(dir, "refs/tether/checkpoints/t/1", "turn 1"))!;
    unlinkSync(join(dir, "gone.txt"));
    writeFileSync(join(dir, "src/a.ts"), "one\nTWO\nthree\nfour\nfive\n");
    const r = await checkPaths(dir, ["src/a.ts", "./README.md", "gone.txt", "src", "and/or", "nope.ts", "../etc/passwd", "/etc/passwd", join(dir, "src/a.ts"), ".git/config"], base);
    expect(r["src/a.ts"]).toEqual({ path: "src/a.ts", exists: true, changed: true });
    expect(r["./README.md"]).toEqual({ path: "README.md", exists: true, changed: false });
    expect(r["gone.txt"]).toEqual({ path: "gone.txt", exists: false, changed: true });
    expect(r[join(dir, "src/a.ts")]).toEqual({ path: "src/a.ts", exists: true, changed: true });
    // directories, prose, missing files, outside paths and .git aren't links
    expect(Object.keys(r).sort()).toEqual(["./README.md", join(dir, "src/a.ts"), "gone.txt", "src/a.ts"].sort());
  });

  test("outside a git repository: existing files only", async () => {
    const dir = tmp("tether-nogit-");
    writeFileSync(join(dir, "x.py"), "print(1)\n");
    expect(await checkPaths(dir, ["x.py", "y.py"])).toEqual({ "x.py": { path: "x.py", exists: true, changed: false } });
  });
});

describe("readProjectFile", () => {
  const dir = repo();
  test("reads a file, relative to the project", () => {
    expect(readProjectFile(dir, "./src/a.ts")).toEqual({ path: "src/a.ts", size: 24, content: "one\ntwo\nthree\nfour\nfive\n" });
  });
  test("binary files come back without content", () => {
    writeFileSync(join(dir, "img.bin"), Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]));
    expect(readProjectFile(dir, "img.bin")).toEqual({ path: "img.bin", size: 5, binary: true });
  });
  test("capped by bytes and by lines", () => {
    writeFileSync(join(dir, "big.txt"), "x".repeat(100) + "\n" + "y".repeat(100));
    const r = readProjectFile(dir, "big.txt", 50);
    expect(r).toMatchObject({ truncated: "bytes", size: 201 });
    expect(r.content).toBe("x".repeat(50));
    writeFileSync(join(dir, "long.txt"), Array.from({ length: 25_000 }, (_, i) => `line ${i + 1}`).join("\n"));
    const l = readProjectFile(dir, "long.txt");
    expect(l.truncated).toBe("lines");
    expect(l.content!.split("\n").filter(Boolean).length).toBe(20_000);
    // never more than 1 MB, whatever is asked
    writeFileSync(join(dir, "huge.txt"), "z".repeat(1024 * 1024 + 10));
    expect(readProjectFile(dir, "huge.txt", 10 * 1024 * 1024).content!.length).toBe(1024 * 1024);
  });
  test("refuses paths outside the project, .git, symlink escapes, directories and missing files", () => {
    const outside = tmp("tether-outside2-");
    writeFileSync(join(outside, "s.txt"), "s\n");
    symlinkSync(join(outside, "s.txt"), join(dir, "esc.txt"));
    expect(() => readProjectFile(dir, "../x")).toThrow();
    expect(() => readProjectFile(dir, join(outside, "s.txt"))).toThrow();
    expect(() => readProjectFile(dir, "esc.txt")).toThrow();
    expect(() => readProjectFile(dir, ".git/config")).toThrow();
    expect(() => readProjectFile(dir, "src")).toThrow();
    expect(() => readProjectFile(dir, "missing.ts")).toThrow();
  });
});

describe("fileDiff", () => {
  async function session() {
    const dir = repo();
    const cps: Checkpoint[] = [];
    const take = async (id: string) => {
      const sha = (await snapshot(dir, `refs/tether/checkpoints/t/${id}`, id, cps[cps.length - 1]?.sha))!;
      cps.push({ id, sha, ts: cps.length, label: `prompt ${id}` });
    };
    await take("c1");
    writeFileSync(join(dir, "src/a.ts"), "one\nTWO\nthree\nfour\nfive\n");
    await take("c2");
    writeFileSync(join(dir, "README.md"), "# hello\n");
    await take("c3");
    writeFileSync(join(dir, "src/a.ts"), "one\nTWO\nthree\nfour\nFIVE\nsix\n");
    return { dir, cps };
  }

  test("the whole session for one file, with the turns that changed it", async () => {
    const { dir, cps } = await session();
    const d = await fileDiff(dir, "./src/a.ts", cps[0]!.sha, cps);
    expect(d).toMatchObject({ path: "src/a.ts", exists: true, base: "session" });
    expect(d.file).toMatchObject({ path: "src/a.ts", status: "modified", additions: 3, deletions: 2 });
    expect(d.file!.patch).toContain("-two\n+TWO");
    expect(d.file!.patch).toContain("+six");
    expect(d.turns.map((t) => [t.checkpoint, t.index, t.additions, t.deletions])).toEqual([
      ["c1", 0, 1, 1],
      ["c3", 2, 2, 1],
    ]);
  });

  test("one turn, and a file unchanged in that turn", async () => {
    const { dir, cps } = await session();
    const t1 = await fileDiff(dir, "src/a.ts", cps[0]!.sha, cps, "c1");
    expect(t1.file).toMatchObject({ additions: 1, deletions: 1 });
    expect(t1.file!.patch).not.toContain("six");
    const t2 = await fileDiff(dir, "src/a.ts", cps[0]!.sha, cps, "c2");
    expect(t2.file).toBeUndefined();
    const readme = await fileDiff(dir, "README.md", cps[0]!.sha, cps, "c2");
    expect(readme.file).toMatchObject({ additions: 1, deletions: 1 });
    await expect(fileDiff(dir, "src/a.ts", cps[0]!.sha, cps, "nope")).rejects.toThrow();
  });

  test("a file the session never touched, and paths outside the project", async () => {
    const { dir, cps } = await session();
    writeFileSync(join(dir, "other.txt"), "x\n");
    sh(dir, "add", "other.txt");
    sh(dir, "commit", "-q", "-m", "other");
    const d = await fileDiff(dir, "gone.txt", cps[0]!.sha, cps);
    expect(d).toMatchObject({ path: "gone.txt", exists: true, turns: [] });
    expect(d.file).toBeUndefined();
    await expect(fileDiff(dir, "../x", cps[0]!.sha, cps)).rejects.toThrow();
    await expect(fileDiff(dir, ".git/config", cps[0]!.sha, cps)).rejects.toThrow();
  });

  test("a project in a subdirectory of the repository uses project-relative paths", async () => {
    const top = repo();
    mkdirSync(join(top, "pkg"));
    writeFileSync(join(top, "pkg/b.ts"), "b\n");
    sh(top, "add", "-A");
    sh(top, "commit", "-q", "-m", "pkg");
    const proj = join(top, "pkg");
    const sha = (await snapshot(proj, "refs/tether/checkpoints/t/s1", "s1"))!;
    const cps: Checkpoint[] = [{ id: "s1", sha, ts: 0, label: "x" }];
    writeFileSync(join(proj, "b.ts"), "b\nc\n");
    const d = await fileDiff(proj, "b.ts", sha, cps);
    expect(d.file).toMatchObject({ path: "b.ts", additions: 1, deletions: 0 });
    expect(d.turns).toHaveLength(1);
    expect(await checkPaths(proj, ["b.ts", "src/a.ts"], sha)).toEqual({ "b.ts": { path: "b.ts", exists: true, changed: true } });
  });

  test("a path with pathspec magic is taken literally", async () => {
    const { dir, cps } = await session();
    writeFileSync(join(dir, ":(glob)x.ts"), "x\n");
    const d = await fileDiff(dir, ":(glob)x.ts", cps[0]!.sha, cps);
    expect(d.file).toMatchObject({ path: ":(glob)x.ts", status: "added" });
  });
});
