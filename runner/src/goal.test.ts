// /goal (goal.ts, the goal section of session.ts): the command, the loop's transitions, the
// no-progress guard, the done check with a fake background model, the goal tools over the real
// loopback bridge, the carry-over in a handoff, Codex's native thread goal, and the `/` menu.

import { resetHome } from "./testenv";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { ChainEntry, HarnessId, Msg, SessionGoal } from "../../web/src/shared/protocol";
import { codexAdapter } from "./adapters/codex";
import type { Sink } from "./adapters/types";
import { config, prefs } from "./config";
import { sessionLaunch } from "./connectors/launch";
import { capabilityMatrix } from "./connectors";
import { callTool } from "./context/mcp";
import { bridgeFile } from "./context/launch";
import {
  budgetHit,
  continuationPrompt,
  describeGoal,
  GOAL_CHECK_EVERY,
  GOAL_STALL_TURNS,
  isGoalPrompt,
  kickoffPrompt,
  newGoal,
  parseGoalCommand,
  parseVerdict,
  setGoalJudge,
  transcriptTail,
  withNote,
  type GoalCheck,
} from "./goal";
import { buildBrief } from "./handoff";
import { runHandoff, type HandoffDeps } from "./handoffRun";
import { recent } from "./notify";
import { LiveSession, newId } from "./session";

let live: LiveSession[] = [];
let checks: GoalCheck[] = [];
let verdict: (c: GoalCheck) => { done: boolean; blocked?: boolean; reason: string } = () => ({ done: true, reason: "Tests pass." });

beforeEach(() => {
  resetHome();
  config().sessions = {};
  checks = [];
  verdict = () => ({ done: true, reason: "Tests pass." });
  setGoalJudge(async (c) => {
    checks.push(c);
    return verdict(c);
  });
});
afterEach(() => {
  live.splice(0).forEach((s) => s.close());
  setGoalJudge();
  LiveSession.GOAL_NATIVE_SETTLE_MS = 5_000;
});

async function until(cond: () => unknown, ms = 5_000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(5);
  }
}

const noticeTexts = (s: LiveSession) => s.t.messages.filter((m) => m.role === "notice").map((m) => (m.parts[0] as any).text as string);
const pushes = (s: LiveSession) => recent().filter((n) => n.sessionId === s.id);

/** A harness that runs whatever it's sent as a turn the test then ends (endTurn). */
function fake(harness: HarnessId = "claude-code", opts: { native?: boolean; nativeId?: string; failContinue?: boolean } = {}) {
  const sent: string[] = [];
  const mirrored: (SessionGoal | null)[] = [];
  const sink = { emit: () => {}, summary: () => {}, handoff: async () => {} };
  class Fake extends LiveSession {
    async start() {}
    protected async send(text: string) {
      sent.push(text);
      this.addUserMessage(text);
      this.setState({ status: "running" });
    }
    async abort() {}
    async applyModel(m: string) {
      this.setState({ model: m });
    }
    async setThinking() {}
    async setPermissionMode() {}
    async rename() {}
    async listCommands() {
      return [
        { name: "goal", description: "Claude Code's own goal" },
        { name: "compact", description: "Compact" },
      ];
    }
    async continueTurn(text = "Continue where you left off.") {
      if (opts.failContinue) throw new Error("the harness exited");
      sent.push(text);
      this.addUserMessage(text);
      this.setState({ status: "running" });
    }
    protected shutdown() {}
    /** ends the running turn: `tools` tool calls in its reply */
    endTurn(o: { tools?: number; text?: string; error?: boolean } = {}) {
      const parts: Msg["parts"] = [{ type: "text", text: o.text ?? "Working on it." }];
      for (let i = 0; i < (o.tools ?? 0); i++) parts.push({ type: "tool", id: newId("t"), name: "Bash", input: { command: "bun test" }, status: "done", output: "ok" });
      this.emit({ type: "msg", msg: { id: newId("a"), role: "assistant", parts, ts: Date.now() } });
      if (o.error) this.notice("The turn failed.", "error");
      this.setState({ status: "idle" });
    }
    native(status: string, tokens?: number) {
      this.nativeGoalChanged(status, tokens);
    }
  }
  if (opts.native)
    (Fake.prototype as any).mirrorGoal = async function (this: any, g: SessionGoal | null) {
      mirrored.push(g && JSON.parse(JSON.stringify(g)));
      this.nativeGoal = !!g;
    };
  const s = new Fake(harness, { nativeId: opts.nativeId ?? crypto.randomUUID(), projectPath: process.env.HOME! }, sink);
  s.t.state.status = "idle";
  s.loadPrefs();
  live.push(s);
  return Object.assign(s, { sent, mirrored });
}

