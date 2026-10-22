// The session side of fallback (session.ts): handleTurnError (strict: only definite limits move a
// session), "Continue on …", preferBest, waitThenContinue and setChain, on a fake harness. Usage
// checks go to a fake source, never a real account.

import { resetHome } from "./testenv";
import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import type { ChainEntry, HarnessId, ProviderUsage } from "../../web/src/shared/protocol";
import { config, prefs } from "./config";
import { setUsageSource, type Classified } from "./fallback";
import { LiveSession, type HandoffOpts } from "./session";
import { classifyCodexError } from "./adapters/codex";
import type { UsageAccount } from "./usage";

/** What the fake usage source answers per account, and which accounts were asked. */
let usage: Partial<Record<UsageAccount, ProviderUsage>> = {};
let asked: UsageAccount[] = [];
const full = (provider: "claude" | "codex", resetsAt?: number, label = "5h"): ProviderUsage => ({ provider, label: provider, windows: [{ label, percent: 100, resetsAt }] });
const half = (provider: "claude" | "codex"): ProviderUsage => ({ provider, label: provider, windows: [{ label: "5h", percent: 50 }] });

const sessions: LiveSession[] = [];

beforeEach(() => {
  resetHome();
  config().exhausted = {};
  usage = {};
  asked = [];
  setUsageSource(async (a) => {
    asked.push(a);
    return usage[a];
  });
});
afterEach(() => {
  sessions.splice(0).forEach((s) => s.close());
  jest.useRealTimers();
  config().exhausted = {};
  setUsageSource();
});

/** Lets promise callbacks (a timer's async body) run without moving the clock. */
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

function fake(harness: HarnessId = "claude-code", model = "opus", nativeId = crypto.randomUUID()) {
  const log: string[] = [];
  const continued: (string | undefined)[] = [];
  const handoffs: { to: ChainEntry; reason: string; prompt?: string; interrupted?: boolean }[] = [];
  const sink = {
    emit: () => {},
    summary: () => {},
    handoff: async (_from: LiveSession, to: ChainEntry, reason: string, prompt?: string, opts?: HandoffOpts) => {
      handoffs.push({ to, reason, prompt, ...(opts?.interrupted ? { interrupted: true } : {}) });
    },
  };
  class Fake extends LiveSession {
    async start() {}
    protected async send(text: string) {
      if (await this.preferBest(text)) return;
      log.push(`turn: ${text}`);
    }
    async abort() {
      this.cancelWait();
    }
    async applyModel(m: string) {
      log.push(`model: ${m}`);
      this.setState({ model: m });
    }
    async setThinking() {}
    async setPermissionMode() {}
    async rename() {}
    async listCommands() {
      return [];
    }
    async continueTurn(text?: string) {
      log.push("continue");
      continued.push(text);
    }
    protected shutdown() {}
    turnError(text: string | undefined, status?: number | null, hint?: Classified) {
      return this.handleTurnError(text, status, hint);
    }
    best(prompt: string) {
      return this.preferBest(prompt);
    }
    succeeded() {
      this.turnSucceeded();
    }
  }
  // No .git: checkpoints are skipped.
  const s = new Fake(harness, { nativeId, projectPath: process.env.HOME! }, sink);
  s.t.state.status = "idle";
  s.t.state.model = model;
  sessions.push(s);
  const notices = () => s.t.messages.filter((m) => m.role === "notice").map((m) => (m.parts[0] as any).text as string);
  const actions = () => s.t.messages.flatMap((m) => (m.action?.kind === "continueOn" ? [{ id: m.id, ...m.action }] : []));
  return { s, log, continued, handoffs, notices, actions };
}

