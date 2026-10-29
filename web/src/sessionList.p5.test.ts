import { expect, test } from "bun:test";
import type { SummaryState } from "../../shared/summary";
import type { SessionSummary } from "../../shared/transcript";
import { inbox } from "./sessionList";

const s = (id: string, x: Partial<SessionSummary>): SessionSummary => ({ id, harness: "claude", nativeId: id, projectPath: "/p", title: id, mode: "stored", status: "idle", updatedAt: 1, ...x });
const st = (list: SessionSummary[]): SummaryState => ({ epoch: "e", seq: 1, sessions: Object.fromEntries(list.map((x) => [x.id, x])) });

test("the inbox: needs you, then failed, finished, working; across runners; main sessions only", () => {
  const rows = inbox({
    a: st([
      s("idle", {}),
      s("done", { unread: "finished", updatedAt: 5 }),
      s("done-old", { unread: "finished", updatedAt: 2 }),
      s("busy", { status: "running", mode: "live", updatedAt: 9 }),
      s("asks", { requests: 1, status: "waiting", updatedAt: 7 }),
      s("kid", { requests: 1, parentSessionId: "asks" }),
    ]),
    b: st([s("broke", { unread: "failed", failure: "Rate limited", updatedAt: 3 }), s("term", { mode: "terminal", status: "waiting", updatedAt: 4 })]),
  });
  expect(rows.map((r) => [r.runnerId, r.id, r.inbox])).toEqual([
    ["b", "term", "needs"],
    ["a", "asks", "needs"],
    ["b", "broke", "failed"],
    ["a", "done", "finished"],
    ["a", "done-old", "finished"],
    ["a", "busy", "working"],
  ]);
});
