// The Home chat's "Waiting for N sessions to finish…": which sessions count, and the line.

import { afterEach, expect, test } from "bun:test";
import type { SessionSummary } from "../../shared/transcript";
import { awaitedSessions, setHomeFolders, waitingLine } from "./sessionList";

const s = (id: string, extra: Partial<SessionSummary> = {}): SessionSummary => ({ id, harness: "claude", nativeId: id, projectPath: "/p/web", title: `T ${id}`, mode: "live", status: "running", updatedAt: 1, ...extra });
const of = (sessions: SessionSummary[], other: SessionSummary[] = []) => ({
  r1: { epoch: "e", seq: 1, sessions: Object.fromEntries(sessions.map((x) => [x.id, x])) },
  r2: { epoch: "f", seq: 1, sessions: Object.fromEntries(other.map((x) => [x.id, x])) },
});
const ids = (r: { rows: { id: string }[] }) => r.rows.map((x) => x.id);

afterEach(() => setHomeFolders([]));

test("watching all: every running session counts, and its own chats, subagents, archived and idle ones don't", () => {
  setHomeFolders([{ id: "r1", homeFolder: "/home/agent" }]);
  const all = of(
    [
      s("run", { updatedAt: 2 }),
      s("bg", { status: "idle", backgroundSubagents: 1, updatedAt: 3 }),
      s("idle", { status: "idle" }),
      s("chat", { projectPath: "/home/agent" }),
      s("sub", { parentSessionId: "run" }),
      s("old", { archived: true }),
    ],
    [s("elsewhere")],
  );
  const r = awaitedSessions(all, "r1", { watchAll: true });
  expect(ids(r)).toEqual(["run", "bg"]);
  expect(r.needs).toBe(0);
});

test("watching only its own: the sessions its chats follow", () => {
  const all = of([s("mine"), s("theirs"), s("mine-idle", { status: "idle" })]);
  expect(ids(awaitedSessions(all, "r1", { watchAll: false, following: ["mine", "mine-idle"] }))).toEqual(["mine"]);
  // A runner that didn't say which: none.
  expect(ids(awaitedSessions(all, "r1", { watchAll: false }))).toEqual([]);
});

test("sessions waiting for the person count, first, and are counted as needing you", () => {
  const all = of([s("run", { updatedAt: 1 }), s("ask", { status: "idle", requests: 1, updatedAt: 5 }), s("tui", { status: "waiting", updatedAt: 9 })]);
  const r = awaitedSessions(all, "r1", { watchAll: true });
  expect(ids(r)).toEqual(["ask", "tui", "run"]);
  expect(r.needs).toBe(2);
});

test("nothing running: nothing to wait for", () => {
  expect(awaitedSessions(of([s("a", { status: "idle" })]), "r1", { watchAll: true }).rows).toEqual([]);
});

test("the line", () => {
  expect(waitingLine(1)).toBe("Waiting for 1 session to finish…");
  expect(waitingLine(3)).toBe("Waiting for 3 sessions to finish…");
});
