// /loop and /schedule (schedule.ts, the schedules section of session.ts): the commands, cron
// expressions and next run times, the runner-wide timer with fake timers, runs queued through
// the pending list (sent when idle, after the turn when busy, overlapping runs collapsed), stop and
// delete, persistence across a restart, the move in a handoff, the pulse and the `/` menu.

import { resetHome } from "./testenv";
import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import type { ChainEntry, HarnessId, Msg, SessionSchedule } from "../../web/src/shared/protocol";
import type { Sink } from "./adapters/types";
import { config, prefs } from "./config";
import { capabilityMatrix } from "./connectors";
import { runHandoff, resumeActive, type HandoffDeps } from "./handoffRun";
import { recent } from "./notify";
import { buildPulse } from "./pulse";
import {
  advance,
  describeList,
  fmtInterval,
  newSchedule,
  nextCron,
  parseAt,
  parseCron,
  parseLoopCommand,
  parseScheduleCommand,
  parseInterval,
  Scheduler,
  scheduleChanged,
  sessionScheduler,
  setScheduler,
  type Cron,
} from "./schedule";
import { LiveSession, newId } from "./session";

let live: LiveSession[] = [];

beforeEach(() => {
  resetHome();
  config().sessions = {};
});
afterEach(() => {
  setScheduler(undefined);
  live.splice(0).forEach((s) => s.close());
  jest.useRealTimers();
});

const settle = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
const MIN = 60_000;
const at = (y: number, mo: number, d: number, h = 0, m = 0) => new Date(y, mo - 1, d, h, m).getTime();
const cron = (e: string) => parseCron(e) as Cron;
const noticeTexts = (s: LiveSession) => s.t.messages.filter((m) => m.role === "notice").map((m) => (m.parts[0] as any).text as string);

/** A harness that runs whatever it's sent as a turn the test then ends (endTurn), draining the queue like the adapters. */
function fake(harness: HarnessId = "claude-code", opts: { nativeId?: string } = {}) {
  const sent: string[] = [];
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
        { name: "loop", description: "Claude Code's own /loop" },
        { name: "compact", description: "Compact" },
      ];
    }
    async continueTurn(text = "Continue where you left off.") {
      sent.push(text);
      this.addUserMessage(text);
      this.setState({ status: "running" });
    }
    protected shutdown() {}
    async endTurn() {
      this.emit({ type: "msg", msg: { id: newId("a"), role: "assistant", parts: [{ type: "text", text: "Done." }], ts: Date.now() } as Msg });
      if (await this.drainPending()) return;
      this.setState({ status: "idle" });
    }
  }
  const s = new Fake(harness, { nativeId: opts.nativeId ?? crypto.randomUUID(), projectPath: process.env.HOME! }, sink);
  s.t.state.status = "idle";
  s.loadPrefs();
  live.push(s);
  return Object.assign(s, { sent });
}

/** The runner's scheduler over these sessions (index.ts wires the same thing). */
function runScheduler(open: (id: string) => Promise<LiveSession> = async () => Promise.reject(new Error("not found")), openClosed = true) {
  setScheduler(sessionScheduler({ live: () => live, stored: () => config().sessions, open, save: () => {}, openClosed }));
}

