import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Msg, Part, SessionEvent } from "../../web/src/shared/protocol";
import { applyEvent, emptyState, type Transcript } from "../../web/src/shared/reducer";

// (the preloaded src/testenv.ts already points it at the shared scratch dir)
if (!process.env.TETHER_TEST_ROOT) process.env.TETHER_CONFIG_DIR = mkdtempSync(join(tmpdir(), "tether-judging-"));

// The judge answers when the test says so.
let answer: (v: { decision: "allow" | "deny"; by: "judge"; reason: string }) => void = () => {};
let fail = false;
const guard = await import("./guard");
mock.module("./guard", () => ({
  ...guard,
  judge: () => {
    if (fail) return Promise.reject(new Error("judge crashed"));
    return new Promise((r) => (answer = r));
  },
}));
const { LiveSession } = await import("./session");

const sessions: InstanceType<typeof LiveSession>[] = [];

function fake() {
  // A browser's copy, fed the same events, to check replay and live updates agree.
  const browser: Transcript = { messages: [], state: emptyState() };
  const sink = { emit: (_id: string, _seq: number, e: SessionEvent) => applyEvent(browser, structuredClone(e)), summary: () => {}, handoff: async () => {} };
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
  sessions.push(s);
  const card = (t: Transcript = s.t) => t.messages.flatMap((m) => m.parts).find((p): p is Extract<Part, { type: "tool" }> => p.type === "tool")!;
  const addCard = () => {
    const msg: Msg = { id: "a1", role: "assistant", parts: [{ type: "tool", id: "t1", name: "Bash", input: { command: "curl https://example.com" }, status: "running" }], ts: 0 };
    s.emit({ type: "msg", msg });
  };
  return { s, browser, card, addCard };
}

const tick = () => new Promise((r) => setTimeout(r, 5));
const call = { command: "curl https://example.com" };

afterEach(() => {
  fail = false;
  sessions.splice(0).forEach((s) => s.close());
});

describe("judging shows on the tool card", () => {
  test("pending while judged, then the verdict replaces it; no session status", async () => {
    const { s, browser, card, addCard } = fake();
    addCard();
    const res = s.checkTool("Bash", call, "t1");
    await tick();
    expect(card().judging).toBe(true);
    expect(card(browser).judging).toBe(true);
    expect(s.t.state.statuses).toEqual({});
    // A reload mid-judgment gets the flag from the snapshot.
    expect((s.snapshot().messages[0]!.parts[0] as any).judging).toBe(true);
    answer({ decision: "allow", by: "judge", reason: "fine" });
    expect((await res).allow).toBe(true);
    expect(card().judging).toBeUndefined();
    expect(card(browser).judging).toBeUndefined();
    expect(card(browser).guard?.by).toBe("judge");
  });

  test("deny clears it too", async () => {
    const { s, browser, card, addCard } = fake();
    addCard();
    const res = s.checkTool("Bash", call, "t1");
    await tick();
    answer({ decision: "deny", by: "judge", reason: "no" });
    expect((await res).allow).toBe(false);
    expect(card(browser).judging).toBeUndefined();
    expect(card(browser).guard?.decision).toBe("deny");
  });

  test("a judge error clears it", async () => {
    const { s, browser, card, addCard } = fake();
    addCard();
    fail = true;
    await expect(s.checkTool("Bash", call, "t1")).rejects.toThrow();
    expect(card(browser).judging).toBeUndefined();
  });

  test("stop clears it at once; the late verdict still lands", async () => {
    const { s, browser, card, addCard } = fake();
    addCard();
    const res = s.checkTool("Bash", call, "t1");
    await tick();
    await s.stop();
    expect(card(browser).judging).toBeUndefined();
    answer({ decision: "allow", by: "judge", reason: "fine" });
    await res;
    expect(card(browser).judging).toBeUndefined();
    expect(card(browser).guard?.by).toBe("judge");
  });

  test("a card that arrives after judging started shows it", async () => {
    const { s, browser, card, addCard } = fake();
    const res = s.checkTool("Bash", call, "t1");
    await tick();
    addCard();
    expect(card(browser).judging).toBe(true);
    answer({ decision: "allow", by: "judge", reason: "fine" });
    await res;
    expect(card(browser).judging).toBeUndefined();
    expect(card(browser).guard?.by).toBe("judge");
  });

  test("the call finishing clears it", () => {
    const t: Transcript = { messages: [{ id: "a", role: "assistant", ts: 0, parts: [{ type: "tool", id: "x", name: "Bash", input: {}, status: "running", judging: true }] }], state: emptyState() };
    applyEvent(t, { type: "tool", msgId: "a", toolId: "x", patch: { status: "error" } });
    expect((t.messages[0]!.parts[0] as any).judging).toBeUndefined();
  });
});
