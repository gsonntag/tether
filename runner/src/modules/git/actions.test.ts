// Git actions against real temporary repos: the branch's status, Commit (the default branch refused
// unless ticked, no identity, hooks), Push to a local bare origin (ahead/behind, a rejected push), and
// the PR ops through a fake gh on a path of its own (never the real one).

import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitActionResult, GitDraft, GitStatus, PrLookup } from "../../../../shared/gitActions";
import { EventBus } from "../../core/bus";
import { OpRegistry } from "../../core/ops";
import { commit, countStatus, gitStatus, NO_IDENTITY, push, pushError } from "./actions";
import { commitPrompt, prPrompt } from "./draft";
import { makeGitModule } from ".";

const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "tether-gitact-"));
  dirs.push(d);
  return d;
};
const saved: Record<string, string | undefined> = {};
const ENV = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "EMAIL"];
let globalCfg = "";
beforeAll(() => {
  for (const k of ENV) saved[k] = process.env[k];
  for (const k of ENV) delete process.env[k];
  globalCfg = join(temp(), "gitconfig");
  writeFileSync(globalCfg, "[user]\n\tname = Tess Ter\n\temail = tess@example.com\n[init]\n\tdefaultBranch = main\n");
  process.env.GIT_CONFIG_GLOBAL = globalCfg;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
});
afterAll(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
});

const sh = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: process.env, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};
function repo(origin = false) {
  const d = temp();
  sh(d, "init", "-q", "-b", "main");
  writeFileSync(join(d, "a.txt"), "one\n");
  writeFileSync(join(d, ".gitignore"), "*.log\n");
  sh(d, "add", ".");
  sh(d, "commit", "-qm", "First commit");
  let bare: string | undefined;
  if (origin) {
    bare = temp();
    sh(bare, "init", "-q", "--bare", "-b", "main");
    sh(d, "remote", "add", "origin", bare);
    sh(d, "push", "-q", "-u", "origin", "main");
    sh(d, "remote", "set-head", "origin", "main");
  }
  return { d, bare: bare! };
}

test("status: branch, default branch, changes counted as Uncommitted shows them, identity", async () => {
  const { d } = repo();
  writeFileSync(join(d, "a.txt"), "two\n");
  writeFileSync(join(d, "new.txt"), "n\n");
  writeFileSync(join(d, "noise.log"), "x\n");
  sh(d, "mv", ".gitignore", ".ignore2");
  const s = await gitStatus(d);
  expect(s).toMatchObject({ state: "ok", branch: "main", defaultBranch: "main", origin: false, ahead: 0, behind: 0, identity: "Tess Ter <tess@example.com>" });
  expect(s.upstream).toBeUndefined();
  // a.txt, new.txt, the rename (one entry), and noise.log, no longer ignored
  expect(s.changed).toBe(4);
  expect((await gitStatus(temp())).state).toBe("notRepo");
  expect(countStatus("R  new\0old\0?? x\0")).toBe(2);
});

test("commit: refused on the default branch unless ticked; takes untracked files, never ignored ones", async () => {
  const { d } = repo();
  writeFileSync(join(d, "a.txt"), "two\n");
  writeFileSync(join(d, "new.txt"), "n\n");
  writeFileSync(join(d, "noise.log"), "x\n");
  const no = await commit(d, "Change a");
  expect(no.ok).toBe(false);
  expect(no.error).toContain("Commit to main anyway");
  expect(sh(d, "rev-list", "--count", "HEAD")).toBe("1");
  expect(sh(d, "diff", "--cached", "--name-only")).toBe("");
  const yes = await commit(d, "Change a\n\nAnd add new.", true);
  expect(yes.ok).toBe(true);
  expect(yes.commit).toBe(sh(d, "rev-parse", "--short", "HEAD"));
  expect(sh(d, "log", "-1", "--format=%B")).toBe("Change a\n\nAnd add new.");
  expect(sh(d, "log", "-1", "--format=%an <%ae>")).toBe("Tess Ter <tess@example.com>");
  expect(sh(d, "show", "--name-only", "--format=", "HEAD").split("\n").sort()).toEqual(["a.txt", "new.txt"]);
  // noise.log is ignored: not committed, not counted
  expect(yes.status.changed).toBe(0);
});

