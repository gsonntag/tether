// The check-in's pieces: the message, reading an answer, deciding, skipping busy sessions, and
// checking the answer (merged, worktrees cleaned up) against real git repos.

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionSummary } from "../../../../shared/transcript";
import { ANSWER_TAG, checkInMessage, judge, parseAnswer, skipReason, verify } from "./checkIn";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

test("the check-in message asks for the tagged line and a cleanup that spares other sessions' folders", () => {
  const m = checkInMessage("/r/wt-a", ["/r/main", "/r/wt-b", "/r/wt-a"]);
  expect(m).toContain(ANSWER_TAG);
  expect(m).toContain("Don't start or continue any task work");
  expect(m).toContain('"cleaned_up": true');
  expect(m).toContain("git worktree remove <path>, without --force");
  expect(m).toContain("git branch -d <branch>, never -D");
  expect(m).toContain("the main checkout");
  expect(m).toContain("your own folder (/r/wt-a)");
  expect(m).toContain("other sessions are using:\n     /r/main\n     /r/wt-b\n");
  expect(m.split("/r/wt-a").length).toBe(2);
  expect(checkInMessage("/r/x")).toContain("any worktree you didn't create yourself.");
});

test("parseAnswer reads the last tagged line, and nothing else", () => {
  expect(parseAnswer(`All merged in #12.\n${ANSWER_TAG} {"done": true, "merged": true, "cleaned_up": true, "branch": "fix-x", "worktree": null, "note": "PR #12 merged"}`)).toEqual({ done: true, merged: true, cleanedUp: true, branch: "fix-x", note: "PR #12 merged" });
  expect(parseAnswer(`\`${ANSWER_TAG} {"done": false, "merged": false, "branch": "null"}\``)).toEqual({ done: false, merged: false });
  expect(parseAnswer(`${ANSWER_TAG} {"done": true, "merged": true, "cleaned_up": "yes"}`)).toEqual({ done: true, merged: true });
  // Earlier lines (an example, a quote) lose to the last one.
  expect(parseAnswer(`${ANSWER_TAG} {"done": true, "merged": true}\nActually:\n${ANSWER_TAG} {"done": true, "merged": false}`)?.merged).toBe(false);
  // JSON on the following lines.
  expect(parseAnswer(`${ANSWER_TAG}\n\`\`\`json\n{"done": true, "merged": true}\n\`\`\``)).toEqual({ done: true, merged: true });
  expect(parseAnswer("I'm done and it's merged.")).toBeUndefined();
  expect(parseAnswer(`${ANSWER_TAG} {"done": "yes", "merged": true}`)).toBeUndefined();
  expect(parseAnswer(`${ANSWER_TAG} {not json}`)).toBeUndefined();
  expect(parseAnswer(undefined)).toBeUndefined();
});

test("judge archives only done, merged, cleaned-up work git agrees with", () => {
  const none = { unmerged: [], leftover: [] };
  expect(judge({ done: true, merged: true, cleanedUp: true }, none)).toEqual({ archive: true, reason: "done, merged and cleaned up" });
  expect(judge(undefined, none).archive).toBe(false);
  expect(judge({ done: false, merged: true, note: "tests failing" }, none).reason).toBe("not done: tests failing");
  expect(judge({ done: true, merged: false, branch: "b" }, none).reason).toContain("not merged or applied");
  const v = judge({ done: true, merged: true, cleanedUp: true }, { unmerged: ["branch b has commits not in main"], leftover: [] });
  expect(v.archive).toBe(false);
  expect(v.reason).toContain("git disagrees");
  // A worktree left behind keeps it, whatever it says.
  expect(judge({ done: true, merged: true, cleanedUp: true }, { unmerged: [], leftover: ["/r/wt"] })).toEqual({ archive: false, reason: "done and merged, but its worktree is still there: /r/wt" });
  expect(judge({ done: true, merged: true, cleanedUp: false, note: "wt in use" }, none)).toEqual({ archive: false, reason: "done and merged, but it didn't clean up its worktrees: wt in use" });
  expect(judge({ done: true, merged: true }, none).reason).toContain("didn't say whether it cleaned up");
});

test("skipReason leaves busy sessions alone", () => {
  const row = { id: "claude:x", status: "idle", mode: "live" } as SessionSummary;
  const look = (o: Record<string, unknown> = {}, state: Record<string, unknown> = {}) => ({ summary: row, status: "idle", requests: [], busy: false, background: false, state: { queue: [], ...state }, ...o }) as any;
  expect(skipReason(row, look())).toBeUndefined();
  expect(skipReason(row, undefined)).toBeUndefined();
  expect(skipReason({ ...row, status: "running" }, undefined)).toBe("it's running a turn");
  expect(skipReason(row, look({ status: "running" }))).toBe("it's running a turn");
  expect(skipReason(row, look({ requests: ["r"] }))).toBe("it's waiting for the person");
  expect(skipReason(row, look({ busy: true }))).toBe("it has work running");
  expect(skipReason(row, look({}, { queue: [{ id: "q" }] }))).toBe("it has messages queued");
  expect(skipReason({ ...row, mode: "terminal" }, look())).toBe("it's open in a terminal");
});

