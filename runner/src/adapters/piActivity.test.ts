// pi-subagents records, shaped after pi-subagents 0.76 (runs/foreground/execution.js onUpdate and
// tui/render.js's async snapshot widget).
import { describe, expect, test } from "bun:test";
import { PiActivity } from "./piActivity";

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
    const gone = act.onRecord(snap([]));
    expect(gone.map((a) => [a.id, a.status, a.endedAt])).toEqual([
      ["async:r1", "done", 50],
      ["async:s1", "done", 50],
    ]);
  });
});
