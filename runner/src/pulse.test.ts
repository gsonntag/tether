import { describe, expect, test } from "bun:test";
import type { LiveState, Msg, SessionPulse, SessionSummary } from "../../web/src/shared/protocol";
import { emptyState } from "../../web/src/shared/reducer";
import { buildPulse, ClosedPulses, compactUi, currentAction, lastLine, PulseThrottle, pulseKey, TurnClock } from "./pulse";

const summary = (id: string, over: Partial<SessionSummary> = {}): SessionSummary => ({
  id,
  harness: "claude-code",
  nativeId: id,
  projectPath: "/tmp/p",
  title: id,
  createdAt: 0,
  updatedAt: 0,
  live: true,
  status: "running",
  ...over,
});
const pulse = (id: string, over: Partial<SessionPulse> = {}): SessionPulse => ({ session: summary(id), ...over });

/** A fake clock and timer queue. */
function clock() {
  let now = 1_000;
  let timers: { at: number; fn: () => void; id: number }[] = [];
  let n = 0;
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      const t = { at: now + ms, fn, id: ++n };
      timers.push(t);
      return t.id;
    },
    clearTimer: (id: unknown) => void (timers = timers.filter((t) => t.id !== id)),
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers = timers.filter((t) => t !== due);
        now = due.at;
        due.fn();
      }
      now = end;
    },
    get pending() {
      return timers.length;
    },
  };
}

function setup(intervalMs = 1_000) {
  const c = clock();
  const sent: SessionPulse[][] = [];
  const state = new Map<string, SessionPulse>();
  let builds = 0;
  const t = new PulseThrottle({
    intervalMs,
    build: (id) => (builds++, state.get(id)),
    send: (l) => sent.push(l),
    now: c.now,
    setTimer: c.setTimer,
    clearTimer: c.clearTimer,
  });
  return { c, sent, state, t, builds: () => builds };
}

describe("PulseThrottle", () => {
  test("a burst in one tick sends once, right away", () => {
    const { c, sent, state, t, builds } = setup();
    state.set("a", pulse("a", { action: "x" }));
    for (let i = 0; i < 50; i++) t.touch("a");
    c.advance(0);
    expect(sent.length).toBe(1);
    expect(builds()).toBe(1);
  });

  test("at most one pulse per session per interval, with the latest state (trailing)", () => {
    const { c, sent, state, t } = setup();
    state.set("a", pulse("a", { action: "1" }));
    t.touch("a");
    c.advance(0);
    for (let i = 2; i <= 9; i++) {
      state.set("a", pulse("a", { action: String(i) }));
      t.touch("a");
      c.advance(100);
    }
    expect(sent.length).toBe(1);
    c.advance(300);
    expect(sent.length).toBe(2);
    expect(sent[1]![0]!.action).toBe("9");
    expect(sent.flat().length).toBe(2);
  });

  test("unchanged pulses are not sent again, and updatedAt alone isn't a change", () => {
    const { c, sent, state, t } = setup();
    state.set("a", pulse("a", { action: "x" }));
    t.touch("a");
    c.advance(0);
    state.set("a", { ...pulse("a", { action: "x" }), session: summary("a", { updatedAt: 999 }) });
    t.touch("a");
    c.advance(2_000);
    expect(sent.length).toBe(1);
    expect(c.pending).toBe(0);
  });

  test("sessions are throttled independently, and due pulses go out together", () => {
    const { c, sent, state, t } = setup();
    state.set("a", pulse("a", { action: "a1" }));
    state.set("b", pulse("b", { action: "b1" }));
    t.touch("a");
    t.touch("b");
    c.advance(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.map((p) => p.session.id).sort()).toEqual(["a", "b"]);
    state.set("a", pulse("a", { action: "a2" }));
    state.set("b", pulse("b", { action: "b2" }));
    t.touch("a");
    c.advance(500);
    t.touch("b");
    c.advance(600);
    // both became due at the same instant (1 s after the first send)
    expect(sent).toHaveLength(2);
    expect(sent[1]!.map((p) => p.action).sort()).toEqual(["a2", "b2"]);
  });

  test("a session that's gone builds nothing", () => {
    const { c, sent, t } = setup();
    t.touch("ghost");
    c.advance(0);
    expect(sent).toHaveLength(0);
  });

  test("resetSent re-sends an unchanged pulse once touched", () => {
    const { c, sent, state, t } = setup();
    state.set("a", pulse("a"));
    t.touch("a");
    c.advance(0);
    t.resetSent();
    t.touch("a");
    c.advance(1_000);
    expect(sent).toHaveLength(2);
  });

  test("many quiet sessions cost nothing; many busy ones build once per interval each", () => {
    const { c, sent, state, t, builds } = setup();
    for (let i = 0; i < 200; i++) state.set(`s${i}`, pulse(`s${i}`, { action: "0" }));
    for (let tick = 0; tick < 10; tick++) {
      for (let i = 0; i < 20; i++) {
        state.set(`s${i}`, pulse(`s${i}`, { action: String(tick) }));
        for (let k = 0; k < 30; k++) t.touch(`s${i}`); // streaming deltas
      }
      c.advance(100);
    }
    c.advance(1_000);
    // 20 busy sessions over ~2 s: first send + one per elapsed interval, never per event
    expect(builds()).toBeLessThanOrEqual(20 * 3);
    expect(sent.flat().length).toBeLessThanOrEqual(20 * 3);
  });
});

