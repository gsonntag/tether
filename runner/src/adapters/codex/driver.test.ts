import { afterEach, expect, test } from "bun:test";
import { FROM_TETHER } from "../../../../shared/fromTether";
import { RESOLVED_ELSEWHERE } from "../../core/adapter";
import { setConnector } from "./daemon";
import { CodexDriver, createThread } from "./driver";
import { CodexRpc } from "./rpc";
import { rememberIn } from "./remember";
import { frames, TestSink } from "./testSink";

const MAIN = "01a187c7-9ae6-7631-b0cc-596277bb8c13";
const CWD = "/tmp";

/** A scripted daemon: answers calls, records everything the client sends. */
class FakeDaemon {
  sent: any[] = [];
  rpc = new CodexRpc();
  answers: Record<string, (p: any) => unknown> = {
    "thread/resume": () => ({ thread: { id: MAIN, status: { type: "idle" } }, model: "gpt-6-luna", reasoningEffort: "low", approvalPolicy: "untrusted", approvalsReviewer: "user", sandbox: { type: "workspaceWrite" } }),
    "thread/start": () => ({ thread: { id: "NEW", status: { type: "idle" } }, model: "gpt-6-luna", approvalPolicy: "on-request", sandbox: { type: "readOnly" } }),
    "turn/start": () => ({ turn: { id: "t9" } }),
  };
  /** the thread's settings as the daemon has them (thread/settings/update changes them and says so) */
  settings: any = { model: "gpt-6-luna", effort: "low", approvalPolicy: "untrusted", sandboxPolicy: { type: "workspaceWrite" } };
  /** what thread/settings/update ignores (as the daemon does nothing for a field it rejects) */
  ignore = new Set<string>();
  /** no thread/settings/updated at all */
  silent = false;
  constructor() {
    this.answers["thread/settings/update"] = (p) => {
      const { threadId, ...rest } = p;
      for (const k of Object.keys(rest)) if (!this.ignore.has(k)) this.settings[k] = rest[k];
      if (!this.silent) queueMicrotask(() => this.say({ method: "thread/settings/updated", params: { threadId, threadSettings: { ...this.settings } } }));
      return {};
    };
    this.rpc.wire = {
      send: (text) => {
        const m = JSON.parse(text);
        this.sent.push(m);
        if (m.method && m.id !== undefined)
          queueMicrotask(() => {
            let reply: any;
            try {
              reply = { id: m.id, result: this.answers[m.method]?.(m.params) ?? {} };
            } catch (e: any) {
              reply = { id: m.id, error: { code: -32600, message: e.message } };
            }
            this.rpc.receive(JSON.stringify(reply));
          });
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
function useDaemon(fresh = true) {
  // What Tether remembers about threads starts empty for each test (the fake's thread ids repeat).
  if (fresh) rememberIn(undefined);
  daemon = new FakeDaemon();
  setConnector(async () => daemon.rpc);
}

test("resume keeps the thread's own settings: nothing sent; the state is the thread's", async () => {
  useDaemon();
  daemon.answers["thread/resume"] = () => ({ thread: { id: MAIN, status: { type: "idle" } }, model: "gpt-6-luna", reasoningEffort: "low", approvalPolicy: "never", approvalsReviewer: "user", sandbox: { type: "readOnly", networkAccess: false } });
  const sink = new TestSink();
  await CodexDriver.open(MAIN, CWD, {}, sink, true);
  expect(daemon.calls("thread/resume")[0]).toEqual({ threadId: MAIN, excludeTurns: true });
  expect(daemon.calls("thread/settings/update")).toEqual([]);
  // A combination no preset has is shown as it is (never loosened to a preset).
  expect(sink.states[0]).toEqual({ model: "gpt-6-luna", modelResolved: "gpt-6-luna", effort: "low", permissionMode: "never+read-only" });
});

test("settings you changed in Tether are applied after the resume (the daemon ignores them on a loaded thread) and confirmed", async () => {
  useDaemon();
  const sink = new TestSink();
  await CodexDriver.open(MAIN, CWD, { permissionMode: "auto", effort: "medium", model: "gpt-6-sol" }, sink, true);
  expect(daemon.calls("thread/resume")[0]).toEqual({ threadId: MAIN, excludeTurns: true });
  expect(daemon.calls("thread/settings/update")).toEqual([{ threadId: MAIN, model: "gpt-6-sol", effort: "medium", approvalPolicy: "on-request", approvalsReviewer: "user", sandboxPolicy: { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false } }]);
  expect(sink.lastWith("model")).toEqual({ model: "gpt-6-sol", modelResolved: "gpt-6-sol", effort: "medium", permissionMode: "auto" });
});

test("a change Codex doesn't apply or confirm fails the start: nothing runs looser than you chose", async () => {
  useDaemon();
  daemon.ignore.add("approvalPolicy").add("sandboxPolicy");
  await expect(CodexDriver.open(MAIN, CWD, { permissionMode: "read-only" }, new TestSink(), true)).rejects.toThrow("Codex didn't apply your permissions. Nothing was sent.");
  useDaemon();
  daemon.silent = true;
  const t0 = Date.now();
  const p = CodexDriver.open(MAIN, CWD, { effort: "high" }, new TestSink(), true);
  await expect(p).rejects.toThrow("didn't confirm");
  expect(Date.now() - t0).toBeGreaterThan(1000);
}, 15_000);

test('"Default" is the daemon\'s default model, applied, and shown as Default while it runs it', async () => {
  useDaemon();
  daemon.answers["model/list"] = () => ({ data: [{ id: "gpt-6.1-sol", isDefault: true }, { id: "gpt-6-luna" }] });
  const sink = new TestSink();
  const d = await CodexDriver.open(MAIN, CWD, { model: "default" }, sink, true);
  expect(daemon.calls("thread/settings/update")[0]).toEqual({ threadId: MAIN, model: "gpt-6.1-sol" });
  expect(sink.lastWith("model")).toMatchObject({ model: "default", modelResolved: "gpt-6.1-sol" });
  await d.setModel("gpt-6-luna");
  await Bun.sleep(5);
  expect(sink.lastWith("model")).toMatchObject({ model: "gpt-6-luna" });
  await d.setModel("default");
  await Bun.sleep(5);
  expect(sink.lastWith("model")).toMatchObject({ model: "default", modelResolved: "gpt-6.1-sol" });
});

test("Codex's own reviewer (Approve for me) set elsewhere: shown as part of the mode, never changed implicitly; a send pins what's shown", async () => {
  useDaemon();
  daemon.answers["thread/resume"] = () => ({ thread: { id: MAIN, status: { type: "idle" } }, model: "m", approvalPolicy: "on-request", approvalsReviewer: "auto_review", sandbox: { type: "workspaceWrite" } });
  const sink = new TestSink();
  const d = await CodexDriver.open(MAIN, CWD, {}, sink, true);
  expect(daemon.calls("thread/settings/update")).toEqual([]);
  expect(sink.lastWith("permissionMode")).toMatchObject({ permissionMode: "auto@codex-reviews" });
  // You pick Auto (you answer approvals): the next turn is pinned with it.
  await d.send("go", [], { permissionMode: "auto", model: "m" });
  expect(daemon.calls("turn/start")[0]).toMatchObject({ approvalPolicy: "on-request", approvalsReviewer: "user", sandboxPolicy: { type: "workspaceWrite" }, model: "m" });
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
  void d;
});

test("what Tether can't show is left for Codex's TUI, with a card saying so; nothing is answered on its own", async () => {
  useDaemon();
  const sink = new TestSink();
  await CodexDriver.open(MAIN, CWD, {}, sink, true);
  // Not about the thread (auth and the like): never answered here.
  daemon.say({ id: 20, method: "account/chatgptAuthTokens/refresh", params: {} });
  // An MCP form: a card pointing at the terminal, and no answer until someone gives one.
  daemon.say({ id: 21, method: "mcpServer/elicitation/request", params: { threadId: MAIN, serverName: "gh", mode: "form", message: "Pick a repo", requestedSchema: {} } });
  daemon.say({ id: 22, method: "item/unknownThing/request", params: { threadId: MAIN } });
  await Bun.sleep(5);
  expect(daemon.replies(20)).toEqual([]);
  expect(daemon.replies(21)).toEqual([]);
  expect(sink.asks.map((a) => a.ask.question)).toEqual([
    "gh needs some input that Tether can't show. Open the terminal to answer it there, or decline it here.",
    "Codex is asking something (item/unknownThing/request) that Tether can't show. Open the terminal to answer it there, or decline it here.",
  ]);
  expect(sink.asks[0]!.ask).toMatchObject({ kind: "question", options: ["Decline"], reason: "Pick a repo" });
  // The TUI answers the form: the card closes, Tether says nothing.
  daemon.say({ method: "serverRequest/resolved", params: { threadId: MAIN, requestId: 21 } });
  expect(sink.asks[0]!.signal!.aborted).toBe(true);
  // Declined in Tether: an error for the unknown method.
  sink.asks[1]!.resolve({ allow: true, answers: ["Decline"] });
  await Bun.sleep(5);
  expect(daemon.replies(21)).toEqual([]);
  expect(daemon.replies(22)[0].error.message).toContain("Declined");
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
  expect(sink.lastWith("model")).toEqual({ model: "gpt-6-sol", modelResolved: "gpt-6-sol", effort: "high", permissionMode: "full-access" });
  // A turn runs (t9): it keeps what it started with, shown beside the change (not looser: nothing to stop).
  expect(sink.states.at(-1)).toEqual({ turnSettings: { model: "gpt-6-luna", effort: "low", permissionMode: "untrusted", who: "turn" } });
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
  // The commands it left running are looked up (none started by its turn here, so none ended).
  expect(daemon.calls("thread/backgroundTerminals/clean")).toEqual([]);
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

test("a new thread named only so the TUI could join is named after its first message once its first turn ends", async () => {
  useDaemon();
  const id = await createThread(CWD, {});
  const d = await CodexDriver.open(id, CWD, {}, new TestSink(), false);
  await d.beforeTerminal();
  daemon.answers["thread/read"] = () => ({ thread: { id, name: "New session", preview: "Fix the   flaky test\nin ci" } });
  daemon.say({ method: "turn/completed", params: { threadId: id, turn: { id: "t1", status: "completed" } } });
  await Bun.sleep(5);
  expect(daemon.calls("thread/name/set").map((p) => p.name)).toEqual(["New session", "Fix the flaky test in ci"]);
  // Named by Codex meanwhile: left alone.
  const d2 = await CodexDriver.open(await createThread(CWD, {}), CWD, {}, new TestSink(), false);
  await d2.beforeTerminal();
  daemon.say({ method: "thread/name/updated", params: { threadId: d2.nativeId, threadName: "Codex's own title" } });
  daemon.say({ method: "turn/completed", params: { threadId: d2.nativeId, turn: { id: "t2", status: "completed" } } });
  await Bun.sleep(5);
  expect(daemon.calls("thread/name/set")).toHaveLength(3);
});

test("rejoined mid-turn with a subagent running: its turn is found, so stop and steer reach it", async () => {
  useDaemon();
  daemon.answers["thread/resume"] = () => ({ thread: { id: MAIN, status: { type: "active" } }, model: "m" });
  daemon.answers["thread/turns/list"] = (p) =>
    p.threadId === MAIN
      ? { data: [{ id: "t1", status: "inProgress", items: [{ type: "subAgentActivity", id: "call_1", kind: "started", agentThreadId: "C", agentPath: "/root/scan" }] }] }
      : { data: [{ id: "ct", status: "inProgress", items: [{ type: "commandExecution", id: "x", command: "ls", status: "inProgress" }] }] };
  const sink = new TestSink();
  const d = await CodexDriver.open(MAIN, CWD, {}, sink, true);
  expect(sink.starts.map((s) => s.nativeId)).toEqual(["C"]);
  await d.stopSubagent("C");
  expect(daemon.calls("turn/interrupt")).toEqual([{ threadId: "C", turnId: "ct" }]);
  expect(sink.children.get("C")!.t.messages[0]!.parts[0]).toMatchObject({ type: "tool", status: "running" });
});

test("a subagent's request that arrives before its spawn: shown in the subagent once it's known", async () => {
  useDaemon();
  const sink = new TestSink();
  await CodexDriver.open(MAIN, CWD, {}, sink, true);
  daemon.say({ method: "turn/started", params: { threadId: MAIN, turn: { id: "t1" } } });
  daemon.say({ id: 31, method: "item/commandExecution/requestApproval", params: { threadId: "C", turnId: "ct", itemId: "e1", command: "ls" } });
  await Bun.sleep(50);
  expect(sink.asks).toHaveLength(0);
  daemon.say({ method: "item/completed", params: { threadId: MAIN, item: { type: "subAgentActivity", id: "call_1", kind: "started", agentThreadId: "C", agentPath: "/root/scan" } } });
  await Bun.sleep(400);
  const child = sink.children.get("C")!;
  expect(child.asks.map((a) => a.ask.command)).toEqual(["ls"]);
  child.asks[0]!.resolve({ allow: true });
  await Bun.sleep(5);
  expect(daemon.replies(31)).toEqual([{ id: 31, result: { decision: "accept" } }]);
  // One answered elsewhere before it could be shown: never shown, never answered here.
  daemon.say({ id: 32, method: "item/commandExecution/requestApproval", params: { threadId: "D", itemId: "e2", command: "pwd" } });
  daemon.say({ method: "serverRequest/resolved", params: { threadId: "D", requestId: 32 } });
  daemon.say({ method: "item/completed", params: { threadId: MAIN, item: { type: "subAgentActivity", id: "call_2", kind: "started", agentThreadId: "D", agentPath: "/root/two" } } });
  await Bun.sleep(400);
  expect(sink.children.get("D")!.asks).toEqual([]);
  expect(daemon.replies(32)).toEqual([]);
});

test("the placeholder name survives a runner restart: renamed after the first turn all the same", async () => {
  useDaemon();
  const id = await createThread(CWD, {});
  const d = await CodexDriver.open(id, CWD, {}, new TestSink(), false);
  await d.beforeTerminal();
  // A new runner: a new driver on the same thread.
  useDaemon(false);
  daemon.answers["thread/resume"] = () => ({ thread: { id, status: { type: "idle" } }, model: "m", approvalsReviewer: "user" });
  await CodexDriver.open(id, CWD, {}, new TestSink(), true);
  daemon.answers["thread/read"] = () => ({ thread: { id, name: "New session", preview: "First words" } });
  daemon.say({ method: "turn/completed", params: { threadId: id, turn: { id: "t1", status: "completed" } } });
  await Bun.sleep(5);
  expect(daemon.calls("thread/name/set").map((p) => p.name)).toEqual(["First words"]);
});

test("a thread with no turn yet: the settings Tether started it with, else unknown (never Codex's config)", async () => {
  useDaemon();
  const { threadSettings } = await import("./discovery");
  daemon.answers["thread/read"] = (p) => ({ thread: { id: p.threadId, model: "gpt-6-luna", reasoningEffort: "high" } });
  expect(await threadSettings("OTHER")).toEqual({ model: "gpt-6-luna", effort: "high", permissionMode: "unknown" });
  const id = await createThread(CWD, { model: "gpt-6-luna", effort: "low", permissionMode: "read-only" });
  expect(await threadSettings(id)).toEqual({ model: "gpt-6-luna", effort: "low", permissionMode: "read-only" });
  await CodexDriver.open(id, CWD, {}, new TestSink(), false);
  // A runner restart before its first turn: its start settings are applied again on resume.
  daemon.answers["thread/resume"] = () => ({ thread: { id, status: { type: "idle" } }, model: "gpt-6-luna", reasoningEffort: "high", approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: { type: "workspaceWrite" } });
  await CodexDriver.open(id, CWD, {}, new TestSink(), true);
  expect(daemon.calls("thread/settings/update").at(-1)).toMatchObject({ effort: "low", approvalPolicy: "on-request", sandboxPolicy: { type: "readOnly" } });
});

test("live changes: a rejected one fails (the core rolls back); one the thread already has is confirmed at once", async () => {
  useDaemon();
  const sink = new TestSink();
  const d = await CodexDriver.open(MAIN, CWD, {}, sink, true);
  daemon.answers["thread/settings/update"] = () => {
    throw new Error("Invalid request: bad sandbox");
  };
  await expect(d.setPermissionMode("read-only")).rejects.toThrow("bad sandbox");
  // Already untrusted + workspace-write (from the resume): the daemon says nothing, the driver reports it.
  daemon.answers["thread/settings/update"] = () => ({});
  const n = sink.states.length;
  await d.setPermissionMode("untrusted");
  expect(sink.states.slice(n).filter((x) => "permissionMode" in x).at(-1)).toMatchObject({ permissionMode: "untrusted" });
  // A real change with no confirmation: nothing reported (the core waits, then rolls back).
  const m = sink.states.length;
  await d.setPermissionMode("read-only");
  await Bun.sleep(20);
  expect(sink.states.length).toBe(m);
  // "Default" when Codex can't list its models: fails (rolled back), never left showing Default.
  daemon.answers["model/list"] = () => {
    throw new Error("timeout");
  };
  await expect(d.setModel("default")).rejects.toThrow("didn't say which model is its default");
});

test("a change applied with no turn after it is what a stored header shows (not the older rollout's)", async () => {
  useDaemon();
  const { threadSettings } = await import("./discovery");
  const sink = new TestSink();
  const d = await CodexDriver.open(MAIN, CWD, {}, sink, true);
  await d.setPermissionMode("read-only");
  await Bun.sleep(5);
  // The rollout (no path here) has nothing newer; the thread metadata says the model.
  daemon.answers["thread/read"] = (p) => ({ thread: { id: p.threadId, model: "gpt-6-luna" } });
  expect(await threadSettings(MAIN)).toEqual({ model: "gpt-6-luna", effort: "low", permissionMode: "read-only" });
  // thread/read failing: what Tether last saw, never Codex's config.
  const { codexAdapter } = await import("./index");
  daemon.answers["thread/read"] = () => {
    throw new Error("timed out");
  };
  daemon.answers["config/read"] = () => ({ config: { model: "gpt-6.1-sol", approval_policy: "never", sandbox_mode: "danger-full-access" } });
  expect(await codexAdapter.defaults(CWD, "OTHER-UNREAD")).toEqual({ permissionMode: "unknown" });
  expect(await codexAdapter.defaults(CWD, MAIN)).toEqual({ model: "gpt-6-luna", effort: "low", permissionMode: "read-only" });
});

test("Default survives a restart: a stored session and a resumed one still show Default", async () => {
  useDaemon();
  daemon.answers["model/list"] = () => ({ data: [{ id: "gpt-6.1-sol", isDefault: true }, { id: "gpt-6-luna" }] });
  await CodexDriver.open(MAIN, CWD, { model: "default" }, new TestSink(), true);
  // A new runner: nothing in Tether's prefs any more.
  useDaemon(false);
  daemon.answers["model/list"] = () => ({ data: [{ id: "gpt-6.1-sol", isDefault: true }, { id: "gpt-6-luna" }] });
  daemon.answers["thread/resume"] = () => ({ thread: { id: MAIN, status: { type: "idle" } }, model: "gpt-6.1-sol", approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: { type: "readOnly" } });
  const sink = new TestSink();
  await CodexDriver.open(MAIN, CWD, {}, sink, true);
  expect(sink.lastWith("model")).toMatchObject({ model: "default", modelResolved: "gpt-6.1-sol" });
  const { codexAdapter } = await import("./index");
  daemon.answers["thread/read"] = (p) => ({ thread: { id: p.threadId, model: "gpt-6.1-sol" } });
  expect((await codexAdapter.defaults(CWD, MAIN)).model).toBe("default");
});

test("joining a turn already running: busy, and its own settings (its turn_context) shown beside the thread's", async () => {
  useDaemon();
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const path = join(mkdtempSync(join(tmpdir(), "tether-ctx-")), "rollout.jsonl");
  writeFileSync(path, [JSON.stringify({ timestamp: "2026-10-29T10:00:00Z", type: "turn_context", payload: { turn_id: "t1", model: "gpt-6-luna", effort: "low", approval_policy: "never", sandbox_policy: { type: "danger-full-access" } } }), '{"type":"event_msg"}'].join("\n"));
  // Read only now (changed while the turn ran, elsewhere), the turn started with full access.
  daemon.answers["thread/resume"] = () => ({ thread: { id: MAIN, status: { type: "active" }, path }, model: "gpt-6-luna", reasoningEffort: "low", approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: { type: "readOnly" } });
  daemon.answers["thread/turns/list"] = () => ({ data: [{ id: "t1", status: "inProgress", items: [] }] });
  const sink = new TestSink();
  const d = await CodexDriver.open(MAIN, CWD, {}, sink, true);
  expect(d.turnRunning()).toBe(true);
  expect(sink.status).toBe("running");
  expect(sink.states.at(-1)).toEqual({ turnSettings: { permissionMode: "full-access", looser: true, who: "turn" } });
  // The turn ends: the note goes.
  daemon.say({ method: "turn/completed", params: { threadId: MAIN, turn: { id: "t1", status: "completed" } } });
  expect(sink.states.at(-1)).toEqual({ turnSettings: undefined });
  expect(d.turnRunning()).toBe(false);
});

test("a change mid-turn (here or in Codex's TUI) shows the turn's own value; subagents keep it until they end; Stop stops them too", async () => {
  useDaemon();
  daemon.settings = { model: "gpt-6-luna", effort: "low", approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" }, approvalsReviewer: "user" };
  daemon.answers["thread/resume"] = () => ({ thread: { id: MAIN, status: { type: "idle" } }, model: "gpt-6-luna", reasoningEffort: "low", approvalPolicy: "never", approvalsReviewer: "user", sandbox: { type: "dangerFullAccess" } });
  const sink = new TestSink();
  const d = await CodexDriver.open(MAIN, CWD, {}, sink, true);
  daemon.say({ method: "turn/started", params: { threadId: MAIN, turn: { id: "t1" } } });
  expect(sink.states.at(-1)).toEqual({ turnSettings: undefined });
  // Codex's TUI picks read-only (the daemon reports it).
  daemon.say({ method: "thread/settings/updated", params: { threadId: MAIN, threadSettings: { ...daemon.settings, approvalPolicy: "on-request", sandboxPolicy: { type: "readOnly" } } } });
  expect(sink.states.at(-1)).toEqual({ turnSettings: { permissionMode: "full-access", looser: true, who: "turn" } });
  // A subagent started in the turn outlives it.
  daemon.say({ method: "item/completed", params: { threadId: MAIN, item: { type: "subAgentActivity", id: "call_1", kind: "started", agentThreadId: "C", agentPath: "/root/x" } } });
  daemon.say({ method: "turn/started", params: { threadId: "C", turn: { id: "ct" } } });
  daemon.say({ method: "turn/completed", params: { threadId: MAIN, turn: { id: "t1", status: "completed" } } });
  // The turn is over; its subagent still runs with its settings: said, with Stop.
  expect(sink.states.filter((x) => "turnSettings" in x).at(-1)).toEqual({ turnSettings: { permissionMode: "full-access", looser: true, who: "subagent", subagentSessionId: "codex:C" } });
  // A new turn (a queue drain, a ! command's output) runs read-only, pinned: the subagent's entry stays.
  await d.send("next", [], { permissionMode: "read-only", model: "gpt-6-luna" });
  daemon.say({ method: "turn/started", params: { threadId: MAIN, turn: { id: "t2" } } });
  expect(sink.states.filter((x) => "turnSettings" in x).at(-1)).toEqual({ turnSettings: { permissionMode: "full-access", looser: true, who: "subagent", subagentSessionId: "codex:C" } });
  daemon.say({ method: "turn/completed", params: { threadId: MAIN, turn: { id: "t2", status: "completed" } } });
  expect(sink.states.filter((x) => "turnSettings" in x).at(-1)).toEqual({ turnSettings: { permissionMode: "full-access", looser: true, who: "subagent", subagentSessionId: "codex:C" } });
  // Stop: the subagent too.
  await d.interrupt();
  expect(daemon.calls("turn/interrupt")).toEqual([{ threadId: "C", turnId: "ct" }]);
  daemon.say({ method: "turn/completed", params: { threadId: "C", turn: { id: "ct", status: "interrupted" } } });
  expect(sink.states.filter((x) => "turnSettings" in x).at(-1)).toEqual({ turnSettings: undefined });
});

test("rejoined with the turn over but a subagent still running (a runner restart): found, with its own settings, Stop reaches it", async () => {
  useDaemon();
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const childPath = join(mkdtempSync(join(tmpdir(), "tether-ctx-")), "child.jsonl");
  writeFileSync(childPath, JSON.stringify({ type: "turn_context", payload: { turn_id: "ct", model: "gpt-6-luna", approval_policy: "never", sandbox_policy: { type: "danger-full-access" } } }));
  daemon.answers["thread/resume"] = () => ({ thread: { id: MAIN, status: { type: "idle" } }, model: "gpt-6-luna", approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: { type: "readOnly" } });
  daemon.answers["thread/list"] = () => ({ data: [{ id: "C", status: { type: "active" } }] });
  daemon.answers["thread/read"] = (p) => (p.threadId === "C" ? { thread: { id: "C", status: { type: "active" }, path: childPath, agentNickname: "Scout" } } : { thread: { id: p.threadId } });
  daemon.answers["thread/turns/list"] = (p) => (p.threadId === "C" ? { data: [{ id: "ct", status: "inProgress", items: [] }] } : { data: [] });
  const sink = new TestSink();
  const d = await CodexDriver.open(MAIN, CWD, {}, sink, true);
  expect(sink.starts.map((s) => s.nativeId)).toEqual(["C"]);
  expect(d.busy()).toBe(true);
  expect(sink.lastWith("turnSettings")).toEqual({ turnSettings: { permissionMode: "full-access", looser: true, who: "subagent", subagentSessionId: "codex:C" } });
  await d.interrupt();
  expect(daemon.calls("turn/interrupt")).toEqual([{ threadId: "C", turnId: "ct" }]);
});

test("a turn whose settings can't be read (no turn_context): Unknown, counted as looser (fail closed)", async () => {
  useDaemon();
  const sink = new TestSink();
  const d = await CodexDriver.open(MAIN, CWD, {}, sink, true);
  d.retryMs = 1;
  daemon.say({ method: "turn/started", params: { threadId: MAIN, turn: { id: "tx" } } });
  await Bun.sleep(50);
  expect(sink.lastWith("turnSettings")).toEqual({ turnSettings: { permissionMode: "unknown", looser: true, who: "turn" } });
});


test("turn/start racing another client's turn: the daemon puts the message into that turn; said, and its own settings shown, never taken as pinned", async () => {
  useDaemon();
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const path = join(mkdtempSync(join(tmpdir(), "tether-race-")), "r.jsonl");
  writeFileSync(path, JSON.stringify({ type: "turn_context", payload: { turn_id: "other", model: "gpt-6-luna", approval_policy: "never", sandbox_policy: { type: "danger-full-access" } } }));
  daemon.answers["thread/resume"] = () => ({ thread: { id: MAIN, status: { type: "idle" }, path }, model: "gpt-6-luna", reasoningEffort: "low", approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: { type: "readOnly" } });
  // The other client's turn starts just before Tether's turn/start; the daemon answers with it.
  daemon.answers["turn/start"] = () => ({ turn: { id: "other" } });
  const sink = new TestSink();
  const d = await CodexDriver.open(MAIN, CWD, {}, sink, true);
  d.retryMs = 1;
  daemon.say({ method: "turn/started", params: { threadId: MAIN, turn: { id: "other" } } });
  await Bun.sleep(2);
  // (the busy check would refuse it now; the race is the message going out just before it's seen)
  (d as any).stream.main.turnId = undefined;
  (d as any).running.delete(MAIN);
  (d as any).turnSeen.set("other", Date.now() - 1000);
  await d.send("hello", [], { permissionMode: "read-only", model: "gpt-6-luna" });
  await Bun.sleep(30);
  expect(sink.t.messages.some((m) => m.role === "notice" && /went into a turn started elsewhere/.test((m.parts[0] as any).text))).toBe(true);
  expect(sink.lastWith("turnSettings")).toEqual({ turnSettings: { permissionMode: "full-access", looser: true, who: "turn" } });
});

test("a sandbox with network or extra writable roots, or a permission profile: Custom, counted looser (never plain Auto)", async () => {
  const { modeOf } = await import("./modes");
  expect(modeOf("on-request", { type: "workspaceWrite", networkAccess: true, writableRoots: [] })).toBe("custom");
  expect(modeOf("on-request", { type: "workspaceWrite", networkAccess: false, writableRoots: ["/x"] })).toBe("custom");
  expect(modeOf("on-request", { type: "workspace-write", network_access: true })).toBe("custom");
  expect(modeOf("on-request", { type: "workspaceWrite", networkAccess: false, writableRoots: [] })).toBe("auto");
  expect(modeOf("on-request", { type: "workspaceWrite" }, "user", { id: ":workspace" })).toBe("custom");
  useDaemon();
  daemon.answers["thread/resume"] = () => ({ thread: { id: MAIN, status: { type: "idle" } }, model: "m", approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: { type: "workspaceWrite", networkAccess: true, writableRoots: [] } });
  const sink = new TestSink();
  const d = await CodexDriver.open(MAIN, CWD, {}, sink, true);
  expect(sink.lastWith("permissionMode")).toMatchObject({ permissionMode: "custom" });
  // A turn running with it: noted with Stop, though Custom is also what's shown.
  daemon.say({ method: "turn/started", params: { threadId: MAIN, turn: { id: "t1" } } });
  expect(sink.lastWith("turnSettings")).toEqual({ turnSettings: { permissionMode: "custom", looser: true, who: "turn" } });
  // Picking Auto in Tether really is Auto (no network, no extra roots).
  await d.setPermissionMode("auto");
  expect(daemon.calls("thread/settings/update").at(-1)).toMatchObject({ sandboxPolicy: { type: "workspaceWrite", networkAccess: false, writableRoots: [] } });
});

test("Stop ends only the commands its own turn left running, never one from an earlier turn", async () => {
  useDaemon();
  daemon.answers["thread/backgroundTerminals/list"] = () => ({ data: [{ itemId: "exec-old", processId: "1" }, { itemId: "exec-now", processId: "2" }] });
  const sink = new TestSink();
  const d = await CodexDriver.open(MAIN, CWD, {}, sink, true);
  daemon.say({ method: "turn/started", params: { threadId: MAIN, turn: { id: "t2" } } });
  daemon.say({ method: "item/started", params: { threadId: MAIN, item: { type: "commandExecution", id: "exec-now", command: "sleep 30", status: "inProgress" } } });
  await d.interrupt();
  expect(daemon.calls("thread/backgroundTerminals/terminate")).toEqual([{ threadId: MAIN, processId: "2" }]);
  expect(daemon.calls("thread/backgroundTerminals/clean")).toEqual([]);
});

test("a subagent whose turn started before its spawn was reported is in the running set", async () => {
  useDaemon();
  const sink = new TestSink();
  const d = await CodexDriver.open(MAIN, CWD, {}, sink, true);
  daemon.say({ method: "turn/started", params: { threadId: MAIN, turn: { id: "t1" } } });
  daemon.say({ method: "turn/started", params: { threadId: "EARLY", turn: { id: "et" } } });
  expect(d.running.has("EARLY")).toBe(false);
  daemon.say({ method: "item/completed", params: { threadId: MAIN, item: { type: "subAgentActivity", id: "call_9", kind: "started", agentThreadId: "EARLY", agentPath: "/root/e" } } });
  expect(d.running.has("EARLY")).toBe(true);
  expect(d.busy()).toBe(true);
});
