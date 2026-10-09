import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.TETHER_CONFIG_DIR = mkdtempSync(join(tmpdir(), "tether-pending-"));
const { LiveSession } = await import("./session");

const sink = { emit: () => {}, summary: () => {}, handoff: async () => {} };
const sessions: InstanceType<typeof LiveSession>[] = [];

/** A harness that records what it was given; turns end when the test says so. */
function fake(opts: { steers?: boolean } = {}) {
  const log: string[] = [];
  class Fake extends LiveSession {
    async start() {}
    protected async send(text: string) {
      log.push(`turn: ${text}`);
      this.addUserMessage(text);
      this.setState({ status: "running" });
    }
    async endTurn() {
      if (!(await this.drainPending())) this.setState({ status: "idle" });
    }
    async abort() {
      log.push("abort");
      await this.endTurn();
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
  if (opts.steers !== false)
    (Fake.prototype as any).steer = async function (text: string) {
      log.push(`steer: ${text}`);
      return true;
    };
  const s = new Fake("pi", { nativeId: crypto.randomUUID(), projectPath: "/tmp" }, sink);
  s.t.state.status = "idle";
  sessions.push(s);
  return { s, log, texts: () => (s.t.state.pending ?? []).map((p) => `${p.mode}:${p.text}`) };
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

beforeAll(() => {
  LiveSession.STEER_GRACE_MS = 20;
});
afterEach(() => sessions.splice(0).forEach((s) => s.close()));

describe("pending messages", () => {
  test("idle: a message starts a turn", async () => {
    const { s, log } = fake();
    await s.prompt("hello");
    expect(log).toEqual(["turn: hello"]);
  });

  test("a steer waits out its grace period, then goes into the running turn", async () => {
    const { s, log, texts } = fake();
    await s.prompt("go");
    await s.prompt("also this", "steer");
    expect(texts()).toEqual(["steer:also this"]);
    expect(log).toEqual(["turn: go"]);
    await tick();
    expect(log).toEqual(["turn: go", "steer: also this"]);
    expect(texts()).toEqual([]);
    expect(s.t.state.amendable?.length).toBe(1);
  });

  test("a queued message blocks steers behind it; they steer into the turn it starts", async () => {
    const { s, log, texts } = fake();
    await s.prompt("go");
    await s.prompt("later", "followUp");
    await s.prompt("steer", "steer");
    await tick();
    expect(texts()).toEqual(["followUp:later", "steer:steer"]);
    await (s as any).endTurn();
    expect(log).toEqual(["turn: go", "turn: later"]);
    expect(texts()).toEqual(["steer:steer"]);
    await tick();
    expect(log).toEqual(["turn: go", "turn: later", "steer: steer"]);
    expect(texts()).toEqual([]);
  });

  test("queued messages go one per turn, in order", async () => {
    const { s, log, texts } = fake();
    await s.prompt("go");
    await s.prompt("one", "followUp");
    await s.prompt("two", "followUp");
    await s.prompt("three", "followUp");
    await (s as any).endTurn();
    expect(log).toEqual(["turn: go", "turn: one"]);
    expect(texts()).toEqual(["followUp:two", "followUp:three"]);
    await (s as any).endTurn();
    expect(log).toEqual(["turn: go", "turn: one", "turn: two"]);
    await (s as any).endTurn();
    expect(log).toEqual(["turn: go", "turn: one", "turn: two", "turn: three"]);
    await (s as any).endTurn();
    expect(s.t.state.status).toBe("idle");
    expect(s.t.state.amendable).toBeUndefined();
  });

  test("steers between queued messages wait for their turn", async () => {
    const { s, log, texts } = fake();
    await s.prompt("go");
    await s.prompt("q1", "followUp");
    await s.prompt("s1", "steer");
    await s.prompt("q2", "followUp");
    await s.prompt("s2", "steer");
    await tick();
    expect(log).toEqual(["turn: go"]);
    await (s as any).endTurn();
    await tick();
    expect(log).toEqual(["turn: go", "turn: q1", "steer: s1"]);
    expect(texts()).toEqual(["followUp:q2", "steer:s2"]);
    await (s as any).endTurn();
    await tick();
    expect(log).toEqual(["turn: go", "turn: q1", "steer: s1", "turn: q2", "steer: s2"]);
  });

  test("a steer with nothing queued above it doesn't wait for the turn to end", async () => {
    const { s, log } = fake();
    await s.prompt("go");
    await s.prompt("s", "steer");
    await s.prompt("q", "followUp");
    await tick();
    expect(log).toEqual(["turn: go", "steer: s"]);
    await (s as any).endTurn();
    expect(log).toEqual(["turn: go", "steer: s", "turn: q"]);
  });

  test("steers left at the top when a turn ends go as their own turn, before the queue", async () => {
    const { s, log } = fake({ steers: false });
    await s.prompt("go");
    await s.prompt("a", "steer");
    await s.prompt("q", "followUp");
    await (s as any).endTurn();
    expect(log).toEqual(["turn: go", "turn: a"]);
    await (s as any).endTurn();
    expect(log).toEqual(["turn: go", "turn: a", "turn: q"]);
  });

  test("dragging a steer above a queued message lets it go", async () => {
    const { s, log } = fake();
    await s.prompt("go");
    await s.prompt("later", "followUp");
    await s.prompt("now", "steer");
    const id = s.t.state.pending![1]!.id;
    await s.editPending(id, { index: 0 });
    await tick();
    expect(log).toEqual(["turn: go", "steer: now"]);
    expect(s.t.state.pending!.map((p) => p.text)).toEqual(["later"]);
  });

  test("editing a steer restarts its grace period; remove cancels it", async () => {
    const { s, log } = fake();
    await s.prompt("go");
    await s.prompt("typo", "steer");
    const id = s.t.state.pending![0]!.id;
    await tick(10);
    await s.editPending(id, { text: "fixed" });
    await tick(15);
    expect(log).toEqual(["turn: go"]);
    await tick(20);
    expect(log).toEqual(["turn: go", "steer: fixed"]);
    await s.prompt("never mind", "steer");
    await s.editPending(s.t.state.pending![0]!.id, { remove: true });
    await tick();
    expect(log).toEqual(["turn: go", "steer: fixed"]);
  });

  test("harness without steering: steers wait for the end of the turn", async () => {
    const { s, log } = fake({ steers: false });
    await s.prompt("go");
    await s.prompt("a", "steer");
    await s.prompt("b", "steer");
    await tick();
    expect(log).toEqual(["turn: go"]);
    await (s as any).endTurn();
    expect(log).toEqual(["turn: go", "turn: a\n\nb"]);
  });

  test("Stop holds pending messages until sent", async () => {
    const { s, log } = fake();
    await s.prompt("go");
    await s.prompt("queued", "followUp");
    await s.stop();
    expect(log).toEqual(["turn: go", "abort"]);
    expect(s.t.state.pendingHeld).toBe(true);
    await s.editPending(s.t.state.pending![0]!.id, { now: true });
    expect(log).toEqual(["turn: go", "abort", "turn: queued"]);
    expect(s.t.state.pendingHeld).toBeUndefined();
  });

  test("Stop, then send now on one of several held messages: it goes first, the rest one at a time", async () => {
    const { s, log, texts } = fake();
    await s.prompt("go");
    await s.prompt("one", "followUp");
    await s.prompt("two", "followUp");
    await s.stop();
    await s.editPending(s.t.state.pending![1]!.id, { now: true });
    expect(log).toEqual(["turn: go", "abort", "turn: two"]);
    expect(texts()).toEqual(["followUp:one"]);
    await (s as any).endTurn();
    expect(log.at(-1)).toBe("turn: one");
  });

  test("a new message after Stop releases the held ones and joins the bottom", async () => {
    const { s, log, texts } = fake();
    await s.prompt("go");
    await s.prompt("held1", "followUp");
    await s.prompt("held2", "followUp");
    await s.stop();
    await s.prompt("new", "followUp");
    expect(log.at(-1)).toBe("turn: held1");
    expect(texts()).toEqual(["followUp:held2", "followUp:new"]);
    expect(s.t.state.pendingHeld).toBeUndefined();
    await (s as any).endTurn();
    await (s as any).endTurn();
    expect(log.slice(-3)).toEqual(["turn: held1", "turn: held2", "turn: new"]);
  });

  test("↑ takes everything pending back", async () => {
    const { s } = fake();
    await s.prompt("go");
    await s.prompt("one", "followUp");
    await s.prompt("two", "steer");
    expect(s.takePending()).toBe("one\n\ntwo");
    expect(s.t.state.pending).toEqual([]);
  });

  test("editing a delivered steer sends a correction", async () => {
    const { s, log } = fake();
    await s.prompt("go");
    await s.prompt("use red", "steer");
    await tick();
    const msgId = s.t.state.amendable![0]!;
    s.amendSteer(msgId, "use blue");
    await tick();
    expect(log.at(-1)).toContain("> use red");
    expect(log.at(-1)).toContain("> use blue");
    await (s as any).endTurn();
    expect(() => s.amendSteer(msgId, "green")).toThrow();
  });
});
