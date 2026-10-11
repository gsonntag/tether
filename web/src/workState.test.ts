import { describe, expect, test } from "bun:test";
import type { SessionPulse, SessionSummary } from "./shared/protocol";
import { pulseWork, runningLine, summaryWork, workLabel, workState } from "./workState";

const s = (over: Partial<SessionSummary> = {}): SessionSummary => ({
  id: "a",
  harness: "claude-code",
  nativeId: "a",
  projectPath: "/p",
  title: "a",
  createdAt: 0,
  updatedAt: 0,
  live: true,
  status: "idle",
  ...over,
});

describe("workState", () => {
  test("the main turn running is working, whatever else is going", () => {
    expect(workState({ live: true, status: "running" })).toBe("working");
    expect(workState({ live: true, status: "running", running: { subagent: 2 }, armed: 1 })).toBe("working");
  });

  test("a turn waiting on a limit is waiting", () => {
    expect(workState({ live: true, status: "waiting", running: { shell: 1 } })).toBe("waiting");
  });

  test("an idle turn with running subagents, shells, monitors or workflows is working in the background", () => {
    for (const kind of ["subagent", "shell", "monitor", "workflow", "tool"] as const) expect(workState({ live: true, status: "idle", running: { [kind]: 1 } })).toBe("background");
    expect(workState({ live: true, status: "idle", running: { subagent: 1 }, armed: 3 })).toBe("background");
  });

  test("only armed wakeups or cron jobs is scheduled, not working", () => {
    expect(workState({ live: true, status: "idle", armed: 1 })).toBe("scheduled");
    expect(workState({ live: true, status: "idle", running: {}, armed: 2 })).toBe("scheduled");
  });

  test("nothing going is idle; no process is closed", () => {
    expect(workState({ live: true, status: "idle" })).toBe("idle");
    expect(workState({ live: true, status: "idle", running: { subagent: 0 } })).toBe("idle");
    expect(workState({ live: false, status: "idle", running: { subagent: 1 } })).toBe("closed");
  });
});

describe("from a summary", () => {
  test("running kinds count as running; the rest of activeCount is armed; no kinds (older runner) is running", () => {
    expect(workState(summaryWork(s({ activeCount: 3, runningKinds: { subagent: 2 } })))).toBe("background");
    expect(summaryWork(s({ activeCount: 3, runningKinds: { subagent: 2 } })).armed).toBe(1);
    expect(workState(summaryWork(s({ activeCount: 1, status: "idle" })))).toBe("background");
    expect(workState(summaryWork(s()))).toBe("idle");
  });

  test("a wakeup alone is scheduled", () => {
    // The runner sends runningKinds whenever activeCount is set ({} for armed items only); an older
    // one never does, read above as "running".
    const w = summaryWork(s({ activeCount: 1, runningKinds: {} }));
    expect(workState(w)).toBe("scheduled");
  });
});

describe("from a pulse", () => {
  test("uses the pulse's running counts and armed", () => {
    const p: SessionPulse = { session: s(), activity: { shell: 1 } };
    expect(workState(pulseWork(p))).toBe("background");
    expect(workState(pulseWork({ session: s(), armed: 1 }))).toBe("scheduled");
  });
});

describe("labels", () => {
  test("background names what's still running", () => {
    expect(runningLine({ subagent: 2, shell: 1 })).toBe("2 agents, 1 shell");
    expect(workLabel({ live: true, status: "idle", running: { subagent: 2, shell: 1 } })).toEqual({
      state: "background",
      label: "Working in background",
      tooltip: "Main agent is idle · 2 agents, 1 shell still running",
    });
  });

  test("scheduled says it's waiting", () => {
    expect(workLabel({ live: true, status: "idle", armed: 1 }).tooltip).toBe("Waiting for a scheduled wakeup");
    expect(workLabel({ live: true, status: "idle", armed: 2 }).tooltip).toBe("Waiting for 2 scheduled wakeups");
  });
});