describe("the commands", () => {
  test("/loop: interval, prompt, list and stop", () => {
    expect(parseLoopCommand("check CI")).toBeUndefined();
    expect(parseLoopCommand("/loops")).toBeUndefined();
    expect(parseLoopCommand("/loop")).toEqual({ cmd: "list", kind: "loop" });
    expect(parseLoopCommand("/loop list")).toEqual({ cmd: "list", kind: "loop" });
    expect(parseLoopCommand("/loop 10m check CI and fix failures")).toEqual({ cmd: "add", kind: "loop", prompt: "check CI and fix failures", everyMs: 10 * MIN, label: "every 10m" });
    expect(parseLoopCommand("/loop every 1h30m /review\nthe diff")).toMatchObject({ cmd: "add", prompt: "/review\nthe diff", everyMs: 90 * MIN, label: "every 1h 30m" });
    expect(parseLoopCommand("/loop stop")).toEqual({ cmd: "remove", kind: "loop", which: "all" });
    expect(parseLoopCommand("/loop stop 2")).toEqual({ cmd: "remove", kind: "loop", which: 2 });
    expect(parseLoopCommand("/loop stop x")).toMatchObject({ cmd: "error" });
    expect(parseLoopCommand("/loop 30s ping")).toEqual({ cmd: "error", text: "A loop runs at most once a minute." });
    expect(parseLoopCommand("/loop soon ping")).toMatchObject({ cmd: "error", text: expect.stringContaining(`"soon" isn't an interval`) });
    expect(parseLoopCommand("/loop 10m")).toMatchObject({ cmd: "error", text: expect.stringMatching(/^Say what to send\./) });
    expect(parseLoopCommand("/loop 10m /goal ship it")).toMatchObject({ cmd: "error", text: "A loop or schedule can't run /loop, /schedule or /goal." });
  });

  test("/schedule: cron, at, in, list and delete", () => {
    const now = at(2026, 10, 11, 14, 0); // a Sunday
    expect(parseScheduleCommand("/schedule", now)).toEqual({ cmd: "list", kind: "schedule" });
    expect(parseScheduleCommand("/schedule 0 9 * * 1-5 summarize open PRs", now)).toEqual({ cmd: "add", kind: "cron", cron: "0 9 * * 1-5", label: "0 9 * * 1-5", prompt: "summarize open PRs" });
    expect(parseScheduleCommand(`/schedule "*/15 * * * *" poll`, now)).toMatchObject({ cmd: "add", kind: "cron", cron: "*/15 * * * *", prompt: "poll" });
    expect(parseScheduleCommand("/schedule @daily tidy up", now)).toMatchObject({ cmd: "add", kind: "cron", cron: "@daily", prompt: "tidy up" });
    expect(parseScheduleCommand("/schedule at 15:00 deploy", now)).toEqual({ cmd: "add", kind: "once", at: at(2026, 10, 11, 15), label: "at 15:00", prompt: "deploy" });
    // A time already past today means tomorrow.
    expect(parseScheduleCommand("/schedule at 9am standup notes", now)).toMatchObject({ at: at(2026, 10, 12, 9), label: "at 9am", prompt: "standup notes" });
    expect(parseScheduleCommand("/schedule at tomorrow 3:30pm x", now)).toMatchObject({ at: at(2026, 10, 12, 15, 30), label: "at tomorrow 3:30pm" });
    expect(parseScheduleCommand("/schedule at 2026-10-20 08:00 x", now)).toMatchObject({ at: at(2026, 10, 20, 8) });
    expect(parseScheduleCommand("/schedule at 2026-10-01 08:00 x", now)).toMatchObject({ cmd: "error", text: expect.stringContaining("has passed already") });
    expect(parseScheduleCommand("/schedule in 2h check the deploy", now)).toEqual({ cmd: "add", kind: "once", at: now + 120 * MIN, label: "in 2h", prompt: "check the deploy" });
    expect(parseScheduleCommand("/schedule delete 2", now)).toEqual({ cmd: "remove", kind: "schedule", which: 2 });
    expect(parseScheduleCommand("/schedule delete all", now)).toEqual({ cmd: "remove", kind: "schedule", which: "all" });
    expect(parseScheduleCommand("/schedule delete", now)).toMatchObject({ cmd: "error" });
    expect(parseScheduleCommand("/schedule 0 9 * * 1-5", now)).toMatchObject({ cmd: "error", text: expect.stringMatching(/^Say what to send\./) });
    expect(parseScheduleCommand("/schedule 61 9 * * * x", now)).toMatchObject({ cmd: "error", text: expect.stringContaining(`"61" isn't a valid minute field`) });
    expect(parseScheduleCommand("/schedule 0 0 31 2 * never", now)).toMatchObject({ cmd: "error", text: `"0 0 31 2 *" never runs.` });
    expect(parseScheduleCommand("/schedule tomorrow do it", now)).toMatchObject({ cmd: "error" });
  });

  test("durations and times", () => {
    expect(parseInterval("10m")).toBe(10 * MIN);
    expect(parseInterval("1d2h")).toBe(26 * 60 * MIN);
    expect(parseInterval("5min")).toBe(5 * MIN);
    expect(parseInterval("")).toBeUndefined();
    expect(parseInterval("0m")).toBeUndefined();
    expect(fmtInterval(90 * MIN)).toBe("1h 30m");
    expect(parseAt(["15"], 0)).toBeUndefined(); // a bare number isn't a time
    expect(parseAt(["13pm"], 0)).toBeUndefined();
    expect(parseAt(["2026-02-30", "9am"], 0)).toEqual({ error: `"2026-02-30" isn't a date.` });
  });
});

