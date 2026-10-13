// pi-subagents records, shaped after pi-subagents 0.76 (runs/foreground/execution.js onUpdate and
// tui/render.js's async snapshot widget).
import { describe, expect, test } from "bun:test";
import { PiActivity, chainSpans } from "./piActivity";

const progress = (over: any = {}) => ({
  index: 0,
  agent: "scout",
  status: "running",
  task: "Map the auth module\nand list entry points",
  currentTool: "read",
  currentToolArgs: { path: "src/auth/login.ts" },
  currentToolStartedAt: 900,
  recentTools: [{ tool: "bash", args: { command: "rg login" }, endMs: 800 }],
  recentOutput: ["found 3 files"],
  toolCount: 2,
  tokens: 5_400,
  model: "anthropic/claude-haiku-5-5",
  durationMs: 4_000,
  ...over,
});

describe("pi activity", () => {
  test("a foreground subagent call: progress, then its result", () => {
    const act = new PiActivity(() => 10_000);
    const [a] = act.onRecord({ type: "tool_execution_update", toolCallId: "c1", toolName: "subagent", partialResult: { content: [], details: { mode: "single", results: [], progress: [progress()] } } });
    expect(a).toMatchObject({
      id: "c1:0",
      kind: "subagent",
      title: "Map the auth module",
      agentType: "scout",
      status: "running",
      startedAt: 6_000,
      toolUses: 2,
      tokens: 5_400,
      latest: "Reading login.ts",
      background: false,
    });
    expect(a!.steps!.map((s) => [s.label, s.status])).toEqual([
      ["Running rg login", "done"],
      ["Reading login.ts", "running"],
    ]);
    const [done] = act.onRecord({
      type: "tool_execution_end",
      toolCallId: "c1",
      toolName: "subagent",
      result: { details: { mode: "single", results: [{ index: 0, agent: "scout", task: "x", exitCode: 0, finalOutput: "Entry points: login, logout", usage: { input: 5000, output: 900 } }] } },
      isError: false,
    });
    expect(done).toMatchObject({ status: "done", summary: "Entry points: login, logout", tokens: 5_900, endedAt: 10_000 });
  });

  test("parallel agents, one failing", () => {
    const act = new PiActivity(() => 0);
    act.onRecord({ type: "tool_execution_update", toolCallId: "c2", toolName: "subagent", partialResult: { details: { progress: [progress(), progress({ index: 1, agent: "fixer" })] } } });
    const end = act.onRecord({ type: "tool_execution_end", toolCallId: "c2", toolName: "subagent", result: { details: { results: [{ index: 0, exitCode: 0 }, { index: 1, exitCode: 1, error: "timed out" }] } } });
    expect(end.map((a) => [a.id, a.status])).toEqual([
      ["c2:0", "done"],
      ["c2:1", "failed"],
    ]);
  });

  test("async runs from the widget snapshot", () => {
    let t = 0;
    const act = new PiActivity(() => t);
    const snap = (runs: any[]) => ({ type: "extension_ui_request", method: "setWidget", widgetKey: "subagent-async", widgetLines: [`PI_SUBAGENT_ASYNC_JSON:${JSON.stringify({ kind: "pi-subagents.async-status-snapshot", version: 1, runs })}`] });
    const items = act.onRecord(
      snap([{ id: "r1", kind: "workflow", label: "review", state: "running", startedAt: 5, children: [{ id: "s1", kind: "subagent", label: "reviewer", state: "running", activity: { currentTool: "bash", toolCount: 4 } }] }]),
    );
    expect(items.map((a) => [a.id, a.kind, a.status, a.parentId])).toEqual([
      ["async:r1", "workflow", "running", undefined],
      ["async:s1", "subagent", "running", "async:r1"],
    ]);
    expect(items[1]).toMatchObject({ toolUses: 4, latest: "Running a command", background: true });
    t = 50;
    // Its lanes ("step" children, planned ones included) are its phases; a lane that runs is its agent.
    const lanes = act.onRecord(
      snap([
        {
          id: "r1",
          kind: "workflow",
          label: "review",
          state: "running",
          startedAt: 5,
          children: [
            { id: "s1", kind: "step", label: "scout", state: "complete", endedAt: 20 },
            { id: "s2", kind: "step", label: "reviewers", state: "running", children: [{ id: "n1", kind: "subagent", label: "reviewer-a", state: "running", activity: { currentTool: "read" } }] },
            { id: "s3", kind: "step", label: "fix", state: "queued" },
            { id: "h1", kind: "host-step", label: "CI", state: "queued", hostStep: { kind: "ci", state: "pending" } },
          ],
        },
      ]),
    );
    const wf = lanes.find((a) => a.id === "async:r1")!;
    expect(wf.phases).toEqual([
      { title: "scout", status: "done" },
      { title: "reviewers", status: "running" },
      { title: "fix", status: "pending" },
      { title: "CI", status: "pending" },
    ]);
    // A running lane keeps its item (it was running before as s1's sibling run): its agents sit under it.
    expect(lanes.filter((a) => a.parentId === "async:r1").map((a) => [a.id, a.phase, a.status])).toEqual([
      ["async:s1", 0, "done"],
      ["async:s2", 1, "running"],
    ]);
    expect(lanes.find((a) => a.id === "async:n1")).toMatchObject({ parentId: "async:s2", phase: 1, status: "running" });
    // The lane gains another agent: it stays running (not ended for "leaving" the snapshot).
    t = 60;
    const more = act.onRecord(
      snap([
        {
          id: "r1",
          kind: "workflow",
          label: "review",
          state: "running",
          startedAt: 5,
          children: [
            { id: "s1", kind: "step", label: "scout", state: "complete", endedAt: 20 },
            {
              id: "s2",
              kind: "step",
              label: "reviewers",
              state: "running",
              children: [
                { id: "n1", kind: "subagent", label: "reviewer-a", state: "running" },
                { id: "n2", kind: "subagent", label: "reviewer-b", state: "running" },
              ],
            },
          ],
        },
      ]),
    );
    expect(more.filter((a) => a.endedAt).map((a) => a.id)).toEqual(["async:s1"]);
    t = 70;
    const gone = act.onRecord(snap([]));
    expect(gone.map((a) => [a.id, a.status, a.endedAt])).toEqual([
      ["async:r1", "done", 70],
      ["async:s2", "done", 70],
      ["async:n1", "done", 70],
      ["async:n2", "done", 70],
    ]);
  });

  test("a foreground chain: its steps are phases, later steps aren't running yet", () => {
    const act = new PiActivity(() => 1_000);
    const items = act.onRecord({
      type: "tool_execution_update",
      toolCallId: "c3",
      toolName: "subagent",
      partialResult: {
        details: {
          mode: "chain",
          chainAgents: ["scout", "[reviewer+tester]", "fixer"],
          progress: [progress({ index: 0, status: "completed", currentTool: undefined }), progress({ index: 1, agent: "reviewer" }), progress({ index: 2, agent: "tester", status: "pending" }), progress({ index: 3, agent: "fixer", status: "pending" })],
        },
      },
    });
    const chain = items.find((a) => a.id === "chain:c3")!;
    expect(chain).toMatchObject({ kind: "workflow", title: "Chain: scout → reviewer + tester → fixer", status: "running", background: false, latest: "Reading login.ts" });
    expect(chain.phases).toEqual([
      { title: "scout", status: "done" },
      { title: "reviewer + tester", status: "running", detail: "0 of 2 agents done" },
      { title: "fixer", status: "pending" },
    ]);
    expect(items.filter((a) => a.parentId === "chain:c3").map((a) => [a.id, a.phase, a.status])).toEqual([
      ["c3:0", 0, "done"],
      ["c3:1", 1, "running"],
    ]);
    const end = act.onRecord({ type: "tool_execution_end", toolCallId: "c3", toolName: "subagent", result: { details: { mode: "chain", results: [] } }, isError: true });
    expect(end.find((a) => a.id === "chain:c3")).toMatchObject({ status: "failed" });
    expect(end.find((a) => a.id === "chain:c3")!.phases!.map((p) => p.status)).toEqual(["done", "failed", "pending"]);
  });

  test("chain steps from a workflow graph", () => {
    const d = {
      workflowGraph: {
        nodes: [
          { id: "step-1", kind: "parallel-group", label: "Parallel group (2)", status: "running", stepIndex: 1, children: [{ flatIndex: 1 }, { flatIndex: 2 }] },
          { id: "step-0", kind: "step", label: "plan", status: "completed", stepIndex: 0, flatIndex: 0 },
        ],
      },
    };
    expect(chainSpans(d)).toEqual([
      { title: "plan", start: 0, count: 1, status: "completed" },
      { title: "Parallel group (2)", start: 1, count: 2, status: "running" },
    ]);
  });
});
