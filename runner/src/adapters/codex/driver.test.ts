import { afterEach, expect, test } from "bun:test";
import { FROM_TETHER } from "../../../../shared/fromTether";
import { RESOLVED_ELSEWHERE } from "../../core/adapter";
import { setConnector } from "./daemon";
import { CodexDriver, createThread } from "./driver";
import { CodexRpc } from "./rpc";
import { frames, TestSink } from "./testSink";

const MAIN = "01a187c7-9ae6-7631-b0cc-596277bb8c13";
const CWD = "/tmp";

/** A scripted daemon: answers calls, records everything the client sends. */
class FakeDaemon {
  sent: any[] = [];
  rpc = new CodexRpc();
  answers: Record<string, (p: any) => unknown> = {
    "thread/resume": () => ({ thread: { id: MAIN, status: { type: "idle" } }, model: "gpt-6-luna", reasoningEffort: "low", approvalPolicy: "untrusted", sandbox: { type: "workspaceWrite" } }),
    "thread/start": () => ({ thread: { id: "NEW", status: { type: "idle" } }, model: "gpt-6-luna", approvalPolicy: "on-request", sandbox: { type: "readOnly" } }),
    "turn/start": () => ({ turn: { id: "t9" } }),
  };
  constructor() {
    this.rpc.wire = {
      send: (text) => {
        const m = JSON.parse(text);
        this.sent.push(m);
        if (m.method && m.id !== undefined) queueMicrotask(() => this.rpc.receive(JSON.stringify({ id: m.id, result: this.answers[m.method]?.(m.params) ?? {} })));
      },
      close: () => {},
    };
  }
  /** Feeds what the daemon says. */
  say(m: any) {
    this.rpc.receive(JSON.stringify(m));
  }
  calls(method: string) {
    return this.sent.filter((m) => m.method === method && m.id !== undefined).map((m) => m.params);
  }
  replies(id: number | string) {
    return this.sent.filter((m) => m.id === id && !m.method);
  }
}

let daemon: FakeDaemon;
afterEach(() => setConnector(undefined));
function useDaemon() {
  daemon = new FakeDaemon();
  setConnector(async () => daemon.rpc);
}

test("resume: Tether's settings and approvals routed to it; the thread's own settings fill the rest", async () => {
  useDaemon();
  const sink = new TestSink();
  await CodexDriver.open(MAIN, CWD, { permissionMode: "auto" }, sink, true);
  expect(daemon.calls("thread/resume")[0]).toEqual({ threadId: MAIN, approvalsReviewer: "user", approvalPolicy: "on-request", sandbox: "workspace-write", excludeTurns: true });
  expect(sink.states[0]).toEqual({ modelResolved: "gpt-6-luna", model: "gpt-6-luna", effort: "low" });
});

test("an approval answered in another client (Codex's TUI) closes as resolved elsewhere, and Tether sends no answer", async () => {
  useDaemon();
  const sink = new TestSink();
  await CodexDriver.open(MAIN, CWD, {}, sink, true);
  for (const m of await frames("approval-steer.jsonl")) {
    if (m.method === undefined) continue; // the recorded client's own answers
    daemon.say(m);
    if (m.method === "item/commandExecution/requestApproval") {
      expect(sink.asks).toHaveLength(1);
      expect(sink.asks[0]!.ask).toMatchObject({ tool: "bash", command: "sleep 3 && echo done > out.txt", toolId: "exec-bf2427f0-bfa8-4463-b269-17e857e4a2e5" });
    }
  }
  expect(sink.asks[0]!.signal!.aborted).toBe(true);
  expect(sink.asks[0]!.signal!.reason).toBe(RESOLVED_ELSEWHERE);
  await Bun.sleep(5);
  expect(daemon.replies(0)).toEqual([]);
  expect(sink.t.messages.at(-1)!.parts).toEqual([{ type: "text", text: "The command completed successfully. BANANA" }]);
});

test("answered in Tether: the daemon gets the decision; a denial's reason goes into the turn", async () => {
  useDaemon();
  const sink = new TestSink();
  const d = await CodexDriver.open(MAIN, CWD, {}, sink, true);
  daemon.say({ method: "turn/started", params: { threadId: MAIN, turn: { id: "t1" } } });
  const ask = { threadId: MAIN, turnId: "t1", itemId: "exec-1", command: "rm x" };
  daemon.say({ id: 7, method: "item/commandExecution/requestApproval", params: ask });
  sink.asks[0]!.resolve({ allow: true });
  await Bun.sleep(5);
  expect(daemon.replies(7)).toEqual([{ id: 7, result: { decision: "accept" } }]);
  daemon.say({ id: 8, method: "item/commandExecution/requestApproval", params: ask });
  sink.asks[1]!.resolve({ allow: false, reason: "The user denied this request and said: use trash" });
  await Bun.sleep(5);
  expect(daemon.replies(8)).toEqual([{ id: 8, result: { decision: "decline" } }]);
  expect(daemon.calls("turn/steer")[0]).toEqual({ threadId: MAIN, expectedTurnId: "t1", input: [{ type: "text", text: `${FROM_TETHER}The user denied this request and said: use trash`, text_elements: [] }] });
  // Methods Tether doesn't handle are refused, not left hanging.
  daemon.say({ id: 9, method: "item/tool/call", params: {} });
  await Bun.sleep(5);
  expect(daemon.replies(9)[0].error.code).toBe(-32601);
  void d;
});

