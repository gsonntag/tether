// The Phase 1 test matrix (docs/harness-platform.md), end to end on the real adapters' parsers with
// no harness process: Claude Code, Codex and Kiro sessions are created but never started, their
// process handles are stubs, and the simulated limits of `/tether simulate-limit` (faults.ts) end
// their turns with each harness's own error. Handoffs go through the real runHandoff (with the
// master context off), restarts through the real resumeActive. Usage checks read only what
// `/tether simulate-usage` set. docs/fallback-testing.md is the manual version, on real harnesses.

import { resetHome } from "./testenv";
import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChainEntry } from "../../web/src/shared/protocol";
import { kiroAdapter } from "./adapters/acp";
import { claudeAdapter } from "./adapters/claude";
import { codexAdapter } from "./adapters/codex";
import type { Sink } from "./adapters/types";
import { config, prefs } from "./config";
import { setUsageSource } from "./fallback";
import { resumeActive, runHandoff, type HandoffDeps } from "./handoffRun";
import type { HandoffOpts, LiveSession } from "./session";
import { simulatedFor, simulateUsage } from "./usage";

let live: LiveSession[] = [];

beforeEach(() => {
  resetHome();
  process.env.TETHER_DEV = "1";
  config().exhausted = {};
  config().sessions = {};
  setUsageSource(async (a) => simulatedFor(a));
});
afterEach(() => {
  jest.useRealTimers();
  live.splice(0).forEach((s) => s.close());
  delete process.env.TETHER_DEV;
  simulateUsage("claude");
  simulateUsage("codex");
  setUsageSource();
  config().exhausted = {};
});

const micro = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};
/** Waits (real time) until `cond` holds: handoffs run git for the brief. */
async function until(cond: () => unknown, ms = 5_000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(10);
  }
}

// ---- the harnesses, stubbed below their parsers ----

const textOf = (c: any): string => (typeof c === "string" ? c : (c ?? []).map((b: any) => b.text ?? "").join(""));

function makeClaude(projectPath: string, opts: { model?: string }, sink: Sink) {
  const s: any = claudeAdapter.create(projectPath, opts, sink);
  const q = {
    interrupts: 0,
    stopped: [] as string[],
    interrupt: async () => void q.interrupts++,
    setModel: async () => {},
    getContextUsage: async () => ({}),
    stopTask: async (id: string) => void q.stopped.push(id),
    supportedCommands: async () => [],
  };
  s.q = q;
  s.start = async () => s.setState({ status: "idle", model: opts.model ?? "default", activity: [] });
  live.push(s);
  return Object.assign(s as LiveSession, {
    q,
    /** what Tether sent Claude Code, in order */
    inputs: () => (s.input.items as any[]).map((m) => textOf(m.message.content)),
    feed: (m: any) => s.onMessage(m),
    /** Claude Code's canUseTool for a call */
    ask: (tool: string, input: any, id: string) => s.permission(tool, input, new AbortController().signal, [], id),
  });
}
type Claude = ReturnType<typeof makeClaude>;

function makeCodex(projectPath: string, opts: { model?: string }, sink: Sink) {
  const s: any = codexAdapter.create(projectPath, opts, sink);
  const calls: [string, any][] = [];
  s.p = { call: async (m: string, p: any) => (calls.push([m, p]), m === "turn/start" ? { turn: { id: `t${calls.length}` } } : {}), kill() {} };
  s.start = async () => {
    s.nativeId = crypto.randomUUID();
    s.setState({ status: "idle", model: opts.model ?? "default" });
  };
  live.push(s);
  return Object.assign(s as LiveSession, {
    calls,
    notify: (method: string, p: any) => s.onNotify(method, { threadId: s.nativeId, ...p }),
    request: (method: string, p: any) => s.onRequest(method, { threadId: s.nativeId, ...p }),
  });
}

function makeKiro(projectPath: string, opts: { model?: string }, sink: Sink, prompt: () => Promise<any> = async () => ({ stopReason: "end_turn" })) {
  const s: any = kiroAdapter.create(projectPath, opts, sink);
  s.p = { conn: { prompt, cancel: async () => {} }, caps: {}, kill() {} };
  live.push(s);
  return Object.assign(s as LiveSession, { turn: (text: string) => s.runTurn(text) });
}

