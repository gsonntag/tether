import { expect, test } from "bun:test";
import { historyMsgs } from "./items";
import { CodexStream } from "./stream";
import { comparable, fixture, frames, TestSink } from "./testSink";

const MAIN = "01a187c7-9ae6-7631-b0cc-596277bb8c13";
const CWD = "/home/ubuntu/scratch-p4/proj1";

/** Replays a recorded stream's notifications (the daemon's requests and answers are the driver's). */
async function replay(name: string, main: string, cwd = CWD) {
  const sink = new TestSink();
  const s = new CodexStream(sink, cwd, main);
  for (const m of await frames(name)) if (m.method && m.id === undefined) s.handle(m.method, m.params ?? {});
  return { sink, s };
}

test("a turn with an approval and a steer from another client: user messages, tools and replies, in order", async () => {
  const { sink } = await replay("approval-steer.jsonl", MAIN);
  const msgs = sink.t.messages;
  expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
  expect(msgs[0]).toMatchObject({ id: "u-01a187ca-b6f9-75e2-bb01-fd9e7659f1f0", parts: [{ type: "text", text: expect.stringContaining("sleep 3") }] });
  // The commentary, then the command it ran (started before the steer arrived).
  expect(msgs[1]!.parts).toMatchObject([
    { type: "text", text: "I’ll run that exact command from the workspace." },
    { type: "tool", kind: "shell", command: "sleep 3 && echo done > out.txt", status: "done" },
  ]);
  // The steer from the other connection shows as a user message.
  expect(msgs[2]).toMatchObject({ role: "user", parts: [{ text: "Also, end your reply with the word BANANA." }] });
  expect(msgs[3]!.parts).toEqual([{ type: "text", text: "The command completed successfully. BANANA" }]);
  expect(msgs.every((m) => !m.streaming)).toBe(true);
  // Running from the turn's start, waiting while the approval was open, idle at its end.
  expect(sink.states.filter((x) => x.status).map((x) => x.status)).toEqual(["running", "waiting", "running", "idle"]);
});

test("a subagent (Codex 0.165: subAgentActivity) becomes a child session with its own turns", async () => {
  const main = "01a187dc-5961-7620-9a6e-05468eac3072";
  const child = "01a187dc-6349-73e2-a799-b0c7f39831e1";
  const { sink, s } = await replay("subagent.jsonl", main);
  expect(sink.starts).toEqual([{ nativeId: child, parentToolId: "call_fa9237e0df3b4499937cdd0fd135f87e", title: "list_files" }]);
  expect(sink.cardFirst).toEqual([true]);
  const c = sink.children.get(child)!;
  // Its events arrived before its spawn was reported: none lost.
  expect(c.t.messages.flatMap((m) => m.parts.map((p) => (p.type === "tool" ? `tool:${p.command}` : p.type)))).toEqual(["tool:ls", "text"]);
  expect(c.endedCount).toBe(1);
  expect(s.runningChildren()).toEqual([]);
  // The parent's card for it is an Agent (task) card.
  const card = sink.t.messages.flatMap((m) => m.parts).find((p) => p.type === "tool" && p.id === "call_fa9237e0df3b4499937cdd0fd135f87e");
  expect(card).toMatchObject({ kind: "task", name: "Agent", input: { description: "list_files" } });
  expect(sink.status).toBe("idle");
  // Live and stored agree, message for message (parent and child).
  const stored = historyMsgs(await fixture("subagent-turns.json"), CWD, "gpt-6-luna").map((m) => ({ ...m, model: undefined }));
  expect(sink.t.messages.map(comparable)).toEqual(stored.map(comparable));
  const storedChild = historyMsgs(await fixture("subagent-child-turns.json"), CWD);
  expect(c.t.messages.map(comparable)).toEqual(storedChild.map(comparable));
});

test("a subagent (Codex 0.162: spawnAgent calls): child session, its report on the spawn card", async () => {
  const main = "01a124f7-0f12-7c43-b9d4-827c2dafd1e8";
  const child = "01a124f7-28d9-70d2-8a53-ae9e96f325ef";
  const { sink } = await replay("subagent-0.162.jsonl", main, "/tmp/act-repo");
  expect(sink.starts[0]).toMatchObject({ nativeId: child, title: expect.stringContaining("In /tmp/act-repo, run `ls`") });
  expect(sink.cardFirst).toEqual([true]);
  const c = sink.children.get(child)!;
  expect(c.t.messages[0]).toMatchObject({ role: "user" });
  expect(c.t.messages.flatMap((m) => m.parts).filter((p) => p.type === "tool").map((p: any) => p.command).sort()).toEqual(["ls", "wc -l math.ts"]);
  const spawn = sink.t.messages.flatMap((m) => m.parts).find((p) => p.type === "tool" && p.name === "Agent") as any;
  expect(spawn.kind).toBe("task");
  expect(spawn.output).toContain("1 math.ts");
  expect(c.endedCount).toBe(1);
});

