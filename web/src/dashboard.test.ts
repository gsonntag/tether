import { describe, expect, test } from "bun:test";
import type { SessionPulse, SessionSummary } from "./shared/protocol";
import { activityLine, answerRequest, blockedLine, buildInbox, contextPercent, diffLabel, elapsed, guardNote, inboxTitle, isBlocking, isShellCall, mergePulses, oneTapQuestion, permissionVerb, rankInbox, requestCall, requestLine, requestTruncated, type InboxKind } from "./dashboard";
import type { AgentNotice, MemoryConflict, UiRequest } from "./shared/protocol";
import { pulseWork, workState } from "./workState";

const s = (id: string, over: Partial<SessionSummary> = {}): SessionSummary => ({
  id,
  harness: "claude-code",
  nativeId: id,
  projectPath: "/p",
  title: id,
  createdAt: 0,
  updatedAt: 0,
  live: true,
  status: "idle",
  ...over,
});
const p = (id: string, over: Partial<SessionPulse> = {}, sum: Partial<SessionSummary> = {}): SessionPulse => ({ session: s(id, sum), ...over });

describe("mergePulses", () => {
  test("upserts per runner and drops archived sessions", () => {
    let m = mergePulses({}, "r1", [p("a"), p("b")]);
    m = mergePulses(m, "r2", [p("a")]);
    expect(Object.keys(m.r1!)).toEqual(["a", "b"]);
    m = mergePulses(m, "r1", [p("a", { action: "x" }), p("b", {}, { archived: true })]);
    expect(m.r1!.a!.action).toBe("x");
    expect(m.r1!.b).toBeUndefined();
    expect(m.r2!.a).toBeDefined();
  });
});

test("activityLine, diffLabel, contextPercent, elapsed", () => {
  expect(activityLine(p("a", { activity: { shell: 1, subagent: 2 }, armed: 1 }))).toBe("2 agents · 1 shell · 1 scheduled");
  expect(activityLine(p("a"))).toBe("");
  // Tether's loops and schedules: the next run, and the session counts as scheduled while live.
  const at = new Date(2026, 9, 11, 14, 20).getTime();
  const looping = p("a", { nextRun: { at, label: "check CI", count: 1 } });
  expect(activityLine(looping, new Date(2026, 9, 11, 14, 0).getTime())).toBe("Next run 14:20");
  expect(workState(pulseWork(looping))).toBe("scheduled");
  // Closed, it's still scheduled: Tether opens it when the run is due. Without one it's closed.
  expect(workState(pulseWork(p("a", { nextRun: { at, label: "x", count: 1 } }, { live: false })))).toBe("scheduled");
  expect(workState(pulseWork(p("a", {}, { live: false })))).toBe("closed");
  expect(diffLabel(p("a", { diffStat: { files: 1, additions: 42, deletions: 3 } }))).toBe("+42 −3");
  expect(diffLabel(p("a", { diffStat: { files: 0, additions: 0, deletions: 0 } }))).toBeUndefined();
  expect(contextPercent(p("a", { context: { used: 50, max: 200 } }))).toBe(25);
  expect(contextPercent(p("a", { context: { max: 200 } }))).toBeUndefined();
  expect(elapsed(45_000)).toBe("45s");
  expect(elapsed(12 * 60_000 + 5_000)).toBe("12m");
  expect(elapsed(65 * 60_000)).toBe("1h 05m");
});

test("oneTapQuestion and requestLine", () => {
  const q = { id: "1", kind: "question" as const, title: "Q", questions: [{ question: "Which?", options: [{ label: "A" }, { label: "B" }] }] };
  expect(oneTapQuestion(q)?.question).toBe("Which?");
  expect(oneTapQuestion({ ...q, questions: [{ ...q.questions[0]!, multiSelect: true }] })).toBeUndefined();
  expect(oneTapQuestion({ ...q, questions: [...q.questions, ...q.questions] })).toBeUndefined();
  expect(requestLine(q)).toBe("Which?");
  expect(requestLine({ id: "2", kind: "permission", title: "t", tool: { name: "Bash", input: { command: "ls" } } })).toBe("Bash: ls");
});