describe("the /goal command", () => {
  test("subcommands, objectives and budgets", () => {
    expect(parseGoalCommand("fix it")).toBeUndefined();
    expect(parseGoalCommand("/goals")).toBeUndefined();
    expect(parseGoalCommand("/goal")).toEqual({ cmd: "status" });
    expect(parseGoalCommand("  /goal status ")).toEqual({ cmd: "status" });
    expect(parseGoalCommand("/goal Pause")).toEqual({ cmd: "pause" });
    expect(parseGoalCommand("/goal resume")).toEqual({ cmd: "resume" });
    expect(parseGoalCommand("/goal clear")).toEqual({ cmd: "clear" });
    expect(parseGoalCommand("/goal pause the deploy, then fix CI")).toEqual({ cmd: "set", objective: "pause the deploy, then fix CI" });
    expect(parseGoalCommand("/goal make all tests pass --turns 20 --tokens 1.5M --time 1h30m")).toEqual({
      cmd: "set",
      objective: "make all tests pass",
      budget: { turns: 20, tokens: 1_500_000, ms: 90 * 60_000 },
    });
    expect(parseGoalCommand("/goal ship it --tokens=500k")).toEqual({ cmd: "set", objective: "ship it", budget: { tokens: 500_000 } });
    expect(parseGoalCommand("/goal ship it --turns 2.5")).toMatchObject({ cmd: "error" });
    expect(parseGoalCommand("/goal --turns 5")).toMatchObject({ cmd: "error" });
    expect(parseGoalCommand("/goal ship it --time soon")).toMatchObject({ cmd: "error" });
  });

  test("wording: the budget, the prompts and the status", () => {
    let g = newGoal("make all tests pass", { turns: 2 });
    expect(budgetHit(g)).toBeUndefined();
    g = { ...g, used: { ...g.used, turns: 2 } };
    expect(budgetHit(g)).toBe("It used its budget of 2 turns.");
    expect(budgetHit(newGoal("x"))).toBeUndefined(); // no default budget (Decision 7)
    g = withNote(g, "3 of 5 suites green", "agent");
    expect(describeGoal(g)).toBe("Goal: make all tests pass\nStatus: Active\nBudget: 2 of 2 turns\nLatest progress:\n- 3 of 5 suites green");
    expect(continuationPrompt(g)).toContain("Latest progress: 3 of 5 suites green");
    expect(continuationPrompt(g, "The auth suite still fails.")).toContain(`Tether's check of your "done": The auth suite still fails.`);
    expect(isGoalPrompt(continuationPrompt(g))).toBe(true);
    expect(isGoalPrompt(kickoffPrompt(g))).toBe(true);
    expect(kickoffPrompt(g)).toContain("goal_update");
  });

  test("the transcript tail keeps the end of the conversation, tool results included", () => {
    const msgs: Msg[] = [
      { id: "u", role: "user", parts: [{ type: "text", text: "old ".repeat(5000) }], ts: 1 },
      { id: "a", role: "assistant", parts: [{ type: "text", text: "Ran them." }, { type: "tool", id: "t", name: "Bash", input: { command: "bun test" }, status: "done", output: "12 pass" }], ts: 2 },
    ];
    const tail = transcriptTail(msgs, 2000);
    expect(tail.length).toBeLessThanOrEqual(2001);
    expect(tail).toContain('[Bash {"command":"bun test"} → 12 pass]');
  });
});