/** A sink whose handoffs run the real runHandoff, into the stubbed harnesses above. */
function world() {
  const created: LiveSession[] = [];
  const handoffs: { from: string; to: ChainEntry; reason: string; interrupted?: boolean }[] = [];
  const sink: Sink = {
    emit: () => {},
    summary: () => {},
    handoff: async (from, to, reason, pendingPrompt, opts?: HandoffOpts) => {
      handoffs.push({ from: from.id, to, reason, ...(opts?.interrupted ? { interrupted: true } : {}) });
      await runHandoff(deps, from, to, reason, pendingPrompt, opts);
    },
  };
  const make = (f: (p: string, o: { model?: string }, s: Sink) => LiveSession) => ({ create: (p: string, o: { model?: string }) => f(p, o, sink) });
  const deps: HandoffDeps = {
    adapters: { "claude-code": make(makeClaude), codex: make(makeCodex), kiro: make((p, o, s) => makeKiro(p, o, s)) } as unknown as HandoffDeps["adapters"],
    sink,
    context: { handoffMemory: async () => undefined },
    track: (s) => {
      s.loadPrefs();
      created.push(s);
    },
  };
  return { sink, created, handoffs };
}

function setup<T extends LiveSession>(s: T, model: string, chain: string[]): T {
  s.t.state.status = "idle";
  s.t.state.model = model;
  s.t.state.chain = chain;
  s.loadPrefs();
  return s;
}

const notices = (s: LiveSession) => s.t.messages.filter((m) => m.role === "notice").map((m) => (m.parts[0] as any).text as string);

// Claude Code's own messages for a turn (Agent SDK shapes).
const start = (id: string) => ({ type: "stream_event", event: { type: "message_start", message: { id, model: "claude-opus-5-5", usage: {} } } });
const toolUse = (id: string, name: string, input: any) => ({
  type: "assistant",
  message: { id: `m-${id}`, model: "claude-opus-5-5", role: "assistant", content: [{ type: "tool_use", id, name, input }], stop_reason: null },
  parent_tool_use_id: null,
});
const toolResult = (id: string, text = "ok") => ({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text }] }, parent_tool_use_id: null });
const interruptedResult = { type: "result", subtype: "error_during_execution", is_error: true, total_cost_usd: 0 };
const okResult = { type: "result", subtype: "success", is_error: false, result: "done", total_cost_usd: 0 };

/** A git repository with one committed file. */
function repo(): string {
  const dir = join(process.env.HOME!, "proj");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "app.ts"), "export const a = 1;\nexport const b = 2;\n");
  for (const args of [["init", "-q"], ["add", "."], ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]]) Bun.spawnSync(["git", ...args], { cwd: dir });
  return dir;
}

describe("same-harness model switch", () => {
  test("before the turn: the limit hits as the turn starts; the next model continues it", async () => {
    const w = world();
    const s = setup(makeClaude(process.env.HOME!, {}, w.sink), "opus", ["opus", "sonnet"]);
    await s.prompt("/tether simulate-limit quota reset 2h");
    await s.prompt("fix the login bug");
    await micro();
    expect(s.q.interrupts).toBe(0); // Claude Code hasn't started the turn yet
    s.feed(start("m1"));
    expect(s.q.interrupts).toBe(1);
    s.feed(interruptedResult);
    await until(() => s.t.state.model === "sonnet" && s.inputs().length === 2);
    expect(config().exhausted["claude-code:opus"]).toBeGreaterThan(Date.now() + 115 * 60_000);
    // The message reached Claude Code; the new model is told to carry on with it.
    expect(s.inputs()).toEqual(["fix the login bug", "Continue where you left off."]);
    expect(notices(s).slice(-2)).toEqual([expect.stringMatching(/^Usage limit reached on Opus/), "Switched to Sonnet."]);
    expect(w.handoffs).toEqual([]);
  });

  test("mid-turn: after the second tool call the turn is stopped and continued on the next model", async () => {
    const w = world();
    const s = setup(makeClaude(process.env.HOME!, {}, w.sink), "opus", ["opus", "sonnet"]);
    await s.prompt("/tether simulate-limit quota after 2 tools");
    await s.prompt("refactor the parser");
    s.feed(start("m1"));
    s.feed(toolUse("t1", "Read", { file_path: "/x" }));
    s.feed(toolResult("t1"));
    await micro();
    expect(s.q.interrupts).toBe(0);
    s.feed(toolUse("t2", "Read", { file_path: "/y" }));
    s.feed(toolResult("t2"));
    await micro();
    expect(s.q.interrupts).toBe(1);
    s.feed(interruptedResult);
    await until(() => s.t.state.model === "sonnet" && s.inputs().length === 2);
    expect(s.inputs()[1]).toBe("Continue where you left off.");
  });
});

