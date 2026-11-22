import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LiveState, Msg } from "../../../../shared/transcript";
import type { Sink, SubagentStart, TranscriptEvent } from "../../core/adapter";
import { Transcript } from "../../core/transcript";
import { ClaudeStream } from "./stream";

const fixture = (name: string) =>
  readFileSync(join(import.meta.dir, "fixtures", name), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

/** A sink that keeps a transcript and state the way the core does, and records subagents. */
class TestSink implements Sink {
  t = new Transcript();
  st: Partial<LiveState> = {};
  events: TranscriptEvent[] = [];
  statuses: string[] = [];
  rateLimits: { retryAt?: number }[] = [];
  limits: { resetsAt?: number }[] = [];
  timeline: string[] = [];
  children = new Map<string, { start: SubagentStart; sink: TestSink; opened: number }>();
  ended_ = false;
  event(e: TranscriptEvent) {
    this.events.push(e);
    this.t.apply(e);
  }
  message(id: string) {
    return this.t.get(id);
  }
  state(p: Partial<LiveState>) {
    if (p.status && p.status !== this.st.status) this.statuses.push(p.status);
    if (p.status) this.timeline.push(`status:${p.status}`);
    this.st = { ...this.st, ...p };
  }
  async request() {
    return { allow: true as const };
  }
  subagent(s: SubagentStart) {
    const had = this.children.get(s.nativeId);
    const sink = new TestSink();
    this.children.set(s.nativeId, { start: s, sink, opened: (had?.opened ?? 0) + 1 });
    return sink;
  }
  ended() {
    this.ended_ = true;
  }
  rateLimited(hit: { retryAt?: number }) {
    this.timeline.push("rateLimited");
    this.rateLimits.push(hit);
  }
  limitReached(hit: { resetsAt?: number }) {
    this.timeline.push("limitReached");
    this.limits.push(hit);
  }
  mainFree?: () => void;
  mainChanged?: () => void;
}

function replay(name: string, nativeId = "S") {
  const sink = new TestSink();
  const s = new ClaudeStream(sink, { nativeId });
  for (const m of fixture(name)) s.handle(m);
  return { sink, stream: s };
}

const texts = (m: Msg) => m.parts.map((p) => (p.type === "tool" ? `tool:${p.name}:${p.status}` : `${p.type}:${(p as any).text}`));

test("a reply streams into one message per API message, with final blocks merged", () => {
  const { sink } = replay("reply.jsonl");
  const msgs = sink.t.messages;
  expect(msgs.map((m) => m.id.slice(0, 4))).toEqual(["msg_", "msg_"]);
  const [first, second] = msgs;
  expect(first!.parts.map((p) => p.type)).toEqual(["thinking", "text", "tool"]);
  const read = first!.parts[2] as any;
  expect(read).toMatchObject({ name: "Read", kind: "read", status: "done" });
  expect(read.path).toContain("math.ts");
  expect(read.output).toContain("export const add");
  expect(texts(second!).at(-1)).toMatch(/^text:.*add/s);
  expect(msgs.every((m) => !m.streaming)).toBe(true);
  expect(first!.model).toBe("claude-haiku-5-5");
  // Streaming happened: deltas came before the final blocks.
  expect(sink.events.filter((e) => e.type === "delta").length).toBeGreaterThan(10);
  expect(sink.st).toMatchObject({ modelResolved: "claude-haiku-5-5", permissionMode: "bypassPermissions", status: "idle" });
});

test("an interrupted turn ends with an Interrupted notice and no error", () => {
  const { sink } = replay("interrupt.jsonl");
  const msgs = sink.t.messages;
  expect(msgs.at(-1)).toMatchObject({ role: "notice", level: "info", parts: [{ type: "text", text: "Interrupted" }] });
  expect(msgs.some((m) => m.level === "error")).toBe(false);
  expect((msgs[0]!.parts.find((p) => p.type === "text") as any).text.length).toBeGreaterThan(20);
  expect(sink.statuses).toEqual(["running", "idle"]);
});

test("a subagent becomes a child with its own exact turns; the main turn stays running until it ends", () => {
  const { sink, stream } = replay("subagent.jsonl", "S");
  expect(sink.children.size).toBe(1);
  const [[nativeId, child]] = [...sink.children];
  expect(nativeId).toMatch(/^S\/[0-9a-f]+$/);
  expect(child!.start).toMatchObject({ title: "Count lines in two files", agentType: "general-purpose" });
  expect(child!.start.prompt).toContain("wc -l");
  // The parent's Agent card is the call that started it.
  const agentCall = sink.t.messages.flatMap((m) => m.parts).find((p) => p.type === "tool" && p.name === "Agent") as any;
  expect(agentCall.id).toBe(child!.start.parentToolId);
  expect(agentCall.kind).toBe("task");
  // The child's transcript: its Bash call with the result, then its report.
  const cm = child!.sink.t.messages;
  const bash = cm.flatMap((m) => m.parts).find((p) => p.type === "tool") as any;
  expect(bash).toMatchObject({ name: "Bash", kind: "shell", status: "done", command: "wc -l README.md math.ts" });
  expect(bash.output).toContain("4 total");
  expect(texts(cm.at(-1)!).join(" ")).toMatch(/README|math/);
  expect(child!.sink.ended_).toBe(true);
  // Main thread: never idle between the first result and the subagent's end.
  expect(sink.statuses).toEqual(["running", "idle"]);
  expect(stream.running.size).toBe(0);
  // No subagent message leaked into the main transcript.
  expect(sink.t.messages.some((m) => cm.some((c) => c.id === m.id))).toBe(false);
});

test("a foreground subagent moved to the background: the call returns, the main agent goes on, the subagent's end still arrives", () => {
  // Real Claude 2.1.314 (Haiku): Agent with run_in_background false, Query.backgroundTasks(its tool
  // id) while it sleeps in Bash, then a message (scripts/record-claude.ts --background-after-ms).
  const sink = new TestSink();
  let free = 0;
  sink.mainFree = () => free++;
  const changes: boolean[] = [];
  sink.mainChanged = () => changes.push(stream.onlyBackground());
  const stream = new ClaudeStream(sink, { nativeId: "S" });
  const frames = fixture("background.jsonl");
  const started = frames.findIndex((m) => m.subtype === "task_started" && m.task_type === "local_agent");
  const moved = frames.findIndex((m) => m.subtype === "task_updated" && m.patch?.is_backgrounded);
  const results = frames.flatMap((m, i) => (m.type === "result" ? [i] : []));
  const agentCall = () => sink.t.messages.flatMap((m) => m.parts).find((p) => p.type === "tool" && p.name === "Agent") as any;
  expect(frames[started].is_backgrounded).toBe(false);

  frames.slice(0, moved).forEach((m) => stream.handle(m));
  expect(agentCall().status).toBe("running");
  expect(stream.background.size).toBe(1);
  expect(stream.onlyBackground()).toBe(false);

  // The first result: the main agent is free, though the session stays running.
  frames.slice(moved, results[0]! + 1).forEach((m) => stream.handle(m));
  expect(agentCall().status).toBe("done");
  expect(stream.onlyBackground()).toBe(true);
  expect(free).toBe(1);
  expect(sink.statuses).toEqual(["running"]);
  const [[, child]] = [...sink.children];
  expect(child!.sink.ended_).toBe(false);

  // The rest: the message's reply, then the subagent's end and the main agent's summary.
  frames.slice(results[0]! + 1).forEach((m) => stream.handle(m));
  expect(child!.sink.ended_).toBe(true);
  expect(texts(child!.sink.t.messages.at(-1)!).join(" ")).toContain("4321");
  expect(sink.t.messages.flatMap(texts).join(" ")).toContain("PONG-MANGO");
  expect(texts(sink.t.messages.at(-1)!).join(" ")).toContain("4321");
  expect(sink.statuses).toEqual(["running", "idle"]);
  expect(stream.onlyBackground()).toBe(false);
  expect(stream.running.size).toBe(0);
  expect(free).toBe(2);
  // Free after the first result, busy again with the message, free, busy for the summary it writes.
  expect(changes.slice(0, 2)).toEqual([true, false]);
  expect(changes.at(-1)).toBe(false);
});

test("a stopped subagent stays stopped: its last frames land in it, its calls keep their results", () => {
  // Real Claude (Haiku): a foreground subagent starts `sleep 90` in the background (its result comes
  // at once), then waits with Monitor; stopTask stops it. Its interrupt frames come after its end.
  const { sink, stream } = replay("stop.jsonl", "S");
  expect(sink.children.size).toBe(1);
  const [[, child]] = [...sink.children];
  expect(child!.opened).toBe(1);
  expect(child!.sink.ended_).toBe(true);
  const tools = child!.sink.t.messages.flatMap((m) => m.parts).filter((p) => p.type === "tool").map((p: any) => `${p.name}:${p.status}`);
  // The background Bash got its result before the stop, though a background shell was listed meanwhile.
  expect(tools).toEqual(["Bash:done", "ToolSearch:done", "Monitor:error"]);
  expect(child!.sink.t.messages.filter((m) => m.role === "notice").map((m) => (m.parts[0] as any).text)).toEqual(["Stopped", "Interrupted"]);
  expect(stream.running.size).toBe(0);
  // The turn over, nothing is kept about it.
  expect((stream as any).endedAgents.size).toBe(0);
  expect((stream as any).agentByTool.size).toBe(0);
});

test("a compaction mid-session keeps the conversation and marks the spot", () => {
  const sink = new TestSink();
  const s = new ClaudeStream(sink, { nativeId: "S" });
  for (const m of fixture("reply.jsonl")) s.handle(m);
  const before = sink.t.messages.map((m) => m.id);
  s.handle({ type: "system", subtype: "compact_boundary", uuid: "b-1", compact_metadata: { trigger: "auto" } });
  expect(sink.t.messages.map((m) => m.id)).toEqual([...before, "b-1"]);
  expect(sink.events.some((e) => e.type === "reset")).toBe(false);
  expect(sink.t.messages.at(-1)).toMatchObject({ role: "notice", parts: [{ text: "Context compacted." }] });
});

test("a turn another session puts in is marked with its origin, as in the store", () => {
  const sink = new TestSink();
  const s = new ClaudeStream(sink, { nativeId: "S" });
  s.handle({ type: "user", uuid: "p1", parent_tool_use_id: null, origin: { kind: "peer", from: "a1", name: "general-purpose", body: "[Subagent hand-back] preamble. The report follows:\n  All done." }, message: { role: "user", content: "Another Claude session sent a message:\n<agent-message from=\"a1\">x</agent-message>" } });
  expect(sink.t.get("p1")).toMatchObject({ role: "user", origin: { kind: "peer", name: "general-purpose" }, parts: [{ type: "text", text: "All done." }] });
  // Your own prompt echoed with origin human is not repeated (the driver added it).
  s.handle({ type: "user", uuid: "h1", parent_tool_use_id: null, origin: { kind: "human" }, message: { role: "user", content: "hi" } });
  expect(sink.t.get("h1")).toBeUndefined();
});

test("Claude Code's own replies read as the store has them: a notice, or a message with its error", () => {
  const sink = new TestSink();
  const s = new ClaudeStream(sink, { nativeId: "S" });
  s.handle({ type: "assistant", uuid: "s1", parent_tool_use_id: null, message: { id: "x1", model: "<synthetic>", content: [{ type: "text", text: "No response requested." }] } });
  s.handle({ type: "assistant", uuid: "s2", parent_tool_use_id: null, error: "rate_limit", message: { id: "x2", model: "<synthetic>", content: [{ type: "text", text: "You've hit your limit" }] } });
  expect(sink.t.get("s1")).toMatchObject({ role: "notice", parts: [{ text: "No response requested." }] });
  expect(sink.t.get("x2")).toMatchObject({ role: "assistant", error: "You've hit your limit" });
});

test("not signed in: what to do goes in the chat as one error, not only in the state", () => {
  const sink = new TestSink();
  const s = new ClaudeStream(sink, { nativeId: "S" });
  s.handle({ type: "result", subtype: "success", is_error: true, uuid: "r1", result: "Not logged in · Please run /login" });
  const hint = "Claude Code isn't signed in on the runner. Sign in and send again.";
  expect(sink.t.messages.map((m) => [m.role, m.level, m.parts])).toEqual([["notice", "error", [{ type: "text", text: hint }]]]);
  expect(sink.st.error).toBe(hint);
});

test("a terminal short API throttle signals before idle, while plan limits and interruptions keep their meaning", () => {
  const sink = new TestSink();
  const s = new ClaudeStream(sink, { nativeId: "S" });
  const apiError = (text = "Temporary throttle") => s.handle({
    type: "assistant", uuid: "api-error", parent_tool_use_id: null, error: "rate_limit",
    message: { id: "api-error", model: "claude-sonnet", content: [{ type: "text", text }] },
  });
  const result = (extra: Record<string, unknown> = {}) => s.handle({ type: "result", subtype: "error_api", is_error: true, api_error_status: 429, uuid: "end", ...extra });

  s.mainStarts();
  apiError();
  result();
  expect(sink.rateLimits).toEqual([{}]);
  expect(sink.timeline.slice(-2)).toEqual(["rateLimited", "status:idle"]);
  expect(sink.limits).toEqual([]);

  s.mainStarts();
  s.handle({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 123 } });
  apiError();
  result();
  expect(sink.limits).toEqual([{ resetsAt: 123000 }]);
  expect(sink.rateLimits).toHaveLength(1);

  s.mainStarts();
  apiError();
  result({ subtype: "error_during_execution" });
  expect(sink.rateLimits).toHaveLength(1);
});