describe("the loop", () => {
  test("set while idle: a kickoff turn, then a continuation after every turn that made progress", async () => {
    const s = fake();
    await s.prompt("/goal make all tests pass");
    expect(noticeTexts(s)[0]).toStartWith("Goal set.");
    await until(() => s.sent.length === 1);
    expect(s.sent[0]).toBe(kickoffPrompt(s.goalState!));
    s.endTurn({ tools: 2 });
    await until(() => s.sent.length === 2);
    expect(s.sent[1]).toStartWith("[Tether goal] Continue working toward the goal: make all tests pass");
    expect(s.goalState!.used.turns).toBe(1);
    expect(s.goalState!.status).toBe("active");
    // The lists keep it under Working between the goal's turns.
    expect(s.summary().goalActive).toBe(true);
    // No "Finished" for each turn of a goal.
    expect(pushes(s).filter((n) => n.kind === "finished")).toEqual([]);
  });

  test("the guard judge reads the goal; Tether's own prompts aren't the user's asks", async () => {
    const s = fake();
    await s.prompt("/goal make all tests pass");
    await until(() => s.sent.length === 1);
    expect(s.goal()).toBe("Goal: make all tests pass");
  });

  test("nothing goes out while a message is queued or an approval is open; an answer resumes the loop", async () => {
    const s = fake();
    await s.prompt("/goal make all tests pass");
    await until(() => s.sent.length === 1);
    // An approval still open when the turn ends.
    const answer = s.askUi({ id: "perm1", kind: "permission", title: "Allow Bash?" });
    s.endTurn({ tools: 1 });
    await Bun.sleep(100);
    expect(s.sent.length).toBe(1);
    s.uiRespond({ id: "perm1", allow: true });
    await answer;
    await until(() => s.sent.length === 2);
    // A queued message starts the next turn instead of the goal.
    s.setState({ pending: [{ id: "p1", text: "also update the docs", mode: "followUp", ts: Date.now() }] });
    s.endTurn({ tools: 1 });
    await Bun.sleep(100);
    expect(s.sent.length).toBe(2);
  });

  test("Stop pauses the goal; /goal resume continues it", async () => {
    const s = fake();
    await s.prompt("/goal make all tests pass");
    await until(() => s.sent.length === 1);
    await s.stop();
    s.endTurn();
    expect(s.goalState).toMatchObject({ status: "paused", reason: "Paused when you stopped the session." });
    await Bun.sleep(50);
    expect(s.sent.length).toBe(1);
    expect(pushes(s)).toEqual([]); // you stopped it: no notification
    await s.prompt("/goal resume");
    await until(() => s.sent.length === 2);
    expect(s.goalState!.status).toBe("active");
  });

  test("/goal pause, status and clear", async () => {
    const s = fake();
    s.setState({ status: "running" });
    await s.prompt("/goal make all tests pass --turns 10");
    await s.prompt("/goal pause");
    expect(s.goalState).toMatchObject({ status: "paused", reason: "Paused by you." });
    await s.prompt("/goal");
    expect(noticeTexts(s).pop()).toBe("Goal: make all tests pass\nStatus: Paused. Paused by you.\nBudget: 0 of 10 turns\nLatest progress:\n- Paused by you.");
    s.endTurn({ tools: 1 });
    await Bun.sleep(50);
    expect(s.sent).toEqual([]);
    await s.prompt("/goal clear");
    expect(s.t.state.goal).toBeNull();
    expect(prefs(s.id).goal).toBeUndefined();
  });

  test("a failed turn pauses the goal (its error was the notification)", async () => {
    const s = fake();
    await s.prompt("/goal make all tests pass");
    await until(() => s.sent.length === 1);
    s.endTurn({ error: true });
    expect(s.goalState).toMatchObject({ status: "paused", reason: "Paused because the turn ended with an error." });
    await Bun.sleep(50);
    expect(s.sent.length).toBe(1);
  });

  test("a budget stops it: a Needs-you notification", async () => {
    const s = fake();
    await s.prompt("/goal make all tests pass --turns 2");
    await until(() => s.sent.length === 1);
    s.endTurn({ tools: 1 });
    await until(() => s.sent.length === 2);
    s.endTurn({ tools: 1 });
    await until(() => s.goalState!.status === "budget");
    expect(s.goalState!.reason).toBe("It used its budget of 2 turns.");
    expect(s.sent.length).toBe(2);
    expect(pushes(s).map((n) => [n.kind, n.title.split(" · ")[0]])).toEqual([["blocked", "Goal out of budget"]]);
    await s.prompt("/goal resume");
    expect(s.goalState!.status).toBe("budget");
  });

  test("the goal and the loop are saved, and come back with the session", async () => {
    const s = fake();
    await s.prompt("/goal make all tests pass");
    await until(() => s.sent.length === 1);
    s.endTurn({ tools: 1 });
    await until(() => s.sent.length === 2);
    s.endTurn({ tools: 1 });
    await until(() => s.goalState!.used.turns === 2);
    expect(prefs(s.id).goal).toMatchObject({ objective: "make all tests pass", status: "active", used: { turns: 2 } });
    expect(prefs(s.id).active).toBe(true);
    // Saved as running: the restart resumes the turn (resumeActive) and the loop with it.
    s.close();
    const back = fake("claude-code", { nativeId: s.id.split(":")[1] });
    expect(back.goalState).toMatchObject({ status: "active", used: { turns: 2 } });
  });

  test("an active goal saved with nothing running is paused when it comes back (no restart resumes it)", async () => {
    const s = fake();
    s.setState({ status: "running" });
    await s.prompt("/goal make all tests pass");
    // Held on an open approval: saved as not running; the approval doesn't survive a restart.
    s.askUi({ id: "perm1", kind: "permission", title: "Allow Bash?" });
    s.endTurn({ tools: 1 });
    await Bun.sleep(50);
    expect(prefs(s.id)).toMatchObject({ active: false, goal: { status: "active" } });
    s.close();
    const back = fake("claude-code", { nativeId: s.id.split(":")[1] });
    expect(back.goalState).toMatchObject({ status: "paused", reason: "Paused when the runner restarted." });
    await back.prompt("/goal resume");
    await until(() => back.sent.length === 1);
    expect(back.goalState!.status).toBe("active");
  });

  test("a continuation that can't start pauses the goal, and /goal resume tries again", async () => {
    const s = fake("claude-code", { failContinue: true });
    await s.prompt("/goal make all tests pass");
    await until(() => s.goalState!.status === "paused");
    expect(s.goalState!.reason).toBe("Paused because Tether couldn't continue it: the harness exited");
    expect(noticeTexts(s).pop()).toBe("Could not continue the goal: the harness exited. /goal resume tries again.");
    await s.prompt("/goal resume");
    expect(noticeTexts(s)).toContain("Goal resumed.");
    await until(() => s.goalState!.status === "paused" && s.goalState!.notes.some((n) => n.text === "Resumed by you."));
  });

  test("/goal resume on an active goal nothing drives continues it", async () => {
    const s = fake();
    s.setState({ goal: newGoal("make all tests pass") });
    await s.prompt("/goal resume");
    await until(() => s.sent.length === 1);
    expect(s.sent[0]).toStartWith("[Tether goal] Continue working toward the goal");
    // A running turn: it's active already.
    await s.prompt("/goal resume");
    expect(noticeTexts(s).pop()).toBe("The goal is active already.");
  });
});