test("commit: a feature branch needs no tick; nothing to commit and an empty message are refused", async () => {
  const { d } = repo();
  sh(d, "checkout", "-qb", "feature");
  expect((await commit(d, "x")).error).toBe("Nothing to commit.");
  writeFileSync(join(d, "a.txt"), "two\n");
  expect((await commit(d, "  ")).error).toBe("Write a commit message first.");
  const r = await commit(d, "Edit a");
  expect(r.ok).toBe(true);
  expect(r.status.branch).toBe("feature");
  expect(r.status.changed).toBe(0);
});

test("commit: no identity configured says so and commits nothing", async () => {
  const { d } = repo();
  sh(d, "checkout", "-qb", "feature");
  writeFileSync(join(d, "a.txt"), "two\n");
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  try {
    const s = await gitStatus(d);
    expect(s.identity).toBeUndefined();
    const r = await commit(d, "Edit a");
    expect(r).toMatchObject({ ok: false, error: NO_IDENTITY });
  } finally {
    process.env.GIT_CONFIG_GLOBAL = globalCfg;
  }
  expect(sh(d, "rev-list", "--count", "HEAD")).toBe("1");
});

test("commit: the repo's pre-commit hook runs; a refusal shows its output", async () => {
  const { d } = repo();
  sh(d, "checkout", "-qb", "feature");
  const hook = join(d, ".git", "hooks", "pre-commit");
  writeFileSync(hook, "#!/bin/sh\necho 'lint: 3 problems in a.txt'\nexit 1\n");
  chmodSync(hook, 0o755);
  writeFileSync(join(d, "a.txt"), "two\n");
  const r = await commit(d, "Edit a");
  expect(r.ok).toBe(false);
  expect(r.error).toBe("The commit failed. Nothing was committed.");
  expect(r.output).toContain("lint: 3 problems in a.txt");
  expect(sh(d, "rev-list", "--count", "HEAD")).toBe("1");
  writeFileSync(hook, `#!/bin/sh\ntouch "${join(d, ".git", "hook-ran")}"\n`);
  expect((await commit(d, "Edit a")).ok).toBe(true);
  expect(existsSync(join(d, ".git", "hook-ran"))).toBe(true);
});

test("push: -u to a bare origin; ahead and behind; a rejected push isn't forced", async () => {
  const { d, bare } = repo(true);
  sh(d, "checkout", "-qb", "feature");
  writeFileSync(join(d, "a.txt"), "two\n");
  await commit(d, "Edit a");
  let s = await gitStatus(d);
  expect(s.upstream).toBeUndefined();
  const p = await push(d);
  expect(p.ok).toBe(true);
  expect(p.status).toMatchObject({ upstream: "origin/feature", ahead: 0, behind: 0 });
  expect(sh(bare, "rev-parse", "feature")).toBe(sh(d, "rev-parse", "HEAD"));

  writeFileSync(join(d, "b.txt"), "b\n");
  await commit(d, "Add b");
  expect((await gitStatus(d)).ahead).toBe(1);

  // Someone else pushes to the branch: after a fetch it's behind too, and a push is rejected.
  const other = temp();
  sh(other, "clone", "-q", "-b", "feature", bare, ".");
  writeFileSync(join(other, "c.txt"), "c\n");
  sh(other, "add", ".");
  sh(other, "commit", "-qm", "Add c");
  sh(other, "push", "-q");
  sh(d, "fetch", "-q");
  s = await gitStatus(d);
  expect([s.ahead, s.behind]).toEqual([1, 1]);
  const rej = await push(d);
  expect(rej.ok).toBe(false);
  expect(rej.error).toContain("never forces");
  expect(sh(bare, "rev-parse", "feature")).toBe(sh(other, "rev-parse", "HEAD"));
  expect(pushError("fatal: Authentication failed for 'https://x'")).toContain("sign-in");
});

