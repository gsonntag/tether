// Dev fault injection (faults.ts): the `/tether` commands, the simulated usage source, and each
// adapter ending a turn with its harness's own error shape, fed through the adapter's real parser
// into the real fallback path. No harness process runs: sessions are created but never started,
// and their process handles are stubs.

import { resetHome } from "./testenv";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChainEntry } from "../../web/src/shared/protocol";
import { kiroAdapter } from "./adapters/acp";
import { antigravityAdapter } from "./adapters/antigravity";
import { claudeAdapter } from "./adapters/claude";
import { codexAdapter } from "./adapters/codex";
import { piAdapter } from "./adapters/pi";
import { CONFIG_DIR, config } from "./config";
import { classify, setUsageSource } from "./fallback";
import { acpFault, agyFault, claudeFault, codexFault, parseDevCommand, parseDuration, piFault, simulatedUsage } from "./faults";
import type { HandoffOpts, LiveSession } from "./session";
import { accountUsage, getUsage, simulatedFor, simulateUsage } from "./usage";

const sessions: LiveSession[] = [];
let handoffs: { to: ChainEntry; reason: string; interrupted?: boolean }[] = [];
let asked: string[] = [];
const sink = {
  emit: () => {},
  summary: () => {},
  handoff: async (_from: LiveSession, to: ChainEntry, reason: string, _p?: string, opts?: HandoffOpts) => {
    handoffs.push({ to, reason, ...(opts?.interrupted ? { interrupted: true } : {}) });
  },
};

beforeEach(() => {
  resetHome();
  process.env.TETHER_DEV = "1";
  config().exhausted = {};
  handoffs = [];
  asked = [];
  // Verification reads what `/tether simulate-usage` set, as accountUsage() does, but never the
  // real account (Bun's homedir() ignores the scratch HOME, so the real login would be found).
  setUsageSource(async (a) => {
    asked.push(a);
    return simulatedFor(a);
  });
});
afterEach(() => {
  sessions.splice(0).forEach((s) => s.close());
  delete process.env.TETHER_DEV;
  simulateUsage("claude");
  simulateUsage("codex");
  setUsageSource();
  config().exhausted = {};
});

const settle = async (ms = 0) => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  if (ms) await Bun.sleep(ms);
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

function track<T extends LiveSession>(s: T, model: string, chain: string[]): T {
  s.t.state.status = "idle";
  s.t.state.model = model;
  s.t.state.chain = chain;
  sessions.push(s);
  return s;
}

const notices = (s: LiveSession) => s.t.messages.filter((m) => m.role === "notice").map((m) => (m.parts[0] as any).text as string);