describe("cross-harness handoff mid-turn", () => {
  test("Claude Code → Codex with a half-done edit, a background shell, a pending approval and an open question", async () => {
    const dir = repo();
    const w = world();
    const s = setup(makeClaude(dir, {}, w.sink), "opus", ["claude-code:opus", "codex:gpt-5.5"]);
    s.setGuard("ask");
    await s.prompt("/tether simulate-limit quota after 2 tools");
    await s.prompt("add a dev server and rename b");
    s.feed(start("m1"));
    // A background shell, started by tool 1.
    s.feed(toolUse("t1", "Bash", { command: "npm run dev", run_in_background: true }));
    s.feed({ type: "system", subtype: "task_started", task_id: "bash-1", task_type: "local_bash", tool_use_id: "t1", description: "npm run dev", is_backgrounded: true });
    // An approval and a question still open when the limit hits (tools running in parallel).
    const approval: Promise<any> = s.ask("Bash", { command: "git push origin feature" }, "t3");
    const question: Promise<any> = s.ask("AskUserQuestion", { questions: [{ question: "Which port should the dev server use?", header: "Port", options: [], multiSelect: false }] }, "t4");
    await micro();
    expect(s.t.state.pendingUi).toHaveLength(2);
    s.feed(toolResult("t1", "Command running in background with ID: bash-1"));
    // Tool 2: an edit that leaves the file half done.
    writeFileSync(join(dir, "app.ts"), "export const a = 1;\nexport const renamedB = \n");
    s.feed(toolUse("t2", "Edit", { file_path: join(dir, "app.ts"), old_string: "b = 2;", new_string: "renamedB = " }));
    s.feed(toolResult("t2", "The file has been updated."));
    await micro();
    expect(s.q.interrupts).toBe(1);
    s.feed(interruptedResult);
    await until(() => w.created.length === 1 && (w.created[0] as any).calls.some(([m]: [string]) => m === "turn/start"));

    expect(w.handoffs).toEqual([{ from: s.id, to: { harness: "codex", model: "gpt-5.5" }, reason: "Opus hit its usage limit", interrupted: true }]);
    // The old session: requests cancelled, the shell stopped, a notice that says so.
    expect((await approval).behavior).toBe("deny");
    expect((await question).behavior).toBe("deny");
    expect(s.q.stopped).toEqual(["bash-1"]);
    expect(notices(s).at(-1)).toBe("Opus hit its usage limit. Continued on GPT-5.5 in Codex. 2 open requests were cancelled; 1 background task was stopped.");
    expect(s.t.state.handoffTo?.sessionId).toBe(w.created[0]!.id);
    // The new session starts on the brief.
    const next = w.created[0] as ReturnType<typeof makeCodex>;
    expect(next.t.state.chain).toEqual(["claude-code:opus", "codex:gpt-5.5"]);
    expect(next.t.state.guard).toBe("ask");
    const brief = next.calls.find(([m]) => m === "turn/start")![1].input[0].text as string;
    expect(brief).toContain("## Interrupted work");
    expect(brief).toContain("halfway through an edit");
    expect(brief).toContain("M app.ts"); // the half-done edit, from git status
    expect(brief).toContain("- Approval for Bash: git push origin feature");
    expect(brief).toContain("- Question: Which port should the dev server use?");
    expect(brief).toContain("These background tasks of the previous agent were stopped:\n- shell: npm run dev");
    expect(brief).toContain("add a dev server and rename b");
  });

  test("Codex → Claude Code with a pending approval: Codex's own limit, then the brief", async () => {
    const dir = repo();
    const w = world();
    const s = setup(makeCodex(dir, { model: "gpt-5.5" }, w.sink), "gpt-5.5", ["codex:gpt-5.5", "claude-code:opus"]);
    await s.start();
    s.loadPrefs();
    s.setGuard("ask");
    s.t.state.chain = ["codex:gpt-5.5", "claude-code:opus"];
    await s.prompt("/tether simulate-limit quota after 1 tool");
    await s.prompt("run the migrations");
    s.notify("turn/started", { turn: { id: "t1" } });
    const cmd = (id: string, status: string) => ({ item: { type: "commandExecution", id, command: "ls", cwd: dir, status, commandActions: [], aggregatedOutput: "" } });
    const approval = s.request("item/commandExecution/requestApproval", { itemId: "c2", command: "npm install left-pad" });
    await micro();
    expect(s.t.state.pendingUi).toHaveLength(1);
    s.notify("item/started", cmd("c1", "inProgress"));
    s.notify("item/completed", cmd("c1", "completed"));
    await micro();
    expect(s.calls.map(([m]) => m)).toContain("turn/interrupt");
    s.notify("turn/completed", { turn: { id: "t1", status: "interrupted", items: [], error: null } });
    await until(() => w.created.length === 1 && (w.created[0] as Claude).inputs().length === 1);
    expect(((await approval) as any).decision).toBe("decline");
    expect(config().exhausted["codex"]).toBeGreaterThan(Date.now());
    const brief = (w.created[0] as Claude).inputs()[0]!;
    expect(brief).toContain("## Interrupted work");
    expect(brief).toContain("- Approval for bash: npm install left-pad");
  });
});

