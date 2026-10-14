import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Msg, Part, SessionEvent } from "../../web/src/shared/protocol";
import { applyEvent, emptyState, type Transcript } from "../../web/src/shared/reducer";

// (the preloaded src/testenv.ts already points it at the shared scratch dir)
if (!process.env.TETHER_TEST_ROOT) process.env.TETHER_CONFIG_DIR = mkdtempSync(join(tmpdir(), "tether-runblocked-"));
const { LiveSession } = await import("./session");

const sessions: InstanceType<typeof LiveSession>[] = [];

function fake(status: "running" | "idle") {
  const browser: Transcript = { messages: [], state: emptyState() };
  const sink = { emit: (_id: string, _seq: number, e: SessionEvent) => applyEvent(browser, structuredClone(e)), summary: () => {}, handoff: async () => {} };
  const continued: string[] = [];
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
    async continueTurn(text?: string) {
      if (text) continued.push(text);
    }
    protected shutdown() {}
  }
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tether-runblocked-proj-")));
  const s = new Fake("pi", { nativeId: crypto.randomUUID(), projectPath: dir }, sink);
  s.t.state.status = status;
  sessions.push(s);
  const card = (t: Transcript = s.t) => t.messages.flatMap((m) => m.parts).find((p): p is Extract<Part, { type: "tool" }> => p.type === "tool")!;
  const addCard = (input: unknown, guard: any = { decision: "deny", by: "judge", reason: "Blocked: network" }) => {
    const msg: Msg = { id: "a1", role: "assistant", parts: [{ type: "tool", id: "t1", name: "Bash", input, status: "error", guard }], ts: 0 };
    s.emit({ type: "msg", msg });
  };
  return { s, browser, card, addCard, continued, dir };
}

afterEach(() => {
  sessions.splice(0).forEach((s) => s.close());
});

describe("Run it myself on a blocked command", () => {
  test("runs in the project dir, shows the output on the card and hands it to the agent", async () => {
    const { s, browser, card, addCard, continued, dir } = fake("idle");
    addCard({ command: "pwd && echo hello" });
    await s.runBlocked("t1");
    expect(card(browser).userRun).toEqual({ status: "done", exitCode: 0, output: `${dir}\nhello` });
    expect(card(browser).guard).toMatchObject({ decision: "allow", by: "user" });
    expect(continued).toHaveLength(1);
    expect(continued[0]).toContain("<bash-input>pwd && echo hello</bash-input>");
    expect(continued[0]).toContain("hello");
    expect(continued[0]).toContain("don't run it again");
  });

  test("a failing command reports its exit code", async () => {
    const { s, card, addCard, continued } = fake("idle");
    addCard({ command: "echo oops >&2; exit 3" });
    await s.runBlocked("t1");
    expect(card().userRun).toMatchObject({ status: "done", exitCode: 3, output: "oops" });
    expect(continued[0]).toContain("(exit code 3)");
  });

  test("while the agent is running, the result waits in the queue instead of starting a turn", async () => {
    const { s, addCard, continued } = fake("running");
    addCard({ command: "echo hi" });
    await s.runBlocked("t1");
    expect(continued).toHaveLength(0);
    expect((s.t.state.pending ?? []).some((p) => p.text.includes("<bash-input>echo hi</bash-input>"))).toBe(true);
  });

  test("runs once, even when clicked twice", async () => {
    const { s, addCard, continued } = fake("idle");
    addCard({ command: "echo once" });
    await Promise.all([s.runBlocked("t1"), s.runBlocked("t1")]);
    await s.runBlocked("t1");
    expect(continued).toHaveLength(1);
  });

  test("a call plan mode or a review held back needs a second yes", async () => {
    const held = { decision: "deny", by: "mode", reason: "Plan mode: changes wait until you approve the plan." };
    const a = fake("idle");
    a.addCard({ command: "echo held" }, held);
    expect(a.s.runBlocked("t1")).rejects.toThrow("Confirm to run it anyway");
    expect(a.card().userRun).toBeUndefined();
    await a.s.runBlocked("t1", true);
    expect(a.card().userRun).toMatchObject({ status: "done", exitCode: 0, output: "held" });
    const b = fake("idle");
    b.addCard({ file_path: "x.ts" }, held);
    expect(b.s.approveBlocked("t1")).rejects.toThrow("Confirm to run it anyway");
    await b.s.approveBlocked("t1", true);
    expect(b.card().guard).toMatchObject({ decision: "allow", by: "user" });
    expect(b.continued).toHaveLength(1);
  });

  test("only blocked shell calls", async () => {
    const a = fake("idle");
    a.addCard({ command: "echo hi" }, { decision: "allow", by: "judge" });
    expect(a.s.runBlocked("t1")).rejects.toThrow("Only a blocked command");
    const b = fake("idle");
    b.addCard({ file_path: "/etc/hosts" });
    expect(b.s.runBlocked("t1")).rejects.toThrow("Shell command not found");
    // An MCP tool that takes a `command` isn't a shell command to run here.
    const c = fake("idle");
    const guard = { decision: "deny", by: "judge", reason: "Blocked" } as const;
    c.s.emit({ type: "msg", msg: { id: "a1", role: "assistant", parts: [{ type: "tool", id: "t1", name: "mcp__ops__run", input: { command: "deploy" }, status: "error", guard }], ts: 0 } });
    expect(c.s.runBlocked("t1")).rejects.toThrow("Shell command not found");
  });
});
