// A worktree per session (SPEC §4), against real git repos in temp folders: where a worktree goes
// and from what, unique branches, folders outside git, the repo's setup (absent, passing, failing)
// gating the first message, and the record that makes the worktree the session's own.

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { folderForBranch, hashSlug, randomSlug, slugOf } from "../../../../shared/worktree";
import { saveConfig } from "../../config";
import { FakeAdapter, idle, say } from "../../core/fakeAdapter";
import { createRunner } from "../../core/runner";
import { Worktrees } from ".";
import { addWorktree, branchNameOk, defaultBase, fetchBase, findSetup, freeBranch, ignoredIn, precious, removeWorktree, repoOf, runGit, setupAt, taken, undoAdd, worktreesDir, type Git } from "./git";
import { removeOwnWorktree } from "../homeAgent/checkIn";

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
    expect(findSetup(a, b)).toEqual({ label: "npm ci", command: "npm ci" });
    mkdirSync(join(a, ".tether"));
    writeFileSync(join(a, ".tether", "setup"), "#!/bin/sh\necho hi\n");
    // Not executable: not a setup.
    expect(findSetup(a, b)).toEqual({ label: "npm ci", command: "npm ci" });
    chmodSync(join(a, ".tether", "setup"), 0o755);
    expect(findSetup(a, b)).toEqual({ label: ".tether/setup", argv: [join(a, ".tether", "setup")], text: "#!/bin/sh\necho hi\n" });
    writeFileSync(join(b, ".tether", "config.json"), "{ not json");
    expect(findSetup(b)).toBeUndefined();
  });
});

function runnerFor(o: { dir?: string; setupMs?: number } = {}) {
  const dir = o.dir ?? scratch();
  const prefsFile = join(dir, "runner.json");
  if (!existsSync(prefsFile)) saveConfig({ runnerId: "t" }, prefsFile);
  const adapter = new FakeAdapter();
  adapter.script = (text) => [say(`a-${text.slice(0, 10)}`, "ok"), idle];
  const runner = createRunner({ url: "http://x", token: "t", runnerId: "t", name: "t", version: "0", detectHarnesses: async () => [], adapters: [adapter], prefsFile, noticesFile: join(dir, "notices.json"), core: { evictMs: 60_000 } });
  cleanups.push(() => (void runner.shellRuns.stopAll(0), runner.core.stop()));
  const logs: string[] = [];
  const w = new Worktrees({ sessions: runner.look.sessions, newSession: (a) => runner.ops.call("newSession", a), log: (l) => logs.push(l), ...(o.setupMs ? { setupMs: o.setupMs } : {}) });
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

  test("ignored files: regenerable folders and what setup left may go; others (a .env) keep the worktree", async () => {
    const r = repo();
    writeFileSync(join(r.dir, ".gitignore"), "node_modules\n.env\ndata.db\nbuild\n");
    sh(r.dir, "add", ".");
    sh(r.dir, "commit", "-qm", "ignore");
    const path = await addWorktree(r.dir, "tether/ig", "main");
    mkdirSync(join(path, "node_modules"));
    writeFileSync(join(path, "node_modules", "x"), "");
    mkdirSync(join(path, "pkg", "build"), { recursive: true });
    writeFileSync(join(path, "pkg", "build", "out"), "");
    writeFileSync(join(path, "data.db"), "");
    const ignored = (await ignoredIn(path))!;
    expect(ignored.sort()).toEqual(["data.db", "node_modules/", "pkg/build/"]);
    expect(precious(ignored)).toEqual(["data.db"]);
    // data.db was there right after setup: it may go.
    expect(precious(ignored, ["data.db"])).toEqual([]);
    writeFileSync(join(path, ".env"), "SECRET=1");
    const own = { path, branch: "tether/ig", repo: r.dir, known: ["data.db"] };
    const kept = await removeOwnWorktree(own, []);
    expect(kept).toMatchObject({ removed: false });
    expect(kept.why).toContain("would delete ignored files: .env");
    expect(existsSync(join(path, ".env"))).toBe(true);
    rmSync(join(path, ".env"));
    expect(await removeOwnWorktree(own, [])).toEqual({ removed: true });
    expect(existsSync(path)).toBe(false);
    expect(sh(r.dir, "branch", "--list", "tether/ig")).toBe("");
  });

  test("Archive done: a branch with work not in main is never deleted, even when HEAD moved to merged work", async () => {
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
});