describe("/tether commands", () => {
  test("parsing", () => {
    expect(parseDevCommand("/tether simulate-limit quota", false)).toBeUndefined(); // not in dev mode
    expect(parseDevCommand("fix the bug", true)).toBeUndefined();
    expect(parseDevCommand("/tether simulate-limit quota", true)).toEqual({ cmd: "limit", fault: { kind: "quota", afterTools: 0 } });
    expect(parseDevCommand("/tether simulate-limit rate after 3 tools reset 90m", true)).toEqual({ cmd: "limit", fault: { kind: "rate", afterTools: 3, resetMs: 90 * 60_000 } });
    expect(parseDevCommand("/tether simulate-limit other after 1 tool now", true)).toEqual({ cmd: "limit", fault: { kind: "other", afterTools: 1, now: true } });
    expect(parseDevCommand("/tether simulate-limit off", true)).toEqual({ cmd: "limit-off" });
    expect(parseDevCommand("/tether simulate-usage codex 100% reset 2h", true)).toEqual({ cmd: "usage", provider: "codex", percent: 100, resetMs: 2 * 36e5 });
    expect(parseDevCommand("/tether simulate-usage clear", true)).toEqual({ cmd: "usage-clear" });
    expect(parseDevCommand("/tether exhausted claude-code:sonnet 3m", true)).toEqual({ cmd: "exhausted", entry: "claude-code:sonnet", ms: 3 * 60_000 });
    expect(parseDevCommand("/tether exhausted clear", true)).toEqual({ cmd: "exhausted-clear" });
    for (const bad of ["/tether simulate-limit billing", "/tether simulate-limit quota after x", "/tether simulate-limit quota reset soon", "/tether simulate-usage gemini 50", "/tether simulate-usage claude 120", "/tether exhausted sonnet", "/tether exhausted sonnet 3m extra", "/tether nonsense"])
      expect(parseDevCommand(bad, true)?.cmd).toBe("error");
    expect(parseDuration("1h30m")).toBe(90 * 60_000);
    expect(parseDuration("45s")).toBe(45_000);
    expect(parseDuration("soon")).toBeUndefined();
  });

  test("a dev command is answered inline and never reaches the harness; outside dev mode it is a message", async () => {
    const sent: string[] = [];
    const s = track(claudeAdapter.create(process.env.HOME!, {}, sink), "opus", ["opus"]);
    (s as any).send = async (t: string) => void sent.push(t);
    await s.prompt("/tether simulate-limit quota after 2 tools");
    expect(sent).toEqual([]);
    expect(notices(s).at(-1)).toBe("Simulating a usage limit: the next turn ends with this harness's own error after 2 tool calls. It resets 1 h after it hits.");
    await s.prompt("/tether simulate-limit sideways");
    expect(notices(s).at(-1)).toStartWith('Unknown limit kind "sideways".');
    delete process.env.TETHER_DEV;
    await s.prompt("/tether simulate-limit quota");
    expect(sent).toEqual(["/tether simulate-limit quota"]);
  });

  test("exhausted sets and clears the runner's limit record, in memory and in runner.json", async () => {
    const s = track(claudeAdapter.create(process.env.HOME!, {}, sink), "opus", ["opus", "sonnet", "codex:gpt-5.5"]);
    const onDisk = () => JSON.parse(readFileSync(join(CONFIG_DIR, "runner.json"), "utf8")).exhausted;
    s.devCommand("/tether exhausted sonnet 3m");
    s.devCommand("/tether exhausted codex:gpt-5.5 1h");
    expect(notices(s)).toEqual(["Sonnet counts as at its usage limit for 3 min.", "GPT-5.5 in Codex counts as at its usage limit for 1 h."]);
    expect(Math.abs(config().exhausted["claude-code:sonnet"]! - (Date.now() + 3 * 60_000))).toBeLessThan(1_000);
    expect(Object.keys(onDisk()).sort()).toEqual(["claude-code:sonnet", "codex"]);
    s.devCommand("/tether exhausted clear");
    expect(config().exhausted).toEqual({});
    expect(onDisk()).toEqual({});
  });
});

describe("simulated usage", () => {
  test("stands in for the account's usage in the usage bar and in fallback's check, until cleared", async () => {
    const s = track(claudeAdapter.create(process.env.HOME!, {}, sink), "opus", ["opus"]);
    s.devCommand("/tether simulate-usage claude 100 reset 2h");
    s.devCommand("/tether simulate-usage codex 40");
    expect(notices(s)[0]).toBe("Simulated Claude usage: 100%, resetting in 2 h. It stands in for the real usage until cleared.");
    const report = await getUsage(true);
    expect(report.providers.map((p) => [p.label, p.windows[0]!.percent])).toEqual([
      ["Claude (simulated)", 100],
      ["Codex (simulated)", 40],
    ]);
    expect((await accountUsage("chatgpt:pi"))?.label).toBe("Codex (simulated)"); // both ChatGPT logins
    s.devCommand("/tether simulate-usage clear");
    expect(simulatedFor("chatgpt:codex")).toBeUndefined();
    expect(simulatedFor("claude")).toBeUndefined();
  });

  test("a full simulated window reads as the provider's limit", () => {
    expect(simulatedUsage("codex", 100).limited).toBe(true);
    expect(simulatedUsage("claude", 100).limited).toBeUndefined();
    expect(simulatedUsage("codex", 99).windows[0]!.percent).toBe(99);
  });
});