describe("no-progress guard and the done check", () => {
  test(`${GOAL_STALL_TURNS} turns with no tool call, diff change or goal_update: checked, then blocked`, async () => {
    verdict = () => ({ done: false, reason: "Nothing was tried." });
    const s = fake();
    await s.prompt("/goal make all tests pass");
    for (let i = 1; i <= GOAL_STALL_TURNS; i++) {
      await until(() => s.sent.length === i);
      s.endTurn({ text: "Thinking about it." });
    }
    await until(() => s.goalState!.status === "blocked");
    expect(checks.map((c) => c.claim)).toEqual(["stalled"]);
    expect(s.goalState!.reason).toBe(`No progress for ${GOAL_STALL_TURNS} turns in a row. Nothing was tried.`);
    expect(pushes(s).map((n) => [n.kind, n.title.split(" · ")[0]])).toEqual([["blocked", "Goal blocked"]]);
    await Bun.sleep(50);
    expect(s.sent.length).toBe(GOAL_STALL_TURNS);
  });

  test(`a busy agent that never reports is checked every ${GOAL_CHECK_EVERY} turns: continue, then blocked`, async () => {
    let n = 0;
    verdict = (c) => (++n === 1 ? { done: false, reason: "Still adding tests." } : { done: false, blocked: true, reason: "It reruns the same failing migration." });
    const s = fake();
    await s.prompt("/goal make all tests pass");
    for (let i = 1; i <= GOAL_CHECK_EVERY * 2; i++) {
      await until(() => s.sent.length === i);
      s.endTurn({ tools: 2 });
    }
    await until(() => s.goalState!.status === "blocked");
    expect(checks.map((c) => c.claim)).toEqual(["periodic", "periodic"]);
    // The first check said go on: no "Not done yet" note and no check text in the prompt.
    expect(s.sent[GOAL_CHECK_EVERY]).not.toContain("Tether's check");
    expect(s.goalState!.notes.some((x) => x.text.startsWith("Not done yet"))).toBe(false);
    expect(s.goalState!.reason).toBe("It reruns the same failing migration.");
    expect(s.sent.length).toBe(GOAL_CHECK_EVERY * 2);
    expect(pushes(s).map((x) => x.title.split(" · ")[0])).toEqual(["Goal blocked"]);
  });

  test("a periodic check that finds it done ends the goal; one that can't run lets it go on", async () => {
    const s = fake();
    await s.prompt("/goal make all tests pass");
    for (let i = 1; i <= GOAL_CHECK_EVERY; i++) {
      await until(() => s.sent.length === i);
      s.endTurn({ tools: 1 });
    }
    await until(() => s.goalState!.status === "done");
    expect(checks.map((c) => c.claim)).toEqual(["periodic"]);

    setGoalJudge(async () => {
      throw new Error("claude isn't installed");
    });
    const t = fake();
    await t.prompt("/goal make all tests pass");
    for (let i = 1; i <= GOAL_CHECK_EVERY; i++) {
      await until(() => t.sent.length === i);
      t.endTurn({ tools: 1 });
    }
    await until(() => t.sent.length === GOAL_CHECK_EVERY + 1);
    expect(t.goalState!.status).toBe("active");
  });

  test("the background model's reply: status, or the older done flag", () => {
    expect(parseVerdict({ status: "done", reason: "ok" })).toEqual({ done: true, reason: "ok" });
    expect(parseVerdict({ status: "continue", reason: "more" })).toEqual({ done: false, reason: "more" });
    expect(parseVerdict({ status: "Blocked", reason: "loop" })).toEqual({ done: false, blocked: true, reason: "loop" });
    expect(parseVerdict({ done: true, reason: "ok" })).toEqual({ done: true, reason: "ok" });
    expect(parseVerdict({})).toEqual({ done: false, reason: "" });
  });

  test("a goal_update in a turn counts as progress", async () => {
    const s = fake();
    await s.prompt("/goal make all tests pass");
    for (let i = 1; i <= GOAL_STALL_TURNS + 1; i++) {
      await until(() => s.sent.length === i);
      expect(s.goalTool("update", { status: "active", note: `step ${i}` })).toEqual({ ok: true, text: "Noted. Keep going." });
      s.endTurn();
    }
    await until(() => s.sent.length === GOAL_STALL_TURNS + 2);
    expect(checks).toEqual([]);
    expect(s.goalState!.notes.at(-1)).toMatchObject({ text: `step ${GOAL_STALL_TURNS + 1}`, by: "agent" });
  });

  test("a stall the background model finds done is done", async () => {
    const s = fake();
    await s.prompt("/goal make all tests pass");
    for (let i = 1; i <= GOAL_STALL_TURNS; i++) {
      await until(() => s.sent.length === i);
      s.endTurn();
    }
    await until(() => s.goalState!.status === "done");
    expect(s.goalState!.reason).toBe("Tests pass.");
  });

  test("done, confirmed: one notification, no continuation", async () => {
    const s = fake();
    await s.prompt("/goal make all tests pass");
    await until(() => s.sent.length === 1);
    expect(s.goalTool("update", { status: "done", note: "All 40 tests pass." }).ok).toBe(true);
    s.endTurn({ tools: 1, text: "All 40 tests pass." });
    await until(() => s.goalState!.status === "done");
    expect(checks.map((c) => c.claim)).toEqual(["done"]);
    expect(checks[0]!.transcript).toContain("All 40 tests pass.");
    expect(pushes(s).map((n) => [n.kind, n.title.split(" · ")[0]])).toEqual([["finished", "Goal done"]]);
    await Bun.sleep(50);
    expect(s.sent.length).toBe(1);
    expect(s.goalTool("update", { status: "active", note: "more" }).text).toStartWith("The goal is done");
  });

  test("a check that outlives its goal is dropped: a new goal set meanwhile isn't marked done", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    setGoalJudge(async (c) => {
      checks.push(c);
      await held;
      return { done: true, reason: "The old goal is achieved." };
    });
    const s = fake();
    await s.prompt("/goal make all tests pass");
    await until(() => s.sent.length === 1);
    s.goalTool("update", { status: "done", note: "Done." });
    s.endTurn({ tools: 1 });
    await until(() => checks.length === 1);
    await s.prompt("/goal update the docs");
    await until(() => s.sent.length === 2);
    release();
    await Bun.sleep(50);
    expect(s.goalState).toMatchObject({ objective: "update the docs", status: "active" });
    expect(pushes(s)).toEqual([]);
  });

  test("a check that outlives a pause and resume is dropped too", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    setGoalJudge(async (c) => {
      checks.push(c);
      await held;
      return { done: false, reason: "Not yet." };
    });
    const s = fake();
    await s.prompt("/goal make all tests pass");
    await until(() => s.sent.length === 1);
    s.goalTool("update", { status: "done" });
    s.endTurn({ tools: 1 });
    await until(() => checks.length === 1);
    await s.prompt("/goal pause");
    await s.prompt("/goal resume");
    await until(() => s.sent.length === 2);
    release();
    await Bun.sleep(50);
    expect(s.sent.length).toBe(2);
    expect(s.goalState!.notes.some((n) => n.text.startsWith("Not done yet"))).toBe(false);
  });

  test("a false done: the loop goes on with the background model's reason", async () => {
    verdict = () => ({ done: false, reason: "The auth suite still fails." });
    const s = fake();
    await s.prompt("/goal make all tests pass");
    await until(() => s.sent.length === 1);
    s.goalTool("update", { status: "done" });
    s.endTurn({ tools: 1 });
    await until(() => s.sent.length === 2);
    expect(s.sent[1]).toContain(`Tether's check of your "done": The auth suite still fails.`);
    expect(s.goalState).toMatchObject({ status: "active" });
    expect(s.goalState!.notes.at(-1)).toMatchObject({ text: "Not done yet: The auth suite still fails.", by: "tether" });
    expect(pushes(s)).toEqual([]);
  });

  test("no background model: the agent's done stands", async () => {
    setGoalJudge(async () => {
      throw new Error("claude isn't installed");
    });
    const s = fake();
    await s.prompt("/goal make all tests pass");
    await until(() => s.sent.length === 1);
    s.goalTool("update", { status: "done", note: "Done." });
    s.endTurn({ tools: 1 });
    await until(() => s.goalState!.status === "done");
    expect(s.goalState!.reason).toBe("Done. (Tether couldn't double-check it: claude isn't installed)");
  });

  test("the agent reports blocked: stopped at once, the turn just ends", async () => {
    const s = fake();
    await s.prompt("/goal deploy to staging");
    await until(() => s.sent.length === 1);
    s.goalTool("update", { status: "blocked", note: "Needs the staging password." });
    expect(s.goalState).toMatchObject({ status: "blocked", reason: "Needs the staging password." });
    s.endTurn({ tools: 1 });
    await Bun.sleep(50);
    expect(s.sent.length).toBe(1);
    expect(pushes(s).map((n) => n.title.split(" · ")[0])).toEqual(["Goal blocked"]);
  });

  test("goal tool errors", () => {
    const s = fake();
    expect(s.goalTool("get", {})).toEqual({ ok: true, text: "No goal is set for this session. The user sets one with /goal in Tether." });
    expect(s.goalTool("update", { note: "x" }).ok).toBe(false);
    s.setState({ goal: newGoal("x") });
    expect(s.goalTool("update", { status: "finished", note: "x" }).ok).toBe(false);
    expect(s.goalTool("nope", {}).ok).toBe(false);
  });
});