// ---------------- watchers (shared/watchers.ts) ----------------

/** A main-thread assistant frame with one tool call. */
const toolCall = (id: string, name: string, input: unknown) => ({ type: "assistant", uuid: `u-${id}`, message: { id: `msg-${id}`, model: "claude-opus-5-5", content: [{ type: "tool_use", id, name, input }] } });
const listed = (tasks: unknown[]) => ({ type: "system", subtype: "background_tasks_changed", tasks });

test("background shells and monitors show as watching until the level drops them", () => {
  const sink = new TestSink();
  const s = new ClaudeStream(sink, { nativeId: "S" });
  s.handle(toolCall("t-mon", "Monitor", { description: "progress.log events", command: "tail -F x" }));
  s.handle(listed([{ task_id: "m1", task_type: "local_bash", description: "progress.log events" }]));
  s.handle({ type: "system", subtype: "task_started", task_id: "m1", tool_use_id: "t-mon", task_type: "local_bash", description: "progress.log events" });
  s.handle(listed([
    { task_id: "m1", task_type: "local_bash", description: "progress.log events" },
    { task_id: "b1", task_type: "local_bash", description: "until results land" },
    { task_id: "a1", task_type: "local_agent", description: "Step 1", subagent_type: "general-purpose" },
    { task_id: "x1", task_type: "local_bash", description: "housekeeping", ambient: true },
  ]));
  expect(sink.st.watching).toEqual([
    { kind: "monitor", label: "progress.log events" },
    { kind: "shell", label: "until results land" },
  ]);
  s.handle(listed([{ task_id: "b1", task_type: "local_bash", description: "until results land" }]));
  expect(sink.st.watching).toEqual([{ kind: "shell", label: "until results land" }]);
  s.handle(listed([]));
  expect(sink.st.watching).toBeUndefined();
});

