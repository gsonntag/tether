// The session plan, todos and ask_user (plan.ts, the "plan and todos" section of session.ts): the
// pure pieces, plan_set / todo_set and the harness's own plans and todos, Tether's review card and
// plan-mode guard (pi's emulated mode, Codex/ACP plan modes, an ACP agent leaving plan mode),
// ask_user over the real loopback bridge and the MCP server, the handoff carry, and the matrix.

import { resetHome } from "./testenv";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ChainEntry, HarnessId, Msg, SessionPlan } from "../../web/src/shared/protocol";
import type { Sink } from "./adapters/types";
import { config } from "./config";
import { capabilityMatrix } from "./connectors";
import { callTool, handle, timing } from "./context/mcp";
import { sessionBridgeFile } from "./context/launch";
import { runHandoff, type HandoffDeps } from "./handoffRun";
import {
  briefSection,
  describePlan,
  IMPLEMENT_PROMPT,
  isPlanMode,
  lastReply,
  mutates,
  parseChecklist,
  parseTodos,
  PLAN_HINT,
  PLAN_MODE_REASON,
  PLAN_WAIT_REASON,
  readOnlyCommand,
  withoutPlanHint,
} from "./plan";
import { LiveSession, newId, NOBODY_ANSWERED } from "./session";

let live: LiveSession[] = [];

beforeEach(() => {
  resetHome();
  config().sessions = {};
});
afterEach(() => {
  live.splice(0).forEach((s) => s.close());
  LiveSession.UNATTENDED_QUESTION_MS = 15 * 60_000;
  timing.progressMs = 30_000;
});

async function until(cond: () => unknown, ms = 5_000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(5);
  }
}

type Kind = "native" | "codex" | "acp" | "pi";

/**
 * A harness of one plan kind: "native" reviews its own plans (Claude Code); "codex" plans in a mode
 * with a plan item of its own; "acp" and "pi" take the plan-mode turn's reply as the plan (pi's
 * plan mode is Tether's).
 */
function fake(kind: Kind = "pi", harness: HarnessId = kind === "native" ? "claude-code" : kind === "codex" ? "codex" : kind === "acp" ? "opencode" : "pi") {
  const sent: string[] = [];
  const modes: string[] = [];
  const sink = { emit: () => {}, summary: () => {}, handoff: async () => {} };
  class Fake extends LiveSession {
    protected nativePlanReview = kind === "native";
    protected planFromReply = kind === "acp" || kind === "pi";
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
    async setPermissionMode(mode: string) {
      modes.push(mode);
      this.setState({ permissionMode: mode });
    }
    async rename() {}
    async listCommands() {
      return [];
    }
    async continueTurn(text = "Continue where you left off.") {
      sent.push(text);
      this.addUserMessage(text);
      this.setState({ status: "running" });
    }
    protected shutdown() {}
    protected planning() {
      return kind !== "native" && isPlanMode(this.t.state.permissionMode);
    }
    protected async leavePlanMode() {
      if (this.planning()) await this.setPermissionMode(kind === "acp" ? "build" : "default");
    }
    /** ends the running turn with this reply (and any extra parts) */
    endTurn(text = "Done.", extra: Msg["parts"] = []) {
      this.emit({ type: "msg", msg: { id: newId("a"), role: "assistant", parts: [{ type: "text", text }, ...extra], ts: Date.now() } });
      this.setState({ status: "idle" });
    }
    /** the agent switched modes by itself (ACP current_mode_update) */
    agentMode(mode: string) {
      const was = this.t.state.permissionMode;
      this.setState({ permissionMode: mode });
      if (isPlanMode(was) && !isPlanMode(mode)) this.leftPlanMode();
    }
  }
  const s = new Fake(harness, { nativeId: crypto.randomUUID(), projectPath: process.env.HOME! }, sink);
  s.t.state.status = "idle";
  s.loadPrefs();
  live.push(s);
  return Object.assign(s, { sent, modes });
}

const planParts = (s: LiveSession) => s.t.messages.flatMap((m) => m.parts.filter((p) => p.type === "plan")) as Extract<Msg["parts"][number], { type: "plan" }>[];
const todoCards = (s: LiveSession) => s.t.messages.flatMap((m) => m.parts.filter((p) => p.type === "tool" && p.name === "TodoWrite")) as any[];
const planRequest = (s: LiveSession) => s.t.state.pendingUi.find((r) => r.kind === "plan");

