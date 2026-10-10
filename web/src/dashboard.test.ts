import { describe, expect, test } from "bun:test";
import type { SessionPulse, SessionSummary } from "./shared/protocol";
import { activityLine, contextPercent, diffLabel, elapsed, groupDashboard, isRunning, mergePulses, oneTapQuestion, requestLine } from "./dashboard";

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
      p("bg-only", { activity: { subagent: 1 } }),
      p("done-1", { finishedAt: 10, lastText: "ok" }),
      p("done-2", { finishedAt: 20 }),
      p("closed-done", { finishedAt: 30 }, { live: false }),
      p("idle-never-ran"),
    ]),
    "r2",
    [p("other-runner", {}, { status: "waiting" })],
  );
  const d = groupDashboard(map);

  test("needs you: one row per waiting request", () => {
    expect(d.needs.map((n) => [n.runnerId, n.pulse.session.id, n.request.id])).toEqual([["r1", "waiting-approval", "q1"]]);
  });

  test("running: prompts first, then running (newest turn first), then waiting, then background only", () => {
    expect(d.running.map((r) => r.pulse.session.id)).toEqual(["waiting-approval", "busy", "busy-older", "other-runner", "bg-only"]);
  });

  test("recently finished: newest first, includes closed sessions, never a running one", () => {
    expect(d.finished.map((r) => r.pulse.session.id)).toEqual(["closed-done", "done-2", "done-1"]);
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