describe("no-chain quota wait", () => {
  test("resumes with its continuation after a runner restart", async () => {
    jest.useFakeTimers();
    const w = world();
    const s = setup(makeClaude(process.env.HOME!, {}, w.sink), "opus", []);
    await s.prompt("/tether simulate-limit quota reset 10m");
    await s.prompt("finish the task");
    s.feed(start("m1"));
    s.feed(interruptedResult);
    await micro();

    expect(s.t.state.status).toBe("waiting");
    expect(prefs(s.id)).toMatchObject({ waitingUsageLimitResume: true });
    s.savePrefs();
    s.close();
    jest.advanceTimersByTime(2 * 60_000);

    let back!: Claude;
    await resumeActive(async (id) => {
      back = makeClaude(process.env.HOME!, {}, w.sink);
      (back as any).nativeId = id.slice("claude-code:".length);
      back.t.state.model = "opus";
      back.loadPrefs();
      return back;
    });
    expect(back.t.state.status).toBe("waiting");
    jest.advanceTimersByTime(8 * 60_000);
    await micro();

    expect(back.inputs()).toEqual(["The usage limit has reset. Continue the task where you stopped."]);
    expect(notices(back)).toContain("Usage limit reset. Continuing on Opus.");
  });
});

describe("whole chain exhausted", () => {
  test("wait → reset → continue, across a runner restart; then preferBest moves back up once the first entry resets", async () => {
    jest.useFakeTimers();
    const w = world();
    const s = setup(makeClaude(process.env.HOME!, {}, w.sink), "opus", ["opus", "sonnet"]);
    config().exhausted["claude-code:sonnet"] = Date.now() + 20 * 60_000;
    await s.prompt("/tether simulate-limit quota reset 1h");
    await s.prompt("write the tests");
    s.feed(start("m1"));
    s.feed(interruptedResult);
    await micro();
    expect(s.t.state.status).toBe("waiting");
    expect(s.t.state.waitingReason).toBe("Every model in this session's chain is at its usage limit");
    expect(s.t.state.waitingUntil).toBe(Date.now() + 20 * 60_000);
    expect(prefs(s.id)).toMatchObject({ active: true, waitingUntil: Date.now() + 20 * 60_000 });

    // The runner stops (index.ts SIGTERM: prefs saved, sessions closed) and starts again.
    s.savePrefs();
    s.close();
    jest.advanceTimersByTime(5 * 60_000);
    let back!: Claude;
    await resumeActive(async (id) => {
      back = makeClaude(process.env.HOME!, {}, w.sink);
      (back as any).nativeId = id.slice("claude-code:".length);
      back.t.state.model = "opus";
      back.loadPrefs();
      return back;
    });
    expect(back.id).toBe(s.id);
    expect(back.t.state.status).toBe("waiting");
    expect(notices(back)[0]).toStartWith("The runner restarted while this session was waiting. It continues at ");
    jest.advanceTimersByTime(15 * 60_000 - 1);
    await micro();
    expect(back.inputs()).toEqual([]);
    jest.advanceTimersByTime(1);
    await micro();
    expect(back.t.state.model).toBe("sonnet");
    expect(back.inputs()).toEqual(["Continue where you left off."]);
    back.feed(okResult);
    await micro();
    expect(back.t.state.status).toBe("idle");

    // Opus resets an hour after the limit: the next message goes back to it.
    jest.advanceTimersByTime(45 * 60_000);
    await back.prompt("next step");
    expect(back.t.state.model).toBe("opus");
    expect(notices(back)).toContain("Back on Opus: its usage limit has reset.");
    expect(back.inputs().at(-1)).toBe("next step");
  });

  test("preferBest across harnesses: once Claude resets, the Codex session hands the next message back", async () => {
    jest.useFakeTimers();
    const w = world();
    const s = setup(makeClaude(process.env.HOME!, {}, w.sink), "opus", ["claude-code:opus", "codex:gpt-5.5"]);
    await s.prompt("/tether simulate-limit quota reset 30m");
    await s.prompt("start");
    s.feed(start("m1"));
    s.feed(interruptedResult);
    for (let i = 0; i < 20 && !w.created.length; i++) {
      jest.useRealTimers();
      await Bun.sleep(25);
      jest.useFakeTimers({ now: Date.now() });
    }
    const cx = w.created[0] as ReturnType<typeof makeCodex>;
    expect(cx.harness).toBe("codex");
    cx.notify("turn/completed", { turn: { id: "t1", status: "completed", items: [], error: null } });
    await micro();
    // Still within the reset: stays on Codex.
    expect(await (cx as any).preferBest("again")).toBe(false);
    jest.setSystemTime(Date.now() + 31 * 60_000);
    expect(await (cx as any).preferBest("again")).toBe(true);
    expect(w.handoffs.at(-1)).toMatchObject({ from: cx.id, to: { harness: "claude-code", model: "opus" }, reason: "Opus is available again" });
  });
});