describe("plan.ts", () => {
  test("todo items: Claude and Codex spellings, checked", () => {
    expect(parseTodos([{ text: " Read  the code ", status: "completed" }, { content: "Fix it", status: "in-progress" }, { step: "Test", status: "inProgress" }, { text: "Ship" }])).toEqual([
      { text: "Read the code", status: "completed" },
      { text: "Fix it", status: "in_progress" },
      { text: "Test", status: "in_progress" },
      { text: "Ship", status: "pending" },
    ]);
    expect(parseTodos("x")).toBeString();
    expect(parseTodos([{ text: "" }])).toBeString();
    expect(parseTodos([{ text: "a", status: "sideways" }])).toBeString();
  });

  test("an ACP checklist part back as todos", () => {
    expect(parseChecklist("- [x] Read the code\n- [ ] Write the fix _(in progress)_\n- [ ] Run tests\nnot an item")).toEqual([
      { text: "Read the code", status: "completed" },
      { text: "Write the fix", status: "in_progress" },
      { text: "Run tests", status: "pending" },
    ]);
  });

  test("plan mode holds back changes, not reading", () => {
    for (const [tool, input] of [
      ["read", { path: "a.ts" }],
      ["Grep", { pattern: "x" }],
      ["WebFetch", { url: "https://x" }],
      ["TodoWrite", { todos: [] }],
      ["mcp__tether-context__plan_set", { markdown: "x" }],
      ["bash", { command: "git status && rg foo | head -5" }],
      ["bash", { command: "git branch -a" }],
      ["Write", { file_path: "/p/.opencode/plans/feature.md" }],
    ] as const)
      expect(mutates(tool, input)).toBe(false);
    for (const [tool, input] of [
      ["edit", { path: "a.ts" }],
      ["Write", { file_path: "a.ts" }],
      ["apply_patch", { path: "a.ts" }],
      ["bash", { command: "bun test" }],
      ["bash", { command: "echo x > a.ts" }],
      ["bash", { command: "git commit -m x" }],
      ["bash", { command: "git branch -D old" }],
      ["bash", { command: "find . -delete" }],
      ["bash", { command: "cat $(which x)" }],
      ["mcp__github__create_issue", {}],
      ["subagent", {}],
    ] as const)
      expect(mutates(tool, input)).toBe(true);
    expect(readOnlyCommand("ls -la > /dev/null")).toBe(true);
    expect(readOnlyCommand("git config --get user.name")).toBe(true);
    expect(readOnlyCommand("git config user.name x")).toBe(false);
    // Readers that write a file after all.
    for (const c of ["ls 2>out.log", "ls &>out.log", "ls >|out", "sort -o out.txt in.txt", "sort --output=out in", "uniq a.txt b.txt", "xxd a b", "tree -o out.txt", "git diff --output=x.patch", "git log --output x", "find . -fprint0 x", "date -s 2020-01-01", "yq -i '.a=1' f.yml", "cloc --out=r.txt ."])
      expect([c, readOnlyCommand(c)]).toEqual([c, false]);
    for (const c of ["ls 2>&1 | head", "ls 2>/dev/null", "ls &>/dev/null", "rg x >&2", "sort -n a.txt", "uniq -c a.txt", "tree -L 2", "date +%s", "git diff --stat", "find . -name '*.ts' -print0"])
      expect([c, readOnlyCommand(c)]).toEqual([c, true]);
    // pi-mcp-adapter's proxy: looking up tools goes through, calling another server's tool doesn't.
    for (const input of [{}, { search: "plan" }, { describe: "tether_context_plan_set" }, { server: "tether-context" }, { instructions: "gh" }, { connect: "tether-context" }])
      expect(mutates("mcp", input)).toBe(false);
    for (const input of [{ tool: "github_create_issue" }, { action: "install", url: "https://x" }, { connect: "gh" }]) expect(mutates("mcp", input)).toBe(true);
  });

  test("plan modes by name", () => {
    for (const m of ["plan", "Plan", "plan-mode", "planning"]) expect(isPlanMode(m)).toBe(true);
    for (const m of ["build", "default", "planet", undefined]) expect(isPlanMode(m)).toBe(false);
  });

  test("describePlan, the brief section and the plan-mode note", () => {
    const plan: SessionPlan = { text: "1. Add minus\n2. Test it", todos: [{ text: "Add minus", status: "in_progress" }], status: "approved", updatedAt: 1 };
    expect(describePlan(undefined)).toStartWith("No plan yet.");
    expect(describePlan(plan)).toBe("Plan (approved by the user):\n\n1. Add minus\n2. Test it\n\nTodo list:\n- [ ] Add minus (in progress)");
    expect(briefSection(plan)).toStartWith("The user approved this plan; carry it on.\n\n1. Add minus");
    expect(briefSection({ ...plan, status: "draft" })).toStartWith("The user hasn't approved this plan yet.");
    expect(briefSection({ ...plan, text: "", todos: [] })).toBeUndefined();
    expect(withoutPlanHint(`Add minus\n\n${PLAN_HINT}`)).toBe("Add minus");
    expect(withoutPlanHint("Add minus")).toBe("Add minus");
  });

  test("the last reply since a turn began, not past a user message or a plan", () => {
    const msgs: Msg[] = [
      { id: "u", role: "user", parts: [{ type: "text", text: "go" }], ts: 1 },
      { id: "a", role: "assistant", parts: [{ type: "text", text: "The plan" }, { type: "tool", id: "t", name: "read", input: {}, status: "done" }], ts: 2 },
    ];
    expect(lastReply(msgs, 1)).toMatchObject({ index: 0, text: "The plan" });
    expect(lastReply(msgs, 0)).toMatchObject({ text: "The plan" });
    expect(lastReply([...msgs, { id: "u2", role: "user", parts: [{ type: "text", text: "x" }], ts: 3 }], 0)).toBeUndefined();
  });
});

