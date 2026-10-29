import { expect, test } from "bun:test";
import { applySummary, emptySummary } from "./summary";
import type { SessionSummary } from "./transcript";

const s = (id: string, title = id): SessionSummary => ({ id, harness: "claude", nativeId: id, projectPath: "/p", title, mode: "stored", status: "idle", updatedAt: 0 });

test("a list reply older than the updates around it is ignored", () => {
  let st = applySummary(emptySummary(), { kind: "all", seq: 5, sessions: [s("a")] }).state;
  st = applySummary(st, { kind: "upsert", seq: 6, sessions: [s("a", "renamed")] }).state;
  // A list fetched before seq 6 arrives late:
  const late = applySummary(st, { kind: "all", seq: 5, sessions: [s("a")] });
  expect(late.state).toBe(st);
  expect(st.sessions.a!.title).toBe("renamed");
});

test("updates in order apply; duplicates and old ones are dropped", () => {
  let st = applySummary(emptySummary(), { kind: "all", seq: 1, sessions: [s("a"), s("b")] }).state;
  const r = applySummary(st, { kind: "remove", seq: 2, ids: ["a"] });
  expect(r.relist).toBe(false);
  st = r.state;
  expect(Object.keys(st.sessions)).toEqual(["b"]);
  expect(applySummary(st, { kind: "upsert", seq: 2, sessions: [s("a")] }).state).toBe(st);
});

test("a skipped seq, or an update before any list, asks for the list again", () => {
  const st = applySummary(emptySummary(), { kind: "all", seq: 1, sessions: [] }).state;
  const gap = applySummary(st, { kind: "upsert", seq: 3, sessions: [s("c")] });
  expect(gap.relist).toBe(true);
  expect(gap.state.sessions.c).toBeDefined();
  expect(applySummary(emptySummary(), { kind: "upsert", seq: 4, sessions: [s("d")] }).relist).toBe(true);
});