describe("handleTurnError", () => {
  test("without a chain, an unconfirmed limit or unrelated error is reported by the adapter", async () => {
    const { s, log } = fake();
    expect(await s.turnError("usage limit reached", 429)).toBe(false);
    s.t.state.chain = ["opus", "sonnet"];
    expect(await s.turnError("ENOENT: no such file")).toBe(false);
    expect(log).toEqual([]);
    expect(config().exhausted).toEqual({});
    expect(asked).toEqual(["claude"]); // possible limits are checked even without a model chain
  });

  test("without a chain, a confirmed quota waits and sends a continuation prompt at reset", async () => {
    jest.useFakeTimers();
    const { s, log, notices, continued } = fake();
    const reset = Date.now() + 5 * 60_000;
    usage.claude = full("claude", reset);

    expect(await s.turnError("usage limit reached", 429)).toBe(true);
    expect(s.t.state.status).toBe("waiting");
    expect(s.t.state.waitingUntil).toBe(reset);
    expect(config().exhausted["claude-code:opus"]).toBe(reset);

    jest.advanceTimersByTime(5 * 60_000);
    await settle();

    expect(log).toEqual(["continue"]);
    expect(continued).toEqual(["The usage limit has reset. Continue the task where you stopped."]);
    expect(notices()).toContain("Usage limit reset. Continuing on Opus.");
    expect(s.t.state.waitingUntil).toBeUndefined();
  });

  test("without a chain, a past reset uses the one-hour cooldown", async () => {
    jest.useFakeTimers();
    const { s } = fake();
    usage.claude = full("claude", Date.now() - 5_000);

    expect(await s.turnError("usage limit reached", 429)).toBe(true);
    expect(config().exhausted["claude-code:opus"]).toBe(Date.now() + 60 * 60_000);
    expect(s.t.state.waitingUntil).toBe(Date.now() + 60 * 60_000);
  });

  test("a user message or Stop during a no-chain wait cancels the automatic continuation", async () => {
    jest.useFakeTimers();
    const first = fake();
    usage.claude = full("claude", Date.now() + 5 * 60_000);
    await first.s.turnError("usage limit reached", 429);
    await first.s.prompt("try a different approach");
    expect(first.s.t.state.status).toBe("idle");
    expect(first.log).toEqual(["turn: try a different approach"]);

    usage.claude = full("claude", Date.now() + 5 * 60_000);
    const second = fake();
    await second.s.turnError("usage limit reached", 429);
    await second.s.stop();
    expect(second.s.t.state.waitingUntil).toBeUndefined();
    jest.advanceTimersByTime(5 * 60_000);
    await settle();
    expect(first.continued).toEqual([]);
    expect(second.continued).toEqual([]);
  });

  test("a no-chain usage-limit wait is restored after a runner restart", async () => {
    jest.useFakeTimers();
    const nativeId = crypto.randomUUID();
    const first = fake("claude-code", "opus", nativeId);
    first.s.loadPrefs();
    usage.claude = full("claude", Date.now() + 5 * 60_000);
    await first.s.turnError("usage limit reached", 429);
    const saved = { ...prefs(first.s.id) };
    expect(saved).toMatchObject({ waitingUsageLimitResume: true, usageLimitResumeAttempts: 1 });

    await first.s.abort();
    const resumed = fake("claude-code", "opus", nativeId);
    resumed.s.loadPrefs();
    resumed.s.resumeWait(saved.waitingUntil!, saved.waitingReason!, undefined, saved.waitingUsageLimitResume);
    jest.advanceTimersByTime(saved.waitingUntil! - Date.now());
    await settle();

    expect(resumed.continued).toEqual(["The usage limit has reset. Continue the task where you stopped."]);
    expect(resumed.notices()).toContain("Usage limit reset. Continuing on Opus.");
  });

  test("a structured limit signal: the provider is marked exhausted and the next model of the same harness takes over", async () => {
    const { s, log, notices, handoffs } = fake();
    await s.setChain(["opus", "sonnet"]);
    const reset = Date.now() + 3 * 60 * 60_000;
    expect(await s.turnError("You've hit your usage limit", null, { kind: "quota", resetAt: reset, definite: true })).toBe(true);
    expect(config().exhausted["claude-code:opus"]).toBe(reset);
    expect(asked).toEqual([]); // the reset came with the signal: no usage fetch
    expect(log).toEqual(["model: sonnet", "continue"]);
    expect(notices()[0]).toStartWith("Usage limit reached on Opus (resets ");
    expect(notices()[1]).toBe("Switched to Sonnet.");
    expect(handoffs).toEqual([]);
  });

  test("a structured signal without a reset: the account's usage supplies it, else an hour's cooldown", async () => {
    const { s } = fake();
    await s.setChain(["opus", "sonnet"]);
    const reset = Date.now() + 2 * 60 * 60_000;
    usage.claude = full("claude", reset);
    await s.turnError("", null, { kind: "quota", definite: true });
    expect(config().exhausted["claude-code:opus"]).toBe(reset);
    config().exhausted = {};
    usage = {};
    s.t.state.model = "opus";
    const before = Date.now();
    await s.turnError("", null, { kind: "quota", definite: true });
    const until = config().exhausted["claude-code:opus"]!;
    expect(until - before).toBeGreaterThanOrEqual(60 * 60_000);
    expect(until - Date.now()).toBeLessThanOrEqual(60 * 60_000);
  });

  test("limit-looking text switches only when a fresh usage fetch for the account confirms it", async () => {
    const { s, log, handoffs } = fake();
    await s.setChain(["opus", "codex:gpt-5.5"]);
    const reset = Date.now() + 90 * 60_000;
    usage.claude = full("claude", reset);
    expect(await s.turnError("Claude AI usage limit reached")).toBe(true);
    expect(asked).toEqual(["claude"]);
    expect(config().exhausted["claude-code:opus"]).toBe(reset);
    expect(handoffs).toEqual([{ to: { harness: "codex", model: "gpt-5.5" }, reason: "Opus hit its usage limit", prompt: undefined, interrupted: true }]);
    expect(log).toEqual([]); // the new session continues, not this one
  });

  test("limit-looking text the usage doesn't confirm: no switch, the error gets a Continue button", async () => {
    const { s, log, handoffs, actions } = fake();
    await s.setChain(["opus", "codex:gpt-5.5"]);
    usage.claude = half("claude");
    expect(await s.turnError("Your credit balance is too low; billing")).toBe(false);
    expect(config().exhausted).toEqual({});
    expect(handoffs).toEqual([]);
    expect(log).toEqual([]);
    // The adapter shows its error notice: it carries the action.
    s.notice("Your credit balance is too low; billing", "error");
    expect(actions()).toEqual([expect.objectContaining({ kind: "continueOn", label: "Continue on GPT-5.5 in Codex", entry: "codex:gpt-5.5" })]);
  });

  test("a usage fetch that fails confirms nothing", async () => {
    const { s, handoffs } = fake();
    await s.setChain(["opus", "sonnet"]);
    usage.claude = { ...full("claude"), error: "timed out" };
    expect(await s.turnError("usage limit reached")).toBe(false);
    expect(config().exhausted).toEqual({});
    expect(handoffs).toEqual([]);
  });

  test("a model-scoped window only confirms a limit for that model", async () => {
    const { s } = fake("claude-code", "sonnet");
    await s.setChain(["sonnet", "opus"]);
    usage.claude = full("claude", Date.now() + 60_000, "Weekly · Opus");
    expect(await s.turnError("weekly limit reached")).toBe(false);
    usage.claude = full("claude", Date.now() + 60_000, "Weekly · Sonnet");
    expect(await s.turnError("weekly limit reached")).toBe(true);
  });

  test("pi on the ChatGPT login is checked on pi's own login; pi on Anthropic and opencode never switch on their own", async () => {
    const a = fake("pi", "openai-codex/gpt-5.5");
    await a.s.setChain(["pi:openai-codex/gpt-5.5", "claude-code:opus"]);
    usage["chatgpt:pi"] = { provider: "codex", label: "Codex", windows: [], limited: true };
    expect(await a.s.turnError("You have hit your ChatGPT usage limit (plus plan).")).toBe(true);
    expect(asked).toEqual(["chatgpt:pi"]);
    expect(a.handoffs.map((h) => h.to)).toEqual([{ harness: "claude-code", model: "opus" }]);

    asked = [];
    usage.claude = full("claude");
    const b = fake("pi", "anthropic/claude-opus-5-5");
    await b.s.setChain(["pi:anthropic/claude-opus-5-5", "codex:gpt-5.5"]);
    expect(await b.s.turnError("usage limit reached. resets in 2h")).toBe(false);
    const c = fake("opencode", "anthropic/claude-sonnet-5");
    await c.s.setChain(["opencode:anthropic/claude-sonnet-5", "codex:gpt-5.5"]);
    expect(await c.s.turnError("quota exceeded")).toBe(false);
    expect(asked).toEqual([]); // nothing to check
    expect(config().exhausted).toEqual({ "openai-codex": expect.any(Number) });
  });

  test("codex models share one quota key", async () => {
    const { s, handoffs } = fake("codex", "gpt-5.5");
    await s.setChain(["codex:gpt-5.5", "codex:gpt-5.5-mini", "claude-code:opus"]);
    await s.turnError("", null, { kind: "quota", definite: true });
    expect(Object.keys(config().exhausted)).toEqual(["codex"]);
    expect(handoffs.map((h) => h.to)).toEqual([{ harness: "claude-code", model: "opus" }]);
  });

  test("Codex's usageLimitExceeded switches only for a model on the ChatGPT login", async () => {
    const reset = Date.now() + 60 * 60_000;
    const err = { message: "Quota exceeded. Check your plan and billing details.", codexErrorInfo: "usageLimitExceeded" };
    expect(classifyCodexError(err, "gpt-5.5", () => reset).hint).toEqual({ kind: "quota", resetAt: reset, definite: true });
    expect(classifyCodexError(err, "openai/gpt-5.5", () => reset).hint?.definite).toBe(true);
    // Routed to another provider: its insufficient_quota maps to the same signal, but nothing moves.
    const { s, handoffs, actions } = fake("codex", "openrouter/deepseek-v4");
    await s.setChain(["codex:openrouter/deepseek-v4", "claude-code:opus"]);
    const { status, hint } = classifyCodexError(err, "openrouter/deepseek-v4", () => reset);
    expect(hint).toEqual({ kind: "quota" });
    expect(await s.turnError(err.message, status, hint)).toBe(false);
    expect(config().exhausted).toEqual({});
    expect(handoffs).toEqual([]);
    expect(asked).toEqual([]);
    s.notice(err.message, "error");
    expect(actions()).toEqual([expect.objectContaining({ entry: "claude-code:opus" })]);
  });

  test("the adapter's hint wins over the text", async () => {
    const { s, log } = fake();
    await s.setChain(["opus", "sonnet"]);
    expect(await s.turnError("something went wrong", null, { kind: "quota", definite: true })).toBe(true);
    expect(log).toEqual(["model: sonnet", "continue"]);
    log.length = 0;
    // A rate-limit hint backs off even when the text reads like a quota.
    expect(await s.turnError("usage limit reached", null, { kind: "rate_limit" })).toBe(true);
    expect(s.t.state.status).toBe("waiting");
    expect(asked).toEqual(["claude"]); // only for the first signal's missing reset
  });

  test("a 429 stays on the model and backs off, longer each time, until a turn succeeds", async () => {
    jest.useFakeTimers();
    const { s, log } = fake();
    await s.setChain(["opus", "sonnet"]);
    expect(await s.turnError("Too many requests", 429)).toBe(true);
    expect(config().exhausted).toEqual({}); // a rate limit never marks anything exhausted
    expect(s.t.state.status).toBe("waiting");
    expect(s.t.state.waitingReason).toBe("Rate limited on Opus");
    expect(s.t.state.waitingUntil! - Date.now()).toBe(15_000);
    jest.advanceTimersByTime(14_999);
    await settle();
    expect(log).toEqual([]);
    jest.advanceTimersByTime(1);
    await settle();
    expect(log).toEqual(["continue"]);
    expect(s.t.state.waitingReason).toBeUndefined();
    expect(s.t.state.waitingUntil).toBeUndefined();
    // Second in a row: twice as long.
    s.t.state.status = "running";
    await s.turnError("overloaded");
    expect(s.t.state.waitingUntil! - Date.now()).toBe(30_000);
    // A good turn resets the backoff.
    s.succeeded();
    s.t.state.status = "running";
    await s.turnError("overloaded");
    expect(s.t.state.waitingUntil! - Date.now()).toBe(15_000);
  });

  test("a per-minute 429 whose wording looks like a limit backs off when the usage doesn't confirm it", async () => {
    const cases: [HarnessId, string, string, number | null][] = [
      ["pi", "openai/gpt-5", "429 Rate limit reached for gpt-5 in organization org-x on tokens per min (TPM). Please try again in 1.2s.", 429],
      ["opencode", "google/gemini-3-pro", "RESOURCE_EXHAUSTED: Quota exceeded for metric generate_content_requests per minute", 429],
      ["codex", "gpt-5.5", "Rate limit reached for gpt-5.5. Please try again in 20s.", null],
    ];
    usage["chatgpt:codex"] = half("codex"); // the codex case is checked, and not at a limit
    for (const [harness, model, text, status] of cases) {
      const { s, log } = fake(harness, model);
      await s.setChain([`${harness}:${model}`, "claude-code:opus"]);
      log.length = 0;
      expect(await s.turnError(text, status)).toBe(true);
      expect(s.t.state.status).toBe("waiting");
      expect(s.t.state.waitingReason).toStartWith("Rate limited on ");
      expect(s.t.state.waitingUntil! - Date.now()).toBeGreaterThanOrEqual(4_900);
      expect(log).toEqual([]);
      expect(config().exhausted).toEqual({});
    }
  });

  test("a billing error sent as a 429 isn't retried: it gets the Continue button", async () => {
    const { s, actions } = fake("pi", "openai/gpt-5");
    await s.setChain(["pi:openai/gpt-5", "claude-code:opus"]);
    s.t.state.status = "running";
    expect(await s.turnError("You exceeded your current quota, please check your plan and billing details. (insufficient_quota)", 429)).toBe(false);
    s.notice("insufficient_quota", "error");
    expect(s.t.state.waitingUntil).toBeUndefined();
    expect(actions()).toHaveLength(1);
  });

  test("Stop while the usage check runs: the limit is recorded but the session doesn't move on", async () => {
    const { s, log, handoffs, actions } = fake();
    await s.setChain(["opus", "sonnet", "codex:gpt-5.5"]);
    log.length = 0;
    s.t.state.status = "running";
    let answer!: (u: ProviderUsage) => void;
    setUsageSource(() => new Promise((r) => (answer = r)));
    const reset = Date.now() + 60 * 60_000;
    const pending = s.turnError("You have hit your usage limit, resets at 5pm");
    await settle();
    await s.stop();
    answer(full("claude", reset));
    expect(await pending).toBe(false);
    expect(config().exhausted["claude-code:opus"]).toBe(reset);
    expect(log).toEqual([]);
    expect(handoffs).toEqual([]);
    s.notice("You've hit your limit", "error");
    expect(actions()).toEqual([]);
  });

  test("a 429 on an entry Tether can't check still backs off on the same model", async () => {
    jest.useFakeTimers();
    const { s, handoffs } = fake("kiro", "auto");
    await s.setChain(["kiro:auto", "codex:gpt-5.5"]);
    expect(await s.turnError("429 Too Many Requests", 429)).toBe(true);
    expect(s.t.state.status).toBe("waiting");
    expect(handoffs).toEqual([]);
  });

  test("an entry Tether can't check: after 3 failed backoffs the error shows with Continue, never a switch", async () => {
    jest.useFakeTimers();
    const { s, handoffs, actions, log } = fake("pi", "anthropic/claude-opus-5-5");
    await s.setChain(["pi:anthropic/claude-opus-5-5", "codex:gpt-5.5"]);
    const text = '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}';
    for (let i = 0; i < 3; i++) {
      s.t.state.status = "running";
      expect(await s.turnError(text, 429)).toBe(true);
      expect(s.t.state.status as string).toBe("waiting");
      jest.advanceTimersByTime(s.t.state.waitingUntil! - Date.now());
      await settle();
    }
    expect(log.filter((l) => l === "continue")).toHaveLength(3);
    s.t.state.status = "running";
    expect(await s.turnError(text, 429)).toBe(false);
    s.notice(text, "error");
    expect(actions()).toEqual([expect.objectContaining({ label: "Continue on GPT-5.5 in Codex", entry: "codex:gpt-5.5" })]);
    expect(handoffs).toEqual([]);
    expect(config().exhausted).toEqual({});
    expect(asked).toEqual([]); // nothing to check on pi's Anthropic key
    // Your own message starts over: it backs off again.
    s.t.state.status = "idle";
    await s.prompt("go on");
    s.t.state.status = "running";
    expect(await s.turnError(text, 429)).toBe(true);
  });

  test("pi's ChatGPT limit text that reads like a rate limit: checked on pi's login, switches when it's at the limit", async () => {
    const { s, handoffs } = fake("pi", "openai-codex/gpt-5.5");
    await s.setChain(["pi:openai-codex/gpt-5.5", "claude-code:opus"]);
    const text = "You have hit your ChatGPT usage limit (plus plan). Try again in ~42 min.";
    usage["chatgpt:pi"] = half("codex");
    expect(await s.turnError(text)).toBe(true);
    expect(s.t.state.status).toBe("waiting"); // not at the limit: a backoff
    expect(handoffs).toEqual([]);
    usage["chatgpt:pi"] = { provider: "codex", label: "Codex", windows: [], limited: true };
    s.t.state.status = "running";
    expect(await s.turnError(text)).toBe(true);
    expect(handoffs.map((h) => h.to)).toEqual([{ harness: "claude-code", model: "opus" }]);
    expect(asked).toEqual(["chatgpt:pi", "chatgpt:pi"]);
  });

  test("an entry whose usage check fails (expired login): after 3 failed backoffs the error shows with Continue", async () => {
    jest.useFakeTimers();
    const { s, handoffs, actions, log } = fake("pi", "openai-codex/gpt-5.5");
    await s.setChain(["pi:openai-codex/gpt-5.5", "claude-code:opus"]);
    const text = "You have hit your ChatGPT usage limit (plus plan). Try again in ~42 min.";
    setUsageSource(async (a) => {
      asked.push(a);
      return { provider: "codex", label: "Codex", windows: [], error: "401" };
    });
    for (let i = 0; i < 3; i++) {
      s.t.state.status = "running";
      expect(await s.turnError(text)).toBe(true);
      expect(s.t.state.status as string).toBe("waiting");
      jest.advanceTimersByTime(s.t.state.waitingUntil! - Date.now());
      await settle();
    }
    expect(log.filter((l) => l === "continue")).toHaveLength(3);
    s.t.state.status = "running";
    expect(await s.turnError(text)).toBe(false);
    s.notice(text, "error");
    expect(actions()).toEqual([expect.objectContaining({ entry: "claude-code:opus" })]);
    expect(handoffs).toEqual([]);
    expect(config().exhausted).toEqual({});
    expect(asked).toHaveLength(4);
  });

  test("the usage check shows inline while it runs", async () => {
    const { s } = fake();
    await s.setChain(["opus", "sonnet"]);
    let answer!: (u: ProviderUsage | undefined) => void;
    setUsageSource(() => new Promise((r) => (answer = r)));
    const pending = s.turnError("Claude AI usage limit reached");
    await settle();
    expect(s.t.state.checking).toBe("Checking usage on Opus…");
    answer(undefined);
    await pending;
    expect(s.t.state.checking).toBeNull();
  });

  test("a rate limit that says when to retry waits that long (at least 5 s)", async () => {
    jest.useFakeTimers();
    const { s } = fake();
    await s.setChain(["opus"]);
    await s.turnError("Rate limited. Try again in 2 minutes");
    expect(s.t.state.waitingUntil! - Date.now()).toBe(120_000);
    await s.turnError("rate limit", null, { kind: "rate_limit", resetAt: Date.now() + 1000 });
    expect(s.t.state.waitingUntil! - Date.now()).toBe(5_000);
  });

  test("rate limited on the only available model: waits on it rather than moving to an exhausted one", async () => {
    jest.useFakeTimers();
    const { s, log } = fake("claude-code", "haiku");
    config().exhausted["claude-code:sonnet"] = Date.now() + 10 * 60_000;
    await s.setChain(["sonnet", "opus"]);
    expect(log).toEqual(["model: opus"]); // setChain skipped the exhausted entry
    expect(await s.turnError("", 429, { kind: "rate_limit" })).toBe(true);
    expect(s.t.state.waitingReason).toBe("Rate limited on Opus");
  });

  test("everything exhausted: waits for the earliest reset, then continues on that model", async () => {
    jest.useFakeTimers();
    const { s, log, handoffs } = fake();
    await s.setChain(["opus", "sonnet"]);
    config().exhausted["claude-code:sonnet"] = Date.now() + 20 * 60_000;
    log.length = 0;
    const reset = Date.now() + 60 * 60_000;
    expect(await s.turnError("", null, { kind: "quota", resetAt: reset, definite: true })).toBe(true);
    expect(s.t.state.status).toBe("waiting");
    expect(s.t.state.waitingReason).toBe("Every model in this session's chain is at its usage limit");
    expect(s.t.state.waitingUntil).toBe(Date.now() + 20 * 60_000);
    jest.advanceTimersByTime(20 * 60_000);
    await settle();
    expect(log).toEqual(["model: sonnet", "continue"]);
    expect(handoffs).toEqual([]);
    expect(s.t.state.waitingUntil).toBeUndefined();
  });

  test("everything exhausted: the entry that resets first in another harness gets a handoff", async () => {
    jest.useFakeTimers();
    const { s, log, handoffs } = fake();
    await s.setChain(["opus", "codex:gpt-5.5"]);
    config().exhausted["codex"] = Date.now() + 5 * 60_000;
    log.length = 0;
    await s.turnError("", null, { kind: "quota", resetAt: Date.now() + 60 * 60_000, definite: true });
    jest.advanceTimersByTime(5 * 60_000);
    await settle();
    expect(handoffs).toEqual([{ to: { harness: "codex", model: "gpt-5.5" }, reason: "GPT-5.5 has reset", prompt: undefined, interrupted: true }]);
    expect(log).toEqual([]);
    expect(s.t.state.waitingUntil).toBeUndefined();
  });

  test("a wait whose models are still exhausted when it fires waits again", async () => {
    jest.useFakeTimers();
    const { s, log } = fake();
    await s.setChain(["opus"]);
    await s.turnError("Rate limited", 429);
    config().exhausted["claude-code:opus"] = Date.now() + 15_000 + 60_000; // marked meanwhile
    jest.advanceTimersByTime(15_000);
    await settle();
    expect(log).toEqual([]);
    expect(s.t.state.status).toBe("waiting");
    expect(s.t.state.waitingUntil).toBe(config().exhausted["claude-code:opus"]);
    jest.advanceTimersByTime(60_000);
    await settle();
    expect(log).toEqual(["continue"]);
  });

  test("stopping during a wait cancels it; a wait no longer waiting does nothing", async () => {
    jest.useFakeTimers();
    const { s, log } = fake();
    await s.setChain(["opus"]);
    await s.turnError("429", 429);
    await s.abort();
    expect(s.t.state.status).toBe("idle");
    expect(s.t.state.waitingUntil).toBeUndefined();
    jest.advanceTimersByTime(60_000);
    await settle();
    expect(log).toEqual([]);
    // The status moved on some other way (a new turn): the timer leaves it alone.
    await s.turnError("429", 429);
    s.setState({ status: "running" });
    jest.advanceTimersByTime(5 * 60_000);
    await settle();
    expect(log).toEqual([]);
  });

  test("a closed session never continues", async () => {
    jest.useFakeTimers();
    const { s, log } = fake();
    await s.setChain(["opus"]);
    await s.turnError("429", 429);
    s.close();
    jest.advanceTimersByTime(5 * 60_000);
    await settle();
    expect(log).toEqual([]);
  });
});