test("a subagent's watchers outlive its 'completed' notification and name it", () => {
  const sink = new TestSink();
  const s = new ClaudeStream(sink, { nativeId: "S" });
  s.handle({ type: "system", subtype: "task_started", task_id: "a2", task_type: "local_agent", subagent_type: "general-purpose", description: "Step 2: policy space", tool_use_id: "t-a2" });
  s.handle(listed([
    { task_id: "a2", task_type: "local_agent", description: "Step 2: policy space" },
    { task_id: "w1", task_type: "local_bash", description: "wait for smoke", parent_task_id: "a2" },
  ]));
  // Claude Code reports the subagent done while its own background work still runs.
  s.handle({ type: "system", subtype: "task_notification", task_id: "a2", status: "completed" });
  s.handle(listed([{ task_id: "w1", task_type: "local_bash", description: "wait for smoke", parent_task_id: "a2" }]));
  expect(sink.st.watching).toEqual([{ kind: "shell", label: "wait for smoke", by: "Step 2: policy space" }]);
});

test("a Stop hook's session crons are scheduled wakeups, with their next fire time", () => {
  const sink = new TestSink();
  const s = new ClaudeStream(sink, { nativeId: "S" });
  expect(s.hasWakeups()).toBe(false);
  const now = new Date(2026, 10, 20, 23, 10, 30).getTime();
  s.setCrons([{ id: "c1", schedule: "40 23 20 11 *", recurring: false, prompt: "<<autonomous-loop-dynamic>>" }], now);
  expect(sink.st.watching).toEqual([{ kind: "wakeup", label: "Autonomous loop", at: new Date(2026, 10, 20, 23, 40).getTime() }]);
  expect(s.hasWakeups()).toBe(true);
  // A missing list (an older CLI) changes nothing; an empty one clears.
  s.setCrons(undefined, now);
  expect(s.hasWakeups()).toBe(true);
  s.setCrons([], now);
  expect(sink.st.watching).toBeUndefined();
  expect(s.hasWakeups()).toBe(false);
});