describe("goal tools over the bridge (tether-context)", () => {
  test("goal_get and goal_update reach the calling session", async () => {
    const s = fake();
    s.setState({ status: "running" });
    await s.prompt("/goal make all tests pass");
    const file = bridgeFile();
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/), token: expect.any(String) });
    const key = s.guardEnv.TETHER_GUARD_KEY;
    process.env.TETHER_SESSION_KEY = key;
    process.env.TETHER_BRIDGE_FILE = file;
    try {
      expect((await callTool("goal_get", {})).content[0]!.text).toStartWith("Goal: make all tests pass\nStatus: Active");
      expect(await callTool("goal_update", { status: "active", note: "2 suites left" })).toEqual({ content: [{ type: "text", text: "Noted. Keep going." }] });
      expect(s.goalState!.notes.at(-1)).toMatchObject({ text: "2 suites left", by: "agent" });
      expect((await callTool("goal_update", { status: "sideways", note: "x" })).isError).toBe(true);
      process.env.TETHER_SESSION_KEY = "someone-else";
      expect((await callTool("goal_get", {})).isError).toBe(true);
      delete process.env.TETHER_SESSION_KEY;
      expect((await callTool("goal_get", {})).content[0]!.text).toBe("Goals work only in sessions Tether started.");
    } finally {
      delete process.env.TETHER_SESSION_KEY;
      delete process.env.TETHER_BRIDGE_FILE;
    }
  });

  test("with the master context off, a session launch still gets tether-context with only the goal tools", async () => {
    const l = await sessionLaunch("claude-code", { projectPath: process.env.HOME!, session: { id: "claude-code:x", key: "gk" } });
    const server = l.options.mcpServers["tether-context"];
    expect(server.env).toMatchObject({ TETHER_SESSION_KEY: "gk", TETHER_CONTEXT_TOOLS: "goal", TETHER_BRIDGE_FILE: bridgeFile() });
    expect(l.options.systemPrompt).toBeUndefined();
    // No session key (Antigravity's preamble-only launch): nothing.
    expect(await sessionLaunch("antigravity", { projectPath: process.env.HOME! })).toEqual({ args: [], options: {}, env: {} });
  });

  test("the capability matrix says where the goal is native", () => {
    const m = capabilityMatrix();
    expect(m.codex.goal.level).toBe("native");
    for (const h of ["claude-code", "pi", "opencode", "kiro", "antigravity"] as const) expect(m[h].goal.level).toBe("emulated");
  });
});