describe("Continue on …", () => {
  test("an unverifiable entry's error: the button switches the model here and continues", async () => {
    const { s, log, notices, actions } = fake("pi", "anthropic/claude-opus-5-5");
    await s.setChain(["pi:anthropic/claude-opus-5-5", "pi:openai-codex/gpt-5.5"]);
    log.length = 0;
    s.t.state.status = "running";
    expect(await s.turnError("You're out of extra usage. Resets in 3h")).toBe(false);
    s.notice("You're out of extra usage. Resets in 3h", "error");
    s.setState({ status: "idle" });
    const [a] = actions();
    expect(a).toMatchObject({ label: "Continue on GPT-5.5", entry: "pi:openai-codex/gpt-5.5" });
    const before = Date.now();
    await s.continueOn(a!.id);
    expect(log).toEqual(["model: openai-codex/gpt-5.5", "continue"]);
    expect(notices()).toContain("Switched to GPT-5.5.");
    expect(actions()).toEqual([]); // used up
    await expect(s.continueOn(a!.id)).rejects.toThrow();
    // Nothing confirmed a limit, so nothing global is marked: other sessions keep using it.
    expect(config().exhausted).toEqual({});
    // But this session's next message doesn't go straight back (its reset from the text)...
    log.length = 0;
    expect(await s.best("next")).toBe(false);
    expect(log).toEqual([]);
    // ...until then, and coming back doesn't claim a limit reset.
    jest.useFakeTimers({ now: before + 3 * 60 * 60_000 + 60_000 });
    expect(await s.best("later")).toBe(false);
    expect(log).toEqual(["model: anthropic/claude-opus-5-5"]);
    expect(notices().at(-1)).toMatch(/^Back on .*\.$/);
    expect(notices().at(-1)).not.toContain("reset");
  });

  test("a manual move off an entry affects only that session", async () => {
    const a = fake();
    const b = fake();
    await a.s.setChain(["opus", "sonnet"]);
    await b.s.setChain(["opus", "sonnet"]);
    a.s.t.state.status = "running";
    await a.s.turnError("prompt is too long");
    a.s.notice("prompt is too long", "error");
    a.s.setState({ status: "idle" });
    await a.s.continueOn(a.actions()[0]!.id);
    expect(a.s.t.state.model).toBe("sonnet");
    b.s.t.state.model = "sonnet";
    b.log.length = 0;
    await b.s.best("hi");
    expect(b.log).toEqual(["model: opus"]);
    a.log.length = 0;
    await a.s.best("hi");
    expect(a.log).toEqual([]);
  });

  test("an entry in another harness: the button hands off, marked as interrupted", async () => {
    const { s, handoffs, actions } = fake("kiro", "auto");
    await s.setChain(["kiro:auto", "claude-code:opus"]);
    s.t.state.status = "running";
    await s.turnError("Something broke");
    s.notice("Something broke", "error");
    s.setState({ status: "idle" });
    await s.continueOn(actions()[0]!.id);
    expect(handoffs).toEqual([{ to: { harness: "claude-code", model: "opus" }, reason: "You moved it on from Auto after an error", prompt: undefined, interrupted: true }]);
  });

  test("an error shown only on the message (pi, Antigravity) gets a notice with the button when the turn ends", async () => {
    const { s, actions, notices } = fake("opencode", "x/y");
    await s.setChain(["opencode:x/y", "codex:gpt-5.5"]);
    s.t.state.status = "running";
    await s.turnError("provider error");
    s.setState({ status: "idle" });
    expect(notices()).toEqual(["provider error"]);
    expect(actions()).toHaveLength(1);
  });

  test("no button without a later entry, after Stop, and it goes away when a new turn starts", async () => {
    const { s, actions } = fake();
    s.t.state.chain = ["sonnet", "opus"];
    s.t.state.status = "running";
    await s.turnError("boom");
    s.notice("boom", "error");
    expect(actions()).toEqual([]); // opus is the last entry
    await s.setChain(["opus", "sonnet"]);
    s.setState({ status: "running" });
    await s.turnError("boom");
    s.notice("boom", "error");
    expect(actions()).toHaveLength(1);
    s.setState({ status: "idle" });
    s.setState({ status: "running" });
    expect(actions()).toEqual([]);
    await s.stop();
    await s.turnError("aborted");
    s.notice("aborted", "error");
    expect(actions()).toEqual([]);
  });

  test("exhausted later entries are skipped", async () => {
    const { s, actions } = fake();
    config().exhausted["codex"] = Date.now() + 60_000;
    await s.setChain(["opus", "codex:gpt-5.5", "sonnet"]);
    s.t.state.status = "running";
    await s.turnError("boom");
    s.notice("boom", "error");
    expect(actions()[0]?.entry).toBe("claude-code:sonnet");
  });
});

