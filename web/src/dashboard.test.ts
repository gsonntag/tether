import { describe, expect, test } from "bun:test";
import type { SessionPulse, SessionSummary } from "./shared/protocol";
import { activityLine, answerRequest, contextPercent, diffLabel, elapsed, groupDashboard, isRunning, mergePulses, oneTapQuestion, requestLine, runningCount } from "./dashboard";

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

describe("groupDashboard", () => {
  const perm = { id: "q1", kind: "permission" as const, title: "Allow Bash?", tool: { name: "Bash", input: { command: "rm -rf build" } } };
  const map = mergePulses(
    mergePulses({}, "r1", [
      p("waiting-approval", { pendingUi: [perm] }, { status: "running", needsInput: true, updatedAt: 5 }),
      p("busy", { turnStartedAt: 100 }, { status: "running" }),
      p("busy-older", { turnStartedAt: 50 }, { status: "running" }),
      p("sched-only", { armed: 1 }, { updatedAt: 9 }),
      p("bg-only", { activity: { subagent: 1 } }),
      p("done-1", { finishedAt: 10, lastText: "ok" }, { updatedAt: 9 }),
      // sorted like the session lists: by the last message, not by when the turn ended
      p("done-2", { finishedAt: 20 }, { updatedAt: 35 }),
      p("closed-done", { finishedAt: 30 }, { live: false, updatedAt: 29 }),
      p("idle-never-ran"),
    ]),
    "r2",
    [p("other-runner", {}, { status: "waiting" })],
  );
  const d = groupDashboard(map);

  test("needs you: one row per waiting request", () => {
    expect(d.needs.map((n) => [n.runnerId, n.pulse.session.id, n.request.id])).toEqual([["r1", "waiting-approval", "q1"]]);
  });

  test("running: prompts first, then running (newest turn first), then waiting, then background only, then a wakeup only", () => {
    expect(d.running.map((r) => r.pulse.session.id)).toEqual(["waiting-approval", "busy", "busy-older", "other-runner", "bg-only", "sched-only"]);
  });

  test("recently finished: most recent message first, includes closed sessions, never a running one", () => {
    expect(d.finished.map((r) => r.pulse.session.id)).toEqual(["done-2", "closed-done", "done-1"]);
    expect(groupDashboard(map, { finished: 1 }).finished).toHaveLength(1);
  });

  test("a closed session is never running, even with stale counts", () => {
    expect(isRunning(p("x", { activity: { shell: 1 } }, { live: false, status: "running" }))).toBe(false);
  });

  test("a finished session that starts again moves back to running", () => {
    const again = mergePulses(map, "r1", [p("done-2", { finishedAt: 20 }, { status: "running" })]);
    const g = groupDashboard(again);
    expect(g.running.some((r) => r.pulse.session.id === "done-2")).toBe(true);
    expect(g.finished.some((r) => r.pulse.session.id === "done-2")).toBe(false);
  });
});

test("activityLine, diffLabel, contextPercent, elapsed", () => {
  expect(activityLine(p("a", { activity: { shell: 1, subagent: 2 }, armed: 1 }))).toBe("2 agents · 1 shell · 1 scheduled");
  expect(activityLine(p("a"))).toBe("");
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

test("runningCount (the sidebar badge) matches Home's Running section across runners", () => {
  let m = mergePulses({}, "r1", [p("a", {}, { status: "running" }), p("b"), p("c", { armed: 1 }), p("bg", { activity: { shell: 1 } })]);
  m = mergePulses(m, "r2", [p("d", {}, { status: "waiting" }), p("e", {}, { live: false, status: "idle" })]);
  // Working in the background counts: the main turn is over, its subagents and shells aren't.
  expect(runningCount(m)).toBe(4);
  expect(runningCount(m)).toBe(groupDashboard(m).running.length);
});
