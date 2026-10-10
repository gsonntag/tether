import { expect, test } from "bun:test";
import { activityOf, activitySummary } from "./activity";
import type { ActivityItem } from "./shared/protocol";

const item = (kind: ActivityItem["kind"], status: ActivityItem["status"] = "running"): ActivityItem => ({ id: Math.random().toString(), kind, title: kind, status, startedAt: 0 });

test("the summary counts running work by kind, then what's armed", () => {
  expect(activitySummary([item("subagent"), item("shell"), item("subagent"), item("shell"), item("shell"), item("schedule", "waiting"), item("subagent", "done")])).toBe(
    "2 agents · 3 shells · 1 waiting",
  );
  expect(activitySummary([item("monitor")])).toBe("1 monitor");
  expect(activitySummary([item("subagent", "done")])).toBe("");
});

test("older runners' background tasks become running items", () => {
  const items = activityOf({ status: "idle", queued: [], statuses: {}, pendingUi: [], background: [{ id: "a", description: "Audit", type: "general-purpose" }, { id: "b", description: "dev server", type: "local_bash" }] });
  expect(items.map((a) => [a.kind, a.title, a.status])).toEqual([
    ["subagent", "Audit", "running"],
    ["shell", "dev server", "running"],
  ]);
});