describe("plan_set and todo_set", () => {
  test("plan_set shows a plan card, a rewrite in the same turn updates it, and plan_get reads it back", async () => {
    const s = fake("native");
    await s.prompt("Add minus");
    await expect(s.sessionTool("plan_set", { markdown: "" })).resolves.toMatchObject({ ok: false });
    expect((await s.sessionTool("plan_set", { markdown: "1. Add minus" })).text).toStartWith("Plan saved. The user sees it");
    await s.sessionTool("plan_set", { markdown: "1. Add minus\n2. Test it" });
    expect(planParts(s).map((p) => p.text)).toEqual(["1. Add minus\n2. Test it"]);
    expect(s.planState).toMatchObject({ text: "1. Add minus\n2. Test it", status: "draft", partId: planParts(s)[0]!.id });
    expect((await s.sessionTool("plan_get", {})).text).toBe("Plan (not reviewed):\n\n1. Add minus\n2. Test it");
    // In its own plan mode, the harness's review still decides.
    s.setState({ permissionMode: "plan" });
    expect((await s.sessionTool("plan_set", { markdown: "1. Add minus" })).text).toContain("ExitPlanMode");
    s.endTurn();
    // A new turn: a new card, not a rewrite of the old one.
    await s.prompt("Also multiply");
    await s.sessionTool("plan_set", { markdown: "1. Add times" });
    expect(planParts(s).map((p) => p.text)).toEqual(["1. Add minus", "1. Add times"]);
  });

  test("todo_set shows the todo card and updates it in place until you write again", async () => {
    const s = fake("native");
    await s.prompt("go");
    const r = await s.sessionTool("todo_set", { items: [{ text: "Read", status: "completed" }, { text: "Fix", status: "in_progress" }] });
    expect(r).toEqual({ ok: true, text: "Todo list updated: 1 of 2 done." });
    await s.sessionTool("todo_set", { items: [{ text: "Read", status: "completed" }, { text: "Fix", status: "completed" }] });
    expect(todoCards(s).length).toBe(1);
    expect(todoCards(s)[0].input).toEqual({ todos: [{ content: "Read", status: "completed" }, { content: "Fix", status: "completed" }] });
    expect(s.planState!.todos).toEqual([{ text: "Read", status: "completed" }, { text: "Fix", status: "completed" }]);
    s.endTurn();
    await s.prompt("next");
    await s.sessionTool("todo_set", { items: [{ text: "Deploy", status: "pending" }] });
    expect(todoCards(s).length).toBe(2);
    expect((await s.sessionTool("todo_set", { items: [{ text: "x", status: "nope" }] })).ok).toBe(false);
  });

  test("the harness's own plans and todo lists become the session's plan; an older one sent again doesn't win", async () => {
    const s = fake("native");
    await s.prompt("go");
    const todo = (id: string, content: string) => ({ type: "tool" as const, id, name: "TodoWrite", input: { todos: [{ content, status: "pending" }] }, status: "done" as const });
    const a = { id: "a1", role: "assistant" as const, parts: [todo("t1", "First")], ts: 1 };
    s.emit({ type: "msg", msg: a });
    s.emit({ type: "msg", msg: { id: "a2", role: "assistant", parts: [todo("t2", "Second"), { type: "plan", id: "p1", text: "Claude's plan" }], ts: 2 } });
    expect(s.planState).toMatchObject({ text: "Claude's plan", partId: "p1", status: "draft", todos: [{ text: "Second", status: "pending" }] });
    s.emit({ type: "msg", msg: a }); // Claude re-sends an older message
    expect(s.planState!.todos[0]!.text).toBe("Second");
    // ExitPlanMode approved: the card's outcome is the plan's status.
    s.emit({ type: "msg", msg: { id: "a2", role: "assistant", parts: [{ type: "plan", id: "p1", text: "Claude's plan", outcome: "approved" }], ts: 2 } });
    expect(s.planState!.status).toBe("approved");
    // An ACP checklist is a todo list.
    s.emit({ type: "msg", msg: { id: "a3", role: "assistant", parts: [{ type: "plan", id: "c1", text: "- [x] One\n- [ ] Two", checklist: true }], ts: 3 } });
    expect(s.planState).toMatchObject({ text: "Claude's plan", todos: [{ text: "One", status: "completed" }, { text: "Two", status: "pending" }] });
  });

  test("the plan is saved with the session, an open review comes back unreviewed", async () => {
    const s = fake("pi");
    await s.setPermissionMode("plan");
    await s.prompt("Add minus");
    await s.sessionTool("plan_set", { markdown: "1. Add minus" });
    s.endTurn("Here's the plan.");
    await until(() => planRequest(s));
    expect(config().sessions[s.id]!.plan).toMatchObject({ text: "1. Add minus", status: "review" });
    const again = fake("pi");
    (again as any).nativeId = s.nativeId;
    again.loadPrefs();
    expect(again.planState).toMatchObject({ text: "1. Add minus", status: "draft" });
  });
});

