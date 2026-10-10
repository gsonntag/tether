import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Part, SessionEvent } from "../../../web/src/shared/protocol";
import { applyEvent, emptyState, type Transcript } from "../../../web/src/shared/reducer";
import { agyUsage } from "../contextWindow";
import { AGY_MODES, AgyStream, APPROVING_MODES, cleanArgs, cleanUserText, effortOf, hookConfig, HookWatch, parseModels, planArtifact, sessionMode, spawnArgs, toolResultText, transcriptToMessages } from "./agy";

// Captured from agy 1.3.3 (`-p "" --input-format stream-json --output-format stream-json`) in
// throwaway repositories; long file contents are cut short.
const fixture = (name: string) => readFileSync(new URL(`./fixtures/agy/${name}`, import.meta.url), "utf8");
const lines = (name: string) =>
  fixture(name)
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

function harness() {
  const t: Transcript = { messages: [], state: emptyState() };
  const events: SessionEvent[] = [];
  const usages: any[] = [];
  const stream = new AgyStream({
    emit: (e) => {
      events.push(e);
      applyEvent(t, e);
    },
    messages: () => t.messages,
    model: () => "gemini-3.8-flash-high",
    usage: (u) => usages.push(u),
  });
  const results: any[] = [];
  const feed = (evs: any[]) => {
    for (const e of evs) {
      const r = stream.event(e);
      if (r.result) {
        results.push({ ...r.result, turnError: r.error });
        stream.finish(r.error);
      }
    }
  };
  return { t, events, usages, stream, results, feed };
}

const tools = (parts: Part[]) => parts.filter((p): p is Extract<Part, { type: "tool" }> => p.type === "tool");