describe("MCP sign-in notices", () => {
  test("one inline notice per server with an Authorize button; the next launch doesn't repeat it", () => {
    const { s } = fake();
    const need = [
      { id: "mcp_a", name: "docs", status: "needs" as const },
      { id: "mcp_b", name: "linear", status: "expired" as const },
    ];
    s.mcpAuthNotice(need, true);
    s.mcpAuthNotice(need);
    const ns = s.t.messages.filter((m) => m.action?.kind === "mcpAuth");
    expect(ns.map((m) => [m.level, (m.parts[0] as any).text, m.action])).toEqual([
      ["warning", "The docs MCP server needs authorization. Its tools work once you sign in.", { kind: "mcpAuth", label: "Authorize docs", server: "mcp_a" }],
      ["warning", "The sign-in to the linear MCP server has expired. Its tools work once you sign in.", { kind: "mcpAuth", label: "Authorize linear", server: "mcp_b" }],
    ]);
    // Not an error: no "Failed" alert, no Continue offer.
    expect(s.t.state.status).toBe("idle");
  });
});

describe("waiting across a runner restart", () => {
  test("Tether's own wait is saved with the session; it re-arms from the saved time", async () => {
    jest.useFakeTimers();
    const { s } = fake();
    s.loadPrefs();
    await s.setChain(["opus"]);
    await s.turnError("429", 429);
    const p = prefs(s.id);
    expect(p.active).toBe(true);
    expect(p.waitingUntil).toBe(s.t.state.waitingUntil!);
    expect(p.waitingReason).toBe("Rate limited on Opus");
    // A harness's own retry wait isn't Tether's: not saved as one.
    await s.abort();
    s.setState({ status: "waiting", waitingUntil: Date.now() + 1000, waitingReason: "API retry 1/10" });
    expect(prefs(s.id).waitingUntil).toBeUndefined();

    // The new process: picks the wait back up and continues when it's over.
    const b = fake();
    b.s.t.state.chain = ["opus"];
    b.s.resumeWait(Date.now() + 30_000, "Rate limited on Opus", "after restart");
    expect(b.s.t.state.status).toBe("waiting");
    jest.advanceTimersByTime(30_000);
    await settle();
    expect(b.log).toEqual(["continue"]);
  });
});