describe("Tether's plan review", () => {
  test("pi's Tether plan mode: changes are held back, the plan goes up for review, Approve leaves plan mode and carries it out", async () => {
    const s = fake("pi");
    await s.setPermissionMode("plan");
    await s.prompt("Add minus");
    expect(await s.checkTool("edit", { path: "math.ts" })).toEqual({ allow: false, reason: PLAN_MODE_REASON, always: false });
    expect((await s.checkTool("read", { path: "math.ts" })).allow).toBe(true);
    expect((await s.checkTool("bash", { command: "rg minus" })).allow).toBe(true);
    expect((await s.sessionTool("plan_set", { markdown: "1. Add minus" })).text).toStartWith("Plan saved. End your turn now");
    s.endTurn("I'll add minus.");
    await until(() => planRequest(s));
    const req = planRequest(s)!;
    expect(req).toMatchObject({ title: "pi's plan is ready for review", planId: s.planState!.partId });
    expect(s.planState!.status).toBe("review");
    // Waiting for the review: still nothing changes.
    expect((await s.checkTool("Write", { file_path: "math.ts" })).reason).toBe(PLAN_WAIT_REASON);
    s.uiRespond({ id: req.id, allow: true });
    await until(() => s.sent.length === 2);
    expect(s.sent[1]).toBe(IMPLEMENT_PROMPT);
    expect(s.t.state.permissionMode).toBe("default");
    expect(s.planState!.status).toBe("approved");
    expect(planParts(s)[0]!.outcome).toBe("approved");
    expect((await s.checkTool("edit", { path: "math.ts" })).allow).toBe(true);
  });

  test("without plan_set the plan-mode turn's reply is the plan (one card, not two); feedback goes back and plan mode stays", async () => {
    const s = fake("acp");
    await s.setPermissionMode("plan");
    await s.prompt("Add minus");
    s.endTurn("1. Add minus to math.ts\n2. Test it", [{ type: "tool", id: "r1", name: "read", input: {}, status: "done" }]);
    await until(() => planRequest(s));
    const last = s.t.messages.at(-1)!;
    expect(last.parts.map((p) => p.type)).toEqual(["plan", "tool"]);
    expect(planParts(s)[0]!.text).toBe("1. Add minus to math.ts\n2. Test it");
    expect(planRequest(s)!.title).toBe("opencode's plan is ready for review");
    s.uiRespond({ id: planRequest(s)!.id, allow: false, value: "> Test it\nUse bun:test." });
    await until(() => s.sent.length === 2);
    expect(s.sent[1]).toBe("> Test it\nUse bun:test.");
    expect(s.planState!.status).toBe("feedback");
    expect(planParts(s)[0]!.outcome).toBe("feedback");
    expect(s.t.state.permissionMode).toBe("plan");
    // The revised plan goes up again; approving switches to Build.
    s.endTurn("1. Add minus\n2. Test it with bun:test");
    await until(() => planRequest(s));
    s.uiRespond({ id: planRequest(s)!.id, allow: true });
    await until(() => s.sent.length === 3);
    expect(s.modes.at(-1)).toBe("build");
  });

  test("Discuss (plan review): the answer isn't a new plan, the same plan comes up again, and approving it carries it out", async () => {
    const s = fake("acp");
    await s.setPermissionMode("plan");
    await s.prompt("Add minus");
    s.endTurn("1. Add minus to math.ts\n2. Test it");
    await until(() => planRequest(s));
    const plan = planParts(s)[0]!;
    s.uiRespond({ id: planRequest(s)!.id, allow: false, value: "Why math.ts?", discuss: true });
    await until(() => s.sent.length === 2);
    expect(s.sent[1]).toBe("Why math.ts?");
    expect(planParts(s)[0]!.outcome).toBeUndefined();
    expect(s.t.state.permissionMode).toBe("plan");
    // Its answer stays a reply; the plan under discussion goes up for review again.
    s.endTurn("Because the other operators live there.");
    await until(() => planRequest(s));
    expect(planParts(s)).toHaveLength(1);
    expect(planRequest(s)!.planId).toBe(plan.id);
    s.uiRespond({ id: planRequest(s)!.id, allow: true });
    await until(() => s.sent.length === 3);
    expect(s.sent[2]).toBe(IMPLEMENT_PROMPT);
    expect(s.modes.at(-1)).toBe("build");
  });

  test("a discussion stopped mid-answer: the next plan-mode turn's own plan goes up, not the one discussed", async () => {
    const s = fake("pi");
    await s.setPermissionMode("plan");
    await s.prompt("Add minus");
    s.endTurn("1. Add minus");
    await until(() => planRequest(s));
    const a = planParts(s)[0]!;
    s.uiRespond({ id: planRequest(s)!.id, allow: false, value: "Why?", discuss: true });
    await until(() => s.sent.length === 2);
    await s.stop();
    s.endTurn("Because");
    await s.prompt("Plan a multiply operator instead");
    s.endTurn("1. Add multiply");
    await until(() => planRequest(s));
    expect(planRequest(s)!.planId).not.toBe(a.id);
    expect(planParts(s).at(-1)!.text).toBe("1. Add multiply");
  });

  test("plan review with no approval waiting: Discuss isn't taken as a new plan, Approve leaves Tether's plan mode", async () => {
    const s = fake("pi");
    await s.setPermissionMode("plan");
    await s.prompt("Add minus");
    s.endTurn("1. Add minus");
    await until(() => planRequest(s));
    const a = planParts(s)[0]!;
    // The review card dismissed: nothing waits for an answer, the plan is held.
    s.uiRespond({ id: planRequest(s)!.id, cancelled: true });
    await until(() => !planRequest(s));
    (s.plans as any).patch(a.id, (p: any) => ({ ...p, held: Date.now() }));
    await s.plans.act(a.id, "discuss", { comments: [], general: "Why minus?" });
    expect(s.sent.at(-1)).toContain("Why minus?");
    s.endTurn("Because the user asked.");
    await until(() => planRequest(s));
    expect(planParts(s)).toHaveLength(1);
    expect(planRequest(s)!.planId).toBe(a.id);
    s.uiRespond({ id: planRequest(s)!.id, cancelled: true });
    await until(() => !planRequest(s));
    await s.plans.act(a.id, "approve", { comments: [], general: "" });
    expect(s.modes.at(-1)).toBe("default");
    expect(s.sent.at(-1)).toBe(IMPLEMENT_PROMPT);
    expect(planParts(s)[0]!.outcome).toBe("approved");
  });

  test("force send during an ACP plan-gate review: changes keep waiting, and the plan comes up again", async () => {
    const s = fake("acp");
    await s.setPermissionMode("plan");
    await s.prompt("Add minus");
    await s.sessionTool("plan_set", { markdown: "1. Add minus" });
    s.agentMode("build");
    await until(() => planRequest(s));
    const plan = planRequest(s)!.planId;
    // The fake's abort doesn't end the turn: cancel the review the way an adapter's abort does.
    (s as any).abort = async () => s.cancelAllUi();
    await s.forceSend({ text: "Also handle zero" });
    await until(() => !planRequest(s));
    expect((await s.checkTool("edit", { path: "math.ts" })).allow).toBe(false);
    s.endTurn("Done.");
    // The adapter's turn end sends what waits.
    await (s as any).drainPending();
    expect(s.sent.at(-1)).toBe("Also handle zero");
    s.endTurn("Zero is handled too.");
    await until(() => planRequest(s));
    expect(planRequest(s)!.planId).toBe(plan);
  });

  test("Codex: only its plan item (or plan_set) goes up for review; a plain answer in plan mode doesn't", async () => {
    const s = fake("codex");
    await s.setPermissionMode("plan");
    await s.prompt("What does this repo do?");
    s.endTurn("It's a calculator.");
    await Bun.sleep(20);
    expect(planRequest(s)).toBeUndefined();
    await s.prompt("Add minus");
    s.endTurn("", [{ type: "plan", id: "item-1", text: "1. Add minus" }]);
    await until(() => planRequest(s));
    expect(planRequest(s)).toMatchObject({ title: "Codex's plan is ready for review", planId: "item-1" });
    s.uiRespond({ id: planRequest(s)!.id, allow: true });
    await until(() => s.sent.at(-1) === IMPLEMENT_PROMPT);
    expect(s.t.state.permissionMode).toBe("default");
  });

  test("a stopped or failed plan-mode turn, or a harness that reviews its own plans, gets no Tether review", async () => {
    const s = fake("pi");
    await s.setPermissionMode("plan");
    await s.prompt("Add minus");
    await s.stop();
    s.endTurn("1. Add minus");
    const n = fake("native");
    n.setState({ permissionMode: "plan" });
    await n.prompt("Add minus");
    n.endTurn("1. Add minus");
    await Bun.sleep(20);
    expect(planRequest(s)).toBeUndefined();
    expect(planRequest(n)).toBeUndefined();
    expect((await n.checkTool("edit", { path: "a.ts" })).reason).not.toBe(PLAN_MODE_REASON);
  });

  test("an ACP agent leaving plan mode by itself: changes wait for the review of its plan", async () => {
    const s = fake("acp");
    await s.setPermissionMode("plan");
    await s.prompt("Add minus");
    s.emit({ type: "msg", msg: { id: "a1", role: "assistant", parts: [{ type: "text", text: "Plan: add minus." }], ts: Date.now() } });
    s.agentMode("build");
    expect((await s.checkTool("edit", { path: "a.ts" })).reason).toBe(PLAN_WAIT_REASON);
    // Its turn ends: the reply goes up for review.
    s.endTurn("1. Add minus");
    await until(() => planRequest(s));
    s.uiRespond({ id: planRequest(s)!.id, allow: true });
    await until(() => s.sent.at(-1) === IMPLEMENT_PROMPT);
    expect((await s.checkTool("edit", { path: "a.ts" })).allow).toBe(true);
  });

  test("an ACP agent leaving plan mode mid-turn after plan_set: one review, still open when the turn ends", async () => {
    const s = fake("acp");
    await s.setPermissionMode("plan");
    await s.prompt("Add minus");
    await s.sessionTool("plan_set", { markdown: "1. Add minus" });
    s.agentMode("build");
    await until(() => planRequest(s));
    const first = planRequest(s)!.id;
    s.endTurn("ok");
    await Bun.sleep(20);
    expect(s.t.state.pendingUi.map((r) => r.id)).toEqual([first]);
    expect(s.planState?.status).toBe("review");
  });

  test("an approval from an earlier plan-mode stint doesn't let a later self-exit through", async () => {
    const s = fake("acp");
    await s.setPermissionMode("plan");
    await s.prompt("Add minus");
    s.endTurn("1. Add minus");
    await until(() => planRequest(s));
    s.uiRespond({ id: planRequest(s)!.id, allow: true });
    await until(() => s.sent.at(-1) === IMPLEMENT_PROMPT);
    s.endTurn("done");
    await s.setPermissionMode("plan");
    await s.prompt("Now refactor everything");
    s.agentMode("build");
    expect((await s.checkTool("edit", { path: "a.ts" })).reason).toBe(PLAN_WAIT_REASON);
  });

  test("an ACP plan gate ends when you stop the review or pick a mode yourself", async () => {
    const s = fake("acp");
    await s.setPermissionMode("plan");
    await s.prompt("Add minus");
    await s.sessionTool("plan_set", { markdown: "1. Add minus" });
    s.agentMode("build");
    await until(() => planRequest(s));
    s.uiRespond({ id: planRequest(s)!.id, cancelled: true });
    await until(() => !planRequest(s));
    expect((await s.checkTool("edit", { path: "a.ts" })).allow).toBe(true);
    // Again, and this time the mode picker (ACP's setPermissionMode tells the session).
    await s.setPermissionMode("plan");
    s.agentMode("build");
    expect((await s.checkTool("edit", { path: "a.ts" })).reason).toBe(PLAN_WAIT_REASON);
    (s as any).modeChosen("build");
    expect((await s.checkTool("edit", { path: "a.ts" })).allow).toBe(true);
  });

  test("a message sent while an approved plan's turn is starting waits for that turn", async () => {
    const s = fake("pi");
    await s.setPermissionMode("plan");
    await s.prompt("Add minus");
    s.endTurn("1. Add minus");
    await until(() => planRequest(s));
    let release!: () => void;
    (s as any).checkpoint = () => new Promise<void>((r) => (release = r));
    s.uiRespond({ id: planRequest(s)!.id, allow: true });
    await until(() => release);
    await s.prompt("Also keep the old name");
    expect(s.sent.at(-1)).not.toBe("Also keep the old name");
    expect(s.t.state.pending?.map((p) => p.text)).toEqual(["Also keep the old name"]);
    release();
    await until(() => s.sent.at(-1) === IMPLEMENT_PROMPT);
    expect(s.sent.filter((t) => t === "Also keep the old name").length).toBe(0);
  });

  test("a message instead of the review: the plan that turn writes replaces the waiting one", async () => {
    const s = fake("pi");
    await s.setPermissionMode("plan");
    await s.prompt("Add minus");
    s.endTurn("1. Add minus");
    await until(() => planRequest(s));
    const first = planRequest(s)!;
    await s.prompt("Also multiply");
    s.endTurn("1. Add minus\n2. Add times");
    await until(() => planRequest(s) && planRequest(s)!.id !== first.id);
    expect(s.t.state.pendingUi.filter((r) => r.kind === "plan").length).toBe(1);
    expect(planRequest(s)!.planId).toBe(s.planState!.partId);
    expect(s.planState).toMatchObject({ text: "1. Add minus\n2. Add times", status: "review" });
  });

  test("approving while a turn runs steers the go-ahead into it", async () => {
    const s = fake("pi");
    await s.setPermissionMode("plan");
    await s.prompt("Add minus");
    s.endTurn("1. Add minus");
    await until(() => planRequest(s));
    await s.prompt("one more thing"); // a turn starts before the review is answered
    s.uiRespond({ id: planRequest(s)!.id, allow: true });
    await until(() => s.t.state.pending?.some((p) => p.text === IMPLEMENT_PROMPT));
  });
});