describe("the / menu", () => {
  test("Tether's /goal on every harness, in place of the harness's own", async () => {
    const s = fake();
    const menu = await s.slashMenu();
    expect(menu.filter((c) => c.name === "goal")).toEqual([expect.objectContaining({ name: "goal", kind: "tether" })]);
    expect(menu.some((c) => c.name === "compact")).toBe(true);
  });
});

describe("handoff (Decision 6)", () => {
  test("the goal goes with the conversation into the brief, and the loop runs on in the new session", async () => {
    LiveSession.GOAL_NATIVE_SETTLE_MS = 0; // Codex would continue by itself; the fake doesn't
    const from = fake("codex", { native: true });
    const to = fake("pi");
    let brief = "";
    const deps: HandoffDeps = {
      adapters: { pi: { create: () => to } } as unknown as HandoffDeps["adapters"],
      sink: { emit: () => {}, summary: () => {}, handoff: async () => {} } as unknown as Sink,
      context: { handoffMemory: async () => undefined },
      track: () => {},
    };
    await from.prompt("/goal make all tests pass --turns 50");
    await until(() => from.sent.length === 1);
    from.goalTool("update", { status: "active", note: "3 of 5 suites green" });
    // the limit hits mid-turn: the turn ends in the handoff
    from.mirrored.length = 0;
    await runHandoff(deps, from, { harness: "pi", model: "default" } as ChainEntry, "Opus hit its usage limit", undefined, { interrupted: true });
    // The old session's goal (and Codex's copy of it) is paused there, quietly.
    expect(from.goalState).toMatchObject({ status: "paused", reason: expect.stringMatching(/^Continued on /) });
    expect(from.mirrored).toEqual([expect.objectContaining({ status: "paused" })]);
    // Codex reporting on the old thread afterwards changes nothing and notifies no one.
    from.native("blocked");
    expect(from.goalState!.status).toBe("paused");
    expect(from.mirrored.at(-1)).toMatchObject({ status: "paused" });
    expect(pushes(from)).toEqual([]);
    brief = to.sent[0]!;
    expect(brief).toContain("## Goal\nThe user set a goal for this session");
    expect(brief).toContain("make all tests pass");
    expect(brief).toContain("- 3 of 5 suites green");
    expect(to.goalState).toMatchObject({ objective: "make all tests pass", status: "active", budget: { turns: 50 } });
    // The old session's loop stops there; the new one continues after the brief's turn.
    from.endTurn();
    to.endTurn({ tools: 1 });
    await until(() => to.sent.length === 2);
    expect(to.sent[1]).toStartWith("[Tether goal] Continue working toward the goal: make all tests pass");
    expect(to.goalState!.used.turns).toBe(1);
    await Bun.sleep(50);
    expect(from.sent.length).toBe(1);
    // Opened again later, it stays paused (and so does Codex's copy).
    from.close();
    const again = fake("codex", { native: true, nativeId: from.id.split(":")[1] });
    expect(again.goalState).toMatchObject({ status: "paused" });
    expect(again.mirrored).toEqual([expect.objectContaining({ status: "paused" })]);
  });

  test("the brief has no goal section without an active goal", async () => {
    const b = await buildBrief({ messages: [], cwd: process.env.HOME!, fromLabel: "x", reason: "y" });
    expect(b).not.toContain("## Goal");
  });
});