describe("answerRequest (Home approve/deny/answer)", () => {
  const perm = (id: string) => ({ id, kind: "permission" as const, title: "Allow Bash?", tool: { name: "Bash", input: { command: "ls" } } });
  const row = (runnerId: string, sessionId: string, reqId: string) => ({ runnerId, pulse: p(sessionId, { pendingUi: [perm(reqId)] }, { status: "running" }), request: perm(reqId) });

  test("targets exactly the row's runner, session and request id", async () => {
    const calls: unknown[] = [];
    const r = await answerRequest(row("r2", "s9", "perm-7"), { allow: true }, async (runnerId, args) => (calls.push({ runnerId, ...args }), {}));
    expect(r).toBe("ok");
    expect(calls).toEqual([{ runnerId: "r2", sessionId: "s9", response: { allow: true, id: "perm-7" } }]);
  });

  test("the response can't override the request id", async () => {
    let sent: any;
    await answerRequest(row("r", "s", "real"), { allow: true, id: "other" } as any, async (_r, a) => ((sent = a), {}));
    expect(sent.response.id).toBe("real");
  });

  test("a double tap (or Approve then Deny) while in flight sends once", async () => {
    let release!: () => void;
    let n = 0;
    const rpc = () => (n++, new Promise<{}>((res) => (release = () => res({}))));
    const x = row("r", "s", "p1");
    const first = answerRequest(x, { allow: true }, rpc);
    expect(await answerRequest(x, { allow: true }, rpc)).toBe("busy");
    expect(await answerRequest(x, { allow: false }, rpc)).toBe("busy");
    release();
    expect(await first).toBe("ok");
    expect(n).toBe(1);
  });

  test("a different request is not blocked by one in flight", () => {
    let n = 0;
    const slow = () => (n++, new Promise<{}>(() => {}));
    void answerRequest(row("r", "s", "x1"), { allow: true }, slow);
    void answerRequest(row("r", "s", "x2"), { allow: true }, slow);
    void answerRequest(row("r2", "s", "x1"), { allow: true }, slow);
    expect(n).toBe(3);
  });

  test("already answered elsewhere / expired: stale; errors reject and free the request", async () => {
    expect(await answerRequest(row("r", "s", "p3"), { allow: true }, async () => ({ stale: true }))).toBe("stale");
    await expect(answerRequest(row("r", "s", "p4"), { allow: true }, async () => Promise.reject(new Error("Session is not running.")))).rejects.toThrow("not running");
    expect(await answerRequest(row("r", "s", "p4"), { allow: false }, async () => ({}))).toBe("ok");
  });

  test("one-tap question answers map the question text to the option label", async () => {
    const q = { id: "q1", kind: "question" as const, title: "Q", questions: [{ question: "Which DB?", options: [{ label: "Postgres" }, { label: "SQLite" }] }] };
    const one = oneTapQuestion(q)!;
    let sent: any;
    await answerRequest({ runnerId: "r", pulse: p("s"), request: q }, { answers: { [one.question]: one.options[1]!.label } }, async (_r, a) => ((sent = a), {}));
    expect(sent.response).toEqual({ id: "q1", answers: { "Which DB?": "SQLite" } });
  });
});


describe("rankInbox", () => {
  const r = (kind: InboxKind, at: number, key = `${kind}${at}`) => ({ kind, at, key });
  test("permissions, then questions/plans (oldest first), then blocked, memory, finished (newest first)", () => {
    const rows = [r("finished", 5), r("blocked", 1), r("ask", 9), r("memory", 2), r("permission", 8), r("finished", 7), r("blocked", 6), r("permission", 3), r("ask", 4), r("memory", 10)];
    expect(rankInbox(rows).map((x) => x.key)).toEqual(["permission3", "permission8", "ask4", "ask9", "blocked6", "blocked1", "memory10", "memory2", "finished7", "finished5"]);
  });
  test("ties go by key, so the order is stable; the input is left alone", () => {
    const rows = [r("ask", 1, "b"), r("ask", 1, "a")];
    expect(rankInbox(rows).map((x) => x.key)).toEqual(["a", "b"]);
    expect(rows.map((x) => x.key)).toEqual(["b", "a"]);
  });
  test("titles and what blocks", () => {
    expect(inboxTitle(3)).toBe("3 to do");
    expect(inboxTitle(0)).toBe("Nothing waiting");
    expect((["permission", "ask", "blocked", "memory", "finished"] as InboxKind[]).filter((kind) => isBlocking({ kind }))).toEqual(["permission", "ask", "blocked", "memory"]);
  });
});