test("push: no origin, or detached, is said plainly", async () => {
  const { d } = repo();
  expect((await push(d)).error).toBe("There's no remote called origin to push to.");
  sh(d, "checkout", "-q", "--detach");
  expect((await push(d)).error).toContain("detached");
});

test("draft prompts: the diff, new files by name only, recent subjects; a PR's commits since the base", async () => {
  const { d } = repo(true);
  sh(d, "checkout", "-qb", "feature");
  writeFileSync(join(d, "a.txt"), "two\n");
  writeFileSync(join(d, "secret.txt"), "hunter2\n");
  const c = await commitPrompt(d);
  expect(c.prompt).toContain("First commit");
  expect(c.prompt).toContain("+two");
  expect(c.prompt).toContain("secret.txt");
  expect(c.prompt).not.toContain("hunter2");
  expect((await prPrompt(d)).note).toContain("No commits");
  await commit(d, "Edit a to two");
  const p = await prPrompt(d);
  expect(p.prompt).toContain("- Edit a to two");
  expect(p.prompt).toContain("+two");
});

// ---------- the ops, with a fake gh ----------

/** A gh that answers from files in its folder and logs every call. */
function fakeGh(): { bin: string; dir: string; calls: () => string[][] } {
  const dir = temp();
  const bin = join(dir, "gh");
  writeFileSync(
    bin,
    `#!/bin/sh
D="${dir}"
printf '%s\\n' "$*" >> "$D/calls"
case "$1 $2" in
  "auth status") [ -e "$D/unauthed" ] && { echo "You are not logged into any GitHub hosts. To log in, run: gh auth login" >&2; exit 1; }; echo ok; exit 0;;
  "pr view") [ -e "$D/pr.json" ] && { cat "$D/pr.json"; exit 0; }; echo "no pull requests found for branch \\"$3\\"" >&2; exit 1;;
  "pr create")
    printf '{"number":42,"url":"https://github.com/o/r/pull/42","title":"T","state":"OPEN","isDraft":false,"headRefName":"feature","statusCheckRollup":[{"__typename":"CheckRun","status":"IN_PROGRESS","conclusion":""}]}' > "$D/pr.json"
    echo "https://github.com/o/r/pull/42"; exit 0;;
esac
exit 2
`,
  );
  chmodSync(bin, 0o755);
  return { bin, dir, calls: () => (existsSync(join(dir, "calls")) ? readFileSync(join(dir, "calls"), "utf8").trim().split("\n").filter(Boolean).map((l) => l.split(" ")) : []) };
}

async function module(d: string, o: { gh?: string; ask?: (id: string, prompt: string) => Promise<string>; status?: string } = {}) {
  const ops = new OpRegistry();
  const look = { summary: { id: "s1", projectPath: d }, status: o.status ?? "idle" } as never;
  await makeGitModule({ ghBin: () => o.gh }).start({
    ops,
    bus: new EventBus(),
    dataDir: temp(),
    log: () => {},
    session: () => look,
    sessions: { open: async () => look, list: () => [], ...(o.ask ? { ask: o.ask } : {}) },
  } as never);
  const call = async <T>(op: string, args: Record<string, unknown>) => {
    const r = await ops.handle(op, { sessionId: "s1", ...args });
    if (!r.ok) throw new Error(r.error);
    return r.data as T;
  };
  return call;
}