describe("preferBest", () => {
  test("no chain, or preferEarlier off: nothing to do", async () => {
    const { s, log } = fake("claude-code", "sonnet");
    expect(await s.best("hi")).toBe(false);
    await s.setChain(["opus", "sonnet"], false);
    log.length = 0;
    expect(await s.best("hi")).toBe(false);
    expect(log).toEqual([]);
    expect(s.t.state.model).toBe("opus"); // setChain itself moved to the first entry
  });

  test("an earlier model of the same harness that has reset: switch back, the turn goes ahead here", async () => {
    const { s, log, notices } = fake();
    config().exhausted["claude-code:opus"] = Date.now() + 60_000;
    await s.setChain(["opus", "sonnet"]);
    expect(s.t.state.model).toBe("sonnet");
    delete config().exhausted["claude-code:opus"];
    log.length = 0;
    expect(await s.best("hi")).toBe(false);
    expect(log).toEqual(["model: opus"]);
    expect(notices()).toContain("Back on Opus: its usage limit has reset.");
  });

  test("an earlier entry in another harness: the prompt goes with a handoff", async () => {
    const { s, handoffs, log } = fake("codex", "gpt-5.5");
    s.t.state.chain = ["claude-code:opus", "codex:gpt-5.5"];
    await s.prompt("fix the bug");
    expect(handoffs).toEqual([{ to: { harness: "claude-code", model: "opus" }, reason: "Opus is available again", prompt: "fix the bug" }]);
    expect(log).toEqual([]); // not sent here
  });

  test("never moves down or sideways: only up the chain", async () => {
    const { s, log, handoffs } = fake();
    s.t.state.chain = ["opus", "sonnet", "codex:gpt-5.5"];
    // Current is opus but it's exhausted (e.g. marked by another session): the pick is sonnet, later in the chain.
    config().exhausted["claude-code:opus"] = Date.now() + 60_000;
    expect(await s.best("hi")).toBe(false);
    expect(log).toEqual([]);
    expect(handoffs).toEqual([]);
  });

  test("already on the best entry: nothing changes", async () => {
    const { s, log, notices } = fake();
    await s.setChain(["opus", "sonnet"]);
    expect(await s.best("hi")).toBe(false);
    expect(log).toEqual([]);
    expect(notices()).toEqual([]);
  });
});