describe("TurnClock", () => {
  test("turn start and finish times from status changes", () => {
    let now = 10;
    const t = new TurnClock(() => now);
    t.update("a", "idle");
    expect(t.finishedAt("a")).toBeUndefined();
    t.update("a", "running");
    expect(t.turnStartedAt("a")).toBe(10);
    now = 20;
    t.update("a", "waiting");
    t.update("a", "running"); // a retry after a wait is the same turn
    expect(t.turnStartedAt("a")).toBe(10);
    now = 30;
    t.update("a", "idle");
    expect(t.finishedAt("a")).toBe(30);
    expect(t.turnStartedAt("a")).toBeUndefined();
  });
});

const msg = (role: Msg["role"], parts: Msg["parts"], over: Partial<Msg> = {}): Msg => ({ id: Math.random().toString(36), role, parts, ts: 0, ...over });

describe("buildPulse", () => {
  test("counts running activity by kind, armed separately, and clips approvals", () => {
    const state: LiveState = {
      ...emptyState(),
      status: "running",
      model: "claude-haiku-4-5",
      context: { used: 50_000, max: 200_000, input: 3 },
      activity: [
        { id: "1", kind: "subagent", title: "a", status: "running", startedAt: 1 },
        { id: "2", kind: "subagent", title: "b", status: "running", startedAt: 2 },
        { id: "3", kind: "shell", title: "c", status: "running", startedAt: 3 },
        { id: "4", kind: "schedule", title: "d", status: "waiting", startedAt: 4 },
        { id: "5", kind: "shell", title: "e", status: "done", startedAt: 5, endedAt: 6 },
      ],
      pendingUi: [{ id: "p", kind: "permission", title: "Allow Write?", tool: { name: "Write", input: { file_path: "/x/a.ts", content: "x".repeat(100_000) } } }],
      diffStat: { files: 2, additions: 42, deletions: 3 },
    };
    const p = buildPulse({ session: summary("a"), state, messages: [msg("assistant", [{ type: "text", text: "Done.\n\nAll **tests** pass." }])], turnStartedAt: 5 });
    expect(p.activity).toEqual({ subagent: 2, shell: 1 });
    expect(p.armed).toBe(1);
    expect(p.context).toEqual({ used: 50_000, max: 200_000 });
    expect(p.action).toBe("Waiting for approval: Write");
    expect(JSON.stringify(p.pendingUi).length).toBeLessThan(500);
    expect(p.lastText).toBe("All **tests** pass.");
    expect(p.diffStat?.additions).toBe(42);
    expect(p.turnStartedAt).toBe(5);
  });

  test("a closed session has no live fields", () => {
    const state: LiveState = { ...emptyState(), activity: [{ id: "1", kind: "shell", title: "c", status: "running", startedAt: 3 }] };
    const p = buildPulse({ session: summary("a", { live: false, status: "idle" }), state, messages: [], finishedAt: 9 });
    expect(p.action).toBeUndefined();
    expect(p.activity).toBeUndefined();
    expect(p.finishedAt).toBe(9);
  });
});