describe("buildInbox", () => {
  const notice = (sessionId: string, kind: AgentNotice["kind"], ts: number, extra: Partial<AgentNotice> = {}): AgentNotice => ({ id: `n-${sessionId}`, kind, title: "", body: "body", sessionId, projectPath: "/p", project: "p", ts, ...extra });
  const perm = (id: string): UiRequest => ({ id, kind: "permission", title: "Allow?", tool: { name: "Bash", input: { command: "ls" } } });
  const conflict = { id: "c1", memoryId: "m", name: "db", scope: "s", oldBody: "", newBody: "", source: "", ts: 50, status: "open" } as MemoryConflict;
  test("one row per waiting request, else one per session by its notice; conflicts too; ranked", () => {
    const seen = new Map<string, number>();
    const since = (k: string, f: number) => (seen.has(k) ? seen.get(k)! : (seen.set(k, f), f));
    const needs = [
      { runnerId: "r", session: s("a", { updatedAt: 10 }), pulse: p("a", { pendingUi: [perm("p1"), { id: "q1", kind: "question", title: "Q" }] }) },
      { runnerId: "r", session: s("b", { live: false, updatedAt: 20 }) },
      { runnerId: "r", session: s("c", { live: false }) },
      { runnerId: "r", session: s("d", { needsInput: true }) },
      // Not live: its stale requests don't count; its notice does.
      { runnerId: "r", session: s("e", { live: false }), pulse: p("e", { pendingUi: [perm("p9")] }) },
    ];
    const notices: Record<string, AgentNotice> = { b: notice("b", "finished", 30), c: notice("c", "blocked", 40, { toolId: "t1", call: "git push", by: "judge", reason: "pushes" }), d: notice("d", "question", 25), e: notice("e", "finished", 35) };
    const rows = buildInbox(needs, [{ runnerId: "r", conflict }], (e) => notices[e.session.id], since, 100);
    expect(rows.map((x) => `${x.kind}:${x.key}`)).toEqual(["permission:r:a:p1", "ask:r:d", "ask:r:a:q1", "blocked:r:c", "memory:r:memory:c1", "finished:r:e", "finished:r:b"]);
    // A request is as old as when it was first seen, and stays that old.
    expect(rows[0]!.at).toBe(100);
    expect(buildInbox(needs, [], (e) => notices[e.session.id], since, 500)[0]!.at).toBe(100);
    expect(rows.find((x) => x.key === "r:c")!.notice!.toolId).toBe("t1");
  });
  test("a question notice says when its request started", () => {
    const e = { runnerId: "r", session: s("a"), pulse: p("a", { pendingUi: [perm("p1")] }) };
    const rows = buildInbox([e], [], () => notice("a", "question", 40, { requestId: "p1" }), (_k, f) => f, 100);
    expect(rows[0]!.at).toBe(40);
    expect(rows[0]!.notice?.requestId).toBe("p1");
  });
});

describe("row text", () => {
  const perm = (name: string, input: unknown, message?: string): UiRequest => ({ id: "1", kind: "permission", title: "t", tool: { name, input }, message });
  test("requestCall, permissionVerb, requestTruncated", () => {
    expect(requestCall(perm("Bash", { command: "git push" }))).toEqual({ text: "git push", shell: true });
    expect(requestCall(perm("exec_command", { cmd: ["ls", "-la"] }))).toEqual({ text: "ls -la", shell: true });
    expect(requestCall(perm("Edit", { file_path: "src/a.ts" }))).toEqual({ text: "src/a.ts", shell: false });
    expect(permissionVerb(perm("Bash", { command: "ls" }))).toBe("wants to run");
    expect(permissionVerb(perm("Edit", { file_path: "a" }))).toBe("wants to edit");
    expect(permissionVerb(perm("WebFetch", { url: "x" }))).toBe("wants to use WebFetch");
    expect(requestTruncated(perm("Bash", { command: "x", truncated: true }))).toBe(true);
    expect(requestTruncated(perm("Bash", { command: "x" }))).toBe(false);
  });
  test("guardNote drops the warning mark; nothing when there's no note", () => {
    expect(guardNote(perm("Bash", {}, "⚠ Pushes to a remote."))).toBe("Pushes to a remote.");
    expect(guardNote(perm("Bash", {}, "A hook asks"))).toBe("A hook asks");
    expect(guardNote(perm("Bash", {}))).toBeUndefined();
    expect(guardNote({ id: "q", kind: "question", title: "", message: "hi" })).toBeUndefined();
  });
  test("isShellCall and blockedLine", () => {
    expect(isShellCall("git push origin main")).toBe(true);
    expect(isShellCall("Edit src/a.ts")).toBe(false);
    expect(isShellCall("mcp__github__create_pr")).toBe(false);
    expect(isShellCall(undefined)).toBe(false);
    expect(blockedLine({ by: "judge", reason: "It pushes.", body: "x" })).toBe("Blocked by the judge: It pushes.");
    expect(blockedLine({ by: "rule", body: "x" })).toBe("Blocked by a rule");
    expect(blockedLine({ body: "older runner" })).toBe("older runner");
  });
  test("a plan's first line; one-tap questions only with short options", () => {
    expect(requestLine({ id: "p", kind: "plan", title: "Plan", message: "\n  1. Add a queue\n2. Test" })).toBe("1. Add a queue");
    expect(requestLine({ id: "p", kind: "plan", title: "Plan" })).toBe("The agent has a plan for you to review");
    const q = { id: "1", kind: "question" as const, title: "Q", questions: [{ question: "Which?", options: [{ label: "A".repeat(40) }] }] };
    expect(oneTapQuestion(q)).toBeUndefined();
  });
});