async function sh(cwd: string, ...cmd: string[]) {
  const p = Bun.spawn(cmd, { cwd, stdout: "ignore", stderr: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  if ((await p.exited) !== 0) throw new Error(`${cmd.join(" ")}: ${await new Response(p.stderr).text()}`);
}

async function repo() {
  const dir = mkdtempSync(join(tmpdir(), "tether-checkin-"));
  dirs.push(dir);
  const main = join(dir, "repo");
  await sh(dir, "git", "init", "-q", "-b", "main", main);
  writeFileSync(join(main, "a.txt"), "a\n");
  await sh(main, "git", "add", ".");
  await sh(main, "git", "commit", "-qm", "init");
  return { dir, main };
}

const ok = { done: true, merged: true, cleanedUp: true };
const clean = { unmerged: [], leftover: [] };

test("verify: a merged branch passes, an unmerged one doesn't, a deleted one passes", async () => {
  const { main } = await repo();
  await sh(main, "git", "checkout", "-qb", "feature");
  writeFileSync(join(main, "b.txt"), "b\n");
  await sh(main, "git", "add", ".");
  await sh(main, "git", "commit", "-qm", "feature");
  await sh(main, "git", "checkout", "-q", "main");
  expect(await verify(main, { ...ok, branch: "feature" })).toEqual({ unmerged: ["branch feature has commits not in main"], leftover: [] });
  await sh(main, "git", "merge", "-q", "--no-ff", "-m", "merge", "feature");
  expect(await verify(main, { ...ok, branch: "feature" })).toEqual(clean);
  expect(await verify(main, { ...ok, branch: "gone-after-merge" })).toEqual(clean);
});

test("verify: a squash-merged branch counts as merged", async () => {
  const { main } = await repo();
  await sh(main, "git", "checkout", "-qb", "squashed");
  writeFileSync(join(main, "c.txt"), "c\n");
  await sh(main, "git", "add", ".");
  await sh(main, "git", "commit", "-qm", "c");
  await sh(main, "git", "checkout", "-q", "main");
  await sh(main, "git", "merge", "-q", "--squash", "squashed");
  await sh(main, "git", "commit", "-qm", "squash");
  expect(await verify(main, { ...ok, branch: "squashed" })).toEqual(clean);
});

test("verify: the session's own worktree must be clean and merged, and it's never a leftover", async () => {
  const { dir, main } = await repo();
  const wt = join(dir, "wt");
  await sh(main, "git", "worktree", "add", "-qb", "wt-branch", wt);
  expect(await verify(wt, { ...ok, worktree: wt, branch: "wt-branch" })).toEqual(clean);
  writeFileSync(join(wt, "d.txt"), "d\n");
  expect((await verify(wt, ok)).unmerged).toEqual([`its worktree ${wt} has 1 uncommitted change`]);
  await sh(wt, "git", "add", ".");
  await sh(wt, "git", "commit", "-qm", "d");
  expect((await verify(wt, ok)).unmerged).toEqual([`its worktree ${wt} is on wt-branch, which has commits not in main`]);
  // The main checkout's uncommitted changes are applied work.
  writeFileSync(join(main, "e.txt"), "e\n");
  expect(await verify(main, ok)).toEqual(clean);
});

test("verify: a worktree the session made that's still there is a leftover, unless another session uses it", async () => {
  const { dir, main } = await repo();
  const made = join(dir, "made");
  const theirs = join(dir, "theirs");
  await sh(main, "git", "worktree", "add", "-qb", "made-branch", made);
  await sh(main, "git", "worktree", "add", "-qb", "their-branch", theirs);
  // Named by path, or found by its branch.
  expect(await verify(main, { ...ok, worktree: made })).toEqual({ unmerged: [], leftover: [made] });
  expect(await verify(main, { ...ok, branch: "made-branch" })).toEqual({ unmerged: [], leftover: [made] });
  // Another session's folder isn't its to remove.
  expect(await verify(main, { ...ok, worktree: theirs }, undefined, undefined, [theirs])).toEqual(clean);
  // Removed: nothing left.
  await sh(main, "git", "worktree", "remove", made);
  await sh(main, "git", "branch", "-d", "made-branch");
  expect(await verify(main, { ...ok, worktree: made, branch: "made-branch" })).toEqual(clean);
});

test("verify: no git, nothing found", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tether-checkin-"));
  dirs.push(dir);
  expect(await verify(dir, { ...ok, branch: "x" })).toEqual(clean);
  expect(await verify(join(dir, "missing"), ok)).toEqual(clean);
});
