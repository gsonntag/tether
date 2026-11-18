// live_state's checks against real git repos (a bare origin and clones), with gh faked.

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit } from "./checkIn";
import { folderState, liveState, parsePrRef, prState, when, type Gh, type LiveDeps } from "./liveState";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const NOW = Date.parse("2026-11-18T09:20:00Z");

function sh(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

/** A bare origin with main, and a clone of it. */
function repo() {
  const d = mkdtempSync(join(tmpdir(), "tether-live-"));
  dirs.push(d);
  const origin = join(d, "origin.git");
  sh(d, "init", "--bare", "-b", "main", origin);
  const seed = join(d, "seed");
  sh(d, "clone", origin, seed);
  sh(seed, "checkout", "-b", "main");
  writeFileSync(join(seed, "a.txt"), "a");
  sh(seed, "add", ".");
  sh(seed, "commit", "-m", "first");
  sh(seed, "push", "origin", "main");
  const clone = join(d, "clone");
  sh(d, "clone", origin, clone);
  return { d, origin, seed, clone };
}

const fakeGh =
  (answers: Record<string, { out?: string; error?: string }>, calls: string[][] = []): Gh =>
  async (_cwd, args) => {
    calls.push(args);
    return answers[args.slice(0, 2).join(" ")] ?? { error: "no answer" };
  };

const deps = (gh: Gh = fakeGh({})): LiveDeps => ({ git: runGit(), fetch: runGit(20_000), gh, now: () => NOW });

test("parsePrRef takes numbers, owner/repo#n and URLs, and nothing that could be an option", () => {
  expect(parsePrRef("95")).toEqual({ number: 95 });
  expect(parsePrRef("#95")).toEqual({ number: 95 });
  expect(parsePrRef("gsonntag/tether#95")).toEqual({ repo: "gsonntag/tether", number: 95 });
  expect(parsePrRef("https://github.com/gsonntag/tether/pull/95/files")).toEqual({ repo: "gsonntag/tether", number: 95 });
  expect(parsePrRef("--web")).toBeUndefined();
  expect(parsePrRef("95; rm -rf /")).toBeUndefined();
  expect(parsePrRef("https://evil.com/a/b/pull/1")).toBeUndefined();
});

test("when gives ISO and how long ago", () => {
  expect(when("2026-11-18T08:48:56Z", NOW)).toBe("2026-11-18T08:48:56Z (31m ago)");
  expect(when(undefined, NOW)).toBe("unknown time");
});

test("prState reports a merged PR as merged, with when and the merge commit", async () => {
  const calls: string[][] = [];
  const gh = fakeGh({ "pr view": { out: JSON.stringify({ number: 95, title: "Files marks", url: "https://github.com/o/r/pull/95", state: "MERGED", isDraft: false, mergedAt: "2026-11-18T08:48:56Z", mergeCommit: { oid: "026e542ae6fbd21ca4e8eaf6da95607460973614" }, headRefName: "files-changed-marks", baseRefName: "main", statusCheckRollup: [], reviewDecision: "" }) } }, calls);
  const s = await prState("o/r#95", undefined, deps(gh));
  expect(s).toContain('PR #95 "Files marks" (https://github.com/o/r/pull/95), files-changed-marks → main');
  expect(s).toContain("State: MERGED at 2026-11-18T08:48:56Z (31m ago), merge commit 026e542.");
  expect(s).toContain("Checks: none reported.");
  expect(calls[0]).toEqual(["pr", "view", "95", "--json", expect.any(String), "--repo", "o/r"]);
});

test("prState: open with failing checks, gh errors, and bad references", async () => {
  const gh = fakeGh({ "pr view": { out: JSON.stringify({ number: 7, title: "x", url: "u", state: "OPEN", isDraft: true, updatedAt: "2026-11-18T09:00:00Z", statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" }], reviewDecision: "CHANGES_REQUESTED" }) } });
  const s = await prState("7", "/tmp", deps(gh));
  expect(s).toContain("State: OPEN (draft), not merged.");
  expect(s).toContain("Checks: failing. Review: changes requested.");
  expect(await prState("7", "/tmp", deps(fakeGh({ "pr view": { error: "not found" } })))).toBe("PR #7: couldn't check (not found).");
  expect(await prState("7", undefined, deps())).toContain("say which repo");
  expect(await prState("-x", "/tmp", deps())).toContain("not a PR reference");
});

test("folderState: a branch that's pushed and merged on origin reads as merged, with its PR", async () => {
  const { seed, clone } = repo();
  sh(clone, "checkout", "-b", "feat");
  writeFileSync(join(clone, "b.txt"), "b");
  sh(clone, "add", ".");
  sh(clone, "commit", "-m", "feat work");
  sh(clone, "push", "-u", "origin", "feat");
  // Before the merge: pushed, not on main.
  const gh = fakeGh({ "pr list": { out: JSON.stringify([{ number: 3, state: "OPEN", url: "https://github.com/o/r/pull/3", baseRefName: "main" }]) } });
  let s = await folderState(clone, deps(gh));
  expect(s).toContain("On branch feat");
  expect(s).toContain("No uncommitted changes.");
  expect(s).toContain("Pushed: same as origin/feat.");
  expect(s).toContain("Not in origin/main: 1 commit here");
  expect(s).toContain("PR #3 (https://github.com/o/r/pull/3) into main: OPEN, not merged.");
  // Someone merges it elsewhere: the clone hasn't fetched, live_state does.
  sh(seed, "fetch", "origin");
  sh(seed, "merge", "--ff-only", "origin/feat");
  sh(seed, "push", "origin", "main");
  const merged = fakeGh({ "pr list": { out: JSON.stringify([{ number: 3, state: "MERGED", url: "u3", baseRefName: "main", mergedAt: "2026-11-18T09:00:00Z" }]) } });
  s = await folderState(clone, deps(merged));
  expect(s).toContain("Merged: every commit here is in origin/main.");
  expect(s).toContain("PR #3 (u3) into main: MERGED at 2026-11-18T09:00:00Z (20m ago).");
  expect(s).toContain("feat work");
});

test("folderState: unpushed commits, uncommitted changes, a removed worktree", async () => {
  const { d, clone } = repo();
  sh(clone, "checkout", "-b", "wip");
  writeFileSync(join(clone, "c.txt"), "c");
  sh(clone, "add", ".");
  sh(clone, "commit", "-m", "wip");
  writeFileSync(join(clone, "dirty.txt"), "x");
  const s = await folderState(clone, deps(fakeGh({ "pr list": { out: "[]" } })));
  expect(s).toContain("1 uncommitted change");
  expect(s).toContain("Not pushed: origin has no branch wip");
  expect(s).toContain("No PR from wip.");
  // A worktree, then removed.
  const wt = join(d, "wt");
  sh(clone, "worktree", "add", "-b", "wt-branch", wt);
  expect(await folderState(wt, deps())).toContain(`It's a worktree of ${clone}.`);
  sh(clone, "worktree", "remove", wt);
  const gone = await folderState(wt, deps(), clone);
  expect(gone).toContain("It no longer exists");
  expect(gone).toContain("The repo's worktrees now");
});

test("liveState sets the live facts apart from the session's last message", async () => {
  const s = await liveState({ folder: "/nonexistent-tether-folder", last: NOW - 30 * 60_000 }, deps());
  expect(s.startsWith("LIVE, checked just now (2026-11-18T09:20:00Z).")).toBe(true);
  expect(s).toContain("The session's last message was at 2026-11-18T08:50:00Z (30m ago)");
  expect(s).toContain("It no longer exists");
});
