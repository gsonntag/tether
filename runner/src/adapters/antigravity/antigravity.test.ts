import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolPart } from "../../../../shared/transcript";
import { fallbackStepProblem } from "../../../../shared/fallbackChain";
import { AcpTranscript, acpTool } from "../acp/transcript";
import { modelList } from "./models";
import { agyScreen } from "./screen";

const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures", name), "utf8");
const lines = (name: string) => fixture(name).trim().split("\n").map((l) => JSON.parse(l));
const hooks = () => ({ stamp: () => 1000 });

test("a replay becomes one message per prompt and one per turn, its calls classified", () => {
  const t = new AcpTranscript("m", hooks());
  for (const l of lines("replay.jsonl")) t.update(l.update);
  const msgs = t.settled();
  expect(msgs.map((m) => `${m.id}:${m.role}`)).toEqual(["m0:user", "m1:assistant", "m2:user", "m3:assistant"]);
  const tools = msgs[1]!.parts.filter((p): p is ToolPart => p.type === "tool");
  expect(tools.map((p) => [p.name, p.kind, p.status, p.path])).toEqual([
    ["read_file", "read", "done", "/tmp/agy-fixture/notes.txt"],
    ["edit_file", "edit", "done", "/tmp/agy-fixture/notes.txt"],
    ["write_file", "write", "done", "/tmp/agy-fixture/todo.md"],
  ]);
  expect((tools[1]!.input as any).edits).toEqual([{ old_string: "line one\nline two\n", new_string: "line one\nline 2\n", path: "/tmp/agy-fixture/notes.txt" }]);
  expect((tools[2]!.input as any).content).toBe("- a\n");
  expect(msgs[1]!.parts.at(-1)).toEqual({ type: "text", text: "ok" });
  const shell = msgs[3]!.parts[0] as ToolPart;
  expect([shell.kind, shell.command, shell.status]).toEqual(["shell", "sleep 20; echo slept", "error"]);
});

test("a live session numbers its messages as a replay does, so the stored transcript takes over cleanly", () => {
  const replay = new AcpTranscript("m", hooks());
  for (const l of lines("replay.jsonl")) replay.update(l.update);
  const stored = replay.settled();

  const live = new AcpTranscript("m", hooks());
  const prompts = stored.filter((m) => m.role === "user");
  let turn = 0;
  live.prompt(prompts[turn++]!.parts);
  for (const l of lines("live.jsonl")) {
    if (l.update) live.update(l.update);
    if (l.result) {
      live.end(undefined, l.result.stopReason === "cancelled");
      if (turn < prompts.length) live.prompt(prompts[turn++]!.parts);
    }
  }
  const msgs = live.settled();
  expect(msgs.map((m) => m.id)).toEqual(stored.map((m) => m.id));
  const shape = (ms: typeof msgs) => ms.map((m) => [m.role, m.parts.map((p) => (p.type === "tool" ? `${p.kind}:${p.status}` : p.type))]);
  expect(shape(msgs)).toEqual(shape(stored));
});

test("live events: text streams as deltas, calls as patches, and each new message is announced", () => {
  const t = new AcpTranscript("m", hooks());
  t.prompt([{ type: "text", text: "hi" }]);
  t.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hel" } });
  t.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "lo" } });
  t.update({ sessionUpdate: "tool_call", toolCallId: "c1", name: "run_command", kind: "execute", status: "in_progress", rawInput: { CommandLine: "ls" } });
  t.update({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed", rawOutput: { output: "a.txt" } });
  t.end();
  const ev = t.drain();
  expect(ev.map((e) => e.type)).toEqual(["msg", "msg", "msg", "delta", "msg", "tool", "msg"]);
  const patch = ev.find((e) => e.type === "tool") as any;
  expect([patch.patch.status, patch.patch.output, patch.patch.command]).toEqual(["done", "a.txt", "ls"]);
  const last = (ev.at(-1) as any).msg;
  expect([last.streaming, last.parts[0].text]).toEqual([false, "Hello"]);
});

test("a prompt from another session is announced with its origin (peers reads it from the event)", () => {
  const t = new AcpTranscript("m", hooks());
  t.prompt([{ type: "text", text: "Fix the bug" }], { kind: "session", name: "Boss", sessionId: "claude:boss" });
  const first = (t.drain().find((e) => e.type === "msg") as any).msg;
  expect(first.origin).toEqual({ kind: "session", name: "Boss", sessionId: "claude:boss" });
});

test("a stopped turn settles its running calls as errors, and a failed one carries its error", () => {
  const t = new AcpTranscript("m", hooks());
  t.prompt([{ type: "text", text: "go" }]);
  t.update({ sessionUpdate: "tool_call", toolCallId: "c1", name: "run_command", kind: "execute", status: "in_progress", rawInput: { CommandLine: "sleep 9" } });
  t.end(undefined, true);
  expect((t.msgs[1]!.parts[0] as ToolPart).status).toBe("error");
  t.prompt([{ type: "text", text: "again" }]);
  t.end("Antigravity: quota exceeded");
  expect([t.msgs[3]!.role, t.msgs[3]!.error]).toEqual(["assistant", "Antigravity: quota exceeded"]);
});

