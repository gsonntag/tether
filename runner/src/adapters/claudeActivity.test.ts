import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { upsertActivity } from "../../../web/src/shared/reducer";
import type { ActivityItem } from "../../../web/src/shared/protocol";
import { describeTool, tail } from "./activity";
import { ClaudeActivity, LONG_TOOL_S } from "./claudeActivity";

/** Raw Agent SDK messages captured from a real haiku session (uuid/session_id stripped). */
async function fixture(name: string): Promise<any[]> {
  const text = await Bun.file(join(import.meta.dir, "fixtures", `${name}.jsonl`)).text();
  return text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

/** Replays a fixture as the session would: every change goes through the shared reducer. */
function replay(messages: any[], until?: (m: any) => boolean) {
  let t = 1_000;
  const act = new ClaudeActivity(() => t);
  let list: ActivityItem[] = [];
  for (const m of messages) {
    t += 100;
    if (m.type?.startsWith("__")) continue;
    list = upsertActivity(list, act.onMessage(m));
    if (until?.(m)) break;
  }
  return { act, list, byTitle: (s: string) => list.find((a) => a.title.includes(s))! };
}

describe("Claude Code activity", () => {
  test("two background subagents and a background shell, while they run", async () => {
    const msgs = await fixture("claude-bg");
    // Stop right before the first task finishes.
    const { list, byTitle } = replay(msgs, (m) => m.type === "result");
    expect(list.map((a) => [a.kind, a.status])).toEqual([
      ["subagent", "running"],
      ["subagent", "running"],
      ["shell", "running"],
    ]);
    const sub = byTitle("write sub.ts");
    expect(sub.agentType).toBe("general-purpose");
    expect(sub.model).toBe("claude-haiku-5-5");
    expect(sub.background).toBe(true);
    expect(sub.stoppable).toBe(true);
    expect(sub.toolUses).toBe(3);
    expect(sub.tokens).toBeGreaterThan(10_000);
    expect(sub.latest).toBe("Running List files in /tmp/act-repo");
    // Its own tool calls, not in the transcript: the mini-transcript.
    expect(sub.steps?.map((s) => [s.label, s.status])).toEqual([
      ["Reading math.ts", "done"],
      ["Writing sub.ts", "done"],
      ["Running ls", "running"],
    ]);
    expect(sub.description).toContain("Step 1: Read math.ts");
    const shell = byTitle("Print eight ticks");
    expect(shell.command).toBe("for i in 1 2 3 4 5 6 7 8; do echo tick $i; sleep 2; done");
  });

  test("everything settles with reports and usage", async () => {
    const { act, list, byTitle } = replay(await fixture("claude-bg"));
    expect(list.every((a) => a.status === "done" && a.endedAt)).toBe(true);
    const count = byTitle("Count lines");
    expect(count.summary).toContain("Total: 2 lines");
    expect(count.tokens).toBe(12986);
    expect(count.toolUses).toBe(1);
    expect(byTitle("Print eight ticks").summary).toContain("exit code 0");
    expect(act.readable()).toEqual([]);
  });

  test("Monitor, cron jobs, a stopped shell and a foreground subagent", async () => {
    const msgs = await fixture("claude-mix");
    const mid = replay(msgs, (m) => m.type === "system" && m.subtype === "task_progress");
    const cron = mid.list.find((a) => a.id === "cron:d01e55c0")!;
    expect(cron).toMatchObject({ kind: "schedule", status: "waiting", title: "check the build", schedule: "Every 30 minutes" });
    expect(mid.byTitle("count to three")).toMatchObject({ kind: "monitor", status: "running", watching: "for i in 1 2 3; do echo line $i; sleep 1; done" });
    expect(mid.byTitle("List repo files")).toMatchObject({ kind: "subagent", status: "running", background: false, latest: "Running List files in current directory" });
    expect(mid.act.readable().map((a) => a.title).sort()).toEqual(["Sleep a minute", "count to three"]);

    const end = replay(msgs);
    expect(end.byTitle("count to three").status).toBe("done");
    expect(end.byTitle("Sleep a minute").status).toBe("stopped");
    const fg = end.byTitle("List repo files");
    expect(fg.status).toBe("done");
    expect(fg.summary).toContain("README.md");
    expect(fg.steps?.map((s) => s.label)).toEqual(["Running ls"]);
    expect(end.list.find((a) => a.id === "cron:d01e55c0")!.status).toBe("stopped");
  });

  test("ScheduleWakeup: armed, replaced, then fired", () => {
    let t = 0;
    const act = new ClaudeActivity(() => t);
    const wake = (id: string, input: any, result: any) => {
      act.onMessage({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "ScheduleWakeup", input }] } });
      return act.onMessage({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] }, tool_use_result: result });
    };
    const [a] = wake("w1", { delaySeconds: 600, reason: "check CI again", prompt: "/loop check CI" }, { scheduledFor: 600_000, clampedDelaySeconds: 600 });
    expect(a).toMatchObject({ kind: "schedule", status: "waiting", nextAt: 600_000, title: "check CI again" });
    t = 10;
    const changed = wake("w2", { delaySeconds: 60, reason: "soon" }, { scheduledFor: 60_010 });
    expect(changed.find((x) => x.id === "wakeup:w1")?.status).toBe("done");
    t = 70_000;
    expect(act.tick().map((x) => [x.id, x.status])).toEqual([["wakeup:w2", "done"]]);
  });

  test("a long main-thread tool call shows while it runs", () => {
    let t = 100_000;
    const act = new ClaudeActivity(() => t);
    act.onMessage({ type: "assistant", message: { content: [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "bun test", description: "Run the tests" } }] } });
    expect(act.onMessage({ type: "tool_progress", tool_use_id: "b1", tool_name: "Bash", parent_tool_use_id: null, elapsed_time_seconds: 3 })).toEqual([]);
    const [item] = act.onMessage({ type: "tool_progress", tool_use_id: "b1", tool_name: "Bash", parent_tool_use_id: null, elapsed_time_seconds: LONG_TOOL_S });
    expect(item).toMatchObject({ kind: "shell", title: "Run the tests", command: "bun test", status: "running", startedAt: 100_000 - LONG_TOOL_S * 1000 });
    const [done] = act.onMessage({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "b1", content: "ok" }] } });
    expect(done!.status).toBe("done");
  });

  test("ambient tasks are not activity", () => {
    const act = new ClaudeActivity(() => 0);
    expect(act.onMessage({ type: "system", subtype: "task_started", task_id: "x", description: "memory", ambient: true })).toEqual([]);
    expect(act.onMessage({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "x", task_type: "dream", description: "d", ambient: true }] })).toEqual([]);
  });

  test("a task that leaves the level without its closing edge is over", () => {
    const act = new ClaudeActivity(() => 5);
    act.onMessage({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "b1", task_type: "local_bash", description: "serve" }] });
    const [gone] = act.onMessage({ type: "system", subtype: "background_tasks_changed", tasks: [] });
    expect(gone).toMatchObject({ id: "b1", kind: "shell", status: "done" });
  });
});

describe("activity helpers", () => {
  test("describeTool", () => {
    expect(describeTool("Edit", { file_path: "/a/web/src/components/Sidebar.tsx" })).toBe("Editing Sidebar.tsx");
    expect(describeTool("Bash", { command: "bun test" })).toBe("Running bun test");
    expect(describeTool("read", { path: "src/x.ts" })).toBe("Reading x.ts");
    expect(describeTool("mcp__github__create_pr", {})).toBe("github: create_pr");
  });

  test("tail keeps the last lines", () => {
    expect(tail("a\nb\nc\nd\n", 2)).toBe("c\nd");
  });

  test("upsertActivity keeps running items and the newest finished ones", () => {
    const items: ActivityItem[] = Array.from({ length: 30 }, (_, i) => ({ id: `d${i}`, kind: "shell", title: "x", status: "done", startedAt: i, endedAt: i }));
    const list = upsertActivity([{ id: "run", kind: "subagent", title: "r", status: "running", startedAt: -1 }], items);
    expect(list.length).toBe(21);
    expect(list[0]!.id).toBe("run");
    expect(list.some((a) => a.id === "d0")).toBe(false);
    expect(list.some((a) => a.id === "d29")).toBe(true);
  });
});
