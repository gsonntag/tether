// The check-in's pieces: the message, reading an answer, deciding, skipping busy sessions, and
// checking the answer (merged, worktrees cleaned up) against real git repos.

import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionSummary } from "../../../../shared/transcript";
import { ANSWER_TAG, checkInMessage, judge, listeningPorts, namedInRunning, parseAnswer, skipReason, stillRunning, systemProbe, verify, type Pr, type Probe } from "./checkIn";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

test("the check-in message asks for the tagged line and a cleanup that spares other sessions' folders", () => {
  const m = checkInMessage("/r/wt-a", ["/r/main", "/r/wt-b", "/r/wt-a"]);
  expect(m).toContain(ANSWER_TAG);
  expect(m).toContain("Don't start or continue any task work");
  expect(m).toContain('"cleaned_up": true');
  expect(m).toContain("git worktree remove <path>, without --force");
  expect(m).toContain("git branch -d <branch>; -D only as above");
  expect(m).toContain("git branch -D <branch> only for work the person asked you to discard");
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

test("judge archives done, cleaned-up work with nothing to merge, unless git disagrees", () => {
  const none = { unmerged: [], leftover: [] };
  // Discarded at the person's request (the seeding session's answer).
  const seeded = { done: true, merged: false, nothingToMerge: true, cleanedUp: true, branch: "seed-local-applications", note: "local data seeded; script discarded at user's request" };
  expect(judge(seeded, none)).toEqual({ archive: true, reason: "local data seeded; script discarded at user's request" });
  expect(judge({ done: true, merged: false, nothingToMerge: true, cleanedUp: true }, none)).toEqual({ archive: true, reason: "done, nothing to merge and cleaned up" });
  // Still unmerged work somewhere, a worktree left, or no cleanup: kept.
  expect(judge(seeded, { unmerged: ["branch seed-local-applications has commits not in main"], leftover: [] })).toEqual({ archive: false, reason: "says it's done and nothing to merge, but git disagrees: branch seed-local-applications has commits not in main" });
  expect(judge(seeded, { unmerged: ["PR #7 for seed-local-applications is still open"], leftover: [] }).archive).toBe(false);
  expect(judge(seeded, { unmerged: [], leftover: ["/r/wt"] }).archive).toBe(false);
  expect(judge({ ...seeded, cleanedUp: false }, none).archive).toBe(false);
  expect(judge({ ...seeded, done: false }, none).archive).toBe(false);
  // Not merged and not "nothing to merge": kept as before.
  expect(judge({ ...seeded, nothingToMerge: undefined }, none).reason).toContain("not merged or applied");
});

test("parseAnswer reads nothing_to_merge", () => {
  expect(parseAnswer(`${ANSWER_TAG} {"done": true, "merged": false, "nothing_to_merge": true, "cleaned_up": true}`)).toEqual({ done: true, merged: false, nothingToMerge: true, cleanedUp: true });
  expect(parseAnswer(`${ANSWER_TAG} {"done": true, "merged": false, "nothing_to_merge": "yes"}`)).toEqual({ done: true, merged: false });
  expect(checkInMessage("/r/x")).toContain('"nothing_to_merge": false');
  expect(checkInMessage("/r/x")).toContain('"target": ');
  expect(checkInMessage("/r/x")).toContain("merged into that intended branch on the remote counts as merged");
  expect(parseAnswer(`${ANSWER_TAG} {"done": true, "merged": true, "target": "foliation"}`)).toEqual({ done: true, merged: true, target: "foliation" });
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
  // Waiting to retry a rate limit: its turn isn't over, so its end isn't a check-in answer.
  expect(skipReason(row, look({}, { retry: { attempt: 1, maxAttempts: 5, nextAt: 1, deadline: 2, error: "x" } }))).toBe("it's waiting to retry after a rate limit");
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

/** A repo with a bare origin, and branch `name` with a commit not in main, pushed. */
async function withOrigin(name: string) {
  const r = await repo();
  const origin = join(r.dir, "origin.git");
  await sh(r.dir, "git", "init", "-q", "--bare", origin);
  await sh(r.main, "git", "remote", "add", "origin", origin);
  await sh(r.main, "git", "push", "-q", "origin", "main");
  await sh(r.main, "git", "checkout", "-qb", name);
  writeFileSync(join(r.main, "seed.ts"), "seed\n");
  await sh(r.main, "git", "add", ".");
  await sh(r.main, "git", "commit", "-qm", "seed script");
  await sh(r.main, "git", "push", "-q", "origin", name);
  await sh(r.main, "git", "checkout", "-q", "main");
  return { ...r, origin };
}

const nothing = { done: true, merged: false, nothingToMerge: true, cleanedUp: true };
const noPrs = async () => [] as Pr[];

test("verify, nothing to merge: discarded work whose branch is gone everywhere passes", async () => {
  const { main, origin } = await withOrigin("seed-local");
  // The session discarded it at the person's request: local and remote branch deleted (the remote
  // one from elsewhere, so only the stale remote-tracking ref is left here until the fetch prunes it).
  await sh(main, "git", "branch", "-qD", "seed-local");
  await sh(origin, "git", "branch", "-qD", "seed-local");
  expect(await verify(main, { ...nothing, branch: "seed-local" }, undefined, undefined, [], noPrs)).toEqual(clean);
  // Local or research work with no branch at all.
  expect(await verify(main, nothing, undefined, undefined, [], noPrs)).toEqual(clean);
});

test("verify, nothing to merge: a branch or an open PR with unmerged work still keeps it", async () => {
  const { main } = await withOrigin("seed-local");
  // Local branch deleted, but the remote one still has the commits.
  await sh(main, "git", "branch", "-qD", "seed-local");
  expect(await verify(main, { ...nothing, branch: "seed-local" }, undefined, undefined, [], noPrs)).toEqual({ unmerged: ["branch seed-local has commits not in main"], leftover: [] });
  // An open PR for it, whatever git says.
  const { main: other } = await repo();
  expect(await verify(other, { ...nothing, branch: "gone" }, undefined, undefined, [], async (_cwd, b) => (b === "gone" ? [{ number: 7, state: "OPEN" as const, base: "main" }] : []))).toEqual({ unmerged: ["PR #7 from gone into main is still open"], leftover: [] });
  // No way to tell (no gh): git alone decides.
  expect(await verify(other, { ...nothing, branch: "gone" }, undefined, undefined, [], async () => undefined)).toEqual(clean);
});

/** A repo whose work goes to a `foliation` branch on origin, and branch `remove-link` with one commit, pushed. */
async function deployBranch() {
  const r = await withOrigin("remove-link");
  await sh(r.main, "git", "branch", "foliation", "main");
  await sh(r.main, "git", "push", "-q", "origin", "foliation");
  return r;
}
const mergedAnswer = { done: true, merged: true, cleanedUp: true, branch: "remove-link" };

test("verify: merged into the session's own target branch on the remote counts, not main only", async () => {
  const { main } = await deployBranch();
  // Not in main, and not in foliation yet.
  expect((await verify(main, mergedAnswer, undefined, undefined, [], noPrs)).unmerged).toEqual(["branch remove-link has commits not in main"]);
  // Merged into foliation only here, not on the remote: still not merged.
  await sh(main, "git", "checkout", "-q", "foliation");
  await sh(main, "git", "merge", "-q", "--no-ff", "-m", "merge", "remove-link");
  await sh(main, "git", "checkout", "-q", "main");
  expect((await verify(main, { ...mergedAnswer, target: "foliation" }, undefined, undefined, [], noPrs)).unmerged).toEqual(["branch remove-link has commits not in origin/foliation"]);
  // Pushed: merged, by the target it names or by its merged PR's base.
  await sh(main, "git", "push", "-q", "origin", "foliation");
  expect(await verify(main, { ...mergedAnswer, target: "foliation" }, undefined, undefined, [], noPrs)).toEqual(clean);
  expect(await verify(main, mergedAnswer, undefined, undefined, [], async () => [{ number: 2, state: "MERGED", base: "foliation" }])).toEqual(clean);
  // A closed PR's base doesn't count, nor does a target that isn't on the remote.
  expect((await verify(main, mergedAnswer, undefined, undefined, [], async () => [{ number: 2, state: "CLOSED", base: "foliation" }])).unmerged).toEqual(["branch remove-link has commits not in main"]);
  expect((await verify(main, { ...mergedAnswer, target: "nowhere" }, undefined, undefined, [], noPrs)).unmerged).toEqual(["branch remove-link has commits not in main"]);
  // Work done on the target branch itself must be on the remote.
  expect(await verify(main, { ...mergedAnswer, branch: "foliation", target: "foliation" }, undefined, undefined, [], noPrs)).toEqual(clean);
  expect(judge({ ...mergedAnswer, target: "foliation", note: "live via foliation" }, clean)).toEqual({ archive: true, reason: "live via foliation" });
});

test("verify: a PR still open against a non-default branch keeps it", async () => {
  const { main } = await deployBranch();
  const open = async () => [{ number: 3, state: "OPEN" as const, base: "foliation" }];
  const f = await verify(main, { ...mergedAnswer, target: "foliation" }, undefined, undefined, [], open);
  expect(f.unmerged).toEqual(["branch remove-link has commits not in origin/foliation", "PR #3 from remove-link into foliation is still open"]);
  expect(judge({ ...mergedAnswer, target: "foliation" }, f).archive).toBe(false);
  // Open even though the commits are in foliation already.
  await sh(main, "git", "push", "-q", "origin", "remove-link:foliation");
  expect((await verify(main, { ...mergedAnswer, target: "foliation" }, undefined, undefined, [], open)).unmerged).toEqual(["PR #3 from remove-link into foliation is still open"]);
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

const jungle = "local stack (tmux jungle-dev, Supabase :54421, app :3005)";

test("the check-in asks what's still running, to leave it running and to spare worktrees in use", () => {
  const m = checkInMessage("/r/x");
  expect(m).toContain("don't stop anything you started that's still running");
  expect(m).toContain('"running": "what you started that\'s still running, or null"');
  expect(m).toContain("lsof +D <path>");
  expect(m).toContain("if something is, leave the worktree and answer cleaned_up: false");
  expect(parseAnswer(`${ANSWER_TAG} {"done": true, "merged": false, "running": "${jungle}"}`)).toEqual({ done: true, merged: false, running: jungle });
  expect(parseAnswer(`${ANSWER_TAG} {"done": true, "merged": true, "running": null}`)).toEqual({ done: true, merged: true });
  expect(namedInRunning(jungle)).toEqual({ tmux: ["jungle-dev"], ports: [54421, 3005] });
  expect(namedInRunning("vite on port 5173, watcher")).toEqual({ tmux: [], ports: [5173] });
});

test("listeningPorts reads /proc/net/tcp", () => {
  const text = [
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
    "   0: 0100007F:D5E5 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1",
    "   1: 0100007F:0BBD 0100007F:9C40 01 00000000:00000000 00:00000000 00000000  1000        0 2",
  ].join("\n");
  expect(listeningPorts(text)).toEqual([54757]);
});

/** A machine where `tmux` and `ports` are live, and `busy` folders have that many processes. */
const fakeProbe = (o: { tmux?: Record<string, boolean | undefined>; ports?: number[]; busy?: Record<string, number> }): Probe => ({
  tmux: async (n) => o.tmux?.[n],
  ports: async () => (o.ports ? new Set(o.ports) : undefined),
  usersOf: async (d) => o.busy?.[d] ?? 0,
});

test("stillRunning takes the session's word when something it names is live or can't be checked, not when all of it is gone", async () => {
  const a = { done: true, merged: false, running: jungle };
  expect(await stillRunning(a, fakeProbe({ tmux: { "jungle-dev": true }, ports: [] }))).toBe(jungle);
  expect(await stillRunning(a, fakeProbe({ tmux: { "jungle-dev": false }, ports: [3005] }))).toBe(jungle);
  expect(await stillRunning(a, fakeProbe({ tmux: { "jungle-dev": false }, ports: [] }))).toBeUndefined();
  // tmux and the ports can't be told: its word.
  expect(await stillRunning(a, fakeProbe({}))).toBe(jungle);
  // Nothing it names can be checked: its word.
  expect(await stillRunning({ ...a, running: "a file watcher" }, fakeProbe({ ports: [] }))).toBe("a file watcher");
  expect(await stillRunning({ done: true, merged: true }, fakeProbe({ ports: [] }))).toBeUndefined();
});

test("stillRunning counts processes working in the separate worktree it names, never in its own folder", async () => {
  const { dir } = await repo();
  const wt = join(dir, "wt");
  mkdirSync(wt);
  const a = { done: true, merged: true, cleanedUp: false, worktree: wt };
  expect(await stillRunning(a, fakeProbe({ busy: { [wt]: 2 } }))).toBe(`2 processes working in ${wt}`);
  expect(await stillRunning(a, fakeProbe({ busy: { [wt]: 2 } }), wt)).toBeUndefined();
  expect(await stillRunning(a, fakeProbe({}))).toBeUndefined();
  // The machine's own view: a process started in it.
  expect(await systemProbe.usersOf(wt)).toBe(0);
  const p = Bun.spawn(["sleep", "30"], { cwd: wt });
  try {
    await Bun.sleep(50);
    expect(await systemProbe.usersOf(wt)).toBe(1);
    expect(await stillRunning(a)).toBe(`1 process working in ${wt}`);
  } finally {
    p.kill();
    await p.exited;
  }
});

test("systemProbe sees a listening port", async () => {
  const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  try {
    expect((await systemProbe.ports())?.has(s.port)).toBe(true);
    expect(await stillRunning({ done: true, merged: true, running: `app :${s.port}` })).toBe(`app :${s.port}`);
  } finally {
    s.stop(true);
  }
  expect(await stillRunning({ done: true, merged: true, running: `app :${s.port}` })).toBeUndefined();
});

test("judge keeps a session that still runs something, with that first", () => {
  const none = { unmerged: [], leftover: [] };
  // The Jungle case: still running, and its PR is open.
  expect(judge({ done: true, merged: false, note: "PR #377 still open" }, none, jungle)).toEqual({ archive: false, reason: `still running: ${jungle}. Also done, but not merged or applied: PR #377 still open` });
  expect(judge({ done: true, merged: true, cleanedUp: true }, { unmerged: ["PR #377 from dev into main is still open"], leftover: [] }, jungle).reason).toBe(`still running: ${jungle}. Also says it's done and merged, but git disagrees: PR #377 from dev into main is still open`);
  // Otherwise finished: kept for that alone.
  expect(judge({ done: true, merged: true, cleanedUp: true }, none, jungle)).toEqual({ archive: false, reason: `still running: ${jungle}` });
  expect(judge({ done: true, merged: true, cleanedUp: true }, none, undefined).archive).toBe(true);
});