describe("native goals", () => {
  test("a harness that drives its own goal gets a moment to continue by itself", async () => {
    LiveSession.GOAL_NATIVE_SETTLE_MS = 150;
    const s = fake("codex", { native: true });
    await s.prompt("/goal make all tests pass --tokens 1M");
    expect(s.mirrored).toEqual([expect.objectContaining({ objective: "make all tests pass", status: "active", budget: { tokens: 1_000_000 } })]);
    // Codex started the work itself: no kickoff from Tether.
    s.setState({ status: "running" });
    await Bun.sleep(250);
    expect(s.sent).toEqual([]);
    s.endTurn({ tools: 1 });
    // ... and it doesn't continue this time: Tether does, after the settle time.
    await Bun.sleep(50);
    expect(s.sent).toEqual([]);
    await until(() => s.sent.length === 1);
    // Codex says complete: checked like a goal_update "done".
    s.setState({ status: "running" });
    s.native("complete", 4_000);
    s.endTurn({ tools: 1 });
    await until(() => s.goalState!.status === "done");
    expect(checks.map((c) => c.claim)).toEqual(["done"]);
    expect(s.goalState!.used.tokens).toBeGreaterThanOrEqual(4_000);
    expect(s.mirrored.at(-1)).toMatchObject({ status: "done" });
  });

  test("Codex's own blocked or paused stops Tether's; an active Codex goal can't revive a stopped one", async () => {
    const s = fake("codex", { native: true });
    s.setState({ status: "running" });
    await s.prompt("/goal make all tests pass");
    s.native("blocked");
    expect(s.goalState).toMatchObject({ status: "blocked" });
    s.mirrored.length = 0;
    s.native("active");
    expect(s.goalState!.status).toBe("blocked");
    expect(s.mirrored).toEqual([expect.objectContaining({ status: "blocked" })]);
  });

  test("Codex app-server: mirrored with thread/goal/set, status back from thread/goal/updated", async () => {
    const sink = { emit: () => {}, summary: () => {}, handoff: async () => {} } as unknown as Sink;
    const s: any = codexAdapter.create(process.env.HOME!, {}, sink);
    const calls: [string, any][] = [];
    s.p = {
      call: async (m: string, p: any) => (calls.push([m, p]), m === "thread/goal/get" ? { goal: { objective: "an old goal" } } : m === "turn/start" ? { turn: { id: "t1" } } : {}),
      kill() {},
    };
    s.nativeId = "th1";
    s.setState({ status: "running" });
    live.push(s);
    await s.prompt("/goal make all tests pass --tokens 2M");
    expect(calls.map((c) => c[0])).toEqual(["thread/goal/get", "thread/goal/clear", "thread/goal/set"]);
    expect(calls[2]![1]).toEqual({ threadId: "th1", origin: "user", objective: "make all tests pass", status: "active", tokenBudget: 2_000_000 });
    expect(s.goalState.native).toBe(true);
    // Our own change coming back changes nothing; Codex's "complete" is a claim to check.
    s.onNotify("thread/goal/updated", { threadId: "th1", turnId: null, goal: { threadId: "th1", objective: "make all tests pass", status: "active", tokensUsed: 10 } });
    expect(s.goalState.status).toBe("active");
    s.onNotify("thread/goal/updated", { threadId: "th1", turnId: "t1", goal: { threadId: "th1", objective: "make all tests pass", status: "budgetLimited", tokensUsed: 2_000_001 } });
    expect(s.goalState).toMatchObject({ status: "budget", used: { tokens: 2_000_001 } });
    await s.prompt("/goal clear");
    expect(calls.at(-1)).toEqual(["thread/goal/clear", { threadId: "th1", origin: "user" }]);
  });
});