describe("cron", () => {
  test("fields: steps, ranges, lists, names, Sunday as 7", () => {
    expect(cron("*/15 * * * *").minute).toEqual([0, 15, 30, 45]);
    expect(cron("0 9-17/4 * * *").hour).toEqual([9, 13, 17]);
    expect([...cron("0 0 * jan,jul *").month]).toEqual([1, 7]);
    expect([...cron("0 0 * * mon-fri").dow]).toEqual([1, 2, 3, 4, 5]);
    expect([...cron("0 0 * * 7").dow]).toEqual([0]);
    expect(parseCron("* * * *")).toContain("needs 5 fields");
    expect(parseCron("* * * * 8")).toContain("day-of-week");
  });

  test("next run", () => {
    const sun = at(2026, 10, 11, 14, 7);
    expect(nextCron(cron("*/15 * * * *"), sun)).toBe(at(2026, 10, 11, 14, 15));
    // strictly after: at 14:15 exactly, the next is 14:30
    expect(nextCron(cron("*/15 * * * *"), at(2026, 10, 11, 14, 15))).toBe(at(2026, 10, 11, 14, 30));
    // weekdays at 9: Sunday afternoon -> Monday
    expect(nextCron(cron("0 9 * * 1-5"), sun)).toBe(at(2026, 10, 12, 9));
    expect(nextCron(cron("0 9 * * 1-5"), at(2026, 10, 16, 9))).toBe(at(2026, 10, 19, 9)); // Friday 9:00 -> Monday
    // Both day fields restricted: either matches (the 1st, or any Monday).
    expect(nextCron(cron("0 0 1 * mon"), sun)).toBe(at(2026, 10, 12));
    expect(nextCron(cron("0 0 1 * mon"), at(2026, 10, 26, 1))).toBe(at(2026, 11, 1));
    expect(nextCron(cron("0 0 29 2 *"), sun)).toBe(at(2028, 2, 29));
    expect(nextCron(cron("0 0 31 2 *"), sun)).toBeUndefined();
    expect(nextCron(cron("@hourly"), sun)).toBe(at(2026, 10, 11, 15));
  });
});

describe("next run times", () => {
  const add = (text: string, now: number) => newSchedule(parseScheduleCommand(text, now) ?? (parseLoopCommand(text) as any), now)!;

  test("a loop keeps its cadence and skips runs it missed", () => {
    const t0 = at(2026, 10, 11, 14);
    const l = add("/loop 10m check CI", t0);
    expect(l).toMatchObject({ kind: "loop", nextAt: t0, runs: 0 });
    const a = advance(l, t0)!;
    expect(a).toMatchObject({ nextAt: t0 + 10 * MIN, runs: 1, lastRunAt: t0 });
    // Fired 3 s late: still on the 10-minute grid.
    expect(advance(a, t0 + 10 * MIN + 3_000)!.nextAt).toBe(t0 + 20 * MIN);
    // The runner was down for 35 minutes: one run now, the next on the grid after it.
    expect(advance(a, t0 + 45 * MIN)!.nextAt).toBe(t0 + 50 * MIN);
  });

  test("a one-off is over after its run; a cron moves to its next match", () => {
    const now = at(2026, 10, 11, 14);
    expect(advance(add("/schedule in 1h x", now), now + 60 * MIN)).toBeUndefined();
    const c = add("/schedule 0 9 * * * x", now);
    expect(c.nextAt).toBe(at(2026, 10, 12, 9));
    expect(advance(c, at(2026, 10, 12, 9))!.nextAt).toBe(at(2026, 10, 13, 9));
  });

  test("lists are numbered per kind", () => {
    const now = at(2026, 10, 11, 14);
    const list = [add("/loop 10m check CI", now), add("/schedule at 15:00 deploy", now + 1)];
    expect(describeList(list, "loop", now)).toBe("Loops (/loop stop <n> ends one):\n1. Every 10m: check CI Next 14:00.");
    expect(describeList(list, "schedule", now)).toBe("Schedules (/schedule delete <n> removes one):\n1. At 15:00: deploy Next 15:00.");
    expect(describeList([], "loop", now)).toStartWith("No loops.");
  });
});

