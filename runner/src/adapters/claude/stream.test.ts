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
  children = new Map<string, { start: SubagentStart; sink: TestSink }>();
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
    this.st = { ...this.st, ...p };
  }
  async request() {
    return { allow: true as const };
  }
  subagent(s: SubagentStart) {
    const sink = new TestSink();
    this.children.set(s.nativeId, { start: s, sink });
    return sink;
  }
  ended() {
    this.ended_ = true;
  }
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
