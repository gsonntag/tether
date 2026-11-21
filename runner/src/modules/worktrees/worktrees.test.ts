// A worktree per session (SPEC §4), against real git repos in temp folders: where a worktree goes
// and from what, unique branches, folders outside git, the repo's setup (absent, passing, failing)
// gating the first message, and the record that makes the worktree the session's own.

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, symlinkSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { folderForBranch, hashSlug, pickWorktree, randomSlug, slugOf } from "../../../../shared/worktree";
import { saveConfig } from "../../config";
import { FakeAdapter, idle, say } from "../../core/fakeAdapter";
import { createRunner } from "../../core/runner";
import { busyWhy, Worktrees } from ".";
import { addWorktree, branchNameOk, defaultBase, fetchBase, findSetup, freeBranch, ignoredFiles, lockWorktree, outsideUsers, precious, IGNORED_MAX, removeOwnWorktree, removeWorktree, repoOf, runGit, setupAt, taken, undoAdd, worktreesDir, type Git } from "./git";

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
    // No commit checked: the worktree goes, the branch stays.
    const tip = sh(r.dir, "rev-parse", "tether/a");
    const kept = await removeWorktree(r.dir, path, "tether/a");
    expect(kept.ok).toBe(true);
    expect(kept.branchKept).toContain("aren't all in main");
    expect(existsSync(path)).toBe(false);
    expect(sh(r.dir, "branch", "--list", "tether/a")).toContain("tether/a");
    // The branch moved since it was checked: kept.
    sh(r.dir, "branch", "-f", "tether/a", "main");
    expect((await removeWorktree(r.dir, path, "tether/a", { branchAt: tip })).branchKept).toContain("moved");
    expect(sh(r.dir, "branch", "--list", "tether/a")).toContain("tether/a");
    // At the commit checked: deleted. (The folder already gone: said so.)
    expect(await removeWorktree(r.dir, path, "tether/a", { branchAt: sh(r.dir, "rev-parse", "tether/a") })).toEqual({ ok: true, gone: true });
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
    expect(findSetup(a, b)).toMatchObject({ label: "npm ci", command: "npm ci" });
    mkdirSync(join(a, ".tether"));
    writeFileSync(join(a, ".tether", "setup"), "#!/bin/sh\necho hi\n");
    // Not executable: not a setup.
    expect(findSetup(a, b)).toMatchObject({ label: "npm ci", command: "npm ci" });
    chmodSync(join(a, ".tether", "setup"), 0o755);
    expect(findSetup(a, b)).toMatchObject({ label: ".tether/setup", argv: [join(a, ".tether", "setup")], text: "#!/bin/sh\necho hi\n" });
    writeFileSync(join(b, ".tether", "config.json"), "{ not json");
    expect(findSetup(b)).toBeUndefined();
  });
});