describe("the runner-wide timer (fake timers)", () => {
  const sched = (id: string, nextAt: number): SessionSchedule => ({ id, kind: "loop", prompt: id, everyMs: 10 * MIN, label: "every 10m", nextAt, runs: 0, createdAt: 0 });

  test("arms for the soonest run, fires what's due, and retries a run that didn't move on only after RETRY_MS", async () => {
    jest.useFakeTimers();
    const t0 = Date.now();
    const sessions = [
      { sessionId: "a", schedules: [sched("a1", t0 + 5 * MIN)] },
      { sessionId: "b", schedules: [sched("b1", t0 + 3 * MIN)] },
    ];
    const fired: string[] = [];
    const s = new Scheduler({
      list: () => sessions,
      fire: async (sid, id) => {
        fired.push(id);
        // b's session moves its run on; a's can't be opened and stays put.
        if (sid === "b") sessions[1]!.schedules = [{ ...sessions[1]!.schedules[0]!, nextAt: Date.now() + 10 * MIN }];
        else throw new Error("gone");
      },
    });
    s.poke();
    jest.advanceTimersByTime(3 * MIN - 1);
    await settle();
    expect(fired).toEqual([]);
    jest.advanceTimersByTime(1);
    await settle();
    expect(fired).toEqual(["b1"]);
    jest.advanceTimersByTime(2 * MIN);
    await settle();
    expect(fired).toEqual(["b1", "a1"]);
    // a1 is still "due" but was just tried: not again until RETRY_MS later (b1's next run comes first).
    jest.advanceTimersByTime(Scheduler.RETRY_MS - 1);
    await settle();
    expect(fired).toEqual(["b1", "a1"]);
    jest.advanceTimersByTime(1);
    await settle();
    expect(fired).toEqual(["b1", "a1", "a1"]);
    jest.advanceTimersByTime(3 * MIN);
    await settle();
    expect(fired).toEqual(["b1", "a1", "a1", "b1"]);
    s.stop();
  });

  test("a far-off run is re-checked hourly", async () => {
    jest.useFakeTimers();
    const t0 = Date.now();
    let looked = 0;
    const s = new Scheduler({
      list: () => (looked++, [{ sessionId: "a", schedules: [sched("a1", t0 + 30 * 60 * MIN)] }]),
      fire: async () => {},
    });
    s.poke();
    const before = looked;
    jest.advanceTimersByTime(Scheduler.MAX_WAIT_MS);
    await settle();
    expect(looked).toBeGreaterThan(before);
    s.stop();
  });
});

