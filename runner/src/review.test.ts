// /review (review.ts, the "review" section of session.ts): the command, who reviews, the prompt
// with the session's diff, the report (review_report or the reply's JSON), the card in the session
// reviewed (also closed, also after a handoff), sending findings to the agent, the read-only guard,
// review_report in tether-context, Codex's read-only sandbox and the capability matrix. Harness
// processes are stubs; the diff comes from a real git repository in the scratch HOME.

import { HOME, resetHome } from "./testenv";
import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HarnessId, SessionReview } from "../../web/src/shared/protocol";
import { REVIEW_PREFIX } from "../../web/src/shared/review";
import { CodexSession } from "./adapters/codex";
import type { Sink } from "./adapters/types";
import { config, prefs } from "./config";
import { capabilityMatrix } from "./connectors";
import { mcpLaunch } from "./context/launch";
import { tools } from "./context/mcp";
import { runHandoff, type HandoffDeps } from "./handoffRun";
import {
  applyReview,
  describeFindings,
  fixMessage,
  formatDiff,
  parseReport,
  parseReviewCommand,
  pickReviewer,
  reportFromReply,
  REVIEW_READ_ONLY_REASON,
  runReview,
  type ReviewDeps,
} from "./review";
import { LiveSession, newId } from "./session";

let live: LiveSession[] = [];
const byId = new Map<string, LiveSession>();

beforeEach(() => {
  resetHome();
  config().sessions = {};
  config().archived = [];
  config().titles = {};
  byId.clear();
});
afterEach(() => {
  jest.useRealTimers();
  live.splice(0).forEach((s) => s.close());
});

async function until(cond: () => unknown, ms = 5_000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(5);
  }
}

const noticeTexts = (s: LiveSession) => s.t.messages.filter((m) => m.role === "notice").map((m) => (m.parts[0] as any).text as string);

/** The sink index.ts wires: a review session's result reaches the session it reviews by id. */
function sink(): Sink {
  return { emit: () => {}, summary: () => {}, handoff: async () => {}, reviewResult: (id, rid, patch) => applyReview((x) => byId.get(x), id, rid, patch) };
}

function fake(harness: HarnessId = "claude-code", projectPath = HOME, s0: Sink = sink()) {
  const sent: string[] = [];
  class Fake extends LiveSession {
    async start() {
      this.setState({ status: "idle" });
    }
    protected async send(text: string) {
      sent.push(text);
      this.addUserMessage(text);
      this.setState({ status: "running" });
    }
    async abort() {
      this.setState({ status: "idle" });
    }
    async applyModel(m: string) {
      this.setState({ model: m });
    }
    async setThinking() {}
    async setPermissionMode() {}
    async rename() {}
    async listCommands() {
      return [];
    }
    async continueTurn(text = "Continue where you left off.") {
      sent.push(text);
      this.addUserMessage(text);
      this.setState({ status: "running" });
    }
    protected shutdown() {}
    endTurn(text = "Done.") {
      this.emit({ type: "msg", msg: { id: newId("a"), role: "assistant", parts: [{ type: "text", text }], ts: Date.now() } });
      this.setState({ status: "idle" });
    }
  }
  const s = new Fake(harness, { nativeId: crypto.randomUUID(), projectPath }, s0);
  s.t.state.status = "idle";
  s.loadPrefs();
  live.push(s);
  byId.set(s.id, s);
  return Object.assign(s, { sent });
}
type Fake = ReturnType<typeof fake>;

const git = (cwd: string, ...args: string[]) => {
  const p = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd });
  if (p.exitCode) throw new Error(p.stderr.toString());
};

/** A repository with one committed file, a session that took its first checkpoint, then changed it and added another. */
async function repoSession(harness: HarnessId = "claude-code", s0: Sink = sink()) {
  const dir = join(HOME, "proj");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "math.ts"), "export const add = (a: number, b: number) => a + b;\n");
  git(dir, "init", "-q");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "init");
  const s = fake(harness, dir, s0);
  s.addUserMessage("Add minus");
  await s.checkpoint("Add minus");
  writeFileSync(join(dir, "math.ts"), "export const add = (a: number, b: number) => a + b;\nexport const minus = (a: number, b: number) => a + b;\n");
  writeFileSync(join(dir, "math.test.ts"), "// todo\n");
  s.emit({ type: "msg", msg: { id: "a1", role: "assistant", parts: [{ type: "text", text: "Added minus." }], ts: Date.now() } });
  return { s, dir };
}