describe("no switch without a definite, verified limit", () => {
  test("Claude: billing text with the account's usage below its limit offers Continue on and moves nothing", async () => {
    const w = world();
    const s = setup(makeClaude(process.env.HOME!, {}, w.sink), "opus", ["opus", "sonnet"]);
    await s.prompt("/tether simulate-usage claude 50");
    await s.prompt("hi");
    const text = "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.";
    s.feed({ type: "assistant", message: { id: "e1", model: "<synthetic>", role: "assistant", content: [{ type: "text", text }], stop_reason: "stop_sequence" }, parent_tool_use_id: null, error: "billing_error" });
    s.feed({ type: "result", subtype: "success", is_error: true, result: text, api_error_status: 400, total_cost_usd: 0 });
    await until(() => s.t.state.status === "idle");
    expect(config().exhausted).toEqual({});
    expect(s.t.state.model).toBe("opus");
    expect(s.t.messages.at(-1)?.action?.label).toBe("Continue on Sonnet");
  });

  test("Kiro (unverifiable): limit text with a reset in it offers Continue on and moves nothing", async () => {
    const w = world();
    const s = setup(
      makeKiro(process.env.HOME!, {}, w.sink, async () => {
        throw { code: -32603, message: "Internal error", data: { message: "Monthly usage limit reached for billing account. Usage resets in 3 days." } };
      }),
      "auto",
      ["kiro:auto", "claude-code:opus"],
    );
    await s.turn("hi");
    expect(config().exhausted).toEqual({});
    expect(w.handoffs).toEqual([]);
    expect(s.t.state.status).toBe("idle");
    expect(s.t.messages.at(-1)?.action?.label).toBe("Continue on Opus in Claude Code");
  });

  test("an unverifiable entry's simulated limit: only the manual Continue on moves it, as an interrupted handoff", async () => {
    const w = world();
    const s = setup(makeKiro(process.env.HOME!, {}, w.sink, async () => ({ stopReason: "cancelled" })), "auto", ["kiro:auto", "claude-code:opus"]);
    await s.prompt("/tether simulate-limit quota");
    await s.turn("hi");
    expect(w.handoffs).toEqual([]);
    const offer = s.t.messages.at(-1)!;
    expect(offer.action?.label).toBe("Continue on Opus in Claude Code");
    await s.continueOn(offer.id);
    await until(() => w.created.length === 1 && (w.created[0] as Claude).inputs().length === 1);
    expect(w.handoffs).toEqual([{ from: s.id, to: { harness: "claude-code", model: "opus" }, reason: "You moved it on from Auto after an error", interrupted: true }]);
    expect((w.created[0] as Claude).inputs()[0]).toContain("## Interrupted work");
    expect(config().exhausted).toEqual({}); // a manual move marks nothing for other sessions
  });
});
