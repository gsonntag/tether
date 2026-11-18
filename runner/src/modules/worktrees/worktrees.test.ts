// A worktree per session (SPEC §4), against real git repos in temp folders: where a worktree goes
// and from what, unique branches, folders outside git, the repo's setup (absent, passing, failing)
// gating the first message, and the record that makes the worktree the session's own.

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { folderForBranch, randomSlug, slugOf } from "../../../../shared/worktree";
import { saveConfig } from "../../config";
import { FakeAdapter, idle, say } from "../../core/fakeAdapter";
import { createRunner } from "../../core/runner";
import { Worktrees } from ".";
import { addWorktree, defaultBase, findSetup, freeBranch, removeWorktree, repoOf, runGit } from "./git";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((f) => f()));

const until = async (f: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(10);
  }
};

function sh(cwd: string, ...args: string[]) {
  const p = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}

/** A scratch folder (removed after the test), its real path. */
function scratch() {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "tether-wt-")));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

/** A repo with one commit on `branch`, in `<scratch>/app`. */
function repo(branch = "main") {
  const root = scratch();
  const dir = join(root, "app");
  mkdirSync(dir);
  sh(dir, "init", "-q", "-b", branch);
  writeFileSync(join(dir, "README.md"), "hi\n");
  sh(dir, "add", ".");
  sh(dir, "commit", "-qm", "first");
  return { root, dir };
}

/** A clone of a repo whose origin has `main` ahead of the clone's local main. */
function cloned() {
  const up = repo();
  const dir = join(up.root, "clone");
  sh(up.root, "clone", "-q", up.dir, dir);
  writeFileSync(join(up.dir, "new.txt"), "x\n");
  sh(up.dir, "add", ".");
  sh(up.dir, "commit", "-qm", "second");
  sh(dir, "fetch", "-q", "origin");
  return { root: up.root, dir, upstream: sh(up.dir, "rev-parse", "HEAD") };
}

describe("slugs", () => {
  test("from a first message: its first meaningful words, safe for a branch and a folder", () => {
    expect(slugOf("Please fix the login bug on Safari!")).toBe("fix-login-bug-safari");
    expect(slugOf("Café crème: ajoute un test")).toBe("cafe-creme-ajoute-un-test");
    expect(slugOf("   ")).toBe("");
    expect(slugOf("!!!")).toBe("");
    expect(slugOf("a".repeat(100)).length).toBeLessThanOrEqual(40);
    expect(randomSlug()).toMatch(/^wt-[a-z0-9]{6}$/);
    expect(folderForBranch("tether/fix-login")).toBe("fix-login");
    expect(folderForBranch("gavin/x y")).toBe("gavin-x-y");
  });
});