test("ops: open PR pushes first, records the PR; the lookup is cached; checks read", async () => {
  const { d, bare } = repo(true);
  sh(d, "checkout", "-qb", "feature");
  writeFileSync(join(d, "a.txt"), "two\n");
  const gh = fakeGh();
  const call = await module(d, { gh: gh.bin });
  expect((await call<GitActionResult>("gitCommit", { message: "Edit a" })).ok).toBe(true);
  // no PR yet: gh is asked by branch
  expect(await call<PrLookup>("gitPr", {})).toMatchObject({ gh: "ok" });
  expect((await call<PrLookup>("gitPr", {})).pr).toBeUndefined();
  expect(gh.calls().filter((c) => c[1] === "view").length).toBe(1);

  const r = await call<GitActionResult>("gitOpenPr", { title: "Edit a", body: "Body" });
  expect(r.ok).toBe(true);
  expect(r.pr).toMatchObject({ number: 42, state: "open", checks: "pending" });
  expect(r.status.upstream).toBe("origin/feature");
  expect(sh(bare, "rev-parse", "feature")).toBe(sh(d, "rev-parse", "HEAD"));
  const create = gh.calls().find((c) => c[1] === "create")!;
  expect(create.join(" ")).toBe("pr create --base main --head feature --title Edit a --body Body");

  const views = gh.calls().filter((c) => c[1] === "view").length;
  const l = await call<PrLookup>("gitPr", {});
  expect(l.pr).toMatchObject({ number: 42, url: "https://github.com/o/r/pull/42" });
  await call<PrLookup>("gitPr", {});
  await call<PrLookup>("gitPr", { fresh: true });
  expect(gh.calls().filter((c) => c[1] === "view").length).toBe(views + 1);

  // merged: on the default branch now, the recorded PR is still the session's
  writeFileSync(join(gh.dir, "pr.json"), JSON.stringify({ number: 42, url: "https://github.com/o/r/pull/42", title: "T", state: "MERGED", isDraft: false, headRefName: "feature", statusCheckRollup: [] }));
  sh(d, "checkout", "-q", "main");
  const m = await call<PrLookup>("gitPr", {});
  expect(m.pr).toMatchObject({ number: 42, state: "merged", checks: "none" });
  expect(gh.calls().at(-1)!.slice(0, 3)).toEqual(["pr", "view", "42"]);
});

test("ops: no gh, gh signed out, no origin: said plainly, gh asked no more than needed", async () => {
  const { d } = repo(true);
  sh(d, "checkout", "-qb", "feature");
  writeFileSync(join(d, "a.txt"), "two\n");
  expect(await module(d).then((c) => c<PrLookup>("gitPr", {}))).toMatchObject({ gh: "missing" });
  const gh = fakeGh();
  writeFileSync(join(gh.dir, "unauthed"), "");
  const call = await module(d, { gh: gh.bin });
  await call<GitActionResult>("gitCommit", { message: "Edit a" });
  const r = await call<GitActionResult>("gitOpenPr", { title: "T", body: "" });
  expect(r).toMatchObject({ ok: false, error: "gh isn't signed in on this computer. Run gh auth login there." });
  expect(gh.calls().some((c) => c[1] === "create")).toBe(false);
  const local = repo();
  sh(local.d, "checkout", "-qb", "feature");
  const lc = await module(local.d, { gh: gh.bin });
  const n = gh.calls().length;
  expect(await lc<PrLookup>("gitPr", {})).toMatchObject({ gh: "noRemote" });
  expect(gh.calls().length).toBe(n);
});

test("ops: commit refused while the session works; drafts from the session's side query, a failure a note", async () => {
  const { d } = repo();
  sh(d, "checkout", "-qb", "feature");
  writeFileSync(join(d, "a.txt"), "two\n");
  const busy = await module(d, { status: "running" });
  expect((await busy<GitActionResult>("gitCommit", { message: "x" })).error).toContain("working");
  const asked: string[] = [];
  const call = await module(d, { ask: async (_id, p) => (asked.push(p), "```\nEdit a to two\n```") });
  expect(await call<GitDraft>("gitDraft", { kind: "commit" })).toEqual({ message: "Edit a to two" });
  expect(asked[0]).toContain("+two");
  const failing = await module(d, { ask: async () => Promise.reject(new Error("Claude could not confirm the Claude subscription.")) });
  expect((await failing<GitDraft>("gitDraft", { kind: "commit" })).note).toContain("Couldn't generate one");
  const none = await module(d);
  expect(await none<GitDraft>("gitDraft", { kind: "commit" })).toEqual({ note: "This runner can't generate text." });
  const s = await call<GitStatus>("gitStatus", {});
  expect(s.branch).toBe("feature");
});