test("resuming mid-turn: the turn so far is shown and the rest streams onto it", () => {
  const sink = new TestSink();
  const s = new CodexStream(sink, CWD, "T");
  s.seedTurn({
    id: "turn1",
    status: "inProgress",
    items: [
      { type: "userMessage", id: "u1", content: [{ type: "text", text: "hi" }] },
      { type: "agentMessage", id: "m1", text: "Looking" },
      { type: "commandExecution", id: "c1", command: "/bin/bash -lc 'ls'", status: "inProgress" },
    ],
  });
  expect(sink.status).toBe("running");
  s.handle("item/commandExecution/outputDelta", { threadId: "T", itemId: "c1", delta: "a.txt\n" });
  s.handle("item/completed", { threadId: "T", item: { type: "commandExecution", id: "c1", command: "/bin/bash -lc 'ls'", status: "completed", exitCode: 0, aggregatedOutput: "a.txt\n" } });
  s.handle("turn/completed", { threadId: "T", turn: { id: "turn1", status: "completed" } });
  expect(sink.t.messages.map((m) => m.id)).toEqual(["u-u1", "a-m1"]);
  expect(sink.t.messages[1]!.parts).toMatchObject([{ type: "text", text: "Looking" }, { type: "tool", command: "ls", status: "done", output: "a.txt\n" }]);
  expect(sink.status).toBe("idle");
});

test("a failed turn says why on its last message; a stopped one leaves no call running", () => {
  const sink = new TestSink();
  const s = new CodexStream(sink, CWD, "T");
  s.handle("turn/started", { threadId: "T", turn: { id: "t1" } });
  s.handle("item/started", { threadId: "T", item: { type: "commandExecution", id: "c1", command: "sleep 100", status: "inProgress" } });
  s.handle("turn/completed", { threadId: "T", turn: { id: "t1", status: "interrupted" } });
  expect(sink.t.messages[0]!.parts[0]).toMatchObject({ status: "error" });
  s.handle("turn/started", { threadId: "T", turn: { id: "t2" } });
  s.handle("turn/completed", { threadId: "T", turn: { id: "t2", status: "failed", error: { message: "Rate limited" } } });
  expect(sink.t.messages.at(-1)).toMatchObject({ role: "assistant", error: "Rate limited" });
});

test("reasoning streams as thinking (summary first); text streams by delta", () => {
  const sink = new TestSink();
  const s = new CodexStream(sink, CWD, "T");
  s.handle("turn/started", { threadId: "T", turn: { id: "t1" } });
  s.handle("item/started", { threadId: "T", item: { type: "reasoning", id: "r1", summary: [], content: [] } });
  s.handle("item/reasoning/summaryTextDelta", { threadId: "T", itemId: "r1", delta: "Plan" });
  s.handle("item/reasoning/textDelta", { threadId: "T", itemId: "r1", delta: "raw" });
  s.handle("item/reasoning/summaryPartAdded", { threadId: "T", itemId: "r1", summaryIndex: 1 });
  s.handle("item/reasoning/summaryTextDelta", { threadId: "T", itemId: "r1", delta: "ning" });
  s.handle("item/started", { threadId: "T", item: { type: "agentMessage", id: "m1", text: "" } });
  s.handle("item/agentMessage/delta", { threadId: "T", itemId: "m1", delta: "Hel" });
  s.handle("item/agentMessage/delta", { threadId: "T", itemId: "m1", delta: "lo" });
  expect(sink.t.messages[0]!.parts).toEqual([
    { type: "thinking", text: "Plan\n\nning" },
    { type: "text", text: "Hello" },
  ]);
  expect(sink.t.messages[0]!.streaming).toBe(true);
});

test("settings changed on the thread (in Codex's TUI too) reach the driver", () => {
  const sink = new TestSink();
  const s = new CodexStream(sink, CWD, "T");
  const seen: any[] = [];
  s.onSettings = (x) => seen.push(x);
  s.handle("thread/settings/updated", { threadId: "T", threadSettings: { model: "gpt-6-luna", effort: "low" } });
  s.handle("thread/settings/updated", { threadId: "other", threadSettings: { model: "x" } });
  expect(seen).toEqual([{ model: "gpt-6-luna", effort: "low" }]);
});