describe("each harness's own error shape, through its adapter", () => {
  test("Claude Code: a rejected rate_limit_event + error result is a definite limit; the next model takes over", async () => {
    const s = track(claudeAdapter.create(process.env.HOME!, {}, sink), "opus", ["opus", "sonnet"]);
    let interrupted = 0;
    (s as any).q = { interrupt: async () => void interrupted++, setModel: async () => {}, getContextUsage: async () => ({}) };
    s.devCommand("/tether simulate-limit quota reset 3h");
    (s as any).turnSeen = false;
    s.setState({ status: "running" });
    await settle();
    expect(interrupted).toBe(0); // waits for Claude Code to start the turn
    (s as any).onMessage({ type: "stream_event", event: { type: "message_start", message: { id: "m1", model: "claude-opus-5-5", usage: {} } } });
    expect(interrupted).toBe(1);
    // The interrupted turn's own result is replaced.
    (s as any).onMessage({ type: "result", subtype: "error_during_execution", is_error: true, total_cost_usd: 0 });
    await settle();
    expect(asked).toEqual([]); // the rejected event is definite and carries its reset
    const until = config().exhausted["claude-code:opus"]!;
    expect(Math.abs(until - (Date.now() + 3 * 36e5))).toBeLessThan(2_000);
    expect(s.t.state.model).toBe("sonnet");
    expect(notices(s).slice(-2)).toEqual([expect.stringMatching(/^Usage limit reached on Opus \(resets /), "Switched to Sonnet."]);
  });

  test("Claude Code: a simulated 429 backs off on the same model", async () => {
    const s = track(claudeAdapter.create(process.env.HOME!, {}, sink), "opus", ["opus", "sonnet"]);
    s.devCommand("/tether simulate-limit rate now");
    s.setState({ status: "running" });
    (s as any).onMessage({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0 });
    await settle();
    expect(s.t.state.status).toBe("waiting");
    expect(s.t.state.waitingReason).toBe("Rate limited on Opus");
    expect(config().exhausted).toEqual({});
  });

  test("Codex: usageLimitExceeded after n tool calls hands off, with the reset from Codex's rate limits", async () => {
    const s = track(codexAdapter.create(process.env.HOME!, { model: "gpt-5.5" }, sink), "gpt-5.5", ["codex:gpt-5.5", "claude-code:opus"]);
    const calls: string[] = [];
    (s as any).p = { call: async (m: string) => void calls.push(m), kill() {} };
    s.devCommand("/tether simulate-limit quota after 2 tools reset 2h");
    const n = (method: string, p: any) => (s as any).onNotify(method, { threadId: s.nativeId, ...p });
    n("turn/started", { turn: { id: "t1" } });
    await settle();
    const cmd = (id: string, status: string) => ({ item: { type: "commandExecution", id, command: "ls", cwd: "/", status, commandActions: [], aggregatedOutput: "" } });
    n("item/started", cmd("c1", "inProgress"));
    n("item/completed", cmd("c1", "completed"));
    await settle();
    expect(calls).toEqual([]); // one tool call so far
    n("item/started", cmd("c2", "inProgress"));
    n("item/completed", cmd("c2", "completed"));
    await settle();
    expect(calls).toEqual(["turn/interrupt"]);
    n("turn/completed", { turn: { id: "t1", status: "interrupted", items: [], error: null } });
    await settle();
    expect(asked).toEqual([]);
    expect(Math.abs(config().exhausted["codex"]! - (Date.now() + 2 * 36e5))).toBeLessThan(2_000);
    expect(handoffs).toEqual([{ to: { harness: "claude-code", model: "opus" }, reason: "GPT-5.5 hit its usage limit", interrupted: true }]);
  });

  test("Codex: a limit armed mid-turn fires in the queued turn that starts next, not one later", async () => {
    const s = track(codexAdapter.create(process.env.HOME!, { model: "gpt-5.5" }, sink), "gpt-5.5", ["codex:gpt-5.5", "claude-code:opus"]);
    const calls: string[] = [];
    let turns = 0;
    (s as any).p = { call: async (m: string) => (calls.push(m), m === "turn/start" ? { turn: { id: `t${++turns}` } } : {}), kill() {} };
    const n = (method: string, p: any) => (s as any).onNotify(method, { threadId: s.nativeId, ...p });
    await s.prompt("first");
    n("turn/started", { turn: { id: "t1" } });
    await s.prompt("second", "followUp");
    await s.prompt("/tether simulate-limit quota");
    expect(notices(s).at(-1)).toStartWith("Simulating a usage limit: the next turn ends");
    n("turn/completed", { turn: { id: "t1", status: "completed", items: [], error: null } });
    await settle(50);
    // The queued message started t2 without leaving "running": the limit stops it.
    expect(calls.filter((m) => m.startsWith("turn/"))).toEqual(["turn/start", "turn/start", "turn/interrupt"]);
    n("turn/started", { turn: { id: "t2" } });
    n("turn/completed", { turn: { id: "t2", status: "interrupted", items: [], error: null } });
    await settle();
    expect(config().exhausted["codex"]).toBeGreaterThan(Date.now());
    expect(handoffs.map((h) => h.to)).toEqual([{ harness: "claude-code", model: "opus" }]);
  });

  test("pi: a limit armed during a provider retry waits for the next turn", async () => {
    const s = track(piAdapter.create(process.env.HOME!, {}, sink), "anthropic/claude-opus-4-5", ["pi:anthropic/claude-opus-4-5", "claude-code:opus"]);
    const calls: string[] = [];
    (s as any).rpc = { call: async (m: string) => (calls.push(m), {}), write() {}, close() {} };
    (s as any).onRecord({ type: "agent_start" });
    (s as any).onRecord({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1000, errorMessage: "overloaded" });
    expect(s.t.state.status).toBe("waiting");
    s.devCommand("/tether simulate-limit quota");
    (s as any).onRecord({ type: "auto_retry_end", success: true, attempt: 1 });
    await settle();
    expect(s.t.state.status).toBe("running");
    expect(calls).toEqual([]);
    (s as any).onRecord({ type: "agent_settled" });
    await settle();
    expect(handoffs).toEqual([]);
    (s as any).onRecord({ type: "agent_start" });
    await settle();
    expect(calls).toEqual(["abort"]);
  });

  test("`now` typed while nothing runs says it waits for the next turn", () => {
    const s = track(claudeAdapter.create(process.env.HOME!, {}, sink), "opus", ["opus", "sonnet"]);
    s.devCommand("/tether simulate-limit rate now");
    expect(notices(s).at(-1)).toStartWith("Simulating a rate limit (429): the next turn ends");
  });

  test("pi on the ChatGPT login: its text-only limit is confirmed by the (simulated) usage of pi's login", async () => {
    const s = track(piAdapter.create(process.env.HOME!, {}, sink), "openai-codex/gpt-5.5", ["pi:openai-codex/gpt-5.5", "claude-code:opus"]);
    const calls: string[] = [];
    (s as any).rpc = { call: async (m: string) => (calls.push(m), {}), write() {}, close() {} };
    s.devCommand("/tether simulate-limit quota");
    s.devCommand("/tether simulate-usage codex 100");
    (s as any).onRecord({ type: "agent_start" });
    await settle();
    expect(calls).toEqual(["abort"]);
    (s as any).onRecord({ type: "agent_settled" });
    await settle();
    expect(asked).toEqual(["chatgpt:pi"]);
    expect(config().exhausted["openai-codex"]).toBeGreaterThan(Date.now());
    expect(handoffs.map((h) => h.to)).toEqual([{ harness: "claude-code", model: "opus" }]);
  });

  test("pi: the same text with the usage below its limit doesn't switch (it reads as a retry: backs off)", async () => {
    const s = track(piAdapter.create(process.env.HOME!, {}, sink), "openai-codex/gpt-5.5", ["pi:openai-codex/gpt-5.5", "claude-code:opus"]);
    (s as any).rpc = { call: async () => ({}), write() {}, close() {} };
    s.devCommand("/tether simulate-limit quota");
    s.devCommand("/tether simulate-usage codex 60");
    (s as any).onRecord({ type: "agent_start" });
    (s as any).onRecord({ type: "agent_settled" });
    await settle();
    expect(config().exhausted).toEqual({});
    expect(handoffs).toEqual([]);
    expect(s.t.state.status).toBe("waiting");
    expect(s.t.state.waitingReason).toBe("Rate limited on GPT-5.5");
  });

  test("Antigravity: its quota message is a definite limit with the reset it names", async () => {
    const s = track(antigravityAdapter.create(process.env.HOME!, {}, sink), "default", ["antigravity:default", "claude-code:opus"]);
    s.devCommand("/tether simulate-limit quota reset 5h");
    s.setState({ status: "running" });
    await settle(250);
    expect(Math.abs(config().exhausted["antigravity:default"]! - (Date.now() + 5 * 36e5))).toBeLessThan(5_000);
    expect(handoffs.map((h) => h.to)).toEqual([{ harness: "claude-code", model: "opus" }]);
  });

  test("ACP (Kiro): the prompt's JSON-RPC error can't be verified, so it only offers Continue on", async () => {
    const s = track(kiroAdapter.create(process.env.HOME!, {}, sink), "auto", ["kiro:auto", "claude-code:opus"]);
    const cancels: string[] = [];
    (s as any).p = { conn: { prompt: async () => ({ stopReason: "cancelled" }), cancel: async (p: any) => void cancels.push(p.sessionId) }, caps: {}, kill() {} };
    s.devCommand("/tether simulate-limit quota");
    await (s as any).runTurn("hello");
    await settle();
    expect(cancels).toEqual([s.nativeId]);
    expect(config().exhausted).toEqual({});
    expect(handoffs).toEqual([]);
    const last = s.t.messages.at(-1)!;
    expect((last.parts[0] as any).text).toStartWith("Internal error: You have reached your usage limit.");
    expect(last.action?.label).toBe("Continue on Opus in Claude Code");
  });

  test("a Stop while the simulated error is firing ends the turn as a stop", async () => {
    const s = track(claudeAdapter.create(process.env.HOME!, {}, sink), "opus", ["opus", "sonnet"]);
    (s as any).q = { interrupt: async () => {} };
    s.devCommand("/tether simulate-limit quota now");
    s.setState({ status: "running" });
    await s.stop();
    (s as any).onMessage({ type: "result", subtype: "error_during_execution", is_error: true, total_cost_usd: 0 });
    await settle();
    expect(config().exhausted).toEqual({});
    expect(s.t.state.model).toBe("opus");
  });
});

describe("the shapes classify as the real errors do", () => {
  const f = { kind: "quota" as const, afterTools: 0, resetMs: 3_600_000 };
  test("text-only shapes", () => {
    const pi = piFault(f, "openai-codex/gpt-5.5").message.errorMessage;
    expect(pi).toBe("You have hit your ChatGPT usage limit (plus plan). Try again in ~60 min.");
    expect(classify(pi).kind).toBe("quota");
    expect(classify(piFault({ ...f, kind: "rate" }, "openai/gpt-5").message.errorMessage).kind).toBe("quota"); // "Rate limit reached": verified, then backs off
    expect(classify(acpFault({ ...f, kind: "rate" }).data.message).kind).toBe("rate_limit");
    expect(classify(acpFault({ ...f, kind: "other" }).data.message).kind).toBe("other");
    expect(agyFault(f)[1].result.error).toMatch(/^RESOURCE_EXHAUSTED \(code 429\): Individual quota reached\. .* Resets in 1h0m0s\.$/);
  });
  test("structured shapes", () => {
    const c = claudeFault(f, "s");
    expect(c.map((m) => m.type)).toEqual(["rate_limit_event", "assistant", "result"]);
    expect(c[0].rate_limit_info.status).toBe("rejected");
    expect(claudeFault({ ...f, kind: "rate" }, "s").map((m) => m.type)).toEqual(["assistant", "result"]);
    const x = codexFault(f, "th", { id: "t" });
    expect(x.map(([m]) => m)).toEqual(["account/rateLimits/updated", "error", "turn/completed"]);
    expect(x[2]![1].turn.error.codexErrorInfo).toBe("usageLimitExceeded");
    expect(codexFault({ ...f, kind: "rate" }, "th", { id: "t" })[0]![1].error.codexErrorInfo).toEqual({ responseTooManyFailedAttempts: { httpStatusCode: 429 } });
  });
});