test("context, title and settings come through the hooks", () => {
  const seen: any = {};
  const t = new AcpTranscript("m", { stamp: () => 0, context: (c) => (seen.context = c), title: (x) => (seen.title = x), mode: (x) => (seen.mode = x) });
  t.update({ sessionUpdate: "usage_update", used: 10497, size: 1048576 });
  t.update({ sessionUpdate: "usage_update", used: 0, size: 1048576 });
  t.update({ sessionUpdate: "session_info_update", title: "Edit Notes" });
  t.update({ sessionUpdate: "current_mode_update", currentModeId: "plan" });
  expect(seen).toEqual({ context: { used: 10497, total: 1048576 }, title: "Edit Notes", mode: "plan" });
});

test("a call's kind comes from ACP's own, a file made whole is a write, subagents are tasks", () => {
  expect(acpTool({ sessionUpdate: "tool_call", toolCallId: "a", name: "grep_search", kind: "search", rawInput: { Query: "x" } }).kind).toBe("search");
  expect(acpTool({ sessionUpdate: "tool_call", toolCallId: "b", name: "write_file", kind: "edit", rawInput: { Content: "x", Path: "/p/f" } }).kind).toBe("write");
  const sub = acpTool({ sessionUpdate: "tool_call", toolCallId: "c", name: "invoke_subagent", kind: "other", rawInput: { TypeName: "self", Prompt: "run the shell command 'sleep 40'\nsecond line" } });
  expect(sub.kind).toBe("task");
  expect((sub.input as any).description).toBe("self · run the shell command 'sleep 40'");
  expect((sub.input as any).prompt).toBe("run the shell command 'sleep 40'\nsecond line");
  expect((sub.input as any).subagent_type).toBe("self");

  const withRole = acpTool({ sessionUpdate: "tool_call", toolCallId: "c2", name: "invoke_subagent", kind: "other", rawInput: { Role: "Codebase Researcher", TypeName: "research", Prompt: "Search files" } });
  expect(withRole.kind).toBe("task");
  expect((withRole.input as any).description).toBe("Codebase Researcher · Search files");
  expect((withRole.input as any).subagent_type).toBe("research");
});

test("models and thinking levels are separate settings; modes keep Antigravity's ids", () => {
  const config = [
    { id: "model", options: [{ value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" }, { value: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 (Thinking)" }] },
    { id: "thought_level", options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }] },
    { id: "mode", options: [{ value: "default", name: "Default", description: "Ask before edits and commands." }, { value: "accept-edits", name: "Accept edits" }, { value: "plan", name: "Plan" }] },
  ];
  const l = modelList(config);
  expect(l.models).toEqual([
    { id: "default", label: "Default", efforts: ["low", "high"] },
    { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", efforts: ["low", "high"] },
    { id: "claude-opus-4-6-thinking", label: "Claude Opus 4.6 (Thinking)", efforts: ["low", "high"] },
  ]);
  expect(l.permissionModes.map((m) => [m.id, m.label])).toEqual([["default", "Ask first"], ["accept-edits", "Accept edits"], ["plan", "Plan"], ["bypassPermissions", "Bypass permissions"]]);
});

test("per-model efforts come from availableModels when present, with none for fixed models", () => {
  const config = [
    {
      id: "model",
      options: [
        { value: "gemini-4-neon", name: "Gemini 4 Neon" },
        { value: "claude-opus-5-5", name: "Claude Opus 5.5" },
        { value: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
      ],
    },
    // Even if the currently active model has no thought_level options, availableModels still carries them.
    { id: "mode", options: [{ value: "default", name: "Default" }] },
  ];
  const available = [
    { modelId: "gemini-4-neon-high", name: "Gemini 4 Neon (High)" },
    { modelId: "gemini-4-neon-xhigh", name: "Gemini 4 Neon (XHigh)" },
    { modelId: "gemini-4-neon-low", name: "Gemini 4 Neon (Low)" },
    { modelId: "claude-opus-5-5-low", name: "Claude Opus 5.5 (Low)" },
    { modelId: "claude-opus-5-5-high", name: "Claude Opus 5.5 (High)" },
    { modelId: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
  ];
  const l = modelList(config, available);
  expect(l.efforts).toEqual([
    { id: "low", label: "Low" },
    { id: "high", label: "High" },
    { id: "xhigh", label: "Extra" },
  ]);
  expect(l.models).toEqual([
    { id: "default", label: "Default", efforts: ["low", "high", "xhigh"] },
    { id: "gemini-4-neon", label: "Gemini 4 Neon", efforts: ["low", "high", "xhigh"] },
    { id: "claude-opus-5-5", label: "Claude Opus 5.5", efforts: ["low", "high"] },
    { id: "gpt-oss-120b-medium", label: "GPT-OSS 120B (Medium)", efforts: [] },
  ]);
});

test("variants that match no model fall back to the shared thinking levels", () => {
  const config = [
    { id: "model", options: [{ value: "m1", name: "M1" }] },
    { id: "thought_level", options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }] },
  ];
  const l = modelList(config, [{ modelId: "renamed-variant", name: "Renamed" }]);
  expect(l.models).toEqual([
    { id: "default", label: "Default", efforts: ["low", "high"] },
    { id: "m1", label: "M1", efforts: ["low", "high"] },
  ]);
});

