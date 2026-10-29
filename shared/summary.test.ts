import { expect, test } from "bun:test";
import { applySummary, emptySummary } from "./summary";
import type { SessionSummary } from "./transcript";

const s = (id: string, title = id): SessionSummary => ({ id, harness: "claude", nativeId: id, projectPath: "/p", title, mode: "stored", status: "idle", updatedAt: 0 });

test("a list reply older than the updates around it is ignored", () => {
  let st = applySummary(emptySummary(), { kind: "all", epoch: "e1", seq: 5, sessions: [s("a")] }).state;
  st = applySummary(st, { kind: "upsert", epoch: "e1", seq: 6, sessions: [s("a", "renamed")] }).state;
  // A list fetched before seq 6 arrives late:
  const late = applySummary(st, { kind: "all", epoch: "e1", seq: 5, sessions: [s("a")] });
  expect(late.state).toBe(st);
  expect(st.sessions.a!.title).toBe("renamed");
});

test("updates in order apply; duplicates and old ones are dropped", () => {
  let st = applySummary(emptySummary(), { kind: "all", epoch: "e1", seq: 1, sessions: [s("a"), s("b")] }).state;
  const r = applySummary(st, { kind: "remove", epoch: "e1", seq: 2, ids: ["a"] });
  expect(r.relist).toBe(false);
  st = r.state;
  expect(Object.keys(st.sessions)).toEqual(["b"]);
  expect(applySummary(st, { kind: "upsert", epoch: "e1", seq: 2, sessions: [s("a")] }).state).toBe(st);
});

test("a skipped seq, or an update before any list, asks for the list again", () => {
  const st = applySummary(emptySummary(), { kind: "all", epoch: "e1", seq: 1, sessions: [] }).state;
  const gap = applySummary(st, { kind: "upsert", epoch: "e1", seq: 3, sessions: [s("c")] });
  expect(gap.relist).toBe(true);
  expect(gap.state.sessions.c).toBeDefined();
  expect(applySummary(emptySummary(), { kind: "upsert", epoch: "e1", seq: 4, sessions: [s("d")] }).relist).toBe(true);
});

test("a runner restart (new epoch) starts the list over, even with a lower seq", () => {
  let st = applySummary(emptySummary(), { kind: "all", epoch: "e1", seq: 500, sessions: [s("old")] }).state;
  const restarted = applySummary(st, { kind: "all", epoch: "e2", seq: 1, sessions: [s("new")] });
  expect(restarted.relist).toBe(false);
  expect(Object.keys(restarted.state.sessions)).toEqual(["new"]);
  st = restarted.state;
  expect(applySummary(st, { kind: "upsert", epoch: "e2", seq: 2, sessions: [s("x")] }).relist).toBe(false);
  // An update from a new epoch before its list: start over and ask for the list.
  const early = applySummary(st, { kind: "upsert", epoch: "e3", seq: 1, sessions: [s("y")] });
  expect(early.relist).toBe(true);
  expect(Object.keys(early.state.sessions)).toEqual(["y"]);
  // A late frame from the old epoch after the new one took over replaces it again; the list
  // request that follows from relist settles it.
  expect(applySummary(early.state, { kind: "remove", epoch: "e2", seq: 3, ids: [] }).relist).toBe(true);
});