test("send, steer, interrupt and settings go to the thread; steering needs a running turn", async () => {
  useDaemon();
  const sink = new TestSink();
  const d = await CodexDriver.open(MAIN, CWD, {}, sink, true);
  await expect(d.steer("x")).rejects.toThrow("Nothing is running");
  await d.send("hello");
  expect(daemon.calls("turn/start")[0]).toEqual({ threadId: MAIN, input: [{ type: "text", text: "hello", text_elements: [] }] });
  expect(sink.status).toBe("running");
  daemon.say({ method: "turn/started", params: { threadId: MAIN, turn: { id: "t9" } } });
  await d.steer("also");
  expect(daemon.calls("turn/steer")[0]).toMatchObject({ threadId: MAIN, expectedTurnId: "t9" });
  await d.interrupt();
  expect(daemon.calls("turn/interrupt")[0]).toEqual({ threadId: MAIN, turnId: "t9" });
  await d.setPermissionMode("read-only");
  await d.setEffort("low");
  expect(daemon.calls("thread/settings/update")).toEqual([
    { threadId: MAIN, approvalPolicy: "on-request", sandboxPolicy: { type: "readOnly", networkAccess: false }, approvalsReviewer: "user" },
    { threadId: MAIN, effort: "low" },
  ]);
  // A setting changed in the TUI shows in Tether.
  daemon.say({ method: "thread/settings/updated", params: { threadId: MAIN, threadSettings: { model: "gpt-6-sol", effort: "high", approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } } } });
  expect(sink.states.at(-1)).toEqual({ modelResolved: "gpt-6-sol", effort: "high", permissionMode: "full-access" });
});

test("a subagent: stopped and steered on its own thread", async () => {
  useDaemon();
  const sink = new TestSink();
  const d = await CodexDriver.open(MAIN, CWD, {}, sink, true);
  daemon.say({ method: "turn/started", params: { threadId: MAIN, turn: { id: "t1" } } });
  daemon.say({ method: "item/completed", params: { threadId: MAIN, item: { type: "subAgentActivity", id: "call_1", kind: "started", agentThreadId: "C", agentPath: "/root/scan" } } });
  daemon.say({ method: "turn/started", params: { threadId: "C", turn: { id: "ct" } } });
  expect(d.busy()).toBe(true);
  await d.steerSubagent("C", "check docs too");
  await d.stopSubagent("C");
  expect(daemon.calls("turn/steer")[0]).toMatchObject({ threadId: "C", expectedTurnId: "ct" });
  expect(daemon.calls("turn/interrupt")[0]).toEqual({ threadId: "C", turnId: "ct" });
  daemon.say({ method: "turn/completed", params: { threadId: "C", turn: { id: "ct", status: "interrupted" } } });
  expect(d.busy()).toBe(false);
  expect(sink.children.get("C")!.endedCount).toBe(1);
});

test("a new session: the thread is made first, its driver takes it; Codex's TUI can join once it's named", async () => {
  useDaemon();
  const id = await createThread(CWD, { model: "gpt-6-luna", permissionMode: "read-only" });
  expect(id).toBe("NEW");
  expect(daemon.calls("thread/start")[0]).toEqual({ cwd: CWD, approvalsReviewer: "user", model: "gpt-6-luna", approvalPolicy: "on-request", sandbox: "read-only" });
  const sink = new TestSink();
  const d = await CodexDriver.open(id, CWD, { model: "gpt-6-luna", permissionMode: "read-only" }, sink, false);
  expect(daemon.calls("thread/resume")).toEqual([]);
  await d.beforeTerminal();
  await d.beforeTerminal();
  expect(daemon.calls("thread/name/set")).toHaveLength(1);
  await expect(CodexDriver.open("GONE", CWD, {}, new TestSink(), false)).rejects.toThrow("is gone");
});

test("the daemon connection drops: the session says so and goes stored", async () => {
  useDaemon();
  const sink = new TestSink();
  const d = await CodexDriver.open(MAIN, CWD, {}, sink, true);
  let exit: string | undefined;
  d.onExit = (e) => (exit = e);
  daemon.rpc.ended("socket closed");
  expect(exit).toContain("connection to the Codex daemon closed");
  await expect(d.send("x")).rejects.toThrow("isn't connected");
});