describe("git", () => {
  test("a folder outside git, or missing: no repo", async () => {
    expect(await repoOf(scratch())).toBeUndefined();
    expect(await repoOf("/nonexistent/tether-wt")).toBeUndefined();
  });

  test("a subfolder and a linked worktree both find the main checkout", async () => {
    const r = repo();
    mkdirSync(join(r.dir, "sub"));
    expect(await repoOf(join(r.dir, "sub"))).toEqual({ top: r.dir, main: r.dir });
    const path = await addWorktree(r.dir, "tether/one", "main");
    expect(await repoOf(path)).toEqual({ top: path, main: r.dir });
  });

  test("the default branch: origin/HEAD, else origin's or the local main/master, else HEAD", async () => {
    const c = cloned();
    expect(await defaultBase(c.dir)).toBe("origin/main");
    // No origin/HEAD: origin/main still (the remote-tracking one before the local one).
    sh(c.dir, "remote", "set-head", "origin", "-d");
    expect(await defaultBase(c.dir)).toBe("origin/main");
    // origin/HEAD pointing at another branch wins.
    sh(c.dir, "update-ref", "refs/remotes/origin/trunk", "HEAD");
    sh(c.dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
    expect(await defaultBase(c.dir)).toBe("origin/trunk");
    // Local only.
    expect(await defaultBase(repo("master").dir)).toBe("master");
    expect(await defaultBase(repo("main").dir)).toBe("main");
    expect(await defaultBase(repo("dev").dir)).toBe("HEAD");
  });

  test("a new worktree starts from the remote-tracking branch, on its own untracked branch", async () => {
    const c = cloned();
    const path = await addWorktree(c.dir, "tether/fix", await defaultBase(c.dir));
    expect(path).toBe(join(c.root, "clone-worktrees", "fix"));
    expect(sh(path, "rev-parse", "HEAD")).toBe(c.upstream);
    expect(sh(path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("tether/fix");
    // --no-track: a push makes its own upstream.
    expect(() => sh(path, "rev-parse", "--abbrev-ref", "tether/fix@{upstream}")).toThrow();
    // The local main isn't touched.
    expect(sh(c.dir, "rev-parse", "HEAD")).not.toBe(c.upstream);
  });

  test("a taken branch or folder is refused; freeBranch picks the next free one", async () => {
    const r = repo();
    expect(await freeBranch(r.dir, "Fix the login")).toBe("tether/fix-login");
    await addWorktree(r.dir, "tether/fix-login", "main");
    await expect(addWorktree(r.dir, "tether/fix-login", "main")).rejects.toThrow("already exists");
    expect(await freeBranch(r.dir, "Fix the login")).toBe("tether/fix-login-2");
    // A folder in the way (not a branch) counts as taken too.
    mkdirSync(join(r.root, "app-worktrees", "fix-login-2"));
    await expect(addWorktree(r.dir, "tether/fix-login-2", "main")).rejects.toThrow("already exists");
    expect(await freeBranch(r.dir, "Fix the login")).toBe("tether/fix-login-3");
    expect(await freeBranch(r.dir, "")).toMatch(/^tether\/wt-[a-z0-9]{6}$/);
  });

  test("removal: only a clean worktree, and its branch with -d unless it's known merged", async () => {
    const r = repo();
    const path = await addWorktree(r.dir, "tether/a", "main");
    writeFileSync(join(path, "dirty.txt"), "x");
    expect((await removeWorktree(r.dir, path, "tether/a")).ok).toBe(false);
    expect(existsSync(path)).toBe(true);
    rmSync(join(path, "dirty.txt"));
    // Ignored files don't keep it (node_modules from a setup, say).
    writeFileSync(join(path, ".gitignore"), "node_modules\n");
    sh(path, "add", ".");
    sh(path, "commit", "-qm", "ignore");
    mkdirSync(join(path, "node_modules"));
    writeFileSync(join(path, "node_modules", "x.js"), "");
    // Its commit isn't in main: the worktree goes, the branch stays (-d refuses).
    const kept = await removeWorktree(r.dir, path, "tether/a");
    expect(kept.ok).toBe(true);
    expect(kept.branchKept).toContain("not fully merged");
    expect(existsSync(path)).toBe(false);
    expect(sh(r.dir, "branch", "--list", "tether/a")).toContain("tether/a");
    // Known merged (squashed, say): -D.
    expect(await removeWorktree(r.dir, path, "tether/a", { merged: true })).toEqual({ ok: true });
    expect(sh(r.dir, "branch", "--list", "tether/a")).toBe("");
  });

  test("git that hangs is killed after its time limit", async () => {
    const r = await runGit(scratch(), ["hash-object", "--stdin"], 50).catch(() => undefined);
    // stdin is closed, so it ends at once; a real hang is simulated with a hook below.
    expect(r?.ok).toBe(true);
    const slow = repo();
    writeFileSync(join(slow.dir, ".git", "hooks", "post-checkout"), "#!/bin/sh\nsleep 5\n");
    chmodSync(join(slow.dir, ".git", "hooks", "post-checkout"), 0o755);
    const t = await runGit(slow.dir, ["worktree", "add", "-b", "x", join(slow.root, "x"), "main"], 300);
    expect(t.ok).toBe(false);
    expect(t.err).toContain("took longer");
  });

  test("setup: .tether/setup (executable) first, then config.json's setup, the worktree's before the main checkout's", () => {
    const a = scratch();
    const b = scratch();
    expect(findSetup(a, b)).toBeUndefined();
    mkdirSync(join(b, ".tether"));
    writeFileSync(join(b, ".tether", "config.json"), JSON.stringify({ setup: "npm ci" }));
    expect(findSetup(a, b)).toEqual({ label: "npm ci", command: "npm ci" });
    mkdirSync(join(a, ".tether"));
    writeFileSync(join(a, ".tether", "setup"), "#!/bin/sh\necho hi\n");
    // Not executable: not a setup.
    expect(findSetup(a, b)).toEqual({ label: "npm ci", command: "npm ci" });
    chmodSync(join(a, ".tether", "setup"), 0o755);
    expect(findSetup(a, b)).toEqual({ label: ".tether/setup", argv: [join(a, ".tether", "setup")] });
    writeFileSync(join(b, ".tether", "config.json"), "{ not json");
    expect(findSetup(b)).toBeUndefined();
  });
});

function runnerFor() {
  const dir = scratch();
  const prefsFile = join(dir, "runner.json");
  saveConfig({ runnerId: "t" }, prefsFile);
  const adapter = new FakeAdapter();
  adapter.script = (text) => [say(`a-${text.slice(0, 10)}`, "ok"), idle];
  const runner = createRunner({ url: "http://x", token: "t", runnerId: "t", name: "t", version: "0", detectHarnesses: async () => [], adapters: [adapter], prefsFile, noticesFile: join(dir, "notices.json"), core: { evictMs: 60_000 } });
  cleanups.push(() => (void runner.shellRuns.stopAll(0), runner.core.stop()));
  const logs: string[] = [];
  const w = new Worktrees({ sessions: runner.look.sessions, newSession: (a) => runner.ops.call("newSession", a), log: (l) => logs.push(l) });
  const state = (id: string) => runner.core.sessions.get(id)!.state;
  const cards = (id: string) => (runner.core.sessions.get(id)!.transcript?.messages ?? []).filter((m) => m.shell);
  return { runner, adapter, w, prefsFile, logs, state, cards };
}

function withSetup(script: string) {
  const r = repo();
  mkdirSync(join(r.dir, ".tether"));
  writeFileSync(join(r.dir, ".tether", "setup"), script);
  chmodSync(join(r.dir, ".tether", "setup"), 0o755);
  sh(r.dir, "add", ".");
  sh(r.dir, "commit", "-qm", "setup");
  return r;
}

describe("New worktree", () => {
  test("workspaceInfo: in git, where and from what, and its setup; outside git: nothing to offer", async () => {
    const t = runnerFor();
    expect(await t.w.info(scratch())).toEqual({ git: false });
    expect(await t.w.info("/nonexistent/x")).toEqual({ git: false });
    const r = withSetup("#!/bin/sh\ntrue\n");
    const info = await t.w.info(r.dir);
    expect(info).toMatchObject({ git: true, repo: r.dir, base: "main", setup: ".tether/setup" });
    if (!info.git) throw new Error();
    expect(info.branch).toMatch(/^tether\/wt-/);
    expect(info.path).toBe(join(r.root, "app-worktrees", info.branch.slice("tether/".length)));
    expect(existsSync(info.path)).toBe(false);
  });

  test("outside git it's refused, and nothing starts", async () => {
    const t = runnerFor();
    await expect(t.w.create({ harness: "claude", projectPath: scratch() })).rejects.toThrow("isn't in a git repository");
    expect(t.adapter.drivers).toHaveLength(0);
  });

  test("no setup: the session runs in the worktree, recorded as its own, and the first message goes at once", async () => {
    const t = runnerFor();
    const r = repo();
    const made = await t.w.create({ harness: "claude", projectPath: r.dir, name: "Fix the login bug" });
    expect(made).toMatchObject({ branch: "tether/fix-login-bug", base: "main", path: join(r.root, "app-worktrees", "fix-login-bug") });
    expect(made.setup).toBeUndefined();
    expect(sh(made.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("tether/fix-login-bug");
    const s = t.runner.core.sessions.get(made.sessionId)!;
    expect(s.summary.projectPath).toBe(made.path);
    expect(s.summary.worktreeOf).toBe(r.dir);
    // The record, in runner.json at once.
    const saved = JSON.parse(readFileSync(t.prefsFile, "utf8")).sessions[made.sessionId];
    expect(saved.worktree).toEqual({ path: made.path, branch: "tether/fix-login-bug", repo: r.dir });
    expect(t.runner.look.sessions.worktree!(made.sessionId)).toEqual(saved.worktree);
    await t.runner.live.send(made.sessionId, "hello");
    await until(() => t.adapter.drivers.at(-1)?.sent.includes("hello") ?? false);
    // A second one with the same name gets the next branch.
    const again = await t.w.create({ harness: "claude", projectPath: r.dir, name: "Fix the login bug" });
    expect(again.branch).toBe("tether/fix-login-bug-2");
  });

  test("a branch you name is used as it is; taken or invalid, it's refused and nothing is made", async () => {
    const t = runnerFor();
    const r = repo();
    const made = await t.w.create({ harness: "claude", projectPath: r.dir, branch: "gavin/try-it" });
    expect(made.branch).toBe("gavin/try-it");
    expect(made.path).toBe(join(r.root, "app-worktrees", "gavin-try-it"));
    await expect(t.w.create({ harness: "claude", projectPath: r.dir, branch: "gavin/try-it" })).rejects.toThrow("already exists");
    await expect(t.w.create({ harness: "claude", projectPath: r.dir, branch: "bad..name" })).rejects.toThrow("can't be a branch name");
    await expect(t.w.create({ harness: "claude", projectPath: r.dir, branch: "-x" })).rejects.toThrow("can't be a branch name");
    expect(t.adapter.drivers.length).toBeLessThanOrEqual(1);
  });

  test("a session that can't start leaves no worktree or branch behind", async () => {
    const t = runnerFor();
    const r = repo();
    await expect(t.w.create({ harness: "codex", projectPath: r.dir, branch: "tether/nope" })).rejects.toThrow();
    expect(existsSync(join(r.root, "app-worktrees", "nope"))).toBe(false);
    expect(sh(r.dir, "branch", "--list", "tether/nope")).toBe("");
  });

  test("setup passes: its card shows the output, the first message waits for it, then goes", async () => {
    const t = runnerFor();
    const r = withSetup('#!/bin/sh\necho "setting up in $PWD for $TETHER_BRANCH from $TETHER_REPO"\nsleep 0.4\necho done > .setup-ran\n');
    const made = await t.w.create({ harness: "claude", projectPath: r.dir, branch: "tether/s1" });
    expect(made.setup).toBe(".tether/setup");
    const id = made.sessionId;
    expect(t.state(id).setup).toBe("running");
    // Sent while it runs: held, nothing to the agent.
    await t.runner.live.send(id, "first message");
    expect(t.state(id).queue.map((m) => m.text)).toEqual(["first message"]);
    expect(t.state(id).queueHeldBy).toBe("setup");
    // Resume can't let it go before the setup ends; the row doesn't say it waits for you.
    await expect(t.runner.live.queue.resume(id)).rejects.toThrow("still running");
    expect(t.runner.core.sessions.get(id)!.summary.queuePaused).toBeUndefined();
    await until(() => t.state(id).setup === undefined);
    await until(() => t.adapter.drivers.at(-1)?.sent.includes("first message") ?? false);
    expect(readFileSync(join(made.path, ".setup-ran"), "utf8")).toBe("done\n");
    const [card] = t.cards(id);
    expect(card!.shell).toMatchObject({ state: "done", setup: true, exitCode: 0 });
    const tool = card!.parts[0] as { output?: string; command?: string };
    expect(tool.command).toBe(".tether/setup");
    expect(tool.output).toContain(`setting up in ${made.path} for tether/s1 from ${r.dir}`);
    // The setup's output never went to the agent.
    expect(t.adapter.drivers.at(-1)!.sent).toEqual(["first message"]);
  });

  test("setup fails: shown, the first message stays held, and Resume sends it anyway", async () => {
    const t = runnerFor();
    const r = withSetup("#!/bin/sh\necho 'npm ERR! nope' >&2\nsleep 0.2\nexit 2\n");
    const made = await t.w.create({ harness: "claude", projectPath: r.dir, branch: "tether/f1" });
    const id = made.sessionId;
    await t.runner.live.send(id, "do the thing");
    await until(() => t.state(id).setup === "failed");
    const [card] = t.cards(id);
    expect(card!.shell).toMatchObject({ state: "done", setup: true, exitCode: 2 });
    expect((card!.parts[0] as { output?: string }).output).toContain("npm ERR! nope");
    await Bun.sleep(150);
    expect(t.adapter.drivers.at(-1)?.sent ?? []).toEqual([]);
    expect(t.state(id).queueHeldBy).toBe("setup");
    // Home shows it as needing you.
    const row = t.runner.core.sessions.get(id)!.summary;
    expect(row.queuePaused).toBe(true);
    expect(t.runner.core.o.prefs.get(id).failure).toContain("setup failed");
    // Sent after it failed: held too, behind the first.
    await t.runner.live.send(id, "and this");
    expect(t.state(id).queue.map((m) => m.text)).toEqual(["do the thing", "and this"]);
    // Send anyway: they go, and later sends go as usual.
    await t.runner.live.queue.resume(id);
    await until(() => t.adapter.drivers.at(-1)?.sent.includes("do the thing") ?? false);
    expect(t.state(id).setup).toBeUndefined();
    await until(() => t.adapter.drivers.at(-1)?.sent.includes("and this") ?? false);
  });

  test("a setup that ends while the harness is still starting: what waited goes once it has started", async () => {
    const t = runnerFor();
    let open!: () => void;
    t.adapter.startGate = new Promise((r) => (open = r));
    const r = withSetup("#!/bin/sh\nexit 0\n");
    const made = await t.w.create({ harness: "claude", projectPath: r.dir, branch: "tether/slow" });
    await t.runner.live.send(made.sessionId, "first");
    await until(() => t.state(made.sessionId).setup === undefined);
    expect(t.state(made.sessionId).queue.map((m) => m.text)).toEqual(["first"]);
    open();
    await until(() => t.adapter.drivers.at(-1)?.sent.includes("first") ?? false);
  });

  test("setup from .tether/config.json runs through the shell", async () => {
    const t = runnerFor();
    const r = repo();
    mkdirSync(join(r.dir, ".tether"));
    writeFileSync(join(r.dir, ".tether", "config.json"), JSON.stringify({ setup: "echo from-config && pwd" }));
    sh(r.dir, "add", ".");
    sh(r.dir, "commit", "-qm", "cfg");
    const made = await t.w.create({ harness: "claude", projectPath: r.dir, branch: "tether/c1" });
    expect(made.setup).toBe("echo from-config && pwd");
    await until(() => t.state(made.sessionId).setup === undefined);
    const out = (t.cards(made.sessionId)[0]!.parts[0] as { output?: string }).output;
    expect(out).toBe(`from-config\n${made.path}\n`);
  });

  test("through the ops, as the browser calls them", async () => {
    const t = runnerFor();
    const { worktreesModule } = await import(".");
    await worktreesModule.start({ ...t.runner.look, bus: t.runner.bus, ops: t.runner.ops, dataDir: scratch(), log: () => {}, runnerId: "t", appUrl: "http://x" } as never);
    const r = repo();
    expect(await t.runner.ops.handle("workspaceInfo", { projectPath: scratch() })).toEqual({ ok: true, data: { git: false } });
    const made = await t.runner.ops.handle("newWorktreeSession", { harness: "claude", projectPath: r.dir, name: "ops path" });
    expect(made).toMatchObject({ ok: true, data: { branch: "tether/ops-path" } });
  });
});