describe("runs in a session (fake timers)", () => {
  test("a loop runs now, then every interval; a run due mid-turn waits for the turn, and overlapping runs collapse", async () => {
    jest.useFakeTimers();
    const s = fake();
    runScheduler();
    await s.prompt("/loop 10m check CI and fix failures");
    await settle();
    expect(s.sent).toEqual(["check CI and fix failures"]);
    expect(noticeTexts(s)[0]).toStartWith("Loop set: every 10m. It runs now, then next at ");
    expect(s.schedules).toEqual([expect.objectContaining({ kind: "loop", runs: 1, nextAt: Date.now() + 10 * MIN })]);
    expect(s.title).toBe("check CI and fix failures");
    // The turn is still running at the next run: it waits in the queue, tagged with its loop.
    jest.advanceTimersByTime(10 * MIN);
    await settle();
    expect(s.sent.length).toBe(1);
    expect(s.t.state.pending).toEqual([expect.objectContaining({ text: "check CI and fix failures", mode: "followUp", scheduleId: s.schedules[0]!.id })]);
    // Still running at the one after: it collapses into the waiting run.
    jest.advanceTimersByTime(10 * MIN);
    await settle();
    expect(s.t.state.pending!.length).toBe(1);
    expect(s.schedules[0]!.runs).toBe(3);
    // The turn ends: the waiting run starts the next one.
    await s.endTurn();
    await settle();
    expect(s.sent).toEqual(["check CI and fix failures", "check CI and fix failures"]);
    expect(s.t.state.pending).toEqual([]);
    await s.endTurn();
    // Idle at the next run: it goes at once.
    jest.advanceTimersByTime(10 * MIN);
    await settle();
    expect(s.sent.length).toBe(3);
  });

  test("a loop's turns don't each notify Finished; a schedule's do", async () => {
    jest.useFakeTimers();
    const s = fake();
    runScheduler();
    const finished = () => recent().filter((n) => n.sessionId === s.id && n.title.startsWith("Finished")).length;
    await s.prompt("/loop 10m check CI");
    await settle();
    await s.endTurn();
    expect(finished()).toBe(0);
    await s.prompt("/schedule in 1m report");
    jest.advanceTimersByTime(MIN);
    await settle();
    expect(s.sent.at(-1)).toBe("report");
    await s.endTurn();
    expect(finished()).toBe(1);
  });

  test("a run waits behind your queued messages; after Stop your messages stay held but a run that comes due goes alone", async () => {
    jest.useFakeTimers();
    const s = fake();
    runScheduler();
    await s.prompt("start");
    await s.prompt("/schedule in 5m check the deploy");
    expect(s.sent).toEqual(["start"]);
    await s.prompt("then this", "followUp");
    await s.stop();
    expect(s.t.state.pendingHeld).toBe(true);
    await s.endTurn();
    await settle();
    expect(s.sent).toEqual(["start"]);
    jest.advanceTimersByTime(5 * MIN);
    await settle();
    // Idle after Stop: the run that came due goes by itself; your message stays held.
    expect(s.sent).toEqual(["start", "check the deploy"]);
    expect(s.t.state.pending!.map((p) => p.text)).toEqual(["then this"]);
    expect(s.t.state.pendingHeld).toBe(true);
    // A one-off is gone once it has run.
    expect(s.schedules).toEqual([]);
    await s.endTurn();
    await settle();
    expect(s.sent.length).toBe(2);
    // Your next message releases the hold; the list goes out from the top, one queued message per turn.
    await s.prompt("go on", "followUp");
    await settle();
    expect(s.sent.at(-1)).toBe("then this");
    await s.endTurn();
    await settle();
    expect(s.sent.at(-1)).toBe("go on");
  });

  test("a run waiting when you press Stop stays held until the loop's next run, which sends it once", async () => {
    jest.useFakeTimers();
    const s = fake();
    runScheduler();
    await s.prompt("/loop 10m check CI");
    jest.advanceTimersByTime(10 * MIN);
    await settle();
    expect(s.t.state.pending!.length).toBe(1);
    await s.stop();
    await s.endTurn();
    await settle();
    expect(s.sent).toEqual(["check CI"]);
    expect(s.t.state.pendingHeld).toBe(true);
    jest.advanceTimersByTime(10 * MIN);
    await settle();
    expect(s.sent).toEqual(["check CI", "check CI"]);
    expect(s.t.state.pending).toEqual([]);
    expect(s.t.state.pendingHeld).toBeUndefined();
  });

  test("a run stranded at the top of an idle queue goes at the loop's next run", async () => {
    const s = fake();
    await s.prompt("/loop 10m check CI");
    await settle();
    await s.endTurn();
    const loop = s.schedules[0]!;
    // A failed turn start left the run at the top, idle and not held.
    s.setState({ pending: [{ id: "x", text: "check CI", mode: "followUp", ts: 1, scheduleId: loop.id }] });
    expect(s.runSchedule(loop.id, loop.nextAt)).toBe(true);
    await settle();
    expect(s.sent).toEqual(["check CI", "check CI"]);
    expect(s.t.state.pending).toEqual([]);
  });

  test("a run doesn't start while a question waits on you, and goes once it's answered", async () => {
    jest.useFakeTimers();
    const s = fake();
    runScheduler();
    await s.prompt("/schedule in 1m ping");
    const answered = s.askUi({ id: "q1", kind: "question", title: "Which?", questions: [{ question: "Which?", options: [{ label: "A" }] }] } as any);
    jest.advanceTimersByTime(MIN);
    await settle();
    expect(s.sent).toEqual([]);
    expect(s.t.state.pending!.length).toBe(1);
    s.uiRespond({ id: "q1", answers: { "Which?": "A" } } as any);
    await answered;
    jest.advanceTimersByTime(1);
    await settle();
    expect(s.sent).toEqual(["ping"]);
  });

  test("/loop stop, /schedule delete and the delete button; a waiting run goes with its loop", async () => {
    jest.useFakeTimers();
    const s = fake();
    await s.prompt("busy");
    await s.prompt("/loop 10m a");
    await s.prompt("/loop 20m b");
    await s.prompt("/schedule 0 9 * * * c");
    expect(s.t.state.pending!.map((p) => p.text)).toEqual(["a", "b"]);
    await s.prompt("/loop list");
    expect(noticeTexts(s).at(-1)).toMatch(/^Loops \(\/loop stop <n> ends one\):\n1\. Every 10m: a Next .*\n2\. Every 20m: b Next /);
    await s.prompt("/loop stop 2");
    expect(noticeTexts(s).at(-1)).toBe("Loop stopped: Every 20m: b");
    expect(s.t.state.pending!.map((p) => p.text)).toEqual(["a"]);
    await s.prompt("/loop stop 5");
    expect(noticeTexts(s).at(-1)).toStartWith("There's no loop 5.");
    await s.prompt("/schedule delete 1");
    expect(noticeTexts(s).at(-1)).toBe("Schedule deleted: 0 9 * * *: c");
    s.deleteSchedule(s.schedules[0]!.id);
    expect(noticeTexts(s).at(-1)).toBe("Loop stopped: Every 10m: a");
    expect(s.schedules).toEqual([]);
    expect(s.t.state.pending).toEqual([]);
    await s.prompt("/loop stop");
    expect(noticeTexts(s).at(-1)).toBe("No loops are running.");
    // None of it reached the harness.
    expect(s.sent).toEqual(["busy"]);
  });
});