function runnerFor(o: { dir?: string; setupMs?: number; usersOf?: (dir: string) => number | undefined } = {}) {
  const dir = o.dir ?? scratch();
  const prefsFile = join(dir, "runner.json");
  if (!existsSync(prefsFile)) saveConfig({ runnerId: "t" }, prefsFile);
  const adapter = new FakeAdapter();
  adapter.script = (text) => [say(`a-${text.slice(0, 10)}`, "ok"), idle];
  const runner = createRunner({ url: "http://x", token: "t", runnerId: "t", name: "t", version: "0", detectHarnesses: async () => [], adapters: [adapter], prefsFile, noticesFile: join(dir, "notices.json"), core: { evictMs: 60_000 } });
  cleanups.push(() => (void runner.shellRuns.stopAll(0), runner.core.stop()));
  const logs: string[] = [];
  const w = new Worktrees({ sessions: runner.look.sessions, newSession: (a) => runner.ops.call("newSession", a), log: (l) => logs.push(l), usersOf: o.usersOf ?? (() => 0), loaded: () => runner.look.loaded(), ...(o.setupMs ? { setupMs: o.setupMs } : {}) });
  const state = (id: string) => runner.core.sessions.get(id)!.state;
  const cards = (id: string) => (runner.core.sessions.get(id)!.transcript?.messages ?? []).filter((m) => m.shell);
  return { runner, adapter, w, prefsFile, logs, state, cards, dir };
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
    expect(saved.worktree).toMatchObject({ path: made.path, branch: "tether/fix-login-bug", repo: r.dir });
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

  test("a scheduled message that comes due waits for the setup: running or failed, until Send anyway", async () => {
    const t = runnerFor();
    const r = withSetup("#!/bin/sh\nsleep 0.3\nexit 2\n");
    const made = await t.w.create({ harness: "claude", projectPath: r.dir, branch: "tether/sched" });
    const id = made.sessionId;
    await t.runner.live.queue.add(id, "early", [], { at: Date.now() + 50 });
    await Bun.sleep(150);
    expect(t.state(id).setup).toBe("running");
    expect(t.adapter.drivers.at(-1)?.sent ?? []).toEqual([]);
    await until(() => t.state(id).setup === "failed");
    await t.runner.live.queue.add(id, "timed", [], { at: Date.now() + 50 });
    await Bun.sleep(200);
    expect(t.adapter.drivers.at(-1)?.sent ?? []).toEqual([]);
    // Still scheduled, not held as failed: Send anyway lets them go.
    expect(t.state(id).queue.map((m) => [m.text, m.held])).toEqual([["early", undefined], ["timed", undefined]]);
    await t.runner.live.queue.resume(id);
    await until(() => t.adapter.drivers.at(-1)?.sent.includes("timed") ?? false);
    expect(t.adapter.drivers.at(-1)!.sent).toEqual(["early", "timed"]);
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

  test("racing creates in one repo: one at a time, and a loser never touches the winner's worktree", async () => {
    const t = runnerFor();
    const r = repo();
    const both = await Promise.allSettled([t.w.create({ harness: "claude", projectPath: r.dir, branch: "tether/same" }), t.w.create({ harness: "claude", projectPath: r.dir, branch: "tether/same" })]);
    expect(both.map((x) => x.status).sort()).toEqual(["fulfilled", "rejected"]);
    const won = (both.find((x) => x.status === "fulfilled") as PromiseFulfilledResult<{ path: string }>).value;
    expect(sh(won.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("tether/same");
    expect(String((both.find((x) => x.status === "rejected") as PromiseRejectedResult).reason)).toContain("already exists");
    // Default names at the same moment: different branches.
    const two = await Promise.all([t.w.create({ harness: "claude", projectPath: r.dir, name: "same thing" }), t.w.create({ harness: "claude", projectPath: r.dir, name: "same thing" })]);
    expect(two.map((m) => m.branch).sort()).toEqual(["tether/same-thing", "tether/same-thing-2"]);
  });

  test("a failed add cleans up only what it made: never a folder that was there, nor a branch that moved", async () => {
    const r = repo();
    const sha = sh(r.dir, "rev-parse", "main");
    // Something appears at the path between the check and the add (another process): git refuses, it stays.
    const intruding: Git = async (cwd, args, ms) => {
      if (args[0] === "worktree" && args[1] === "add") {
        mkdirSync(args[5]!, { recursive: true });
        writeFileSync(join(args[5]!, "theirs.txt"), "keep me");
      }
      return runGit(cwd, args, ms);
    };
    await expect(addWorktree(r.dir, "tether/x", "main", intruding)).rejects.toThrow("git worktree add failed");
    expect(readFileSync(join(r.root, "app-worktrees", "x", "theirs.txt"), "utf8")).toBe("keep me");
    // Our branch, if git made it before refusing the folder, goes (it was at our base).
    expect(sh(r.dir, "branch", "--list", "tether/x")).toBe("");
    // The branch made meanwhile by someone else: git refuses, and their branch stays where it is.
    const other = sh(r.dir, "commit-tree", "-m", "theirs", `${sha}^{tree}`, "-p", sha);
    const racing: Git = async (cwd, args, ms) => {
      if (args[0] === "worktree" && args[1] === "add") sh(r.dir, "branch", "tether/w", other);
      return runGit(cwd, args, ms);
    };
    await expect(addWorktree(r.dir, "tether/w", "main", racing)).rejects.toThrow("already exists");
    expect(sh(r.dir, "rev-parse", "tether/w")).toBe(other);
    // Undo leaves another branch's worktree at that path, and a branch no longer at our commit.
    const theirs = await addWorktree(r.dir, "tether/y", "main");
    writeFileSync(join(theirs, "f"), "x");
    sh(theirs, "add", ".");
    sh(theirs, "commit", "-qm", "theirs");
    await undoAdd(r.dir, theirs, "tether/z", sha);
    expect(existsSync(join(theirs, "f"))).toBe(true);
    await undoAdd(r.dir, theirs, "tether/y", sha);
    expect(sh(r.dir, "branch", "--list", "tether/y")).toContain("tether/y");
    // A failed add in a repo with no worktrees folder yet leaves none behind.
    const q = repo();
    await expect(addWorktree(q.dir, "tether/q", "nope")).rejects.toThrow();
    const failing: Git = async (cwd, args, ms) => (args[1] === "add" ? { ok: false, out: "", err: "fatal: boom" } : runGit(cwd, args, ms));
    await expect(addWorktree(q.dir, "tether/q", "main", failing)).rejects.toThrow("boom");
    expect(existsSync(worktreesDir(q.dir))).toBe(false);
  });

  test("names: @ and @{…} are refused, git's form must be the typed one; a remote's branch is taken", async () => {
    const c = cloned();
    for (const bad of ["@", "a@{1}", "@{-1}", "x..y", "-x", "a b"]) expect(await branchNameOk(c.dir, bad)).toBe(false);
    expect(await branchNameOk(c.dir, "gavin/ok-1")).toBe(true);
    sh(c.dir, "update-ref", "refs/remotes/origin/feature/x", "HEAD");
    expect(await taken(c.dir, "feature/x")).toContain("already exists on origin");
    expect(await taken(c.dir, "x")).toBeUndefined();
    // Text with no usable words: the same slug each time.
    expect(hashSlug("???")).toBe(hashSlug("???"));
    expect(await freeBranch(c.dir, "!!!")).toBe(`tether/${hashSlug("!!!")}`);
  });

  test("an unborn repo isn't offered New worktree, and creating there is refused", async () => {
    const t = runnerFor();
    const d = join(scratch(), "empty");
    mkdirSync(d);
    sh(d, "init", "-q", "-b", "main");
    expect(await t.w.info(d)).toEqual({ git: false });
    await expect(t.w.create({ harness: "claude", projectPath: d })).rejects.toThrow("no commits yet");
  });

  test("the base is fetched first (best effort), and info says when origin was last fetched", async () => {
    const t = runnerFor();
    const c = cloned();
    // origin moves on after the clone's last fetch.
    const up = join(c.root, "app");
    writeFileSync(join(up, "third.txt"), "x");
    sh(up, "add", ".");
    sh(up, "commit", "-qm", "third");
    const info = await t.w.info(c.dir);
    expect(info).toMatchObject({ git: true, base: "origin/main", remote: true });
    expect(info.git && info.fetchedAt).toBeGreaterThan(0);
    const made = await t.w.create({ harness: "claude", projectPath: c.dir, branch: "tether/fresh" });
    expect(made.fetched).toBe(true);
    expect(sh(made.path, "rev-parse", "HEAD")).toBe(sh(up, "rev-parse", "HEAD"));
    // No way to reach origin: it goes on from what was last fetched.
    sh(c.dir, "remote", "set-url", "origin", join(c.root, "gone"));
    expect(await fetchBase(c.dir, "origin/main")).toBe(false);
    expect((await t.w.create({ harness: "claude", projectPath: c.dir, branch: "tether/stale" })).fetched).toBe(false);
  });

  test("info shows the setup the base has, not the main checkout's uncommitted one", async () => {
    const t = runnerFor();
    const r = withSetup("#!/bin/sh\necho committed\n");
    writeFileSync(join(r.dir, ".tether", "setup"), "#!/bin/sh\necho edited\n");
    const info = await t.w.info(r.dir);
    expect(info).toMatchObject({ setup: ".tether/setup", setupText: "#!/bin/sh\necho committed" });
    expect((await setupAt(r.dir, "main"))?.text).toContain("committed");
    // Only in the main checkout (kept out of git): that's what a new worktree runs too.
    const q = repo();
    mkdirSync(join(q.dir, ".tether"));
    writeFileSync(join(q.dir, ".tether", "config.json"), JSON.stringify({ setup: "make dev" }));
    expect(await t.w.info(q.dir)).toMatchObject({ setup: "make dev" });
  });

  test("a setup that changed on origin after the dialog looked is refused, nothing made; the new one is named", async () => {
    const t = runnerFor();
    const c = cloned();
    const up = join(c.root, "app");
    const info = await t.w.info(c.dir);
    if (!info.git) throw new Error();
    expect(info.setupId).toBe("");
    // origin gains a setup after the dialog asked.
    mkdirSync(join(up, ".tether"));
    writeFileSync(join(up, ".tether", "setup"), "#!/bin/sh\necho pretend-evil\n");
    chmodSync(join(up, ".tether", "setup"), 0o755);
    sh(up, "add", ".");
    sh(up, "commit", "-qm", "setup");
    const err = await t.w.create({ harness: "claude", projectPath: c.dir, branch: "tether/seen", expectSetup: info.setupId }).catch((e) => e as Error);
    expect(String(err)).toContain("The setup changed on origin since you looked. Nothing was made.");
    expect(String(err)).toContain("echo pretend-evil");
    expect(existsSync(join(c.root, "clone-worktrees", "seen"))).toBe(false);
    expect(() => sh(c.dir, "rev-parse", "--verify", "tether/seen")).toThrow();
    expect(t.adapter.drivers).toHaveLength(0);
    // Looked again (now fetched): the shown setup is the one that runs.
    const again = await t.w.info(c.dir);
    if (!again.git) throw new Error();
    expect(again.setupText).toContain("pretend-evil");
    const made = await t.w.create({ harness: "claude", projectPath: c.dir, branch: "tether/seen", expectSetup: again.setupId });
    expect(made.setup).toBe(".tether/setup");
    // The setup going away counts as a change too; no expectSetup (tether_start): whatever the base has.
    sh(up, "rm", "-q", "-r", ".tether");
    sh(up, "commit", "-qm", "no setup");
    await expect(t.w.create({ harness: "claude", projectPath: c.dir, branch: "tether/gone", expectSetup: again.setupId })).rejects.toThrow("there's none now");
    expect((await t.w.create({ harness: "claude", projectPath: c.dir, branch: "tether/home" })).setup).toBeUndefined();
  });

  test("a terminal start in a repo with a setup is refused before anything is made", async () => {
    const t = runnerFor();
    const r = withSetup("#!/bin/sh\ntrue\n");
    await expect(t.w.create({ harness: "claude", projectPath: r.dir, branch: "tether/tui", terminal: true })).rejects.toThrow("terminal start can't wait");
    expect(existsSync(join(r.root, "app-worktrees", "tui"))).toBe(false);
  });

  test("a setup past its time limit is stopped, as failed", async () => {
    const t = runnerFor({ setupMs: 300 });
    const r = withSetup("#!/bin/sh\nsleep 30\n");
    const made = await t.w.create({ harness: "claude", projectPath: r.dir, branch: "tether/slow-setup" });
    await until(() => t.state(made.sessionId).setup === "failed", 8000);
    expect(t.runner.core.o.prefs.get(made.sessionId).failure).toContain("took longer than");
    // Send anyway with nothing queued: the gate ends, and a send goes at once.
    await t.runner.live.queue.resume(made.sessionId);
    expect(t.state(made.sessionId).setup).toBeUndefined();
    expect(t.runner.core.o.prefs.get(made.sessionId).setup).toBeUndefined();
    await t.runner.live.send(made.sessionId, "go");
    await until(() => t.adapter.drivers.at(-1)?.sent.includes("go") ?? false);
  });

  test("a restart mid-setup: failed (cut off), sends held even with nothing queued; Re-run setup runs it again", async () => {
    const first = runnerFor();
    const r = withSetup("#!/bin/sh\nif [ -e .ran ]; then echo second; exit 0; fi\ntouch .ran\nsleep 30\n");
    const made = await first.w.create({ harness: "claude", projectPath: r.dir, branch: "tether/cut" });
    expect(first.runner.core.o.prefs.get(made.sessionId).setup).toBe("running");
    // The runner "crashes": a new one on the same runner.json.
    first.runner.core.o.prefs.flush();
    const t = runnerFor({ dir: first.dir });
    expect(t.runner.live.queue.setupsCutOff()).toEqual([made.sessionId]);
    const look = await t.runner.look.sessions.open(made.sessionId);
    expect(look.state.setup).toBe("failed");
    await t.runner.live.send(made.sessionId, "hi");
    expect(t.state(made.sessionId).queueHeldBy).toBe("setup");
    await t.w.rerun(made.sessionId);
    await until(() => t.state(made.sessionId).setup === undefined, 8000);
    await until(() => t.adapter.drivers.at(-1)?.sent.includes("hi") ?? false);
    await expect(t.w.rerun(made.sessionId)).rejects.toThrow("isn't waiting");
  });

  test("ignored files: file by file outside regenerable folders; unchanged known ones may go, new or edited ones keep it", async () => {
    const r = repo();
    writeFileSync(join(r.dir, ".gitignore"), "node_modules\n.env\ndata/\nbuild\n");
    sh(r.dir, "add", ".");
    sh(r.dir, "commit", "-qm", "ignore");
    const path = await addWorktree(r.dir, "tether/ig", "main");
    mkdirSync(join(path, "node_modules", "deep"), { recursive: true });
    writeFileSync(join(path, "node_modules", "deep", "x"), "");
    mkdirSync(join(path, "pkg", "build"), { recursive: true });
    writeFileSync(join(path, "pkg", "build", "out"), "");
    // What setup left: a data folder with a seed database.
    mkdirSync(join(path, "data", "node_modules"), { recursive: true });
    writeFileSync(join(path, "data", "seed.db"), "seed");
    writeFileSync(join(path, "data", "node_modules", "y"), "");
    const known = (await ignoredFiles(path))!;
    expect(Object.keys(known)).toEqual(["data/seed.db"]);
    expect(precious(known, known)).toEqual([]);
    const own = { path, branch: "tether/ig", repo: r.dir, known };
    // The reviewer's case: later a .env, a new file inside the known data/ folder, and an edit to the seed.
    writeFileSync(join(path, ".env"), "SECRET=1");
    writeFileSync(join(path, "data", "notes.db"), "mine");
    await Bun.sleep(5);
    writeFileSync(join(path, "data", "seed.db"), "seed, edited");
    const kept = await removeOwnWorktree(own, []);
    expect(kept.removed).toBe(false);
    expect(kept.why).toContain("would delete ignored files: .env, data/notes.db, data/seed.db");
    for (const f of [".env", "data/notes.db", "data/seed.db"]) expect(existsSync(join(path, f))).toBe(true);
    // Back to only what setup left (the seed as it was): it goes.
    rmSync(join(path, ".env"));
    rmSync(join(path, "data", "notes.db"));
    const again = { ...own, known: (await ignoredFiles(path))! };
    expect(await removeOwnWorktree(again, [])).toEqual({ removed: true });
    expect(existsSync(path)).toBe(false);
    expect(sh(r.dir, "branch", "--list", "tether/ig")).toBe("");
  });

  test("ignored files: more than can be checked keeps the worktree", async () => {
    const r = repo();
    writeFileSync(join(r.dir, ".gitignore"), "logs/\n");
    sh(r.dir, "add", ".");
    sh(r.dir, "commit", "-qm", "ignore");
    const path = await addWorktree(r.dir, "tether/many", "main");
    mkdirSync(join(path, "logs"));
    for (let i = 0; i <= IGNORED_MAX; i++) writeFileSync(join(path, "logs", `${i}`), "");
    expect(await ignoredFiles(path)).toBeUndefined();
    expect((await removeOwnWorktree({ path, branch: "tether/many", repo: r.dir }, [])).why).toContain("too many");
  }, 30_000);

  test("what setup leaves is taken when it ends, before a waiting message reaches the agent", async () => {
    const t = runnerFor();
    const r = repo();
    writeFileSync(join(r.dir, ".gitignore"), ".env\n");
    mkdirSync(join(r.dir, ".tether"));
    writeFileSync(join(r.dir, ".tether", "setup"), "#!/bin/sh\necho A=1 > .env\n");
    chmodSync(join(r.dir, ".tether", "setup"), 0o755);
    sh(r.dir, "add", ".");
    sh(r.dir, "commit", "-qm", "setup");
    // The agent writes to .env in its first turn.
    t.adapter.script = (text) => (writeFileSync(join(r.root, "app-worktrees", "snap", ".env"), "A=1\nMINE=secret\n"), [say(`a-${text.length}`, "ok"), idle]);
    const made = await t.w.create({ harness: "claude", projectPath: r.dir, branch: "tether/snap" });
    await t.runner.live.send(made.sessionId, "edit .env");
    await until(() => t.adapter.drivers.at(-1)?.sent.includes("edit .env") ?? false);
    await until(() => !!t.runner.look.sessions.worktree!(made.sessionId)?.known?.[".env"]);
    const rec = t.runner.look.sessions.worktree!(made.sessionId)!;
    // Known as the setup left it (4 bytes), so the agent's edit counts as precious.
    expect(rec.known![".env"]![0]).toBe(4);
    expect(precious((await ignoredFiles(made.path))!, rec.known)).toEqual([".env"]);
  });

  test("removal: a branch with work not in main is never deleted, even when HEAD moved to merged work", async () => {
    const r = repo();
    const path = await addWorktree(r.dir, "tether/wip", "main");
    writeFileSync(join(path, "wip.txt"), "unmerged work");
    sh(path, "add", ".");
    sh(path, "commit", "-qm", "wip");
    const wip = sh(path, "rev-parse", "HEAD");
    // The agent switched its worktree to another branch, one that is merged.
    sh(path, "checkout", "-qb", "other", "main");
    const own = { path, branch: "tether/wip", repo: r.dir };
    const gone = await removeOwnWorktree(own, []);
    expect(gone).toMatchObject({ removed: true });
    expect(gone.branchKept).toContain("tether/wip");
    expect(sh(r.dir, "rev-parse", "tether/wip")).toBe(wip);
    // HEAD itself unmerged (detached on the WIP): nothing is removed.
    const p2 = await addWorktree(r.dir, "tether/wip2", "main");
    writeFileSync(join(p2, "w.txt"), "x");
    sh(p2, "add", ".");
    sh(p2, "commit", "-qm", "w");
    sh(p2, "checkout", "-q", "--detach");
    const kept = await removeOwnWorktree({ path: p2, branch: "tether/wip2", repo: r.dir }, []);
    expect(kept.removed).toBe(false);
    expect(kept.why).toContain("aren't in main");
    expect(existsSync(p2)).toBe(true);
    // Its folder moved away by hand: said so, git's record pruned, a merged branch goes.
    const p3 = await addWorktree(r.dir, "tether/moved", "main");
    rmSync(p3, { recursive: true, force: true });
    expect(await removeOwnWorktree({ path: p3, branch: "tether/moved", repo: r.dir }, [])).toEqual({ removed: true, gone: true });
    expect(sh(r.dir, "branch", "--list", "tether/moved")).toBe("");
  });

  test("Re-run setup tapped twice runs it once", async () => {
    const t = runnerFor();
    const r = withSetup("#!/bin/sh\nexit 1\n");
    const made = await t.w.create({ harness: "claude", projectPath: r.dir, branch: "tether/twice" });
    await until(() => t.state(made.sessionId).setup === "failed");
    const both = await Promise.allSettled([t.w.rerun(made.sessionId), t.w.rerun(made.sessionId)]);
    expect(both.map((x) => x.status).sort()).toEqual(["fulfilled", "rejected"]);
    await until(() => t.state(made.sessionId).setup === "failed");
    expect(t.cards(made.sessionId)).toHaveLength(2);
  });

  test("setupId is the script's blob id (or a hash of the whole command); a long script is marked cut", async () => {
    const r = withSetup(`#!/bin/sh\n${"echo x\n".repeat(400)}`);
    const s = (await setupAt(r.dir, "main"))!;
    expect(s.id).toBe(`blob:${sh(r.dir, "rev-parse", "main:.tether/setup")}`);
    expect(s.cut).toBe(true);
    expect(s.text!.length).toBe(2000);
    // The same file read from the folder has the same id.
    expect(findSetup(r.dir)!.id).toBe(s.id);
    const t = runnerFor();
    expect(await t.w.info(r.dir)).toMatchObject({ setupTextCut: true, setupId: s.id });
    // Commands differing only past what's shown differ.
    const long = "x".repeat(3000);
    const q = repo();
    mkdirSync(join(q.dir, ".tether"));
    writeFileSync(join(q.dir, ".tether", "config.json"), JSON.stringify({ setup: `${long}a` }));
    const id1 = findSetup(q.dir)!.id;
    writeFileSync(join(q.dir, ".tether", "config.json"), JSON.stringify({ setup: `${long}b` }));
    expect(findSetup(q.dir)!.id).not.toBe(id1);
  });

  test("the fetch: no prompts; ssh in batch mode unless the repo has its own ssh command", async () => {
    const c = cloned();
    const seen: { args: string[]; env?: Record<string, string> }[] = [];
    const spy: Git = async (cwd, args, ms, env) => (seen.push({ args, env }), runGit(cwd, args, ms, env));
    await fetchBase(c.dir, "origin/main", spy);
    const f = seen.find((x) => x.args.includes("fetch"))!;
    expect(f.args.slice(0, 2)).toEqual(["-c", "credential.interactive=false"]);
    expect(f.env).toEqual({ GIT_SSH_COMMAND: "ssh -o BatchMode=yes" });
    sh(c.dir, "config", "core.sshCommand", "ssh -i ~/.ssh/other");
    seen.length = 0;
    await fetchBase(c.dir, "origin/main", spy);
    expect(seen.find((x) => x.args.includes("fetch"))!.env).toEqual({});
  });

  test("knownAfter: what the setup made or changed, and earlier known files still unchanged; nothing new without a start snapshot", async () => {
    const { knownAfter } = await import(".");
    const had = { "a.db": [1, 1] as [number, number], "gone.db": [1, 1] as [number, number], "edited.db": [1, 1] as [number, number] };
    const before = { "a.db": [1, 1] as [number, number], "edited.db": [2, 2] as [number, number], "mine.env": [3, 3] as [number, number] };
    const after = { "a.db": [1, 1] as [number, number], "edited.db": [2, 2] as [number, number], "mine.env": [3, 3] as [number, number], "new.db": [4, 4] as [number, number] };
    expect(knownAfter(had, before, after)).toEqual({ "a.db": [1, 1], "new.db": [4, 4] });
    expect(knownAfter(had, undefined, after)).toEqual({ "a.db": [1, 1] });
  });

  test("Re-run setup: files made by hand before it stay precious; what it makes is known", async () => {
    const t = runnerFor();
    const r = repo();
    writeFileSync(join(r.dir, ".gitignore"), "*.db\n.env\n");
    mkdirSync(join(r.dir, ".tether"));
    writeFileSync(join(r.dir, ".tether", "setup"), "#!/bin/sh\nif [ -e .env ]; then echo seed > seed.db; exit 0; fi\nexit 1\n");
    chmodSync(join(r.dir, ".tether", "setup"), 0o755);
    sh(r.dir, "add", ".");
    sh(r.dir, "commit", "-qm", "setup");
    const made = await t.w.create({ harness: "claude", projectPath: r.dir, branch: "tether/hand" });
    await until(() => t.state(made.sessionId).setup === "failed");
    // The person fixes it by hand (a `!` command, say): a .env, and a scratch database.
    writeFileSync(join(made.path, ".env"), "TOKEN=mine");
    writeFileSync(join(made.path, "scratch.db"), "mine");
    await t.w.rerun(made.sessionId);
    await until(() => t.state(made.sessionId).setup === undefined);
    await until(() => !!t.runner.look.sessions.worktree!(made.sessionId)?.known?.["seed.db"]);
    const rec = t.runner.look.sessions.worktree!(made.sessionId)!;
    expect(Object.keys(rec.known!).sort()).toEqual(["seed.db"]);
    expect(precious((await ignoredFiles(made.path))!, rec.known)).toEqual([".env", "scratch.db"]);
  });

  test("small ignored files carry a content hash: an edit that keeps size and time still counts", async () => {
    const r = repo();
    writeFileSync(join(r.dir, ".gitignore"), ".env\n");
    sh(r.dir, "add", ".");
    sh(r.dir, "commit", "-qm", "ignore");
    const path = await addWorktree(r.dir, "tether/hash", "main");
    // A whole-second time, so it can be set back exactly.
    const when = new Date(1_700_000_000_000);
    writeFileSync(join(path, ".env"), "A=1");
    utimesSync(join(path, ".env"), when, when);
    const known = (await ignoredFiles(path))!;
    expect(known[".env"]![2]).toMatch(/^[0-9a-f]{40}$/);
    writeFileSync(join(path, ".env"), "B=2");
    utimesSync(join(path, ".env"), when, when);
    const now = (await ignoredFiles(path))!;
    expect(now[".env"]!.slice(0, 2)).toEqual(known[".env"]!.slice(0, 2));
    expect(precious(now, known)).toEqual([".env"]);
  });

  test("git runs in the C locale, so the error text matched is git's English", async () => {
    const r = await runGit(scratch(), ["-c", "alias.lc=!echo $LC_ALL", "lc"]);
    expect(r.out).toBe("C");
  });

  test("a ! command while the worktree's setup runs is refused; once it has failed, it runs", async () => {
    const t = runnerFor();
    const r = withSetup("#!/bin/sh\nsleep 0.5\nexit 1\n");
    const made = await t.w.create({ harness: "claude", projectPath: r.dir, branch: "tether/bang" });
    await expect(t.runner.shellRuns.run(made.sessionId, "touch x")).rejects.toThrow("setup is still running");
    await until(() => t.state(made.sessionId).setup === "failed");
    await t.runner.shellRuns.run(made.sessionId, "touch x");
    await until(() => existsSync(join(made.path, "x")));
  });
});

describe("Existing worktree", () => {
  test("a session going on under another id (a source change, a renewal) takes its worktree record along; the old id stops counting", async () => {
    const t = runnerFor();
    const r = repo();
    const made = await t.w.create({ harness: "claude", projectPath: r.dir, branch: "tether/moving" });
    const old = await t.runner.core.open(made.sessionId);
    expect(t.runner.live.keptPrefs(old).worktree).toEqual(t.runner.look.sessions.worktree!(made.sessionId));
    // As replaceWith and renew leave it: the old id moved on, the successor with what it kept.
    const next = await t.runner.look.sessions.create({ harness: "claude", projectPath: made.path, source: "subscription" });
    t.runner.core.o.prefs.set(next, { ...t.runner.live.keptPrefs(old) });
    t.runner.core.o.prefs.set(made.sessionId, { movedTo: next });
    expect(t.runner.look.sessions.worktreeUsers!(made.path).map((u) => u.id)).toEqual([next]);
    // The worktree is still Tether's: one joining now is recorded as such.
    const joined = await t.w.join({ harness: "claude", projectPath: r.dir, worktree: "tether/moving" });
    expect(joined.tether).toBe(true);
  });

  test("only a live user's record on the worktree's current branch is trusted: an archived one's, or one on another branch, means made by hand", async () => {
    const t = runnerFor();
    const r = repo();
    const made = await t.w.create({ harness: "claude", projectPath: r.dir, branch: "tether/old" });
    await t.runner.look.sessions.setArchived(made.sessionId, true);
    const a = await t.w.join({ harness: "claude", projectPath: r.dir, worktree: "tether/old" });
    expect(a.tether).toBeUndefined();
    expect(t.runner.look.sessions.worktree!(a.sessionId)).toMatchObject({ handMade: true });
    const other = await t.w.create({ harness: "claude", projectPath: r.dir, branch: "tether/two" });
    sh(other.path, "switch", "-qc", "elsewhere");
    expect((await t.w.join({ harness: "claude", projectPath: r.dir, worktree: "elsewhere" })).tether).toBeUndefined();
    expect((await t.w.list(r.dir)).worktrees.find((w) => w.path === other.path)!.tether).toBeUndefined();
  });

  test("joining waits for a removal under way on that worktree, then finds it gone", async () => {
    const t = runnerFor();
    const r = repo();
    const made = await t.w.create({ harness: "claude", projectPath: r.dir, branch: "tether/going" });
    let release!: () => void;
    const held = lockWorktree(made.path, async () => {
      await new Promise<void>((done) => (release = done));
      sh(r.dir, "worktree", "remove", "--force", made.path);
    });
    const joining = t.w.join({ harness: "claude", projectPath: r.dir, worktree: "tether/going" });
    await Bun.sleep(50);
    const n = t.adapter.drivers.length;
    release();
    await held;
    await expect(joining).rejects.toThrow("isn't there any more");
    expect(t.adapter.drivers.length).toBe(n);
  });

  test("pickWorktree: by path (typed loosely), else branch, else folder name", () => {
    const list = [{ path: "/r/app-worktrees/fix", branch: "tether/fix" }, { path: "/r/hand", branch: "gavin/hand" }, { path: "/r/detached" }];
    expect(pickWorktree(list, "/r/hand/")?.path).toBe("/r/hand");
    expect(pickWorktree(list, "~/hand", (p) => p.replace("~", "/r"))?.path).toBe("/r/hand");
    expect(pickWorktree(list, "tether/fix")?.path).toBe("/r/app-worktrees/fix");
    expect(pickWorktree(list, "refs/heads/gavin/hand")?.path).toBe("/r/hand");
    expect(pickWorktree(list, "detached")?.path).toBe("/r/detached");
    expect(pickWorktree(list, "nope")).toBeUndefined();
    expect(pickWorktree(list, " ")).toBeUndefined();
    // A folder name two share says neither; a path or branch always wins over one.
    const two = [...list, { path: "/s/hand", branch: "other" }, { path: "/r/x", branch: "hand" }];
    expect(pickWorktree(two.slice(0, 4), "hand")).toBeUndefined();
    expect(pickWorktree(two, "hand")?.path).toBe("/r/x");

  });

  test("lists the repo's worktrees (not the main checkout) with who works in each; joining runs no setup and records the session as a user", async () => {
    const t = runnerFor();
    const { worktreesModule } = await import(".");
    await worktreesModule.start({ ...t.runner.look, bus: t.runner.bus, ops: t.runner.ops, dataDir: scratch(), log: () => {}, runnerId: "t", appUrl: "http://x" } as never);
    const r = withSetup('#!/bin/sh\necho x >> .setup-runs\n');
    const made = await t.w.create({ harness: "claude", projectPath: r.dir, branch: "tether/shared" });
    await until(() => t.state(made.sessionId).setup === undefined);
    const hand = join(r.root, "hand");
    sh(r.dir, "worktree", "add", "-qb", "gavin/hand", hand);
    expect(await t.w.list(scratch())).toEqual({ worktrees: [] });
    const listed = await t.w.list(r.dir);
    expect(listed.repo).toBe(r.dir);
    expect(listed.worktrees).toMatchObject([
      { path: made.path, branch: "tether/shared", tether: true },
      { path: hand, branch: "gavin/hand", sessions: [] },
    ]);
    expect(listed.worktrees[0]!.sessions.map((x) => x.id)).toEqual([made.sessionId]);
    expect(listed.worktrees[1]!.tether).toBeUndefined();
    // Joining by branch: the session runs there, nothing made, the setup not run again.
    const cards = t.cards(made.sessionId).length;
    const joined = (await t.runner.ops.handle("existingWorktreeSession", { harness: "claude", projectPath: r.dir, worktree: "tether/shared" })) as any;
    expect(joined).toMatchObject({ ok: true, data: { path: made.path, branch: "tether/shared", tether: true } });
    const guest = joined.data.sessionId as string;
    const s = t.runner.core.sessions.get(guest)!;
    expect(s.summary.projectPath).toBe(made.path);
    expect(s.summary.worktreeOf).toBe(r.dir);
    expect(t.runner.look.sessions.worktree!(guest)).toEqual({ path: made.path, branch: "tether/shared", repo: r.dir, joined: true });
    expect(t.state(guest).setup).toBeUndefined();
    expect(t.cards(guest)).toHaveLength(0);
    expect(t.cards(made.sessionId)).toHaveLength(cards);
    expect(readFileSync(join(made.path, ".setup-runs"), "utf8")).toBe("x\n");
    await t.runner.live.send(guest, "hello");
    await until(() => t.adapter.drivers.at(-1)?.sent.includes("hello") ?? false);
    // Both are its users now, in the list and to cleanup.
    expect((await t.w.list(r.dir)).worktrees[0]!.sessions.map((x) => x.id).sort()).toEqual([made.sessionId, guest].sort());
    expect(t.runner.look.sessions.worktreeUsers!(made.path).map((u) => u.id).sort()).toEqual([made.sessionId, guest].sort());
    // One made by hand, by path: recorded, but as never Tether's to remove.
    const byHand = await t.w.join({ harness: "claude", projectPath: r.dir, worktree: `${hand}/` });
    expect(byHand).toMatchObject({ path: hand, branch: "gavin/hand" });
    expect(byHand.tether).toBeUndefined();
    expect(t.runner.look.sessions.worktree!(byHand.sessionId)).toEqual({ path: hand, branch: "gavin/hand", repo: r.dir, joined: true, handMade: true });
    // The main checkout, one that isn't there, and a folder outside git are refused, and nothing starts.
    const n = t.adapter.drivers.length;
    await expect(t.w.join({ harness: "claude", projectPath: r.dir, worktree: r.dir })).rejects.toThrow("main checkout");
    await expect(t.w.join({ harness: "claude", projectPath: r.dir, worktree: "tether/nope" })).rejects.toThrow("isn't one of");
    await expect(t.w.join({ harness: "claude", projectPath: scratch(), worktree: "x" })).rejects.toThrow("isn't in a git repository");
    expect(t.adapter.drivers.length).toBe(n);
  });
});

describe("Cleanup on archive", () => {
  /** A session in a new worktree whose work is committed there and fast-forwarded into main. */
  async function merged(t: ReturnType<typeof runnerFor>, dir: string, branch: string) {
    const made = await t.w.create({ harness: "claude", projectPath: dir, branch });
    writeFileSync(join(made.path, `${folderForBranch(branch)}.txt`), "x");
    sh(made.path, "add", ".");
    sh(made.path, "commit", "-qm", branch);
    sh(dir, "merge", "-q", "--ff-only", branch);
    return made;
  }
  const archive = (t: ReturnType<typeof runnerFor>, id: string) => t.runner.look.sessions.setArchived(id, true);
  const notices = (t: ReturnType<typeof runnerFor>, id: string) => (t.runner.core.sessions.get(id)?.transcript?.messages ?? []).filter((m) => m.role === "notice" && m.id.startsWith("n-worktree-")).map((m) => (m.parts[0] as { text: string }).text);

  test("merged: the worktree Tether made goes with its branch, and the session says so; unmerged work keeps it, with why", async () => {
    const t = runnerFor();
    const r = repo();
    const done = await merged(t, r.dir, "tether/done");
    await archive(t, done.sessionId);
    expect(await t.w.cleanUp(done.sessionId)).toEqual({ removed: true });
    expect(existsSync(done.path)).toBe(false);
    expect(sh(r.dir, "branch", "--list", "tether/done")).toBe("");
    expect(notices(t, done.sessionId)).toEqual([`Archived: everything was merged. Tether removed its worktree ${done.path} and branch tether/done.`]);
    // A commit only on its branch: kept, and said why.
    const open = await t.w.create({ harness: "claude", projectPath: r.dir, branch: "tether/open" });
    writeFileSync(join(open.path, "g.txt"), "x");
    sh(open.path, "add", ".");
    sh(open.path, "commit", "-qm", "wip");
    await archive(t, open.sessionId);
    expect((await t.w.cleanUp(open.sessionId))?.why).toContain("aren't in main");
    expect(existsSync(open.path)).toBe(true);
    expect(notices(t, open.sessionId)[0]).toContain(`Tether kept its worktree ${open.path}: its worktree ${open.path} has commits that aren't in main`);
    // Merged but with uncommitted changes: git's own non-forced remove refuses, so it stays.
    const dirty = await merged(t, r.dir, "tether/dirty");
    writeFileSync(join(dirty.path, "README.md"), "changed\n");
    await archive(t, dirty.sessionId);
    expect((await t.w.cleanUp(dirty.sessionId))?.removed).toBe(false);
    expect(existsSync(join(dirty.path, "README.md"))).toBe(true);
  });

  test("a worktree several sessions share goes only with the last of them; one made by hand never does", async () => {
    const t = runnerFor();
    const r = repo();
    const made = await merged(t, r.dir, "tether/shared");
    const guest = await t.w.join({ harness: "claude", projectPath: r.dir, worktree: "tether/shared" });
    await archive(t, made.sessionId);
    expect(await t.w.cleanUp(made.sessionId)).toEqual({ removed: false, why: `another session works in ${made.path}` });
    expect(existsSync(made.path)).toBe(true);
    // Quietly: the other session is still at work there.
    expect(notices(t, made.sessionId)).toEqual([]);
    await archive(t, guest.sessionId);
    expect(await t.w.cleanUp(guest.sessionId)).toEqual({ removed: true });
    expect(existsSync(made.path)).toBe(false);
    // A session in the worktree's folder with no record counts too.
    const two = await merged(t, r.dir, "tether/two");
    const plain = (await t.runner.ops.call("newSession", { harness: "claude", projectPath: two.path })) as { sessionId: string };
    await t.runner.live.send(plain.sessionId, "hi");
    await until(() => t.runner.look.sessions.list().some((x) => x.id === plain.sessionId));
    await archive(t, two.sessionId);
    expect((await t.w.cleanUp(two.sessionId))?.why).toContain("another session works in");
    // By hand: recorded, never removed.
    const hand = join(r.root, "hand");
    sh(r.dir, "worktree", "add", "-qb", "gavin/hand", hand);
    const byHand = await t.w.join({ harness: "claude", projectPath: r.dir, worktree: hand });
    await archive(t, byHand.sessionId);
    expect(await t.w.cleanUp(byHand.sessionId)).toBeUndefined();
    expect(existsSync(hand)).toBe(true);
  });

  test("a removal waits for a join under way on that worktree, and then sees the new user", async () => {
    const t = runnerFor();
    const r = repo();
    const made = await merged(t, r.dir, "tether/racing");
    let release!: () => void;
    const joining = lockWorktree(made.path, async () => {
      await new Promise<void>((done) => (release = done));
      const guest = await t.runner.look.sessions.create({ harness: "claude", projectPath: r.root, source: "subscription" });
      await t.runner.look.sessions.setWorktree!(guest, { path: made.path, branch: "tether/racing", repo: r.dir, joined: true });
    });
    await archive(t, made.sessionId);
    const cleaning = t.w.cleanUp(made.sessionId);
    await Bun.sleep(200);
    expect(existsSync(made.path)).toBe(true);
    release();
    await joining;
    expect((await cleaning)?.why).toContain(`another session works in ${made.path}`);
    expect(existsSync(made.path)).toBe(true);
  });

  test("never while the session has work going, a process outside Tether works there, or it was unarchived", async () => {
    let outside = 1;
    const t = runnerFor({ usersOf: () => outside });
    const r = repo();
    const made = await merged(t, r.dir, "tether/busy");
    await archive(t, made.sessionId);
    expect((await t.w.cleanUp(made.sessionId))?.why).toBe("1 process outside Tether works in it (a tmux session or a server, say)");
    expect(existsSync(made.path)).toBe(true);
    outside = 0;
    // Unarchived again before the removal: it's in use.
    await t.runner.look.sessions.setArchived(made.sessionId, false);
    expect((await t.w.cleanUp(made.sessionId))?.removed).toBe(false);
    expect(existsSync(made.path)).toBe(true);
    // A message waiting in its queue: kept.
    t.runner.core.sessions.get(made.sessionId)!.state.queue.push({ id: "q1", text: "later", at: Date.now() + 60_000 } as never);
    await archive(t, made.sessionId);
    expect((await t.w.cleanUp(made.sessionId))?.why).toBe("it has messages waiting");
    expect(existsSync(made.path)).toBe(true);
  });

  test("another session that uses it, archived but still at work, keeps it; once idle, it goes", async () => {
    const t = runnerFor();
    const r = repo();
    const made = await merged(t, r.dir, "tether/both");
    const guest = await t.w.join({ harness: "claude", projectPath: r.dir, worktree: "tether/both" });
    await t.runner.core.open(guest.sessionId);
    // The guest is archived, but a message still waits to go to it.
    await archive(t, guest.sessionId);
    t.runner.core.sessions.get(guest.sessionId)!.state.queue.push({ id: "q1", text: "later", at: Date.now() + 60_000 } as never);
    expect((await t.w.cleanUp(guest.sessionId))?.why).toBe("it has messages waiting");
    await archive(t, made.sessionId);
    expect((await t.w.cleanUp(made.sessionId))?.why).toBe(`session ${guest.sessionId}: it has messages waiting`);
    expect(existsSync(made.path)).toBe(true);
    t.runner.core.sessions.get(guest.sessionId)!.state.queue.length = 0;
    expect(await t.w.cleanUp(made.sessionId)).toEqual({ removed: true });
  });

  test("work that starts while it waits for the worktree's lock (the fetch, a join) keeps it", async () => {
    const t = runnerFor();
    const r = repo();
    const made = await merged(t, r.dir, "tether/late");
    await archive(t, made.sessionId);
    let release!: () => void;
    const held = lockWorktree(made.path, () => new Promise<void>((done) => (release = done)));
    const cleaning = t.w.cleanUp(made.sessionId);
    await Bun.sleep(50);
    // A turn starts meanwhile (an archived session can still be sent to).
    t.runner.core.sessions.get(made.sessionId)!.state.status = "running";
    release();
    await held;
    expect((await cleaning)?.why).toBe("it's still running a turn");
    expect(existsSync(made.path)).toBe(true);
  });

  test("a rate-limit retry waiting, or a setup still running, counts as work going", () => {
    const look = (state: object) => ({ summary: { id: "claude:x", projectPath: "/p" }, status: "idle", requests: [], busy: false, background: false, state: { queue: [], ...state } }) as never;
    expect(busyWhy(look({}))).toBeUndefined();
    expect(busyWhy(look({ retry: { id: "r", phase: "waiting" } }))).toBe("it's waiting to retry after a rate limit");
    expect(busyWhy(look({ setup: "running" }))).toBe("its setup is still running");
    expect(busyWhy(look({ setup: "failed" }))).toBeUndefined();
  });

  test("an open side chat of the session keeps it; closed (archived), it goes", async () => {
    const t = runnerFor();
    const r = repo();
    const made = await merged(t, r.dir, "tether/side");
    t.adapter.addStored("side-1", [], { projectPath: made.path });
    t.runner.core.o.prefs.set("claude:side-1", { projectPath: made.path, sideOf: made.sessionId });
    await archive(t, made.sessionId);
    expect((await t.w.cleanUp(made.sessionId))?.why).toBe("its side chat claude:side-1 is open");
    expect(existsSync(made.path)).toBe(true);
    await archive(t, "claude:side-1");
    expect(await t.w.cleanUp(made.sessionId)).toEqual({ removed: true });
  });

  test("when Tether can't tell whether a process outside it works there, it stays", async () => {
    const t = runnerFor({ usersOf: () => undefined });
    const r = repo();
    const made = await merged(t, r.dir, "tether/unsure");
    await archive(t, made.sessionId);
    expect((await t.w.cleanUp(made.sessionId))?.why).toBe("Tether can't tell whether a process outside it works there");
    expect(existsSync(made.path)).toBe(true);
  });

  test("outsideUsers: no /proc, or an empty one, is unknown; a process working there is counted", () => {
    const d = scratch();
    expect(outsideUsers(d, join(d, "no-proc"))).toBeUndefined();
    const proc = join(d, "proc");
    mkdirSync(proc);
    expect(outsideUsers(d, proc)).toBeUndefined();
    const work = join(d, "work");
    mkdirSync(work);
    mkdirSync(join(proc, "4242"));
    symlinkSync(work, join(proc, "4242", "cwd"));
    writeFileSync(join(proc, "4242", "stat"), "4242 (dev server) S 1 0 0");
    expect(outsideUsers(work, proc)).toBe(1);
    expect(outsideUsers(join(d, "elsewhere"), proc)).toBe(0);
  });

  test("the sweep retries what was kept (or cut short by a restart) quietly, and is idempotent", async () => {
    const t = runnerFor();
    const r = repo();
    const made = await merged(t, r.dir, "tether/swept");
    const moved = await merged(t, r.dir, "tether/moved-on");
    await archive(t, made.sessionId);
    await archive(t, moved.sessionId);
    // Busy when archived: kept, and said once.
    t.runner.core.sessions.get(made.sessionId)!.state.queue.push({ id: "q1", text: "later", at: Date.now() + 60_000 } as never);
    expect((await t.w.cleanUp(made.sessionId))?.removed).toBe(false);
    // Another worktree's folder is on another branch now (made again by hand there, say): not Tether's to sweep.
    sh(moved.path, "switch", "-qc", "by-hand");
    // Still busy: the sweep keeps it without another notice.
    await t.w.sweep();
    expect(existsSync(made.path)).toBe(true);
    expect(notices(t, made.sessionId)).toHaveLength(1);
    t.runner.core.sessions.get(made.sessionId)!.state.queue.length = 0;
    await t.w.sweep();
    expect(existsSync(made.path)).toBe(false);
    expect(existsSync(moved.path)).toBe(true);
    expect(notices(t, made.sessionId).at(-1)).toContain("Tether removed its worktree");
    await t.w.sweep();
    expect(notices(t, made.sessionId)).toHaveLength(2);
  });

  test("sending to an archived session unarchives it", async () => {
    const t = runnerFor();
    const r = repo();
    const made = await merged(t, r.dir, "tether/revived");
    await archive(t, made.sessionId);
    await t.runner.live.send(made.sessionId, "one more thing");
    expect(t.runner.core.o.prefs.get(made.sessionId).archived).toBeUndefined();
    expect((await t.w.cleanUp(made.sessionId))?.removed).toBeFalsy();
    expect(existsSync(made.path)).toBe(true);
  });

  test("through the module: archiving a session removes its merged worktree", async () => {
    const t = runnerFor();
    const { worktreesModule } = await import(".");
    const stop = await worktreesModule.start({ ...t.runner.look, bus: t.runner.bus, ops: t.runner.ops, dataDir: scratch(), log: () => {}, runnerId: "t", appUrl: "http://x" } as never);
    if (stop) cleanups.push(stop);
    const r = repo();
    const made = await merged(t, r.dir, "tether/evented");
    await t.runner.ops.call("setSessionArchived", { sessionId: made.sessionId, archived: true });
    await until(() => !existsSync(made.path) && sh(r.dir, "branch", "--list", "tether/evented") === "");
  });

  test("outsideUsers counts a process working in the folder that this runner didn't start", async () => {
    const d = scratch();
    // A worktree's .git file says when it was made: older processes that hide their folder (systemd --user) weren't started there.
    writeFileSync(join(d, ".git"), "gitdir: x\n");
    expect(outsideUsers(d)).toBe(0);
    // Detached, as a tmux server is: once its shell exits it's no longer this process's descendant.
    const p = Bun.spawn(["sh", "-c", "setsid sleep 30 </dev/null >/dev/null 2>&1 & echo $!"], { cwd: d, stdout: "pipe" });
    const pid = Number((await new Response(p.stdout).text()).trim());
    await p.exited;
    cleanups.push(() => {
      try {
        process.kill(pid);
      } catch {}
    });
    await until(() => outsideUsers(d) === 1);
    // One this process started and still parents isn't counted.
    const own = Bun.spawn(["sleep", "30"], { cwd: d });
    cleanups.push(() => own.kill());
    await Bun.sleep(50);
    expect(outsideUsers(d)).toBe(1);
  });
});
