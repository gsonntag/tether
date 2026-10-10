// Answering a waiting approval from another device (Home's inline Approve / Deny): the answer
// settles exactly the request it names, once, and a stale one does nothing.

import { afterEach, describe, expect, test } from "bun:test";
// The scratch HOME and config dir come from the preload (src/testenv.ts, runner/bunfig.toml).
const { LiveSession } = await import("./session");

const sessions: InstanceType<typeof LiveSession>[] = [];
const sink = { emit: () => {}, summary: () => {}, handoff: async () => {} };

function fake() {
  class Fake extends LiveSession {
    async start() {}
    protected async send() {}
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
  const s = new Fake("pi", { nativeId: crypto.randomUUID(), projectPath: "/tmp" }, sink);
  s.t.state.status = "running";
  s.t.state.guard = "ask";
  sessions.push(s);
  return s;
}

const tick = () => new Promise((r) => setTimeout(r, 5));

afterEach(() => {
  sessions.splice(0).forEach((s) => s.close());
});

describe("uiRespond", () => {
  test("approves the named request only; a double tap is stale and changes nothing", async () => {
    const s = fake();
    // (inputs to the guard only: nothing runs them)
    const a = s.checkTool("Bash", { command: "curl https://example.com/a" });
    const b = s.checkTool("Bash", { command: "curl https://example.com/b" });
    await tick();
    const [ra, rb] = s.t.state.pendingUi;
    expect(ra!.tool!.input).toEqual({ command: "curl https://example.com/a" });
    expect(s.uiRespond({ id: rb!.id, allow: true })).toBe(true);
    expect((await b).allow).toBe(true);
    // the second tap names the answered request: nothing happens to the other one still waiting
    expect(s.uiRespond({ id: rb!.id, allow: true })).toBe(false);
    expect(s.t.state.pendingUi.map((r) => r.id)).toEqual([ra!.id]);
    expect(s.uiRespond({ id: ra!.id, allow: false })).toBe(true);
    expect((await a).allow).toBe(false);
  });

  test("a request that took an answered one's place has a new id, so a stale answer can't approve it", async () => {
    const s = fake();
    const first = s.checkTool("Bash", { command: "curl https://example.com/c" });
    await tick();
    const old = s.t.state.pendingUi[0]!;
    s.uiRespond({ id: old.id, allow: false });
    await first;
    const second = s.checkTool("Bash", { command: "curl https://example.com/d" });
    await tick();
    const next = s.t.state.pendingUi[0]!;
    expect(next.id).not.toBe(old.id);
    expect(s.uiRespond({ id: old.id, allow: true })).toBe(false);
    expect(s.t.state.pendingUi).toHaveLength(1);
    s.uiRespond({ id: next.id, allow: false });
    expect((await second).allow).toBe(false);
  });

  test("timed out or cancelled (a stop): stale", async () => {
    const s = fake();
    const r = s.askUi({ id: "q-1", kind: "question", title: "Q", questions: [{ question: "Which?", options: [{ label: "A" }] }] }, 10);
    expect((await r).cancelled).toBe(true);
    expect(s.uiRespond({ id: "q-1", answers: { "Which?": "A" } })).toBe(false);
    const p = s.checkTool("Bash", { command: "curl https://example.com/e" });
    await tick();
    const id = s.t.state.pendingUi[0]!.id;
    s.cancelAllUi();
    expect((await p).allow).toBe(false);
    expect(s.uiRespond({ id, allow: true })).toBe(false);
  });

  test("an answer to one session never reaches another's request with the same id", async () => {
    const s1 = fake();
    const s2 = fake();
    const a = s1.askUi({ id: "same", kind: "confirm", title: "?" });
    void s2.askUi({ id: "same", kind: "confirm", title: "?" });
    expect(s1.uiRespond({ id: "same", confirmed: true })).toBe(true);
    expect((await a).confirmed).toBe(true);
    expect(s2.t.state.pendingUi).toHaveLength(1);
  });
});