describe("setChain", () => {
  test("stores chain, profile and preferEarlier, and moves to the first available model of this harness", async () => {
    const { s, log } = fake("claude-code", "haiku");
    await s.setChain(["opus", "sonnet"], false, "Work");
    expect(s.t.state.chain).toEqual(["opus", "sonnet"]);
    expect(s.t.state.profile).toBe("Work");
    expect(s.t.state.preferEarlier).toBe(false);
    expect(log).toEqual(["model: opus"]);
  });

  test("preferEarlier is left as it was when not given", async () => {
    const { s } = fake();
    s.t.state.preferEarlier = false;
    await s.setChain(["opus"]);
    expect(s.t.state.preferEarlier).toBe(false);
  });

  test("an exhausted first entry is skipped; a first pick in another harness changes nothing here", async () => {
    const { s, log, handoffs } = fake("claude-code", "haiku");
    config().exhausted["claude-code:opus"] = Date.now() + 60_000;
    await s.setChain(["opus", "sonnet"]);
    expect(log).toEqual(["model: sonnet"]);
    log.length = 0;
    await s.setChain(["codex:gpt-5.5", "opus"]);
    expect(log).toEqual([]);
    expect(handoffs).toEqual([]);
    expect(s.t.state.model).toBe("sonnet");
  });

  test("already on the picked model: no applyModel", async () => {
    const { s, log } = fake("claude-code", "opus");
    await s.setChain(["opus", "sonnet"]);
    expect(log).toEqual([]);
  });
});