describe("models and effort", () => {
  const models = parseModels(fixture("models.txt"));
  test("parses `agy models`", () => {
    expect(models[0]).toEqual({ id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" });
    expect(models.some((m) => m.id === "Fetching")).toBe(false);
    expect(models.map((m) => m.id)).toContain("claude-opus-4-6-thinking");
    expect(models.map((m) => m.id)).toContain("gpt-oss-120b-medium");
  });
  test("effort levels are a model's siblings", () => {
    expect(effortOf("gemini-3.8-flash-high", models)).toEqual({ base: "gemini-3.8-flash", level: "high", levels: ["low", "medium", "high"] });
    expect(effortOf("gemini-3.1-pro-low", models)).toEqual({ base: "gemini-3.1-pro", level: "low", levels: ["low", "high"] });
  });
  test("single-variant models have none (agy rejects --effort for them)", () => {
    expect(effortOf("claude-sonnet-4-6", models)).toBeUndefined();
    expect(effortOf("gpt-oss-120b-medium", models)).toBeUndefined();
    expect(effortOf(undefined, models)).toBeUndefined();
  });
});

describe("spawn args", () => {
  test("-p gets an empty prompt; turns come from stdin", () => {
    const a = spawnArgs({});
    expect(a.slice(0, 2)).toEqual(["-p", ""]);
    expect(a).toContain("stream-json");
  });
  test("a full model id never goes with --effort", () => {
    expect(spawnArgs({ model: "gemini-3.8-flash-low", effort: "high" })).not.toContain("--effort");
    expect(spawnArgs({ effort: "low" })).toEqual(expect.arrayContaining(["--effort", "low"]));
  });
  test("resume, plan mode and the hook folder", () => {
    const a = spawnArgs({ convId: "c1", plan: true, hookDir: "/h" });
    expect(a.join(" ")).toContain("--conversation c1");
    expect(a.join(" ")).toContain("--mode plan");
    expect(a.join(" ")).toContain("--dangerously-skip-permissions --add-dir /h");
  });
  test("approvals are only skipped when the hook is there to decide", () => {
    expect(spawnArgs({})).not.toContain("--dangerously-skip-permissions");
    // Every argument set that skips agy's (headless: deny-all) approvals also loads the guard hook.
    for (const o of [{ hookDir: "/h" }, { hookDir: "/h", plan: true, convId: "c" }, { hookDir: "/h", model: "m", sandbox: true }]) {
      const a = spawnArgs(o);
      expect(a[a.indexOf("--dangerously-skip-permissions") + 1]).toBe("--add-dir");
      expect(a[a.indexOf("--add-dir") + 1]).toBe("/h");
    }
  });
  test("agy's own approving modes are never passed", () => {
    expect(spawnArgs({ hookDir: "/h", plan: true }).join(" ")).not.toMatch(/accept-edits|bypass/);
  });
});

describe("session modes", () => {
  test("approving modes are refused: only default and plan", () => {
    for (const m of APPROVING_MODES) expect(sessionMode(m)).toBe("default");
    expect(sessionMode("bypassPermissions")).toBe("default");
    expect(sessionMode(undefined)).toBe("default");
    expect(sessionMode("plan")).toBe("plan");
    expect([...AGY_MODES]).toEqual(["default", "plan"]);
  });
});

describe("stream", () => {
  test("text, tools, a hook denial", () => {
    const h = harness();
    h.feed(lines("stream-hook-denied.jsonl"));
    expect(h.t.messages).toHaveLength(1);
    const m = h.t.messages[0]!;
    expect(m.streaming).toBe(false);
    const [ok, denied] = tools(m.parts);
    expect(ok).toMatchObject({ id: "agy-2", name: "run_command", status: "done", input: { CommandLine: "echo allowed-one > one.txt" } });
    expect(denied).toMatchObject({ id: "agy-4", status: "error", output: "tool call denied by pre-tool hook: TESTHOOK says no" });
    const text = m.parts.filter((p) => p.type === "text").map((p) => (p as any).text).join("");
    expect(text).toContain("TESTHOOK says no");
    expect(h.results[0].status).toBe("SUCCESS");
  });

  test("tool output from the stream", () => {
    const h = harness();
    h.feed(lines("stream-plan.jsonl"));
    const run = tools(h.t.messages[0]!.parts).find((t) => t.id === "agy-22")!;
    expect(run.output).toBe("5\n6\n6");
  });

  test("usage per request, never the result's running total", () => {
    const h = harness();
    h.feed(lines("stream-cache-read.jsonl"));
    // input_tokens leaves out cache reads: 57512 fresh, then 2580 fresh + 55459 cached = 58039.
    expect(h.usages.map((u) => agyUsage(u)!.used).slice(4, 6)).toEqual([57512, 58039]);
    expect(h.results[0].usage.input_tokens).toBe(113192); // the whole process, not the context
    expect(h.t.messages).toHaveLength(3); // one per turn
  });

  test("quota error: no empty message, the error comes with the result", () => {
    const h = harness();
    h.feed(lines("stream-quota.jsonl"));
    expect(h.t.messages).toHaveLength(0);
    expect(h.results[0]).toMatchObject({ status: "ERROR", turnError: expect.stringContaining("Resets in 13h10m12s") });
  });

  test("a stale error in the result isn't this turn's", () => {
    // After the usage-limit error above, agy reports it again with every later result of the
    // conversation, even from a new process, though the turn worked.
    const h = harness();
    h.feed(lines("stream-stale-error.jsonl"));
    expect(h.results[0]).toMatchObject({ status: "ERROR", error: expect.stringContaining("quota") });
    expect(h.results[0].turnError).toBeUndefined();
    expect(h.t.messages[0]!.error).toBeUndefined();
    expect(h.t.messages[0]!.parts).toEqual([{ type: "text", text: "Bye.\n" }]);
  });

  test("interrupt (SIGINT) ends the turn with an 'interrupted' error result", () => {
    const h = harness();
    h.feed(lines("stream-interrupted.jsonl"));
    expect(h.results[0]).toMatchObject({ status: "ERROR", error: "interrupted" });
    expect(h.results[0].turnError).toBeUndefined(); // it responded; the session ignores this result anyway (Stop detaches the process)
    expect(tools(h.t.messages[0]!.parts)[0]!.status).toBe("running");
  });

  test("Stop: calls still running end as stopped", () => {
    const h = harness();
    h.feed(lines("stream-interrupted.jsonl").slice(0, -1));
    h.stream.finish(undefined, "Stopped.");
    expect(tools(h.t.messages[0]!.parts)[0]).toMatchObject({ status: "error", output: "Stopped." });
    expect(h.t.messages[0]!.streaming).toBe(false);
  });

  test("hook arguments replace the stream's abbreviated ones", () => {
    const h = harness();
    const evs = lines("stream-plan.jsonl");
    const at = evs.findIndex((e) => e.step_update?.step_index === 20);
    h.feed(evs.slice(0, at));
    h.stream.toolArgs(20, cleanArgs({ TargetFile: "/tmp/agyt/repo5/calc.py", TargetContent: "a-b", ReplacementContent: "a+b", toolAction: "x" }));
    h.feed(evs.slice(at));
    expect(tools(h.t.messages[0]!.parts).find((t) => t.id === "agy-20")!.input).toEqual({ TargetFile: "/tmp/agyt/repo5/calc.py", TargetContent: "a-b", ReplacementContent: "a+b" });
  });

  test("transcript adds thinking in step order and full results", () => {
    const h = harness();
    const evs = lines("stream-hook-denied.jsonl");
    h.feed(evs.slice(0, -1)); // before the result
    for (const t of lines("transcript-hook-denied.jsonl")) h.stream.transcript(t);
    const parts = h.t.messages[0]!.parts;
    expect(parts[0]).toEqual({ type: "thinking", text: expect.stringContaining("Initial plan: Execute the first shell command") });
    expect(parts.map((p) => p.type)).toEqual(["thinking", "tool", "tool", "text"]);
    expect(tools(parts)[0]!.output).toBe("The command exited with code 0.\nStdout:\n\nStderr:");
    expect(tools(parts)[0]!.input).toMatchObject({ CommandLine: "echo allowed-one > one.txt", Cwd: "/tmp/agyt/repo3" });
    h.stream.transcript(lines("transcript-hook-denied.jsonl")[1]); // repeated: no second thinking part
    expect(h.t.messages[0]!.parts.filter((p) => p.type === "thinking")).toHaveLength(1);
  });

  test("a transcript line ahead of the stream's last deltas doesn't double text", () => {
    const h = harness();
    h.feed([{ event: "step_update", step_update: { conversation_id: "c", step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "You skipped the question without selecting an op" } }]);
    h.stream.transcript({ step_index: 1, type: "PLANNER_RESPONSE", status: "DONE", content: "You skipped the question without selecting an option." });
    h.feed([
      { event: "step_update", step_update: { conversation_id: "c", step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "tion." } },
      { event: "step_update", step_update: { conversation_id: "c", step_index: 1, state: "DONE", step_type: "agent_response", text_delta: "\n" } },
    ]);
    expect(h.t.messages[0]!.parts).toEqual([{ type: "text", text: "You skipped the question without selecting an option.\n" }]);
  });

  test("a plan artifact becomes a plan part after its tool", () => {
    const h = harness();
    const evs = lines("stream-plan.jsonl");
    const at = evs.findIndex((e) => e.step_update?.step_index === 16);
    h.feed(evs.slice(0, at));
    h.stream.plan(16, "# Plan");
    h.feed(evs.slice(at));
    const parts = h.t.messages[0]!.parts;
    const i = parts.findIndex((p) => p.type === "plan");
    expect(parts[i]).toEqual({ type: "plan", id: "plan-agy-16", text: "# Plan" });
    expect(parts[i - 1]).toMatchObject({ type: "tool", id: "agy-16", name: "write_to_file" });
  });
});

describe("transcript replay", () => {
  test("user turns, thinking, tools with results, plans, usage", () => {
    const { messages, usage } = transcriptToMessages(lines("transcript-plan.jsonl"), "gemini-3.8-flash-high");
    expect(messages[0]).toMatchObject({ role: "user", parts: [{ type: "text", text: expect.stringMatching(/^Plan how to add a CLI entry point/) }] });
    const a = messages[1]!;
    expect(a.role).toBe("assistant");
    expect(a.parts[0]!.type).toBe("thinking");
    const ts = tools(a.parts);
    expect(ts.every((t) => t.status === "done")).toBe(true);
    expect(ts.find((t) => t.id === "agy-22")!.output).toContain("5\n6\n6");
    expect(ts.find((t) => t.id === "agy-20")!.input).toMatchObject({ TargetContent: "def add(a,b):\n    return a-b\n" });
    const plan = a.parts.find((p) => p.type === "plan") as any;
    expect(plan.id).toBe("plan-agy-16");
    expect(plan.text).toContain("# Plan: CLI Entry Point for calc.py");
    expect(usage).toEqual({ input_tokens: 2268, cache_read_tokens: 29362 });
  });
  test("a denied call is an error with the hook's reason", () => {
    const { messages } = transcriptToMessages(lines("transcript-hook-denied.jsonl"));
    expect(tools(messages[1]!.parts)[1]).toMatchObject({ status: "error", output: "tool call denied by pre-tool hook: TESTHOOK says no" });
  });
});

describe("helpers", () => {
  test("user text without agy's wrapper or Tether's memory preamble", () => {
    expect(cleanUserText("<USER_REQUEST>\nhi\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nx\n</ADDITIONAL_METADATA>")).toBe("hi");
    expect(cleanUserText("<USER_REQUEST>\n<tether-memory>\nm\n</tether-memory>\n\nfix it\n</USER_REQUEST>")).toBe("fix it");
  });
  test("tool result header", () => expect(toolResultText("Created At: a\nCompleted At: b\n\nThe command exited with code 0.\r\n")).toBe("The command exited with code 0."));
  test("plan artifacts are writes that request feedback", () => {
    expect(planArtifact("write_to_file", { ArtifactMetadata: { RequestFeedback: true }, CodeContent: "# P" })).toBe("# P");
    expect(planArtifact("write_to_file", { ArtifactMetadata: { RequestFeedback: false }, CodeContent: "# P" })).toBeUndefined();
    expect(planArtifact("write_to_file", { CodeContent: "x" })).toBeUndefined();
  });
});

// agy runs with --dangerously-skip-permissions: the hook is the only gate, so it must fail closed.
// Measured on agy 1.3.3: a hook that crashes, times out, prints non-JSON, `{}` or an unknown
// decision blocks the call, but one that prints nothing (or "ask") lets it run, and a hooks.json
// agy can't load runs every call unguarded.
describe("guard hook", () => {
  const preToolUse = (runtime: string, script: string) => hookConfig("tg", runtime, script).tg.PreToolUse[0]!.hooks[0]!.command;
  const run = (command: string) => {
    const p = Bun.spawnSync(["sh", "-c", command], { stdin: new TextEncoder().encode("{}") });
    return { code: p.exitCode, out: JSON.parse(p.stdout.toString()) };
  };

  test("the hook's own answer passes through", () => {
    expect(run(preToolUse("printf", '{"decision":"allow"}')).out).toEqual({ decision: "allow" });
  });
  test.each([
    ["prints nothing", "true", "x"],
    ["exits non-zero", "false", "x"],
    ["is missing", "/nonexistent/bun", "/nonexistent/hook.ts"],
  ])("a hook that %s denies", (_, runtime, script) => {
    const r = run(preToolUse(runtime, script));
    expect(r.code).toBe(0);
    expect(r.out.decision).toBe("deny");
  });
  test("paths with spaces and quotes are quoted", () => {
    expect(preToolUse("/opt/my bun/bun", "/x/it's/agy-guard.ts")).toStartWith(`o=$('/opt/my bun/bun' '/x/it'\\''s/agy-guard.ts')`);
  });
  test("PreInvocation pings the runner", () => {
    expect(hookConfig("tg", "/bun", "/hook.ts").tg.PreInvocation[0]!.command).toBe("'/bun' '/hook.ts'");
  });

  const step = (o: object) => ({ event: "step_update", step_update: { conversation_id: "c1", ...o } });
  test("a guarded process passes", () => {
    const w = new HookWatch();
    expect(w.event(step({ step_type: "user_input", step_index: 0, state: "DONE" }))).toBeUndefined();
    w.invocation("c1");
    expect(w.event(step({ step_type: "agent_response", step_index: 1, state: "ACTIVE" }))).toBeUndefined();
    w.checkedCall("c1", 2);
    expect(w.event(step({ step_type: "tool", step_index: 2, state: "ACTIVE", tool_name: "run_command" }))).toBeUndefined();
    expect(w.event(step({ step_type: "tool", step_index: 2, state: "DONE", tool_name: "run_command" }))).toBeUndefined();
  });
  test("the model answers without the hook's ping: unguarded", () => {
    const w = new HookWatch();
    expect(w.event(step({ step_type: "agent_response", step_index: 1, state: "ACTIVE" }))).toContain("never ran");
    expect(new HookWatch().event(step({ step_type: "tool", step_index: 1, state: "ACTIVE" }))).toContain("never ran");
  });
  test("a tool step that ran without the guard: unguarded", () => {
    const w = new HookWatch();
    w.invocation("c1");
    expect(w.event(step({ step_type: "tool", step_index: 2, state: "ACTIVE", tool_name: "run_command" }))).toBeUndefined(); // the hook may still be starting
    expect(w.event(step({ step_type: "tool", step_index: 2, state: "DONE", tool_name: "run_command" }))).toContain("run_command ran without the guard");
    expect(w.event(step({ step_type: "tool", step_index: 4, state: "ERROR", tool_info: { error: { message: "exit status 1" } } }))).toBeDefined();
  });
  test("a call the failing hook blocked is fine", () => {
    const w = new HookWatch();
    w.invocation("c1");
    const denied = lines("stream-hook-denied.jsonl").find((e) => e.step_update?.state === "ERROR")!;
    expect(w.event({ ...denied, step_update: { ...denied.step_update, conversation_id: "c1" } })).toBeUndefined();
  });
  test("another conversation's steps (a subagent) don't count as checked", () => {
    const w = new HookWatch();
    w.invocation("c1");
    w.checkedCall("sub", 2);
    expect(w.event(step({ step_type: "tool", step_index: 2, state: "DONE" }))).toBeDefined();
  });
});