describe("currentAction", () => {
  test("the newest running tool call, else streaming text or thinking", () => {
    const running = { ...emptyState(), status: "running" as const };
    expect(currentAction(running, [msg("assistant", [{ type: "tool", id: "t", name: "Bash", input: { command: "bun test" }, status: "running" }])])).toBe("Running bun test");
    expect(currentAction(running, [msg("assistant", [{ type: "thinking", text: "hm" }], { streaming: true })])).toBe("Thinking");
    expect(currentAction(running, [msg("assistant", [{ type: "text", text: "hi" }], { streaming: true })])).toBe("Writing");
    expect(currentAction({ ...emptyState(), status: "waiting", waitingReason: "Rate limited" }, [])).toBe("Rate limited");
  });

  test("idle with a subagent running: its latest step", () => {
    const s = { ...emptyState(), activity: [{ id: "1", kind: "subagent" as const, title: "Review", status: "running" as const, startedAt: 1, latest: "Reading a.ts" }] };
    expect(currentAction(s, [])).toBe("Reading a.ts");
    expect(currentAction(emptyState(), [])).toBeUndefined();
  });
});

test("lastLine skips markdown markers and empty lines", () => {
  expect(lastLine([msg("assistant", [{ type: "text", text: "First\n\n- item two\n\n" }]), msg("user", [{ type: "text", text: "u" }])])).toBe("item two");
});

test("compactUi keeps commands, drops file bodies", () => {
  const r = compactUi({ id: "1", kind: "permission", title: "t", tool: { name: "Bash", input: { command: "ls", description: "x" } } });
  expect(r.tool?.input).toEqual({ command: "ls" });
});

test("pulseKey ignores updatedAt only", () => {
  expect(pulseKey(pulse("a"))).toBe(pulseKey({ ...pulse("a"), session: summary("a", { updatedAt: 5 }) }));
  expect(pulseKey(pulse("a"))).not.toBe(pulseKey(pulse("a", { action: "x" })));
});

describe("secrets and long calls on the dashboard", () => {
  const key = "sk-ant-api03-" + "Ab3".repeat(12);
  test("credentials are redacted from commands, summaries, messages, the action and the last line", () => {
    const perm = compactUi({ id: "1", kind: "permission", title: "t", message: `uses ${key}`, tool: { name: "Bash", input: { command: `curl -H "Authorization: Bearer ${key}" https://api` } } });
    const mcp = compactUi({ id: "2", kind: "permission", title: "t", tool: { name: "mcp__x", input: { api_key: "hunter2hunter2hunter2" } } });
    const all = JSON.stringify([perm, mcp]);
    expect(all).not.toContain("Ab3Ab3");
    expect(all).not.toContain("hunter2");
    expect(all).toContain("[redacted]");
    const state: LiveState = { ...emptyState(), status: "running" };
    const p = buildPulse({
      session: summary("a"),
      state,
      messages: [msg("assistant", [{ type: "text", text: `Set OPENAI_KEY=${key}` }, { type: "tool", id: "t", name: "Bash", input: { command: `export TOKEN=${key}` }, status: "running" }])],
    });
    expect(JSON.stringify(p)).not.toContain("Ab3Ab3");
  });

  test("a secret straddling the clip point doesn't leak its start", () => {
    const r = compactUi({ id: "1", kind: "permission", title: "t", tool: { name: "Bash", input: { command: "x".repeat(390) + " " + key } } });
    expect((r.tool!.input as any).command).not.toContain("sk-ant");
  });

  test("a call too long to show is marked truncated (Home sends you to the session to approve it)", () => {
    const short = compactUi({ id: "1", kind: "permission", title: "t", tool: { name: "Bash", input: { command: "ls -la" } } });
    const long = compactUi({ id: "2", kind: "permission", title: "t", tool: { name: "Bash", input: { command: "echo ok; " + "a".repeat(500) + " && rm -rf ~" } } });
    expect((short.tool!.input as any).truncated).toBeUndefined();
    expect((long.tool!.input as any).truncated).toBe(true);
  });
});

test("ClosedPulses tells when it evicts, so per-session state is forgotten", () => {
  const gone: string[] = [];
  const c = new ClosedPulses(2, (id) => gone.push(id));
  for (const id of ["a", "b", "a", "c", "d"]) c.put(pulse(id));
  expect(gone).toEqual(["b", "a"]);
  expect(c.list().map((p) => p.session.id)).toEqual(["c", "d"]);
});

test("ClosedPulses keeps the newest N", () => {
  const c = new ClosedPulses(2);
  c.put(pulse("a"));
  c.put(pulse("b"));
  c.put(pulse("c"));
  expect(c.list().map((p) => p.session.id)).toEqual(["b", "c"]);
});
