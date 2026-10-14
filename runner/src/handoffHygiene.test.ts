// Mid-turn handoff hygiene: the old session's open approvals/questions are cancelled, its
// background tasks stopped (where the harness can), and the brief says so (handoff.ts buildBrief).

import { resetHome } from "./testenv";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ActivityItem, UiResponse } from "../../web/src/shared/protocol";
import { buildBrief, describeRequest, describeTask } from "./handoff";
import { LiveSession } from "./session";

const sessions: LiveSession[] = [];
beforeEach(() => resetHome());
afterEach(() => sessions.splice(0).forEach((s) => s.close()));

function fake(opts: { canStop?: boolean; hangs?: string[] } = {}) {
  const stopped: string[] = [];
  const sink = { emit: () => {}, summary: () => {}, handoff: async () => {} };
  class Fake extends LiveSession {
    async start() {}
    protected async send() {}
    async abort() {}
    async applyModel() {}
    async setThinking() {}
    async setPermissionMode() {}
    async rename() {}
    async listCommands() {
      return [];
    }
    async continueTurn() {}
    protected shutdown() {}
  }
  const s = new Fake("claude-code", { nativeId: crypto.randomUUID(), projectPath: process.env.HOME! }, sink);
  if (opts.canStop)
    (s as any).stopActivityItem = async (item: ActivityItem) => {
      if (opts.hangs?.includes(item.id)) return new Promise(() => {});
      stopped.push(item.id);
    };
  s.t.state.status = "idle";
  sessions.push(s);
  return { s, stopped };
}

const item = (id: string, p: Partial<ActivityItem> = {}): ActivityItem => ({ id, kind: "shell", title: id, status: "running", startedAt: 1, background: true, stoppable: true, ...p });

describe("stopBackground", () => {
  test("stops every running background item the harness can stop; a subagent's own items go with it", async () => {
    const { s, stopped } = fake({ canStop: true });
    s.upsertActivity(
      item("dev", { command: "npm run dev" }),
      item("agent", { kind: "subagent", title: "Explore auth", agentType: "Explore" }),
      item("child", { parentId: "agent" }),
      item("long", { background: false }),
      item("done", { status: "done" }),
      item("cron", { kind: "schedule", status: "waiting", stoppable: false, schedule: "every 30 minutes" }),
    );
    const r = await s.stopBackground();
    expect(stopped).toEqual(["dev", "agent"]);
    expect(r.map((x) => [x.item.id, x.stopped])).toEqual([
      ["dev", true],
      ["agent", true],
      ["cron", false],
    ]);
  });

  test("a harness without a stop mechanism, or a stop that hangs: listed as not stopped", async () => {
    const a = fake();
    a.s.upsertActivity(item("dev"));
    expect((await a.s.stopBackground()).map((x) => x.stopped)).toEqual([false]);
    const b = fake({ canStop: true, hangs: ["dev"] });
    b.s.upsertActivity(item("dev"));
    expect((await b.s.stopBackground(20)).map((x) => x.stopped)).toEqual([false]);
  });
});

describe("cancelOpenUi", () => {
  test("cancels open approvals and questions and returns them", async () => {
    const { s } = fake();
    const answers: Promise<UiResponse>[] = [
      s.askUi({ id: "p1", kind: "permission", title: "Allow Bash?", tool: { name: "Bash", input: { command: "rm -rf build" } } }),
      s.askUi({ id: "q1", kind: "question", title: "Q", questions: [{ question: "Which database?", options: [] }] }),
    ];
    const open = s.cancelOpenUi();
    expect(open.map((r) => r.id)).toEqual(["p1", "q1"]);
    expect((await Promise.all(answers)).every((r) => r.cancelled)).toBe(true);
    expect(s.t.state.pendingUi).toEqual([]);
  });
});

describe("buildBrief", () => {
  test("an interrupted handoff says so, lists what was cancelled and stopped, and asks for a working-tree check", async () => {
    const brief = await buildBrief({
      messages: [],
      cwd: process.env.HOME!,
      fromLabel: "claude-code, Opus",
      reason: "Opus hit its usage limit",
      interrupted: true,
      cancelled: [
        { id: "p1", kind: "permission", title: "Allow Bash?", tool: { name: "Bash", input: { command: "rm -rf build" } } },
        { id: "q1", kind: "question", title: "Q", questions: [{ question: "Which database?", options: [] }] },
      ],
      tasks: [
        { item: item("dev", { command: "npm run dev" }), stopped: true },
        { item: item("agent", { kind: "subagent", title: "Explore auth", agentType: "Explore" }), stopped: true },
        { item: item("watch", { kind: "monitor", watching: "tail -f log" }), stopped: false },
      ],
    });
    expect(brief).toContain("## Interrupted work");
    expect(brief).toContain("interrupted in the middle of its task");
    expect(brief).toContain("`git status`, `git diff`");
    expect(brief).toContain("- Approval for Bash: rm -rf build");
    expect(brief).toContain("- Question: Which database?");
    expect(brief).toContain("These background tasks of the previous agent were stopped:\n- shell: npm run dev\n- subagent (Explore): Explore auth\nRestart the ones that are still needed.");
    expect(brief).toContain("could not be stopped and may still be running:\n- monitor: tail -f log");
    expect(brief).toContain("Inspect the working tree first");
  });

  test("a handoff at a turn boundary has no interrupted section", async () => {
    const brief = await buildBrief({ messages: [], cwd: process.env.HOME!, fromLabel: "codex, GPT-5.5", reason: "Opus is available again", pendingPrompt: "next" });
    expect(brief).not.toContain("## Interrupted work");
    expect(brief).toContain("The user's new message:\n\nnext");
  });

  test("labels", () => {
    expect(describeRequest({ id: "x", kind: "plan", title: "Plan" })).toBe("Review of its plan");
    expect(describeTask(item("c", { kind: "schedule", title: "check CI", schedule: "every 30 minutes" }))).toBe("schedule: check CI (every 30 minutes)");
  });
});