describe("restart and handoff", () => {
  test("saved with the session, back after a restart; a run that came due meanwhile opens the session and runs once", async () => {
    jest.useFakeTimers();
    const s = fake();
    await s.prompt("/loop 10m check CI");
    await s.endTurn();
    const id = s.nativeId;
    expect(prefs(s.id).schedules).toEqual([expect.objectContaining({ prompt: "check CI", runs: 1 })]);
    s.close();
    live = [];
    // The runner is down for 35 minutes.
    jest.advanceTimersByTime(35 * MIN);
    let opened: ReturnType<typeof fake> | undefined;
    runScheduler(async () => (opened = fake("claude-code", { nativeId: id })));
    jest.advanceTimersByTime(0);
    await settle();
    expect(opened!.sent).toEqual(["check CI"]);
    expect(opened!.schedules[0]).toMatchObject({ runs: 2 });
    // Next on the 10-minute grid: 40 minutes after the first run.
    expect(opened!.schedules[0]!.nextAt - opened!.schedules[0]!.createdAt).toBe(40 * MIN);
  });

  test("a second runner (TETHER_NO_RESUME) doesn't open stored sessions: the run is skipped", async () => {
    jest.useFakeTimers();
    const s = fake();
    await s.prompt("/schedule in 1m ping");
    const sid = s.id;
    s.close();
    live = [];
    let opened = 0;
    runScheduler(async () => {
      opened++;
      return fake();
    }, false);
    jest.advanceTimersByTime(MIN);
    await settle();
    expect(opened).toBe(0);
    expect(prefs(sid).schedules).toBeUndefined();
  });

  test("a run that was waiting when the runner stopped is queued again, still tagged", async () => {
    const s = fake();
    await s.prompt("/loop 10m check CI");
    const p = prefs(s.id);
    p.active = false;
    p.pending = [{ id: "x", text: "check CI", mode: "followUp", ts: 1, scheduleId: s.schedules[0]!.id }];
    s.close();
    live = [];
    let again: ReturnType<typeof fake> | undefined;
    await resumeActive(async (id) => (again = fake("claude-code", { nativeId: id.split(":")[1] })));
    await settle();
    expect(again!.sent).toEqual(["check CI"]);
  });

  test("a session marked done runs none until it's back", async () => {
    jest.useFakeTimers();
    const s = fake();
    const archived: string[] = [];
    let opened: ReturnType<typeof fake> | undefined;
    const open = async () => (opened = fake("claude-code", { nativeId: s.nativeId }));
    setScheduler(sessionScheduler({ live: () => live, stored: () => config().sessions, archived: () => archived, open, save: () => {} }));
    await s.prompt("/loop 10m check CI");
    await settle();
    await s.endTurn();
    // Marked done: the idle session closes (archiveSession), and nothing opens it again.
    archived.push(s.id);
    s.close();
    scheduleChanged();
    jest.advanceTimersByTime(35 * MIN);
    await settle();
    expect(opened).toBeUndefined();
    expect(prefs(s.id).schedules).toEqual([expect.objectContaining({ runs: 1 })]);
    // Back: one run now, then on its grid.
    archived.length = 0;
    scheduleChanged();
    jest.advanceTimersByTime(0);
    await settle();
    expect(opened!.sent).toEqual(["check CI"]);
    expect(opened!.schedules[0]!.nextAt - opened!.schedules[0]!.createdAt).toBe(40 * MIN);
  });

  test("/loop and /schedule are refused in a handed-off session", async () => {
    const s = fake();
    s.setState({ handoffTo: { sessionId: "other", reason: "x" } } as any);
    await s.prompt("/loop 10m check CI");
    expect(s.schedules).toEqual([]);
    expect(noticeTexts(s).at(-1)).toBe("This conversation continues in another session. Set it there.");
    expect(s.sent).toEqual([]);
  });

  test("a handoff moves loops and schedules, and a waiting run, to the new session", async () => {
    const from = fake("claude-code");
    const to = fake("pi");
    const deps: HandoffDeps = {
      adapters: { pi: { create: () => to } } as unknown as HandoffDeps["adapters"],
      sink: { emit: () => {}, summary: () => {}, handoff: async () => {} } as unknown as Sink,
      context: { handoffMemory: async () => undefined },
      track: () => {},
    };
    await from.prompt("/loop 10m check CI");
    await from.prompt("/schedule 0 9 * * * summarize");
    const loopId = from.schedules.find((x) => x.kind === "loop")!.id;
    const cronId = from.schedules.find((x) => x.kind === "cron")!.id;
    from.runSchedule(loopId, Date.now() + 10 * MIN);
    expect(from.t.state.pending!.length).toBe(1);
    // Runs that come due on the new session while its brief turn starts are kept, the loop's collapsed.
    const brief = to.continueTurn.bind(to);
    to.continueTurn = async (text?: string) => {
      await brief(text);
      to.runSchedule(cronId, Date.now() + 2 * 86_400_000);
      to.runSchedule(loopId, Date.now() + 20 * MIN);
    };
    await runHandoff(deps, from, { harness: "pi", model: "default" } as ChainEntry, "Opus hit its usage limit", undefined, { interrupted: true });
    expect(from.schedules).toEqual([]);
    expect(prefs(from.id).schedules).toBeUndefined();
    expect(to.schedules.map((x) => x.prompt).sort()).toEqual(["check CI", "summarize"]);
    expect(to.t.state.pending).toEqual([expect.objectContaining({ text: "check CI", scheduleId: loopId }), expect.objectContaining({ text: "summarize", scheduleId: cronId })]);
    // The old session can't run them any more.
    expect(from.runSchedule(to.schedules[0]!.id, Date.now() + 99 * MIN)).toBe(false);
    // Opened again later, the old session has none.
    from.close();
    const again = fake("claude-code", { nativeId: from.nativeId });
    expect(again.schedules).toEqual([]);
  });
});

describe("the dashboard pulse, the / menu and the capability matrix", () => {
  test("the pulse carries the soonest run", async () => {
    const s = fake();
    await s.prompt("/schedule in 2h later");
    await s.prompt("/schedule in 1h sooner");
    const p = buildPulse({ session: s.summary(), state: s.t.state, messages: s.t.messages });
    expect(p.nextRun).toEqual({ at: s.schedules[0]!.nextAt, label: "sooner", count: 2 });    // The lists show it as scheduled too (the summary's nextRunAt).
    expect(s.summary().nextRunAt).toBe(s.schedules[0]!.nextAt);
  });

  test("Tether's /loop and /schedule on every harness, in place of the harness's own", async () => {
    const s = fake();
    const menu = await s.slashMenu();
    expect(menu.filter((c) => c.name === "loop")).toEqual([expect.objectContaining({ kind: "tether" })]);
    expect(menu.filter((c) => c.name === "schedule")).toEqual([expect.objectContaining({ kind: "tether" })]);
  });

  test("emulated everywhere", () => {
    const m = capabilityMatrix();
    for (const h of ["claude-code", "codex", "pi", "opencode", "kiro", "antigravity"] as const) expect(m[h].schedules.level).toBe("emulated");
  });
});
