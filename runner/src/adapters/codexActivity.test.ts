import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { ActivityItem } from "../../../web/src/shared/protocol";
import { upsertActivity } from "../../../web/src/shared/reducer";
import { CodexActivity } from "./codexActivity";

/** app-server notifications captured from a real Codex turn that spawned a subagent (deltas dropped). */
async function fixture(name: string): Promise<{ method: string; params: any }[]> {
  const text = await Bun.file(join(import.meta.dir, "fixtures", `${name}.jsonl`)).text();
  return text.split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((m) => m.method);
}

function replay(msgs: { method: string; params: any }[], stopAt?: (m: { method: string; params: any }) => boolean) {
  let t = 0;
  const act = new CodexActivity(() => t);
  const main = msgs.find((m) => m.method === "thread/started")!.params.thread.id;
  let list: ActivityItem[] = [];
  for (const m of msgs) {
    t += 100;
    list = upsertActivity(list, act.onNotify(m.method, m.params, main));
    if (stopAt?.(m)) break;
  }
  return { act, list };
}

describe("Codex activity", () => {
  test("a spawned subagent thread: steps, tokens and its report", async () => {
    const msgs = await fixture("codex-sub");
    const mid = replay(msgs, (m) => m.method === "thread/tokenUsage/updated" && m.params.threadId.endsWith("f325ef"));
    expect(mid.list.length).toBe(1);
    const sub = mid.list[0]!;
    expect(sub).toMatchObject({ kind: "subagent", status: "running", model: "gpt-5.6-luna", stoppable: true, tokens: 14628 });
    expect(sub.title).toBe("In /tmp/act-repo, run `ls` and `wc -l math.ts`, then report the outputs succinctly. Do not m…".slice(0, 80));
    expect(sub.steps?.map((s) => [s.label, s.status])).toEqual([
      ["Running wc -l math.ts", "done"],
      ["Running ls", "done"],
    ]);
    expect(sub.toolUses).toBe(2);
    expect(mid.act.turns.get(sub.id)).toBe("01a124f7-28fe-7093-a245-d2d371798958");

    const end = replay(msgs).list[0]!;
    expect(end.status).toBe("done");
    expect(end.summary).toContain("1 math.ts");
    expect(end.tokens).toBe(29408);
  });

  test("main-thread commands that finished aren't activity; one still running is a background terminal", () => {
    let t = 1_000;
    const act = new CodexActivity(() => t);
    const cmd = (item: any, completed = true) => act.onNotify(completed ? "item/completed" : "item/started", { threadId: "main", item: { type: "commandExecution", ...item } }, "main");
    expect(cmd({ id: "e1", command: "ls", processId: "1", source: "unifiedExecStartup", status: "completed", exitCode: 0 })).toEqual([]);
    const [bg] = cmd({ id: "e2", command: "bun run dev", processId: "42", source: "unifiedExecStartup", status: "completed", exitCode: null, aggregatedOutput: "listening on 5173\n" });
    expect(bg).toMatchObject({ id: "proc:42", kind: "shell", status: "running", command: "bun run dev", output: "listening on 5173" });
    t = 5_000;
    const [polled] = cmd({ id: "e3", command: "", processId: "42", source: "unifiedExecInteraction", status: "completed", exitCode: 1, aggregatedOutput: "crashed\n" });
    expect(polled).toMatchObject({ id: "proc:42", status: "failed", output: "crashed", endedAt: 5_000 });
  });

  test("a sleep is a wait with a wake time", () => {
    const act = new CodexActivity(() => 10);
    const [s] = act.onNotify("item/started", { threadId: "m", item: { type: "sleep", id: "s1", durationMs: 60_000 } }, "m");
    expect(s).toMatchObject({ kind: "schedule", status: "waiting", nextAt: 60_010 });
    expect(act.onNotify("item/completed", { threadId: "m", item: { type: "sleep", id: "s1" } }, "m")[0]!.status).toBe("done");
  });
});
