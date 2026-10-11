// Session-level activity rules: "Finished" waits for the agent's background work, a quiet turn
// with something still running isn't a stall, and the summary carries the running count.
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import webpush from "web-push";
import type { ActivityItem, SessionSummary } from "../../web/src/shared/protocol";

// (the preloaded src/testenv.ts already points it at the shared scratch dir)
if (!process.env.TETHER_TEST_ROOT) process.env.TETHER_CONFIG_DIR = mkdtempSync(join(tmpdir(), "tether-activity-"));
const { config } = await import("./config");
const { subscribe } = await import("./notify");
const { LiveSession } = await import("./session");

const sent: any[] = [];
(webpush as any).sendNotification = async (_sub: any, payload: string) => void sent.push(JSON.parse(payload));
const summaries: SessionSummary[] = [];
const sink = { emit: () => {}, summary: (s: SessionSummary) => void summaries.push(s), handoff: async () => {} };

beforeEach(() => {
  sent.length = summaries.length = 0;
  config().push = { ...config().push!, subs: [], recent: [] };
  subscribe({ endpoint: "https://push.example/a", keys: { p256dh: "x", auth: "y" }, kinds: ["question", "finished", "blocked"] });
  LiveSession.SETTLE_MS = 0;
});

function fake() {
  class Fake extends LiveSession {
    stopped: string[] = [];
    async start() {}
    protected async send(text: string) {
      this.addUserMessage(text);
      this.setState({ status: "running" });
    }
    reply(text: string) {
      this.emit({ type: "msg", msg: { id: crypto.randomUUID(), role: "assistant", parts: [{ type: "text", text }], ts: Date.now() } });
      this.setState({ status: "idle" });
    }
    protected async stopActivityItem(item: ActivityItem) {
      this.stopped.push(item.id);
    }
    async abort() {
      this.setState({ status: "idle" });
    }
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
  const s = new Fake("claude-code", { nativeId: crypto.randomUUID(), projectPath: "/home/u/proj", title: "Ship it" }, sink);
  s.t.state.status = "idle";
  return s;
}

const item = (id: string, p: Partial<ActivityItem> = {}): ActivityItem => ({ id, kind: "subagent", title: id, status: "running", startedAt: Date.now(), stoppable: true, ...p });
const finished = () => sent.filter((p) => p.kind === "finished");

describe("Finished waits until everything has settled", () => {
  test("a turn that leaves subagents running doesn't notify; the last one ending does, once", async () => {
    const s = fake();
    await s.prompt("fan out");
    s.upsertActivity(item("a1"), item("b1", { kind: "shell" }));
    s.reply("Launched two agents.");
    expect(finished()).toEqual([]);
    s.upsertActivity(item("a1", { status: "done", endedAt: Date.now() }));
    await Bun.sleep(5);
    expect(finished()).toEqual([]);
    s.upsertActivity(item("b1", { kind: "shell", status: "done", endedAt: Date.now() }));
    await Bun.sleep(5);
    expect(finished().length).toBe(1);
    expect(finished()[0].body).toContain("Launched two agents.");
    s.close();
  });

  test("a turn the agent starts on its own about the results waits too, then notifies once", async () => {
    LiveSession.SETTLE_MS = 30;
    const s = fake();
    await s.prompt("fan out");
    s.upsertActivity(item("a1"), item("a2"));
    s.reply("Started.");
    s.upsertActivity(item("a1", { status: "done", endedAt: Date.now() }));
    // a1's report wakes the agent: that turn ends while a2 still runs.
    s.setState({ status: "running" });
    s.reply("a1 is done; waiting on a2.");
    expect(finished()).toEqual([]);
    // a2 ends, and the agent picks it up before the settle delay: only that turn's end notifies.
    s.upsertActivity(item("a2", { status: "done", endedAt: Date.now() }));
    s.setState({ status: "running" });
    await Bun.sleep(50);
    expect(finished()).toEqual([]);
    s.reply("All done.");
    expect(finished().map((p) => p.body)).toEqual(["proj: All done."]);
    s.close();
  });

  test("armed wakeups and cron jobs don't hold it back", async () => {
    const s = fake();
    await s.prompt("check CI every hour");
    s.upsertActivity(item("cron:1", { kind: "schedule", status: "waiting" }));
    s.reply("Scheduled.");
    expect(finished().length).toBe(1);
    s.close();
  });

  test("a foreground item the harness never closed ends with its turn, so Finished still comes", async () => {
    const s = fake();
    s.loadPrefs();
    await s.prompt("run the build");
    // A long tool call (background: false) whose result the interrupt swallowed.
    s.upsertActivity(item("tool:t1", { kind: "tool", background: false }));
    s.reply("Done.");
    expect(s.activity("tool:t1")!.status).toBe("stopped");
    expect(s.busy).toBe(false);
    expect(config().sessions[s.id]!.active).toBe(false);
    expect(finished().length).toBe(1);
    // A late frame from the adapter can't bring it back.
    s.upsertActivity(item("tool:t1", { kind: "tool", background: false, latest: "late" }));
    expect(s.activity("tool:t1")!.status).toBe("stopped");
    expect(s.activeCount).toBe(0);
    s.close();
  });

  test("a shell that runs for good (a dev server) holds Finished back only so long, then says it's still running", async () => {
    LiveSession.SHELL_WAIT_MS = 20;
    try {
      const s = fake();
      await s.prompt("start the dev server");
      s.upsertActivity(item("sh1", { kind: "shell", command: "npm run dev" }), item("a1"));
      s.reply("Server is up.");
      // An agent still working: no cap.
      await Bun.sleep(50);
      expect(finished()).toEqual([]);
      s.upsertActivity(item("a1", { status: "done", endedAt: Date.now() }));
      await Bun.sleep(50);
      expect(finished().map((p) => p.body)).toEqual(["proj: Server is up. (still running: npm run dev)"]);
      // The server stopping later doesn't send another.
      s.upsertActivity(item("sh1", { kind: "shell", status: "stopped", endedAt: Date.now() }));
      await Bun.sleep(20);
      expect(finished().length).toBe(1);
      s.close();
    } finally {
      LiveSession.SHELL_WAIT_MS = 3 * 60_000;
    }
  });

  test("stopping the last running item yourself doesn't send Finished", async () => {
    const s = fake();
    await s.prompt("start a server");
    s.upsertActivity(item("sh1", { kind: "shell" }));
    s.reply("Started it.");
    await s.stopActivity("sh1");
    s.upsertActivity(item("sh1", { kind: "shell", status: "stopped", endedAt: Date.now() }));
    await Bun.sleep(5);
    expect(finished()).toEqual([]);
    s.close();
  });

  test("Stop still isn't 'finished', even when the work settles later", async () => {
    const s = fake();
    await s.prompt("go");
    s.upsertActivity(item("a1"));
    await s.stop();
    s.upsertActivity(item("a1", { status: "stopped", endedAt: Date.now() }));
    await Bun.sleep(5);
    expect(finished()).toEqual([]);
    s.close();
  });
});

describe("stall warning", () => {
  const stalled = (s: any) => {
    s.lastActivity = Date.now() - 16 * 60_000;
    s.checkStall();
    return sent.filter((p) => p.title.startsWith("No activity")).length;
  };

  test("not while a subagent or a tool call is still running", async () => {
    const s = fake();
    await s.prompt("build");
    s.upsertActivity(item("a1"));
    expect(stalled(s)).toBe(0);
    s.upsertActivity(item("a1", { status: "done", endedAt: Date.now() }));
    s.emit({ type: "msg", msg: { id: "m1", role: "assistant", parts: [{ type: "tool", id: "t1", name: "Bash", input: { command: "make" }, status: "running" }], ts: 0 } });
    expect(stalled(s)).toBe(0);
    s.close();
  });

  test("when nothing runs and nothing streams for 15 minutes", async () => {
    const s = fake();
    await s.prompt("think");
    expect(stalled(s)).toBe(1);
    s.close();
  });
});

describe("activity in the session", () => {
  test("the summary carries the running count, and Stop reaches the adapter", async () => {
    const s = fake();
    s.upsertActivity(item("a1"), item("w", { kind: "schedule", status: "waiting" }));
    expect(summaries.at(-1)!.activeCount).toBe(2);
    await s.stopActivity("a1");
    expect((s as any).stopped).toEqual(["a1"]);
    s.upsertActivity(item("x", { stoppable: false }));
    await expect(s.stopActivity("x")).rejects.toThrow("can't stop");
    s.close();
    // Closing the process ends what it ran.
    expect(s.t.state.activity!.every((a) => a.status === "stopped")).toBe(true);
    expect(summaries.at(-1)!.activeCount).toBeUndefined();
  });

  test("the summary goes out again whenever running work starts or ends, not only on status changes", async () => {
    const s = fake();
    await s.prompt("fan out");
    s.upsertActivity(item("a1"), item("a2"), item("sh", { kind: "shell" }));
    s.reply("Launched them.");
    // The main turn is over, the work isn't: the summary says what's still going.
    let last = summaries.at(-1)!;
    expect(last.status).toBe("idle");
    expect(last.activeCount).toBe(3);
    expect(last.runningKinds).toEqual({ subagent: 2, shell: 1 });

    const n = summaries.length;
    s.upsertActivity(item("a1", { status: "done", endedAt: Date.now() }));
    expect(summaries.length).toBe(n + 1);
    expect(summaries.at(-1)!.runningKinds).toEqual({ subagent: 1, shell: 1 });

    // Progress alone changes no counts: no new summary.
    s.upsertActivity(item("a2", { latest: "Reading files" }));
    await Bun.sleep(LiveSession.ACTIVITY_BATCH_MS + 50);
    expect(summaries.length).toBe(n + 1);

    // Same count, different kinds (one ended as another started): still a new summary.
    s.upsertActivity(item("a2", { status: "done", endedAt: Date.now() }), item("m1", { kind: "monitor" }));
    expect(summaries.at(-1)!.runningKinds).toEqual({ shell: 1, monitor: 1 });

    // Only an armed wakeup left: active, but nothing running.
    s.upsertActivity(item("sh", { kind: "shell", status: "done", endedAt: Date.now() }), item("m1", { kind: "monitor", status: "done", endedAt: Date.now() }), item("w", { kind: "schedule", status: "waiting" }));
    last = summaries.at(-1)!;
    expect(last.activeCount).toBe(1);
    expect(last.runningKinds).toEqual({});
    s.close();
  });

  test("progress on a running item is batched; new items and status changes go out at once", async () => {
    const events: any[] = [];
    const s = fake();
    (s as any).sink = { ...sink, emit: (_id: string, _seq: number, e: any) => e.type === "activity" && events.push(e) };
    s.upsertActivity(item("a1"));
    expect(events.length).toBe(1);
    for (let i = 0; i < 5; i++) s.upsertActivity(item("a1", { latest: `step ${i}` }));
    expect(events.length).toBe(1);
    await Bun.sleep(LiveSession.ACTIVITY_BATCH_MS + 50);
    expect(events.length).toBe(2);
    expect(events[1].items).toEqual([expect.objectContaining({ id: "a1", latest: "step 4" })]);
    // A queued progress update rides along with the status change, which isn't delayed.
    s.upsertActivity(item("a1", { latest: "step 5" }));
    s.upsertActivity(item("a1", { status: "done", endedAt: Date.now() }));
    expect(events.length).toBe(3);
    expect(s.activity("a1")!.status).toBe("done");
    s.close();
  });

  test("a restart is told which work it stopped", () => {
    const s = fake();
    s.loadPrefs();
    s.upsertActivity(item("a1", { title: "Refactor auth", agentType: "general-purpose" }));
    expect(s.busy).toBe(true);
    expect(config().sessions[s.id]!.background).toEqual([{ id: "a1", description: "Refactor auth", type: "subagent: general-purpose" }]);
    s.close();
  });
});