function deps(reviewers: Partial<Record<HarnessId, () => LiveSession>>, installed: HarnessId[] = Object.keys(reviewers) as HarnessId[], s0 = sink()): ReviewDeps & { created: HarnessId[] } {
  const created: HarnessId[] = [];
  const all: HarnessId[] = ["claude-code", "codex", "pi", "opencode", "kiro", "antigravity"];
  const adapters = Object.fromEntries(
    all.map((h) => [
      h,
      {
        available: async () => installed.includes(h),
        create: () => {
          created.push(h);
          const r = reviewers[h];
          if (!r) throw new Error(`no ${h} here`);
          return r();
        },
      },
    ]),
  );
  return { adapters: adapters as any, sink: s0, track: (s) => (s.loadPrefs(), byId.set(s.id, s)), created };
}

const finding = { file: "math.ts", line: 2, severity: "high", issue: "minus adds instead of subtracting", fix: "Use a - b." };

// ---------------- pure pieces ----------------

describe("review.ts", () => {
  test("/review: a harness (and model) first, the rest is the focus", () => {
    expect(parseReviewCommand("/review")).toEqual({});
    expect(parseReviewCommand("/reviewer")).toBeUndefined();
    expect(parseReviewCommand("please /review")).toBeUndefined();
    expect(parseReviewCommand("/review codex")).toEqual({ harness: "codex" });
    expect(parseReviewCommand("/review codex:gpt-6-sol the auth changes")).toEqual({ harness: "codex", model: "gpt-6-sol", focus: "the auth changes" });
    expect(parseReviewCommand("/review claude/opus")).toEqual({ harness: "claude-code", model: "opus" });
    expect(parseReviewCommand("/review pi:openai-codex/gpt-6-luna")).toEqual({ harness: "pi", model: "openai-codex/gpt-6-luna" });
    expect(parseReviewCommand("/review agy")).toEqual({ harness: "antigravity" });
    expect(parseReviewCommand("/review check the\nmigrations")).toEqual({ focus: "check the\nmigrations" });
  });

  test("who reviews: the one asked for, else another harness from the chain, else the first other one installed, else the same one", async () => {
    const has = (...hs: HarnessId[]) => async (h: HarnessId) => hs.includes(h);
    expect(await pickReviewer("claude-code", ["claude-code:opus", "pi:openai-codex/gpt-6", "codex:gpt-6-sol"], has("claude-code", "codex", "pi"), {})).toEqual({ harness: "pi", model: "openai-codex/gpt-6" });
    expect(await pickReviewer("claude-code", ["claude-code:opus", "kiro:x"], has("claude-code", "codex", "pi"), {})).toEqual({ harness: "codex" });
    expect(await pickReviewer("codex", undefined, has("codex", "claude-code"), {})).toEqual({ harness: "claude-code" });
    expect(await pickReviewer("codex", undefined, has("codex"), {})).toEqual({ harness: "codex", same: true });
    expect(await pickReviewer("claude-code", ["codex:gpt-6-sol"], has("codex"), { harness: "codex" })).toEqual({ harness: "codex", model: "gpt-6-sol" });
    expect(await pickReviewer("claude-code", ["codex:gpt-6-sol"], has("codex"), { harness: "codex", model: "gpt-5" })).toEqual({ harness: "codex", model: "gpt-5" });
    expect(await pickReviewer("claude-code", undefined, has("codex"), { harness: "kiro" })).toBe("Kiro isn't installed on this runner.");
  });

  test("the report: checked, with other agents' field names and severities", () => {
    expect(parseReport({ findings: [finding], summary: "One bug." })).toEqual({ findings: [finding as any], summary: "One bug." });
    expect(parseReport({ findings: [] })).toEqual({ findings: [] });
    expect(parseReport([{ path: "a.ts", startLine: "12-14", priority: "P0", description: "Crash", suggestion: "Guard it" }])).toEqual({
      findings: [{ file: "a.ts", line: 12, severity: "critical", issue: "Crash", fix: "Guard it" }],
    });
    expect(parseReport({ findings: [{ file: "a.ts", severity: "nit", issue: "x" }] })).toEqual({ findings: [{ file: "a.ts", severity: "low", issue: "x", fix: "" }] });
    expect(parseReport({})).toStartWith("findings must be a list");
    expect(parseReport({ findings: [{ severity: "high", issue: "x" }] })).toBe("Finding 1 needs a file.");
    expect(parseReport({ findings: [{ file: "a", severity: "high" }] })).toBe("Finding 1 needs an issue: what's wrong.");
    expect(parseReport({ findings: [{ file: "a", issue: "b", severity: "urgent" }] })).toBe("Finding 1: severity must be one of critical, high, medium, low.");
    expect(parseReport({ findings: Array(101).fill(finding) })).toStartWith("At most 100");
  });

  test("a report written as JSON at the end of a reply", () => {
    const reply = `I looked at math.ts.\n\n\`\`\`json\n${JSON.stringify({ summary: "One bug.", findings: [finding] })}\n\`\`\``;
    expect(reportFromReply(reply)).toEqual({ findings: [finding as any], summary: "One bug." });
    expect(reportFromReply(`Done. {"findings": []}`)).toEqual({ findings: [] });
    expect(reportFromReply("Looks fine to me.")).toBeUndefined();
    expect(reportFromReply("```json\n{not json}\n```")).toBeUndefined();
  });

  test("the message that asks the agent to fix findings, and the one-line count", () => {
    const r = { harness: "codex" as const, model: "gpt-6-sol", findings: [finding as any, { file: "b.ts", severity: "low", issue: "Typo", fix: "" }] };
    expect(fixMessage(r, [0])).toBe(
      "A review by Codex (GPT-6 Sol) found this in your changes. Check it, and fix it if it holds:\n\n**math.ts:2** (high): minus adds instead of subtracting\n  Suggested fix: Use a - b.",
    );
    expect(fixMessage({ ...r, model: undefined }, [0, 1])).toBe(
      "A review by Codex found these in your changes. Check each one, and fix the ones that hold:\n\n1. **math.ts:2** (high): minus adds instead of subtracting\n  Suggested fix: Use a - b.\n2. **b.ts** (low): Typo",
    );
    expect(describeFindings([])).toBe("No findings");
    expect(describeFindings(r.findings)).toBe("2 findings (1 high)");
    expect(describeFindings([r.findings[1]])).toBe("1 finding");
  });

  test("the diff as the reviewer reads it says what was left out", () => {
    const text = formatDiff({
      base: "session",
      fileCount: 4,
      additions: 3,
      deletions: 1,
      truncated: true,
      files: [
        { path: "a.ts", status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-x\n+y\n", truncated: true },
        { path: "logo.png", status: "added", additions: 0, deletions: 0, patch: "", binary: true },
        { path: "big.json", status: "added", additions: 2, deletions: 0, patch: "", skipped: "too many lines" },
      ],
    });
    expect(text).toContain("diff --git a/a.ts b/a.ts\n# modified, +1 -1\n@@ -1 +1 @@\n-x\n+y\n# … cut short");
    expect(text).toContain("# binary file");
    expect(text).toContain("# not included: too many lines");
    expect(text).toEndWith("# 1 more changed files not listed");
  });

  test("credential and secrets files stay out of the prompt", () => {
    const file = (path: string) => ({ path, status: "modified" as const, additions: 1, deletions: 0, patch: "@@ -0,0 +1 @@\n+SECRET=hunter2\n" });
    const text = formatDiff({ base: "session", fileCount: 3, additions: 3, deletions: 0, truncated: false, files: [file(".env"), file("deploy/credentials.json"), file(".env.example")] });
    expect(text).toContain("diff --git a/.env b/.env\n# modified, +1 -0\n# not included: a credential or secrets file");
    expect(text).toContain("diff --git a/deploy/credentials.json b/deploy/credentials.json\n# modified, +1 -0\n# not included: a credential or secrets file");
    // An example file isn't a secret: its patch goes in.
    expect(text.match(/hunter2/g)).toHaveLength(1);
    expect(text).toContain("diff --git a/.env.example b/.env.example\n# modified, +1 -0\n@@");
  });
});

// ---------------- a review, end to end ----------------

describe("a review", () => {
  test("starts a read-only session on another harness with the session's diff, and its report fills the card", async () => {
    const { s, dir } = await repoSession("claude-code");
    s.setState({ chain: ["claude-code:opus", "codex:gpt-6-sol"] });
    let reviewer!: Fake;
    const d = deps({ codex: () => (reviewer = fake("codex", dir)) }, ["claude-code", "codex", "pi"]);
    await runReview(d, s, { focus: "the minus function" });
    expect(d.created).toEqual(["codex"]);
    const card = s.reviews[0]!;
    expect(card).toMatchObject({ status: "running", harness: "codex", model: "gpt-6-sol", focus: "the minus function", sessionId: reviewer.id, afterMsgId: "a1", findings: [], sent: [] });
    expect(card.stat).toEqual({ files: 2, additions: 2, deletions: 0 });
    // The review session: linked back, read-only, titled, not in the sidebar.
    expect(reviewer.t.state.reviewOf).toEqual({ sessionId: s.id, reviewId: card.id });
    expect(reviewer.t.state.guard).toBe("auto");
    expect(reviewer.title).toBe(`Review of ${s.title}`);
    expect(reviewer.summary().reviewOf).toBe(s.id);
    expect(prefs(reviewer.id).reviewOf).toEqual({ sessionId: s.id, reviewId: card.id });
    // Its prompt: the diff since the session's first checkpoint, what was asked, the focus, how to report.
    const prompt = reviewer.sent[0]!;
    expect(prompt).toStartWith(REVIEW_PREFIX);
    expect(prompt).toContain("2 files, +2 -0");
    expect(prompt).toContain(`git diff ${s.diffBase}`);
    expect(prompt).toContain("diff --git a/math.ts b/math.ts\n# modified, +1 -0\n@@");
    expect(prompt).toContain("+export const minus = (a: number, b: number) => a + b;");
    expect(prompt).toContain("diff --git a/math.test.ts b/math.test.ts\n# added");
    expect(prompt).toContain("## What the session was asked to do\nAdd minus");
    expect(prompt).toContain("The user asked you to focus on: the minus function");
    expect(prompt).toContain("call the review_report tool once");

    // The guard: nothing that changes anything, reading and read-only commands without the judge.
    expect(await reviewer.checkTool("Write", { file_path: join(dir, "math.ts"), content: "" })).toEqual({ allow: false, reason: REVIEW_READ_ONLY_REASON, always: false });
    expect((await reviewer.checkTool("Bash", { command: "bun test" })).reason).toBe(REVIEW_READ_ONLY_REASON);
    expect((await reviewer.checkTool("mcp__github__create_issue", { title: "x" })).allow).toBe(false);
    expect(await reviewer.checkTool("Read", { file_path: join(dir, "math.ts") })).toEqual({ allow: true, reason: "Read-only review.", always: false });
    expect((await reviewer.checkTool("Bash", { command: `git diff ${s.diffBase} -- math.ts` })).allow).toBe(true);
    expect((await reviewer.checkTool("mcp__tether-context__review_report", { findings: [] })).allow).toBe(true);
    expect((await reviewer.checkTool("Read", { file_path: join(dir, ".env") })).allow).toBe(false);
    // Plan files too (plan mode lets those through).
    expect((await reviewer.checkTool("Write", { file_path: join(dir, "docs/plans/rollout.md"), content: "" })).reason).toBe(REVIEW_READ_ONLY_REASON);
    expect((await reviewer.checkTool("edit", { filePath: join(dir, "plans/x.md") })).reason).toBe(REVIEW_READ_ONLY_REASON);

    // review_report: checked, then the card has the findings.
    expect(await reviewer.sessionTool("review_report", { findings: [{ file: "math.ts" }] })).toEqual({ ok: false, text: "Finding 1 needs an issue: what's wrong." });
    expect(s.reviews[0]!.status).toBe("running");
    const r = await reviewer.sessionTool("review_report", { summary: "minus is wrong.", findings: [finding, { ...finding, line: 1, severity: "low", issue: "No test", fix: "Add one." }] });
    expect(r).toEqual({ ok: true, text: "Reported 2 findings: the user sees them in the session you reviewed. You're done: end your turn with a short summary." });
    expect(s.reviews[0]).toMatchObject({ status: "done", summary: "minus is wrong.", sent: [] });
    expect(s.reviews[0]!.findings.map((f) => f.issue)).toEqual(["minus adds instead of subtracting", "No test"]);
    // The turn ending after a report changes nothing; its own "Finished" push stays out.
    reviewer.endTurn("Reported two findings.");
    expect(s.reviews[0]!.status).toBe("done");

    // Send to agent, then Send all (the rest).
    await s.sendReviewFindings(card.id, [0]);
    expect(s.reviews[0]!.sent).toEqual([0]);
    expect(s.sent[0]).toStartWith("A review by Codex (GPT-6 Sol) found this in your changes.");
    expect(s.sent[0]).toContain("**math.ts:2** (high): minus adds instead of subtracting");
    // Busy now: Send all queues behind the running turn.
    await s.sendReviewFindings(card.id);
    expect(s.reviews[0]!.sent).toEqual([0, 1]);
    expect(s.t.state.pending?.map((p) => [p.mode, p.text.split("\n")[2]])).toEqual([["followUp", "**math.ts:1** (low): No test"]]);
    await expect(s.sendReviewFindings(card.id)).rejects.toThrow("Every finding was sent already.");
    await expect(s.sendReviewFindings("nope")).rejects.toThrow("That review is no longer kept.");
    // Saved with the session.
    expect(prefs(s.id).reviews?.[0]?.sent).toEqual([0, 1]);
  });

  test("without review_report: the reply's JSON block, else the card says it failed", async () => {
    const { s, dir } = await repoSession("codex");
    let reviewer!: Fake;
    const d = deps({ "claude-code": () => (reviewer = fake("claude-code", dir)) });
    await runReview(d, s, {});
    reviewer.endTurn(`Here's what I found.\n\n\`\`\`json\n${JSON.stringify({ findings: [finding] })}\n\`\`\``);
    expect(s.reviews[0]).toMatchObject({ status: "done", findings: [finding] });

    await runReview(d, s, {});
    reviewer.endTurn("All good, I think.");
    expect(s.reviews[1]).toMatchObject({ status: "failed", error: "The reviewer finished without reporting findings. Open the review session to read what it said." });
    // A later report (you asked it again) still fills the card.
    await reviewer.sessionTool("review_report", { findings: [] });
    expect(s.reviews[1]).toMatchObject({ status: "done", findings: [] });

    await runReview(d, s, {});
    await reviewer.stop();
    expect(s.reviews[2]).toMatchObject({ status: "failed", error: "Stopped before it reported." });
  });

  test("/review in the session: refusals inline, and nothing to review", async () => {
    const d = deps({ codex: () => fake("codex", join(HOME, "proj")) });
    const withReview: Sink = { ...sink(), review: async (from, req) => void (await runReview(d, from, req)) };
    const { s, dir } = await repoSession("claude-code", withReview);
    s.setState({ status: "running" });
    expect(await s.reviewCommand("/review")).toBe(true);
    expect(noticeTexts(s).at(-1)).toBe("The agent is still working. Review its changes once it's done, or stop it first.");
    s.setState({ status: "idle" });
    // Through prompt(): handled, never sent to the harness.
    await s.prompt("/review codex the tests");
    expect(s.sent).toEqual([]);
    expect(s.reviews[0]).toMatchObject({ harness: "codex", focus: "the tests", status: "running" });
    // Not installed: said inline, no card.
    await s.prompt("/review kiro");
    expect(noticeTexts(s).at(-1)).toBe("Kiro isn't installed on this runner.");
    expect(s.reviews).toHaveLength(1);

    // Nothing changed since the session began.
    const clean = fake("claude-code", dir, withReview);
    await clean.checkpoint("x");
    await clean.prompt("/review");
    expect(noticeTexts(clean).at(-1)).toBe("Nothing to review: this session hasn't changed any files.");
    // Not a git repository.
    mkdirSync(join(HOME, "plain"));
    const nogit = fake("claude-code", join(HOME, "plain"), withReview);
    await nogit.prompt("/review");
    expect(noticeTexts(nogit).at(-1)).toBe("Couldn't read the changes: This project is not a Git repository.");
    // A review session doesn't review itself.
    const rs = fake("codex", dir, withReview);
    rs.setState({ reviewOf: { sessionId: s.id, reviewId: "x" } });
    await rs.prompt("/review");
    expect(noticeTexts(rs).at(-1)).toBe("This is a review session. Run /review in the session it reviews.");
  });

  test("a reviewer that fails to start: the card says so", async () => {
    const { s } = await repoSession();
    const d = deps({ codex: () => fake("codex") });
    (d.adapters as any).codex.create = () => {
      throw new Error("codex exited");
    };
    await runReview(d, s, { harness: "codex" });
    expect(s.reviews[0]).toMatchObject({ status: "failed", error: "Couldn't start the review: codex exited" });
  });

  test("the result reaches a closed session's stored card, and follows a handoff", async () => {
    const { s, dir } = await repoSession();
    let reviewer!: Fake;
    const d = deps({ codex: () => (reviewer = fake("codex", dir)) });
    await runReview(d, s, {});
    const id = s.reviews[0]!.id;
    s.close();
    byId.delete(s.id);
    await reviewer.sessionTool("review_report", { findings: [finding] });
    expect(prefs(s.id).reviews?.[0]).toMatchObject({ id, status: "done", findings: [finding] });

    // Handed off: the new session gets the cards, and a later result reaches both.
    const a = fake("claude-code", dir);
    a.putReview({ ...prefs(s.id).reviews![0]!, status: "running", findings: [] });
    const b = fake("pi", dir);
    const hd: HandoffDeps = { adapters: { pi: { create: () => b } } as any, sink: sink(), context: { handoffMemory: async () => undefined }, track: (x) => x.loadPrefs() };
    await runHandoff(hd, a, { harness: "pi", model: "default" }, "test");
    expect(b.reviews.map((r) => r.id)).toEqual([id]);
    expect(b.reviews[0]!.afterMsgId).toBeUndefined();
    applyReview((x) => byId.get(x), a.id, id, { status: "done", findings: [finding as any] });
    expect(a.reviews[0]!.status).toBe("done");
    expect(b.reviews[0]!.status).toBe("done");
    // Findings are sent from where the conversation goes on.
    await expect(a.sendReviewFindings(id)).rejects.toThrow("This conversation continues in another session.");
  });

  test("a review session that hands off stays read-only, and its successor reports", async () => {
    const { s, dir } = await repoSession();
    let reviewer!: Fake;
    const d = deps({ codex: () => (reviewer = fake("codex", dir)) });
    await runReview(d, s, {});
    const of = reviewer.t.state.reviewOf!;
    reviewer.endTurn("Still reading.");
    // Its first turn ended without a report: failed. Reset it to running, as if a /compact came first.
    s.updateReview(of.reviewId, { status: "running", error: undefined });
    (reviewer as any).reviewSettled = false;
    reviewer.setState({ guard: "full" });
    const b = fake("pi", dir);
    let reviewOfAtStart: unknown;
    const start = b.start.bind(b);
    b.start = async () => {
      reviewOfAtStart = b.t.state.reviewOf;
      await start();
    };
    const hd: HandoffDeps = { adapters: { pi: { create: () => b } } as any, sink: sink(), context: { handoffMemory: async () => undefined }, track: (x) => x.loadPrefs() };
    await runHandoff(hd, reviewer, { harness: "pi", model: "default" }, "Compacted", undefined, { compact: {} });
    expect(reviewOfAtStart).toEqual(of);
    expect(b.t.state.reviewOf).toEqual(of);
    expect(b.t.state.guard).toBe("auto");
    expect(prefs(b.id).reviewOf).toEqual(of);
    expect((await b.checkTool("Write", { file_path: join(dir, "math.ts"), content: "" })).reason).toBe(REVIEW_READ_ONLY_REASON);
    // The old one says nothing more; the new one's reply fills the card.
    b.endTurn(`\`\`\`json\n${JSON.stringify({ findings: [finding] })}\n\`\`\``);
    expect(s.reviews[0]).toMatchObject({ status: "done", findings: [finding] });

    // One that had reported already doesn't report again from its successor's first turn.
    const c = fake("pi", dir);
    await runHandoff({ ...hd, adapters: { pi: { create: () => c } } as any }, b, { harness: "pi", model: "default" }, "Compacted", undefined, { compact: {} });
    expect(c.t.state.reviewOf).toEqual(of);
    c.endTurn("Nothing new.");
    expect(s.reviews[0]).toMatchObject({ status: "done", findings: [finding] });
  });

  test("a review under way keeps the session it reviews open; the idle close counts from its result", async () => {
    const { s, dir } = await repoSession();
    let reviewer!: Fake;
    await runReview(deps({ codex: () => (reviewer = fake("codex", dir)) }), s, {});
    jest.useFakeTimers({ now: Date.now() });
    s.setState({ status: "idle" });
    jest.advanceTimersByTime(31 * 60_000);
    expect(s.closed).toBe(false);
    jest.advanceTimersByTime(31 * 60_000);
    expect(s.closed).toBe(false);
    await reviewer.sessionTool("review_report", { findings: [finding] });
    expect(s.reviews[0]!.status).toBe("done");
    jest.advanceTimersByTime(29 * 60_000);
    expect(s.closed).toBe(false);
    jest.advanceTimersByTime(2 * 60_000);
    expect(s.closed).toBe(true);
  });

  test("a review whose session went away without reporting holds it open only so long", async () => {
    const { s } = await repoSession();
    const now = Date.now();
    s.putReview({ id: "rv", status: "running", harness: "codex", findings: [], sent: [], createdAt: now, updatedAt: now });
    jest.useFakeTimers({ now });
    s.setState({ status: "idle" });
    jest.advanceTimersByTime(2 * 60 * 60_000);
    expect(s.closed).toBe(false);
    jest.advanceTimersByTime(90 * 60_000);
    expect(s.closed).toBe(true);
  });

  test("after a restart: a review still starting failed, a review session stays read-only", () => {
    const now = Date.now();
    const r: SessionReview = { id: "rv1", status: "starting", harness: "codex", findings: [], sent: [], createdAt: now, updatedAt: now };
    const original = fake();
    prefs(original.id).reviews = [r, { ...r, id: "rv2", status: "running" }];
    original.loadPrefs();
    expect(original.reviews.map((x) => [x.id, x.status, x.error])).toEqual([
      ["rv1", "failed", "The runner restarted before the review started."],
      ["rv2", "running", undefined],
    ]);
    const rs = fake("codex");
    prefs(rs.id).reviewOf = { sessionId: original.id, reviewId: "rv2" };
    expect(rs.isReviewSession).toBe(true);
    rs.loadPrefs();
    expect(rs.t.state.reviewOf).toEqual({ sessionId: original.id, reviewId: "rv2" });
    expect(rs.summary().reviewOf).toBe(original.id);
  });
});

// ---------------- harness side ----------------

describe("harnesses", () => {
  test("tether-context offers review_report only to a review session", () => {
    const key = { key: "k" };
    expect(mcpLaunch(key).env.TETHER_CONTEXT_REVIEW).toBeUndefined();
    expect(mcpLaunch({ ...key, review: true }).env.TETHER_CONTEXT_REVIEW).toBe("1");
    expect(mcpLaunch({ review: true }).env.TETHER_CONTEXT_REVIEW).toBeUndefined();
    const was = process.env.TETHER_CONTEXT_REVIEW;
    try {
      delete process.env.TETHER_CONTEXT_REVIEW;
      expect(tools().some((t) => t.name === "review_report")).toBe(false);
      process.env.TETHER_CONTEXT_REVIEW = "1";
      expect(tools().some((t) => t.name === "review_report")).toBe(true);
    } finally {
      if (was === undefined) delete process.env.TETHER_CONTEXT_REVIEW;
      else process.env.TETHER_CONTEXT_REVIEW = was;
    }
  });

  test("Codex reviews in its read-only sandbox, whatever the guard says", () => {
    const c = new CodexSession({ nativeId: "t1", projectPath: HOME }, sink());
    live.push(c);
    (c as any).sandboxed = true;
    expect((c as any).policy().sandboxPolicy.type).toBe("workspaceWrite");
    c.t.state.reviewOf = { sessionId: "x", reviewId: "y" };
    c.t.state.guard = "full";
    expect((c as any).policy()).toEqual({ approvalPolicy: "untrusted", sandboxPolicy: { type: "readOnly", networkAccess: false } });
  });

  test("every connector says how it reviews", () => {
    const m = capabilityMatrix();
    for (const h of Object.keys(m) as HarnessId[]) {
      expect(m[h].review.level).toBe("emulated");
      expect(m[h].review.note.length).toBeGreaterThan(0);
    }
    expect(m.codex.review.note).toContain("review/start");
  });
});
