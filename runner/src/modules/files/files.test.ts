// The files module against real temporary folders: only inside the session's folder (traversal,
// absolute paths, links out, loops, NUL, long and odd names), .gitignore and the hidden toggle, the
// caps, binary detection, images under the frame limit, and the filter.

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DIR_ENTRIES_MAX, FILE_VIEW_MAX, type DirList, type FileRead } from "../../../../shared/files";
import { FRAME_BYTES_MAX, utf8Length } from "../../../../shared/limits";
import { EventBus } from "../../core/bus";
import { OpRegistry } from "../../core/ops";
import { Finder } from "./find";
import { listDir, readFile, realRoot } from "./fs";
import { filesModule } from ".";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "tether-files-"));
  dirs.push(d);
  return d;
};
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const sh = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
};
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6364f8cf00000301010018dd8db40000000049454e44ae426082", "hex");

/** A folder with a bit of everything, and a secret next to it (outside). */
function folder() {
  const base = temp();
  const d = join(base, "proj");
  mkdirSync(d);
  writeFileSync(join(base, "secret.txt"), "outside!\n");
  mkdirSync(join(base, "outdir"));
  writeFileSync(join(base, "outdir", "x.txt"), "outside too\n");
  writeFileSync(join(d, "README.md"), "# Hi\n\nSome *text*.\n");
  writeFileSync(join(d, ".env"), "TOKEN=abc\n");
  mkdirSync(join(d, "src"));
  writeFileSync(join(d, "src", "app.ts"), "export const a = 1;\n");
  writeFileSync(join(d, "src", "ünï 文件.txt"), "unicode\n");
  writeFileSync(join(d, "logo.png"), PNG);
  writeFileSync(join(d, "fake.png"), "not an image\n");
  writeFileSync(join(d, "pic.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  writeFileSync(join(d, "blob.bin"), Buffer.from([1, 2, 0, 3, 4]));
  writeFileSync(join(d, "latin1.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
  mkdirSync(join(d, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(d, "node_modules", "pkg", "index.js"), "x\n");
  symlinkSync(join(base, "secret.txt"), join(d, "out-file"));
  symlinkSync(join(base, "outdir"), join(d, "out-dir"));
  symlinkSync("../secret.txt", join(d, "out-rel"));
  symlinkSync("src/app.ts", join(d, "in-file"));
  symlinkSync("src", join(d, "in-dir"));
  symlinkSync("loop-b", join(d, "loop-a"));
  symlinkSync("loop-a", join(d, "loop-b"));
  symlinkSync("nowhere", join(d, "broken"));
  return { base, d };
}

const names = (l: DirList) => l.entries.map((e) => e.name);

test("refuses anything outside the folder", async () => {
  const { d } = folder();
  const root = await realRoot(d);
  for (const p of ["../secret.txt", "src/../../secret.txt", "/etc/passwd", join(d, "README.md"), "~/x", "a\0b", "src/./app.ts", "src//app.ts"])
    await expect(readFile(root, p)).rejects.toThrow();
  // Links that point out: listed, never read through, neither file nor folder.
  await expect(readFile(root, "out-file")).rejects.toThrow("outside the session's folder");
  await expect(readFile(root, "out-rel")).rejects.toThrow("outside the session's folder");
  await expect(readFile(root, "out-dir/x.txt")).rejects.toThrow("outside the session's folder");
  await expect(listDir(root, "out-dir", true)).rejects.toThrow("outside the session's folder");
  await expect(readFile(root, "loop-a")).rejects.toThrow("loops");
  await expect(readFile(root, "broken")).rejects.toThrow("isn't there");
  await expect(readFile(root, "x".repeat(300))).rejects.toThrow();
  await expect(readFile(root, "")).rejects.toThrow("isn't a file");
  await expect(listDir(root, "README.md", true)).rejects.toThrow("isn't a folder");
  // Links that stay inside are their targets.
  expect(await readFile(root, "in-file")).toMatchObject({ kind: "text", text: "export const a = 1;\n" });
  expect(names(await listDir(root, "in-dir", false))).toContain("app.ts");
});

test("lists links as links, saying where they point", async () => {
  const { d } = folder();
  const l = await listDir(await realRoot(d), "", true);
  const by = Object.fromEntries(l.entries.map((e) => [e.name, e]));
  expect(by["out-file"]).toMatchObject({ kind: "link", to: "outside" });
  expect(by["out-dir"]).toMatchObject({ kind: "link", to: "outside" });
  expect(by["in-file"]).toMatchObject({ kind: "link", to: "file" });
  expect(by["in-dir"]).toMatchObject({ kind: "link", to: "dir" });
  expect(by["loop-a"]).toMatchObject({ kind: "link", to: "broken" });
  expect(by["broken"]).toMatchObject({ kind: "link", to: "broken" });
  expect(by["README.md"]).toMatchObject({ kind: "file", size: 19 });
  // Folders (and links to folders inside) first.
  expect(names(l).slice(0, 3)).toEqual(["in-dir", "node_modules", "src"]);
  expect(l.repo).toBe(false);
});

test("the session folder itself may be a link", async () => {
  const { base, d } = folder();
  symlinkSync(d, join(base, "via-link"));
  const root = await realRoot(join(base, "via-link"));
  expect(names(await listDir(root, "src", false))).toContain("app.ts");
  await expect(readFile(root, "out-file")).rejects.toThrow("outside");
});

test("hidden: dot files and heavy folders only with the toggle (outside a repo)", async () => {
  const { d } = folder();
  const root = await realRoot(d);
  const off = names(await listDir(root, "", false));
  expect(off).not.toContain(".env");
  expect(off).not.toContain("node_modules");
  const on = await listDir(root, "", true);
  expect(names(on)).toContain(".env");
  expect(on.entries.find((e) => e.name === "node_modules")).toMatchObject({ kind: "dir", ignored: true });
  // .env isn't blocked: it's the person's own machine.
  expect(await readFile(root, ".env")).toMatchObject({ kind: "text", text: "TOKEN=abc\n" });
});

test("in a repo: .gitignore decides, .git is never listed, tracked files that match still show", async () => {
  const { d } = folder();
  sh(d, "init", "-q");
  writeFileSync(join(d, ".gitignore"), "build/\n*.log\nnode_modules\n");
  mkdirSync(join(d, "build"));
  writeFileSync(join(d, "build", "out.js"), "x\n");
  writeFileSync(join(d, "debug.log"), "x\n");
  writeFileSync(join(d, "kept.log"), "x\n");
  writeFileSync(join(d, ":(glob)odd"), "x\n");
  sh(d, "add", "-f", "kept.log");
  const root = await realRoot(d);
  const off = await listDir(root, "", false);
  expect(off.repo).toBe(true);
  expect(names(off)).not.toContain("build");
  expect(names(off)).not.toContain("debug.log");
  expect(names(off)).not.toContain("node_modules");
  expect(names(off)).toContain("kept.log");
  expect(names(off)).toContain(":(glob)odd");
  expect(names(off)).not.toContain(".git");
  const on = await listDir(root, "", true);
  expect(on.entries.find((e) => e.name === "build")).toMatchObject({ ignored: true });
  expect(on.entries.find((e) => e.name === "debug.log")).toMatchObject({ ignored: true });
  expect(names(on)).not.toContain(".git");
  // In an ignored folder, listed with the toggle.
  expect(names(await listDir(root, "build", true))).toEqual(["out.js"]);
});

test("names: unicode, very long, not UTF-8", async () => {
  const { d } = folder();
  const root = await realRoot(d);
  expect(await readFile(root, "src/ünï 文件.txt")).toMatchObject({ kind: "text", text: "unicode\n" });
  const long = "l".repeat(250);
  writeFileSync(join(d, long), "long\n");
  expect(await readFile(root, long)).toMatchObject({ kind: "text" });
  // A name that isn't UTF-8 is listed, marked, and can't be opened by any string.
  Bun.spawnSync(["python3", "-c", `open(b'${d}/bad\\xff\\xfe.txt','w').write('x')`]);
  const bad = (await listDir(root, "", false)).entries.find((e) => e.name.startsWith("bad"));
  expect(bad).toMatchObject({ badName: true });
  await expect(readFile(root, bad!.name)).rejects.toThrow();
});

test("text, binary, images, sizes", async () => {
  const { d } = folder();
  const root = await realRoot(d);
  expect(await readFile(root, "README.md")).toEqual({ path: "README.md", size: 19, kind: "text", text: "# Hi\n\nSome *text*.\n" });
  expect(await readFile(root, "blob.bin")).toEqual({ path: "blob.bin", size: 5, kind: "binary" });
  expect((await readFile(root, "latin1.txt")).kind).toBe("binary");
  expect(await readFile(root, "logo.png")).toEqual({ path: "logo.png", size: PNG.length, kind: "image", mime: "image/png", data: PNG.toString("base64") });
  // Named .png but text: shown as text.
  expect(await readFile(root, "fake.png")).toMatchObject({ kind: "text" });
  // SVG travels as an image (the browser shows it as an <img>, where scripts never run).
  expect(await readFile(root, "pic.svg")).toMatchObject({ kind: "image", mime: "image/svg+xml" });

  // Over 1 MB: the size only, unless the head is asked for (text).
  const big = "line of text\n".repeat(Math.ceil((FILE_VIEW_MAX * 1.5) / 13));
  writeFileSync(join(d, "big.txt"), big);
  expect(await readFile(root, "big.txt")).toEqual({ path: "big.txt", size: big.length, kind: "tooBig" });
  const head = await readFile(root, "big.txt", { head: true });
  expect(head).toMatchObject({ kind: "text", cut: true, size: big.length });
  expect((head as { text: string }).text.length).toBe(FILE_VIEW_MAX);
  // A cut that splits a character leaves it out.
  writeFileSync(join(d, "wide.txt"), "é".repeat(FILE_VIEW_MAX));
  const w = (await readFile(root, "wide.txt", { head: true })) as { text: string };
  expect(w.text).toBe("é".repeat(FILE_VIEW_MAX / 2));
  // maxBytes lowers the cap, never raises it.
  expect(await readFile(root, "README.md", { maxBytes: 4 })).toMatchObject({ kind: "tooBig" });
  expect(await readFile(root, "big.txt", { maxBytes: 10 * FILE_VIEW_MAX })).toMatchObject({ kind: "tooBig" });

  // The biggest image allowed travels well under the frame limit.
  writeFileSync(join(d, "huge.png"), Buffer.concat([PNG, Buffer.alloc(FILE_VIEW_MAX - PNG.length, 7)]));
  const img = await readFile(root, "huge.png");
  expect(img.kind).toBe("image");
  expect(utf8Length(JSON.stringify({ t: "result", id: "x", ok: true, data: img }))).toBeLessThan(FRAME_BYTES_MAX);
  writeFileSync(join(d, "huger.png"), Buffer.concat([PNG, Buffer.alloc(FILE_VIEW_MAX, 7)]));
  expect(await readFile(root, "huger.png")).toMatchObject({ kind: "tooBig" });

  // Text of control characters (6 JSON bytes each) is binary rather than a frame too big to send.
  writeFileSync(join(d, "ctl.txt"), "\u0001".repeat(FILE_VIEW_MAX));
  expect((await readFile(root, "ctl.txt")).kind).toBe("binary");
  const t = await readFile(root, "big.txt", { head: true });
  expect(utf8Length(JSON.stringify({ t: "result", id: "x", ok: true, data: t }))).toBeLessThan(FRAME_BYTES_MAX);
});

test("a FIFO neither blocks nor reads", async () => {
  const { d } = folder();
  Bun.spawnSync(["mkfifo", join(d, "pipe")]);
  const root = await realRoot(d);
  await expect(readFile(root, "pipe")).rejects.toThrow("isn't a file");
  expect((await listDir(root, "", false)).entries.find((e) => e.name === "pipe")).toMatchObject({ kind: "other" });
});

test("a folder past the cap lists DIR_ENTRIES_MAX and counts the rest", async () => {
  const d = temp();
  for (let i = 0; i < DIR_ENTRIES_MAX + 25; i++) writeFileSync(join(d, `f${i}`), "");
  const l = await listDir(await realRoot(d), "", false);
  expect(l.entries.length).toBe(DIR_ENTRIES_MAX);
  expect(l.more).toBe(25);
});

test("find: git's list in a repo (ignored never, dot files with the toggle)", async () => {
  const { d } = folder();
  sh(d, "init", "-q");
  writeFileSync(join(d, ".gitignore"), "node_modules\nsecret-*.txt\n");
  writeFileSync(join(d, "secret-key.txt"), "x\n");
  mkdirSync(join(d, ".github"));
  writeFileSync(join(d, ".github", "app-ci.yml"), "x\n");
  const root = await realRoot(d);
  const f = new Finder();
  const r = await f.find(root, "app", false);
  expect(r.paths[0]).toBe("src/app.ts");
  expect(r.paths).not.toContain(".github/app-ci.yml");
  expect((await f.find(root, "app", true)).paths).toContain(".github/app-ci.yml");
  expect((await f.find(root, "secret", true)).paths).toEqual([]);
  expect((await f.find(root, "index.js", true)).paths).toEqual([]);
  expect((await f.find(root, "  ", true)).paths).toEqual([]);
});

test("find: a walk outside a repo, never through links or heavy folders", async () => {
  const { d } = folder();
  const f = new Finder();
  const root = await realRoot(d);
  const r = await f.find(root, "x.txt", true);
  // out-dir/x.txt is outside, behind a link: never found.
  expect(r.paths).toEqual([]);
  expect((await f.find(root, "index", true)).paths).toEqual([]);
  expect((await f.find(root, "app", false)).paths).toEqual(["src/app.ts"]);
  expect((await f.find(root, "env", false)).paths).toEqual([]);
  expect((await f.find(root, "env", true)).paths).toEqual([".env"]);
});

test("find: the list is kept a few seconds", async () => {
  const d = temp();
  writeFileSync(join(d, "one.txt"), "");
  let now = 0;
  const f = new Finder(() => now);
  const root = await realRoot(d);
  expect((await f.find(root, "txt", false)).paths).toEqual(["one.txt"]);
  writeFileSync(join(d, "two.txt"), "");
  expect((await f.find(root, "txt", false)).paths).toEqual(["one.txt"]);
  now = 6000;
  expect((await f.find(root, "txt", false)).paths).toEqual(["one.txt", "two.txt"]);
});

test("the ops: the session's folder, checked args", async () => {
  const { d } = folder();
  const ops = new OpRegistry();
  const look = { summary: { projectPath: d } } as never;
  await filesModule.start({ ops, bus: new EventBus(), dataDir: temp(), log: () => {}, session: () => look, sessions: { open: async () => look, list: () => [] } } as never);
  const l = await ops.handle("listDir", { sessionId: "s", path: "src" });
  expect(l.ok && (l.data as DirList).entries.map((e) => e.name).sort()).toEqual(["app.ts", "ünï 文件.txt"]);
  const r = await ops.handle("readFile", { sessionId: "s", path: "README.md" });
  expect(r.ok && (r.data as FileRead).kind).toBe("text");
  expect(await ops.handle("readFile", { sessionId: "s", path: "../secret.txt" })).toEqual({ ok: false, error: "Only paths inside the session's folder." });
  expect(await ops.handle("readFile", { sessionId: "", path: "README.md" })).toEqual({ ok: false, error: "sessionId is required." });
  expect(await ops.handle("findFiles", { sessionId: "s" })).toEqual({ ok: false, error: "query is required." });
  const f = await ops.handle("findFiles", { sessionId: "s", query: "readme" });
  expect(f.ok && f.data).toEqual({ paths: ["README.md"], more: false });
});

test("a link swapped in on the path while reading is refused by the handle (Linux)", async () => {
  if (process.platform !== "linux") return;
  const base = temp();
  const d = join(base, "root");
  mkdirSync(join(d, "sub"), { recursive: true });
  writeFileSync(join(d, "sub", "f.txt"), "inside\n");
  mkdirSync(join(base, "outside", "secretdir"), { recursive: true });
  writeFileSync(join(base, "outside", "secretdir", "f.txt"), "SECRET\n");
  writeFileSync(join(base, "outside", "secretdir", "hidden-name.txt"), "x\n");
  // Swaps sub for a link out and back, as fast as it can, for 2.5 s.
  const swap = Bun.spawn(
    ["python3", "-c", "import os,sys,time\nos.chdir(sys.argv[1])\nend=time.time()+2.5\nwhile time.time()<end:\n  os.rename('sub','subx'); os.symlink('../outside/secretdir','sub'); os.unlink('sub'); os.rename('subx','sub')", d],
    { stdout: "ignore", stderr: "ignore" },
  );
  const root = await realRoot(d);
  let leaks = 0;
  let tries = 0;
  const end = Date.now() + 2200;
  while (Date.now() < end) {
    tries++;
    try {
      if ((await listDir(root, "sub", true)).entries.some((e) => e.name === "hidden-name.txt")) leaks++;
    } catch {}
    try {
      const r = await readFile(root, "sub/f.txt");
      if (r.kind === "text" && r.text.includes("SECRET")) leaks++;
    } catch {}
    try {
      if ((await new Finder(() => tries * 10_000).find(root, "hidden-name", true)).paths.length) leaks++;
    } catch {}
  }
  await swap.exited;
  expect(tries).toBeGreaterThan(20);
  expect(leaks).toBe(0);
}, 10_000);

test("links: outside whether or not the target exists; broken only by an inside target", async () => {
  const { base, d } = folder();
  symlinkSync(join(base, "no-such-thing"), join(d, "out-missing"));
  symlinkSync("../../etc/nope", join(d, "out-rel-missing"));
  const by = Object.fromEntries((await listDir(await realRoot(d), "", true)).entries.map((e) => [e.name, e.to]));
  expect(by["out-missing"]).toBe("outside");
  expect(by["out-rel-missing"]).toBe("outside");
  expect(by["broken"]).toBe("broken");
  expect(by["loop-a"]).toBe("broken");
});

test("head: text that isn't UTF-8 or is mostly escapes shows lossily, marked; whole files stay binary", async () => {
  const d = temp();
  const root = await realRoot(d);
  writeFileSync(join(d, "latin.txt"), Buffer.concat([Buffer.from("caf"), Buffer.alloc(FILE_VIEW_MAX + 10, 0xe9)]));
  const l = await readFile(root, "latin.txt", { head: true });
  expect(l).toMatchObject({ kind: "text", cut: true, lossy: true });
  expect((l as { text: string }).text.startsWith("caf�")).toBe(true);
  writeFileSync(join(d, "ctl.txt"), "\u0001".repeat(FILE_VIEW_MAX + 10));
  const c = await readFile(root, "ctl.txt", { head: true });
  expect(c).toMatchObject({ kind: "text", cut: true, lossy: true });
  expect(utf8Length(JSON.stringify(c))).toBeLessThan(FRAME_BYTES_MAX);
  writeFileSync(join(d, "small-latin.txt"), Buffer.from([0x63, 0xe9]));
  expect((await readFile(root, "small-latin.txt")).kind).toBe("binary");
  // A NUL is binary even for the head.
  writeFileSync(join(d, "nul.txt"), Buffer.concat([Buffer.from([0]), Buffer.alloc(FILE_VIEW_MAX + 10, 0x61)]));
  expect((await readFile(root, "nul.txt", { head: true })).kind).toBe("binary");
});

test("a file that says it's empty (/proc) is read as empty, but for the head", async () => {
  if (process.platform !== "linux") return;
  const root = await realRoot("/proc/self");
  expect(await readFile(root, "environ")).toMatchObject({ kind: "text", text: "", size: 0 });
});

test("find: the walk's cap says partial; nested repos and gitlinks aren't files; fresh lists again", async () => {
  const d = temp();
  for (let i = 0; i < 5; i++) writeFileSync(join(d, `f${i}.txt`), "");
  const capped = await new Finder(Date.now, 3).find(await realRoot(d), "f", false);
  expect(capped.paths.length).toBe(3);
  expect(capped.partial).toBe(true);

  const r = temp();
  sh(r, "init", "-q");
  writeFileSync(join(r, "top.txt"), "");
  mkdirSync(join(r, "nested"));
  sh(join(r, "nested"), "init", "-q");
  writeFileSync(join(r, "nested", "inner.txt"), "");
  const root = await realRoot(r);
  let now = 0;
  const f = new Finder(() => now);
  expect((await f.find(root, "nested", true)).paths).toEqual([]);
  expect((await f.find(root, "top", true)).paths).toEqual(["top.txt"]);
  writeFileSync(join(r, "top2.txt"), "");
  expect((await f.find(root, "top", true)).paths).toEqual(["top.txt"]);
  expect((await f.find(root, "top", true, true)).paths).toEqual(["top.txt", "top2.txt"]);
});

test("timeouts: a call that answers late is let go, and a handle it opens then is closed", async () => {
  const { timed, noProc } = await import("./fs");
  let closed = false;
  const slow = new Promise<{ close: () => void }>((r) => setTimeout(() => r({ close: () => (closed = true) }), 30));
  await expect(timed(slow, 5, (h) => h.close())).rejects.toThrow("too long");
  await Bun.sleep(40);
  expect(closed).toBe(true);
  // In time: nothing closed.
  let closed2 = false;
  await timed(Promise.resolve({ close: () => (closed2 = true) }), 50, (h) => h.close());
  await Bun.sleep(5);
  expect(closed2).toBe(false);
  // Linux without /proc fails closed; elsewhere it's best effort.
  expect(noProc("linux", false)).toBe(true);
  expect(noProc("linux", true)).toBe(false);
  expect(noProc("darwin", false)).toBe(false);
});
