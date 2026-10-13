import { expect, test } from "bun:test";
import { activityOf, childrenOf, currentPhase, historyItems, nowLine, phaseLabel, stripModel } from "./activity";
import type { ActivityItem } from "./shared/protocol";

test("older runners' background tasks become running items", () => {
  const items = activityOf({
    status: "idle",
    queued: [],
    statuses: {},
    pendingUi: [],
    background: [
      { id: "a", description: "Audit", type: "general-purpose" },
      { id: "b", description: "dev server", type: "local_bash" },
    ],
  });
  expect(items.map((a) => [a.kind, a.title, a.status])).toEqual([
    ["subagent", "Audit", "running"],
    ["shell", "dev server", "running"],
  ]);
});

const it = (id: string, over: Partial<ActivityItem> = {}): ActivityItem => ({ id, kind: "subagent", title: id, status: "running", startedAt: 0, ...over });

test("the strip: running work with children under their parent, armed items apart", () => {
  const items = [
    it("wf", { kind: "workflow" }),
    it("sh", { kind: "shell" }),
    it("a1", { parentId: "wf" }),
    it("a2", { parentId: "wf", status: "done" }),
    it("s1", { kind: "shell", parentId: "a1" }),
    it("orphan", { parentId: "gone" }),
    it("long", { kind: "tool" }),
    it("cron", { kind: "schedule", status: "waiting", nextAt: 50 }),
    it("wake", { kind: "schedule", status: "waiting", nextAt: 10 }),
  ];
  const { rows, waiting } = stripModel(items);
  expect(rows.map((r) => [r.item.id, r.depth])).toEqual([
    ["wf", 0],
    ["a1", 1],
    ["s1", 2],
    ["sh", 0],
    ["orphan", 0],
  ]);
  expect(waiting.map((a) => a.id)).toEqual(["wake", "cron"]);
});

test("what an item is doing now", () => {
  expect(nowLine(it("s", { kind: "shell", output: "building\nok 12 tests\n\n", latest: "Reading its output" }))).toBe("ok 12 tests");
  expect(nowLine(it("a", { latest: "Editing App.tsx" }))).toBe("Editing App.tsx");
  expect(nowLine(it("a", { steps: [{ id: "1", tool: "Read", label: "Reading x.ts", status: "running", ts: 0 }] }))).toBe("Reading x.ts");
  expect(nowLine(it("s", { kind: "shell", command: "bun dev" }))).toBe("bun dev");
  expect(nowLine(it("a"))).toBeUndefined();
});

test("a workflow's current phase", () => {
  const wf = it("wf", {
    kind: "workflow",
    phases: [
      { title: "Map", status: "done" },
      { title: "Review", status: "running", detail: "1 of 3 agents done" },
      { title: "Report", status: "pending" },
    ],
  });
  expect(currentPhase(wf)).toEqual({ index: 1, total: 3, title: "Review", detail: "1 of 3 agents done" });
  expect(phaseLabel(wf)).toBe("Step 2 of 3 · Review");
  // Between phases: the next one.
  expect(
    phaseLabel({
      ...wf,
      phases: [
        { title: "Map", status: "done" },
        { title: "Report", status: "pending" },
      ],
    }),
  ).toBe("Step 2 of 2 · Report");
  expect(currentPhase({ ...wf, phases: [{ title: "Map", status: "done" }] })).toBeUndefined();
  expect(phaseLabel(it("x"))).toBeUndefined();
});

test("history: finished items, newest first, children inside their parent", () => {
  const items = [it("a", { status: "done", endedAt: 5 }), it("b", { status: "failed", endedAt: 9 }), it("c", { parentId: "a", status: "done", endedAt: 7 }), it("d"), it("e", { status: "waiting" })];
  expect(historyItems(items).map((a) => a.id)).toEqual(["b", "a"]);
  expect(childrenOf(items, "a").map((a) => a.id)).toEqual(["c"]);
});