describe("ask_user", () => {
  test("a question card on any harness; the answer goes back to the agent", async () => {
    const s = fake("pi");
    s.setGuard("ask");
    const res = s.sessionTool("ask_user", { question: "Which database?", options: ["Postgres", { label: "SQLite", description: "a file" }], multiSelect: true });
    await until(() => s.t.state.pendingUi.length);
    const q = s.t.state.pendingUi[0]!;
    expect(q).toMatchObject({
      kind: "question",
      title: "pi has a question",
      questions: [{ question: "Which database?", options: [{ label: "Postgres" }, { label: "SQLite", description: "a file" }], multiSelect: true }],
    });
    s.uiRespond({ id: q.id, answers: { "Which database?": "Postgres, SQLite" } });
    expect(await res).toEqual({ ok: true, text: "The user answered: Postgres, SQLite" });
    expect((await s.sessionTool("ask_user", { question: " " })).ok).toBe(false);
  });

  test("unattended (Auto guard), nobody answering times out with the usual answer; dismissing says the same", async () => {
    LiveSession.UNATTENDED_QUESTION_MS = 30;
    const s = fake("codex");
    s.setGuard("auto");
    expect(await s.sessionTool("ask_user", { question: "Go on?" })).toEqual({ ok: true, text: NOBODY_ANSWERED });
    expect(s.t.state.pendingUi).toEqual([]);
    s.setGuard("ask");
    const res = s.sessionTool("ask_user", { question: "Go on?" });
    await until(() => s.t.state.pendingUi.length);
    await Bun.sleep(60); // no timeout with a person in the loop
    s.uiRespond({ id: s.t.state.pendingUi[0]!.id, cancelled: true });
    expect((await res).text).toBe(NOBODY_ANSWERED);
  });

  test("over the bridge from tether-context: waits for the answer; a cancelled call takes the card away", async () => {
    const s = fake("native");
    s.setGuard("ask");
    process.env.TETHER_SESSION_KEY = s.guardEnv.TETHER_GUARD_KEY;
    process.env.TETHER_BRIDGE_FILE = sessionBridgeFile(s.guardEnv.TETHER_GUARD_KEY);
    try {
      const call = callTool("ask_user", { question: "Ship it?", options: ["Yes", "No"] });
      await until(() => s.t.state.pendingUi.length);
      await Bun.sleep(30);
      s.uiRespond({ id: s.t.state.pendingUi[0]!.id, answers: { "Ship it?": "Yes" } });
      expect(await call).toEqual({ content: [{ type: "text", text: "The user answered: Yes" }] });
      // The MCP client gives up on the call (notifications/cancelled): the card goes too.
      timing.progressMs = 10;
      const notes: any[] = [];
      const pending = handle({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "ask_user", arguments: { question: "Still there?" }, _meta: { progressToken: "p7" } } }, (m) => notes.push(m));
      await until(() => s.t.state.pendingUi.length && notes.length >= 2);
      expect(notes[0]).toMatchObject({ method: "notifications/progress", params: { progressToken: "p7", progress: 1 } });
      expect(await handle({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7 } })).toBeUndefined();
      expect(((await pending) as any).result.isError).toBe(true);
      await until(() => !s.t.state.pendingUi.length);
      // plan tools over the same path
      expect((await callTool("plan_set", { markdown: "1. Ship" })).content[0]!.text).toStartWith("Plan saved.");
      expect((await callTool("todo_set", { items: [{ text: "Ship", status: "pending" }] })).content[0]!.text).toBe("Todo list updated: 0 of 1 done.");
      expect((await callTool("plan_get", {})).content[0]!.text).toContain("1. Ship");
      delete process.env.TETHER_SESSION_KEY;
      expect((await callTool("ask_user", { question: "x" })).content[0]!.text).toBe("This works only in sessions Tether started.");
    } finally {
      delete process.env.TETHER_SESSION_KEY;
      delete process.env.TETHER_BRIDGE_FILE;
    }
  });
});

