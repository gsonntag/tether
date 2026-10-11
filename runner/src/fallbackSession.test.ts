// The session side of fallback (session.ts): handleTurnError, preferBest, waitThenContinue and
// setChain, on a fake harness. Pins today's behaviour; the strict-fallback work changes it on purpose.

import { resetHome } from "./testenv";
import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import type { ChainEntry, HarnessId } from "../../web/src/shared/protocol";
import { config } from "./config";
import type { Classified } from "./fallback";
import { LiveSession } from "./session";

const sessions: LiveSession[] = [];

beforeEach(() => {
  resetHome();
  config().exhausted = {};
});
afterEach(() => {
  sessions.splice(0).forEach((s) => s.close());
  jest.useRealTimers();
  config().exhausted = {};
});

/** Lets promise callbacks (a timer's async body) run without moving the clock. */
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

function fake(harness: HarnessId = "claude-code", model = "opus") {
  const log: string[] = [];
  const handoffs: { to: ChainEntry; reason: string; prompt?: string }[] = [];
  const sink = {
    emit: () => {},
    summary: () => {},
    handoff: async (_from: LiveSession, to: ChainEntry, reason: string, prompt?: string) => {
      handoffs.push({ to, reason, prompt });
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
    async continueTurn() {
      log.push("continue");
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
  const s = new Fake(harness, { nativeId: crypto.randomUUID(), projectPath: process.env.HOME! }, sink);
  s.t.state.status = "idle";
  s.t.state.model = model;
  sessions.push(s);
  const notices = () => s.t.messages.filter((m) => m.role === "notice").map((m) => (m.parts[0] as any).text as string);
  return { s, log, handoffs, notices };
}

describe("handleTurnError", () => {
  test("without a chain, or for an error that isn't a limit, the adapter reports it itself", async () => {
    const { s, log } = fake();
    expect(await s.turnError("usage limit reached", 429)).toBe(false);
    s.t.state.chain = ["opus", "sonnet"];
    expect(await s.turnError("ENOENT: no such file")).toBe(false);
    expect(log).toEqual([]);
    expect(config().exhausted).toEqual({});
  });

  test("quota: the provider is marked exhausted and the next model of the same harness takes over", async () => {
    const { s, log, notices, handoffs } = fake();
    await s.setChain(["opus", "sonnet"]);
    const reset = Date.now() + 3 * 60 * 60_000;
    expect(await s.turnError("You've hit your usage limit", null, { kind: "quota", resetAt: reset })).toBe(true);
    expect(config().exhausted["claude-code:opus"]).toBe(reset);
    expect(log).toEqual(["model: sonnet", "continue"]);
    expect(notices()[0]).toStartWith("Usage limit reached on claude-code:opus (resets ");
    expect(notices()[1]).toBe("Switched to sonnet.");
    expect(handoffs).toEqual([]);
  });

  test("quota without a reset time: an hour's cooldown", async () => {
    const { s } = fake();
    await s.setChain(["opus", "sonnet"]);
    const before = Date.now();
    await s.turnError("Claude AI usage limit reached");
    const until = config().exhausted["claude-code:opus"]!;
    expect(until - before).toBeGreaterThanOrEqual(60 * 60_000);
    expect(until - Date.now()).toBeLessThanOrEqual(60 * 60_000);
  });

  test("quota: the next entry in another harness gets a handoff", async () => {
    const { s, log, handoffs } = fake();
    await s.setChain(["opus", "codex:gpt-5.5"]);
    expect(await s.turnError("usage limit")).toBe(true);
    expect(handoffs).toEqual([{ to: { harness: "codex", model: "gpt-5.5" }, reason: "claude-code (opus) hit its usage limit", prompt: undefined }]);
    expect(log).toEqual([]); // the new session continues, not this one
  });

  test("codex models share one quota key", async () => {
    const { s, handoffs } = fake("codex", "gpt-5.5");
    await s.setChain(["codex:gpt-5.5", "codex:gpt-5.5-mini", "claude-code:opus"]);
    await s.turnError("", null, { kind: "quota" });
    expect(Object.keys(config().exhausted)).toEqual(["codex"]);
    expect(handoffs.map((h) => h.to)).toEqual([{ harness: "claude-code", model: "opus" }]);
  });

  test("the adapter's hint wins over the text", async () => {
    const { s, log } = fake();
    await s.setChain(["opus", "sonnet"]);
    expect(await s.turnError("something went wrong", null, { kind: "quota" })).toBe(true);
    expect(log).toEqual(["model: sonnet", "continue"]);
  });

  test("a 429 stays on the model and backs off, longer each time, until a turn succeeds", async () => {
    jest.useFakeTimers();
    const { s, log } = fake();
    await s.setChain(["opus", "sonnet"]);
    expect(await s.turnError("Too many requests", 429)).toBe(true);
    expect(config().exhausted).toEqual({}); // a rate limit never marks anything exhausted
    expect(s.t.state.status).toBe("waiting");
    expect(s.t.state.waitingReason).toBe("Rate limited on opus");
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
    expect(s.t.state.waitingReason).toBe("Rate limited on opus");
  });

  test("everything exhausted: waits for the earliest reset, then continues on that model", async () => {
    jest.useFakeTimers();
    const { s, log, handoffs } = fake();
    await s.setChain(["opus", "sonnet"]);
    config().exhausted["claude-code:sonnet"] = Date.now() + 20 * 60_000;
    log.length = 0;
    const reset = Date.now() + 60 * 60_000;
    expect(await s.turnError("", null, { kind: "quota", resetAt: reset })).toBe(true);
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
    await s.turnError("", null, { kind: "quota", resetAt: Date.now() + 60 * 60_000 });
    jest.advanceTimersByTime(5 * 60_000);
    await settle();
    expect(handoffs).toEqual([{ to: { harness: "codex", model: "gpt-5.5" }, reason: "codex:gpt-5.5 has reset", prompt: undefined }]);
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
    expect(notices()).toContain("Back on opus: its usage limit has reset.");
  });

  test("an earlier entry in another harness: the prompt goes with a handoff", async () => {
    const { s, handoffs, log } = fake("codex", "gpt-5.5");
    s.t.state.chain = ["claude-code:opus", "codex:gpt-5.5"];
    await s.prompt("fix the bug");
    expect(handoffs).toEqual([{ to: { harness: "claude-code", model: "opus" }, reason: "claude-code:opus is available again", prompt: "fix the bug" }]);
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