test("a fallback step with an effort on a fixed model is a problem", () => {
  const l = modelList(
    [{ id: "model", options: [{ value: "gpt-oss-120b-medium", name: "GPT-OSS" }, { value: "g", name: "G" }] }, { id: "mode", options: [{ value: "default", name: "Default" }] }],
    [{ modelId: "g-high", name: "G (High)" }, { modelId: "gpt-oss-120b-medium", name: "GPT-OSS" }],
  );
  const catalog = { harness: "antigravity" as const, sources: [{ source: "subscription" as const, billing: { kind: "plan" as const, label: "Google AI Pro" } }], models: l, defaultMode: "default" };
  expect(fallbackStepProblem({ harness: "antigravity", source: "subscription", model: "gpt-oss-120b-medium", effort: "high" }, catalog)).toMatch(/Effort unavailable/);
  expect(fallbackStepProblem({ harness: "antigravity", source: "subscription", model: "g", effort: "high" }, catalog)).toBeUndefined();
});

test("the TUI's screen: idle, working, asking for permission or trust", () => {
  expect(agyScreen(fixture("screen-idle.txt"))).toEqual({ state: "idle", input: "", prompt: "normal" });
  expect(agyScreen(fixture("screen-typed.txt"))).toEqual({ state: "idle", input: "fix the failing test", prompt: "normal" });
  expect(agyScreen(fixture("screen-busy.txt")).state).toBe("busy");
  expect(agyScreen(fixture("screen-permission.txt")).state).toBe("asking");
  expect(agyScreen(fixture("screen-trust.txt")).state).toBe("asking");
  expect(agyScreen("starting…").state).toBe("unknown");
  const hint = fixture("screen-typed.txt").replace("> fix the failing test", "> Accept-edits mode: file edits auto-approved (shift+tab to cycle)");
  expect(agyScreen(hint)).toEqual({ state: "idle", input: "", prompt: "normal" });
});

test("a command's output loses Antigravity's timing header, but keeps an unclean exit", () => {
  const out = (output: string) => acpTool({ sessionUpdate: "tool_call_update", toolCallId: "x", kind: "execute", status: "completed", rawOutput: { output } }).output;
  expect(out("Created At: 2026-11-20T23:02:15Z\nCompleted At: 2026-11-20T23:02:15Z\nCommand exited with code 0.\n\nhello\n")).toBe("hello\n");
  expect(out("Created At: a\nCompleted At: b\nCommand exited with code 1.\n\noops")).toBe("Command exited with code 1.\n\noops");
});

test("what the agent says after its turn ended, with no prompt between, joins that reply (as a replay groups it)", () => {
  const t = new AcpTranscript("m", hooks());
  t.prompt([{ type: "text", text: "start a subagent" }]);
  t.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Waiting." } });
  t.end();
  t.drain();
  t.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: " It reported." } });
  expect(t.msgs.map((m) => m.id)).toEqual(["m0", "m1"]);
  expect((t.msgs[1]!.parts[0] as any).text).toBe("Waiting. It reported.");
  expect(t.msgs[1]!.streaming).toBe(true);
  t.prompt([{ type: "text", text: "next" }]);
  t.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "New." } });
  expect(t.msgs.map((m) => m.id)).toEqual(["m0", "m1", "m2", "m3"]);
});

test("Tether's own tools draw as peer cards", () => {
  expect(acpTool({ sessionUpdate: "tool_call", toolCallId: "p", name: "mcp_tether_tether_send", kind: "other" }).kind).toBe("peer");
  expect(acpTool({ sessionUpdate: "tool_call", toolCallId: "q", name: "mcp_other_send", kind: "other" }).kind).toBe("other");
});

test("a call that failed with nothing to show says so", () => {
  expect(acpTool({ sessionUpdate: "tool_call_update", toolCallId: "f", name: "run_command", kind: "execute", status: "failed", rawOutput: { output: "" } }).output).toBe("No output: Antigravity didn't say why it failed.");
  expect(acpTool({ sessionUpdate: "tool_call_update", toolCallId: "g", name: "run_command", kind: "execute", status: "failed", rawOutput: { output: "boom" } }).output).toBe("boom");
});