describe("handoff", () => {
  test("the plan and todo list go into the brief and become the new session's plan", async () => {
    const from = fake("native");
    const to = fake("pi");
    const deps: HandoffDeps = {
      adapters: { pi: { create: () => to } } as unknown as HandoffDeps["adapters"],
      sink: { emit: () => {}, summary: () => {}, handoff: async () => {} } as unknown as Sink,
      context: { handoffMemory: async () => undefined },
      track: () => {},
    };
    await from.prompt("Add minus");
    await from.sessionTool("plan_set", { markdown: "1. Add minus\n2. Test it" });
    from.emit({ type: "msg", msg: { id: "a9", role: "assistant", parts: [{ type: "plan", id: planParts(from)[0]!.id, text: "1. Add minus\n2. Test it", outcome: "approved" }], ts: Date.now() } });
    await from.sessionTool("todo_set", { items: [{ text: "Add minus", status: "completed" }, { text: "Test it", status: "in_progress" }] });
    await runHandoff(deps, from, { harness: "pi", model: "default" } as ChainEntry, "Opus hit its usage limit", undefined, { interrupted: true });
    const brief = to.sent[0]!;
    expect(brief).toContain("## Plan\nThe user approved this plan; carry it on.\n\n1. Add minus\n2. Test it\n\nTodo list:\n- [x] Add minus\n- [ ] Test it (in progress)");
    expect(to.planState).toMatchObject({ text: "1. Add minus\n2. Test it", status: "approved", todos: [{ text: "Add minus", status: "completed" }, { text: "Test it", status: "in_progress" }] });
    expect(planParts(to)).toEqual([expect.objectContaining({ text: "1. Add minus\n2. Test it", outcome: "approved", id: to.planState!.partId })]);
    expect(todoCards(to).length).toBe(1);
  });
});

describe("capability matrix", () => {
  test("plan, todos and ask_user on every harness", () => {
    const m = capabilityMatrix();
    for (const h of Object.keys(m) as HarnessId[]) for (const slot of ["plan", "todos", "ask_user"] as const) expect(m[h][slot].note.length).toBeGreaterThan(0);
    expect(m["claude-code"].plan.level).toBe("native");
    expect(m.antigravity.plan.level).toBe("native");
    expect(m.codex.plan.level).toBe("emulated");
    expect(m.opencode.plan.level).toBe("emulated");
    expect(m.pi.plan.level).toBe("emulated");
    expect(m["claude-code"].ask_user.level).toBe("native");
    expect(m.codex.ask_user.level).toBe("native");
    expect(m.codex.todos.level).toBe("native");
  });
});
