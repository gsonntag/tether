// Cross-harness subagents (crossAgents.ts, the "cross-harness subagents" section of session.ts):
// the agent_* tools, the worktree, the link between parent and subagent, what the parent hears when
// a subagent's turn ends, agent_wait, agent_result, and the guardrails (guard, depth, running
// count, Stop). Harness processes are stubs; worktrees are real git worktrees in the scratch HOME.

import { HOME, resetHome } from "./testenv";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HarnessId } from "../../web/src/shared/protocol";
import { MAX_RUNNING_SUBAGENTS, SUBAGENT_NOTE_PREFIX, SUBAGENT_TASK_PREFIX } from "../../web/src/shared/subagents";
import type { Sink } from "./adapters/types";
import { config } from "./config";
import { tools } from "./context/mcp";
import { CrossAgents, lastReport, slug, worktreesRoot } from "./crossAgents";
import { LiveSession, newId } from "./session";
import { runHandoff, type HandoffDeps } from "./handoffRun";

const byId = new Map<string, LiveSession>();
let all: LiveSession[] = [];

beforeEach(() => {
  resetHome();
  config().sessions = {};
  config().archived = [];
  config().titles = {};
  byId.clear();
  CrossAgents.SETTLE_MS = 10;
  CrossAgents.CHANGE_MS = 10;
});
afterEach(() => {
  all.splice(0).forEach((s) => s.close());
});

async function until(cond: () => unknown, ms = 5_000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(5);
  }
}

const git = (cwd: string, ...args: string[]) => {
  const p = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd });
  if (p.exitCode) throw new Error(p.stderr.toString());
  return p.stdout.toString().trim();
};

function makeFake(harness: HarnessId, projectPath: string, sink: Sink) {
  const sent: string[] = [];
  class Fake extends LiveSession {
    async start() {
      this.setState({ status: "idle" });
    }
    protected async send(text: string) {
      sent.push(text);
      this.addUserMessage(text);
      this.setState({ status: "running" });
    }
    protected async steer(text: string) {
      sent.push(`steer: ${text}`);
      return true;
    }
    async abort() {
      this.setState({ status: "idle" });
    }
    async applyModel(m: string) {
      this.setState({ model: m });
    }
    async setThinking(l: string) {
      this.setState({ thinking: l });
    }
    async setPermissionMode() {}
    async rename() {}
    async listCommands() {
      return [];
    }
    async continueTurn(text = "Continue.") {
      sent.push(text);
      this.addUserMessage(text);
      this.setState({ status: "running" });
    }
    protected shutdown() {}
    endTurn(text = "Done.") {
      this.emit({ type: "msg", msg: { id: newId("a"), role: "assistant", parts: [{ type: "text", text }], ts: Date.now() } });
      this.setState({ status: "idle" });
      // As the adapters do: what waits starts the next turn.
      void this.drainPending();
    }
  }
  const s = new Fake(harness, { nativeId: crypto.randomUUID(), projectPath }, sink);
  s.t.state.status = "idle";
  all.push(s);
  return Object.assign(s, { sent });
}
type Fake = ReturnType<typeof makeFake>;

const MODELS: Record<HarnessId, string[]> = {
  "claude-code": ["opus", "sonnet", "haiku"],
  codex: ["gpt-6-sol", "gpt-6-luna"],
  pi: ["openai-codex/gpt-6-luna", "anthropic/claude-sonnet-5"],
  opencode: [],
  kiro: ["claude-sonnet-4.5", "auto"],
  antigravity: ["gemini-3-pro"],
};

/** index.ts's wiring, with stub harnesses: every installed harness creates a Fake. */
function world(installed: HarnessId[] = ["claude-code", "codex", "kiro", "pi"]) {
  const sink: Sink = { emit: () => {}, summary: () => {}, handoff: async () => {} };
  const created: Fake[] = [];
  const track = (s: LiveSession) => {
    byId.set(s.id, s);
    s.loadPrefs();
  };
  const adapters = Object.fromEntries(
    (Object.keys(MODELS) as HarnessId[]).map((h) => [
      h,
      {
        available: async () => installed.includes(h),
        listModels: async () => ({ models: MODELS[h].map((id) => ({ id })), thinkingLevels: h === "codex" ? ["low", "medium", "high"] : [], permissionModes: h === "codex" ? ["default", "plan"] : ["default", "bypassPermissions"] }),
        create: (path: string, opts: { model?: string }) => {
          const s = makeFake(h, path, sink);
          if (opts.model) s.t.state.model = opts.model;
          created.push(s);
          return s;
        },
      },
    ]),
  ) as any;
  const agents = new CrossAgents({
    adapters,
    sink,
    track,
    live: (id) => byId.get(id),
    open: async (id) => {
      const s = byId.get(id);
      if (!s) throw new Error(`no ${id}`);
      return s;
    },
    archived: () => config().archived,
  });
  sink.agents = agents;
  const parent = (path: string, harness: HarnessId = "claude-code") => {
    const s = makeFake(harness, path, sink);
    track(s);
    return s;
  };
  return { agents, created, parent, sink };
}

function repo(name = "proj") {
  const dir = join(HOME, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "math.ts"), "export const add = (a: number, b: number) => a + b;\n");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "init");
  return dir;
}

const call = (s: LiveSession, tool: string, args: Record<string, unknown> = {}) => s.sessionTool(tool, args);

describe("agent_harnesses", () => {
  test("lists installed harnesses with their models, efforts and the guards allowed", async () => {
    const w = world();
    const p = w.parent(repo());
    p.setGuard("edits");
    const r = await call(p, "agent_harnesses");
    expect(r.ok).toBe(true);
    expect(r.text).toContain("## kiro (Kiro)");
    expect(r.text).toContain("claude-sonnet-4.5");
    expect(r.text).toContain("effort: low, medium, high");
    expect(r.text).not.toContain("bypassPermissions");
    expect(r.text).not.toContain("## antigravity");
    expect(r.text).toContain("can be ask, edits (never looser than yours)");
  });
});

describe("agent_start", () => {
  test("a Kiro subagent on a given model, in a worktree on a new branch from HEAD", async () => {
    const w = world();
    const dir = repo();
    const p = w.parent(dir);
    const head = git(dir, "rev-parse", "HEAD");
    writeFileSync(join(dir, "wip.ts"), "// not committed\n");
    const r = await call(p, "agent_start", { harness: "kiro", model: "claude-sonnet-4.5", task: "Write tests for math.ts", name: "Write Tests" });
    expect(r.ok).toBe(true);
    const child = w.created[0]!;
    expect(child.harness).toBe("kiro");
    expect(child.t.state.model).toBe("claude-sonnet-4.5");
    const link = p.subagents[0]!;
    expect(link).toMatchObject({ id: "write-tests", harness: "kiro", model: "claude-sonnet-4.5", cwd: "worktree", status: "working", sessionId: child.id });
    const short = slug(p.nativeId, 8);
    expect(link.worktree!.branch).toBe(`tether/${short}/write-tests`);
    expect(link.worktree!.base).toBe(head);
    expect(child.projectPath).toBe(link.worktree!.path);
    expect(child.projectPath.startsWith(worktreesRoot())).toBe(true);
    expect(git(child.projectPath, "rev-parse", "--abbrev-ref", "HEAD")).toBe(link.worktree!.branch);
    // The uncommitted file isn't there, and the result says so.
    expect(existsSync(join(child.projectPath, "wip.ts"))).toBe(false);
    expect(r.text).toContain("uncommitted changes are NOT in it");
    // The subagent: linked back, same guard, its task as the first message.
    expect(child.t.state.startedBy).toMatchObject({ sessionId: p.id, name: "write-tests", depth: 1, rootId: p.id, projectPath: dir });
    expect(child.summary().startedBy).toEqual({ sessionId: p.id, name: "write-tests" });
    expect(child.guardMode).toBe(p.guardMode);
    expect(child.sent[0]!.startsWith(SUBAGENT_TASK_PREFIX)).toBe(true);
    expect(child.sent[0]).toContain("Write tests for math.ts");
    expect(child.sent[0]).toContain(link.worktree!.branch);
    // The parent's activity strip: a subagent item with the harness and its session.
    const item = p.activity("xa:write-tests")!;
    expect(item).toMatchObject({ kind: "subagent", status: "running", harness: "kiro", sessionId: child.id, model: "claude-sonnet-4.5", background: true });
    expect(p.activeCount).toBe(1);
    expect(p.workingCount).toBe(1);
    // Not something a restart of the parent would report as stopped: the subagent goes on by itself.
    expect(p.busy).toBe(false);
  });

  test("an unknown model is refused with the harness's list; effort and mode are checked", async () => {
    const w = world();
    const p = w.parent(repo());
    const bad = await call(p, "agent_start", { harness: "kiro", model: "gpt-9", task: "x" });
    expect(bad.ok).toBe(false);
    expect(bad.text).toContain("claude-sonnet-4.5, auto");
    expect((await call(p, "agent_start", { harness: "codex", effort: "extreme", task: "x" })).text).toContain("low, medium, high");
    expect((await call(p, "agent_start", { harness: "codex", mode: "bypassPermissions", task: "x" })).ok).toBe(false);
    expect((await call(p, "agent_start", { harness: "antigravity", task: "x" })).text).toContain("isn't installed");
    expect(w.created).toHaveLength(0);
    // A label, case or pi's model without its provider finds the id.
    const ok = await call(p, "agent_start", { harness: "pi", model: "gpt-6-luna", task: "x", cwd: "shared" });
    expect(ok.ok).toBe(true);
    expect(p.subagents[0]!.model).toBe("openai-codex/gpt-6-luna");
    const eff = await call(p, "agent_start", { harness: "Codex", effort: "HIGH", task: "y", cwd: "shared" });
    expect(eff.ok).toBe(true);
    expect(w.created[1]!.t.state.thinking).toBe("high");
  });

  test("the guard is never looser than the parent's", async () => {
    const w = world();
    const p = w.parent(repo());
    p.setGuard("edits");
    const r = await call(p, "agent_start", { task: "x", guard: "auto" });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("looser");
    expect((await call(p, "agent_start", { task: "x", guard: "ask", cwd: "shared" })).ok).toBe(true);
    expect(w.created[0]!.guardMode).toBe("ask");
    expect((await call(p, "agent_start", { task: "y", cwd: "shared" })).ok).toBe(true);
    expect(w.created[1]!.guardMode).toBe("edits");
  });

  test("outside git it shares the folder; names stay unique", async () => {
    const w = world();
    const dir = join(HOME, "plain");
    mkdirSync(dir, { recursive: true });
    const p = w.parent(dir);
    const r = await call(p, "agent_start", { task: "Tidy the notes", name: "tidy" });
    expect(r.text).toContain("isn't a git repository");
    expect(w.created[0]!.projectPath).toBe(dir);
    expect(p.subagents[0]!.cwd).toBe("shared");
    await call(p, "agent_start", { task: "Tidy more", name: "tidy" });
    expect(p.subagents.map((l) => l.id)).toEqual(["tidy", "tidy-2"]);
  });

  test("depth is limited to 2, and at most MAX_RUNNING_SUBAGENTS run in one tree", async () => {
    const w = world();
    const p = w.parent(repo());
    await call(p, "agent_start", { task: "level one", cwd: "shared" });
    const one = w.created[0]!;
    expect((await call(one, "agent_start", { task: "level two", cwd: "shared" })).ok).toBe(true);
    const two = w.created[1]!;
    expect(two.t.state.startedBy).toMatchObject({ depth: 2, rootId: p.id });
    const deep = await call(two, "agent_start", { task: "level three", cwd: "shared" });
    expect(deep.ok).toBe(false);
    expect(deep.text).toContain("deeper");
    for (let i = 2; i < MAX_RUNNING_SUBAGENTS; i++) expect((await call(p, "agent_start", { task: `more ${i}`, cwd: "shared" })).ok).toBe(true);
    const full = await call(one, "agent_start", { task: "one too many", cwd: "shared" });
    expect(full.ok).toBe(false);
    expect(full.text).toContain(`at most ${MAX_RUNNING_SUBAGENTS}`);
    // A separate tree has its own allowance.
    const other = w.parent(repo("other"));
    expect((await call(other, "agent_start", { task: "elsewhere", cwd: "shared" })).ok).toBe(true);
  });

  test("not while planning or in a review session; the tools are listed everywhere but review sessions", async () => {
    const w = world();
    const p = w.parent(repo());
    p.t.state.reviewOf = { sessionId: "x:y", reviewId: "r" };
    expect((await call(p, "agent_start", { task: "x" })).text).toContain("review session");
    const names = () => tools().map((t) => t.name);
    expect(names()).toContain("agent_start");
    process.env.TETHER_CONTEXT_REVIEW = "1";
    try {
      expect(names()).not.toContain("agent_start");
    } finally {
      delete process.env.TETHER_CONTEXT_REVIEW;
    }
  });
});

describe("when a subagent's turn ends", () => {
  test("an idle parent gets a message that starts a turn, with the report's start and a pointer to agent_result", async () => {
    const w = world();
    const p = w.parent(repo());
    await call(p, "agent_start", { harness: "kiro", model: "claude-sonnet-4.5", task: "Write tests", name: "write-tests" });
    const child = w.created[0]!;
    child.endTurn("Added 4 tests in math.test.ts; bun test passes.");
    await until(() => p.sent.length);
    expect(p.sent[0]!.startsWith(`${SUBAGENT_NOTE_PREFIX} "write-tests" (Kiro`)).toBe(true);
    expect(p.sent[0]).toContain("finished: Added 4 tests");
    expect(p.sent[0]).toContain('agent_result({"id": "write-tests"})');
    expect(p.sent[0]).toContain("tether/");
    expect(p.subagents[0]).toMatchObject({ status: "finished", turns: 1, told: 1 });
    expect(p.activity("xa:write-tests")).toMatchObject({ status: "done", summary: "Added 4 tests in math.test.ts; bun test passes." });
    expect(p.activeCount).toBe(0);
  });

  test("a running parent gets it steered in", async () => {
    const w = world();
    const p = w.parent(repo());
    await call(p, "agent_start", { task: "x", name: "a", cwd: "shared" });
    p.setState({ status: "running" });
    w.created[0]!.endTurn("ok");
    await until(() => p.t.state.pending?.length);
    expect(p.t.state.pending![0]).toMatchObject({ mode: "steer" });
    expect(p.t.state.pending![0]!.text).toContain(`${SUBAGENT_NOTE_PREFIX} "a"`);
  });

  test("a failed turn and a stop say so; a turn followed by another (a goal) doesn't count", async () => {
    const w = world();
    const p = w.parent(repo());
    await call(p, "agent_start", { task: "x", name: "a", cwd: "shared" });
    const child = w.created[0]!;
    // Ends and starts again before it settles: no message.
    child.endTurn("step 1");
    child.setState({ status: "running" });
    await Bun.sleep(40);
    expect(p.sent).toHaveLength(0);
    child.notice("Provider exploded", "error");
    child.setState({ status: "idle" });
    await until(() => p.sent.length);
    expect(p.sent[0]).toContain('"a" (Claude Code');
    expect(p.sent[0]).toContain("failed: Provider exploded");
    expect(p.subagents[0]!.status).toBe("failed");
  });

  test("agent_wait returns when it finishes, and the parent isn't also messaged", async () => {
    const w = world();
    const p = w.parent(repo());
    await call(p, "agent_start", { task: "x", name: "a", cwd: "shared" });
    const waiting = call(p, "agent_wait", { id: "a", timeoutSec: 10 });
    await Bun.sleep(20);
    w.created[0]!.endTurn("All green.");
    const r = await waiting;
    expect(r.text).toContain('"a": Claude Code');
    expect(r.text).toContain("finished");
    expect(r.text).toContain("All green.");
    await Bun.sleep(50);
    expect(p.sent).toHaveLength(0);
    expect(p.subagents[0]).toMatchObject({ turns: 1, told: 1 });
    // Times out while one works.
    await call(p, "agent_message", { id: "a", text: "one more thing" });
    const t0 = Date.now();
    const r2 = await call(p, "agent_wait", { timeoutSec: 1 });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
    expect(r2.text).toContain("Still working after 1 s");
  });

  test("a question goes to the user: agent_wait returns, the parent isn't messaged", async () => {
    const w = world();
    const p = w.parent(repo());
    await call(p, "agent_start", { task: "x", name: "a", cwd: "shared" });
    const child = w.created[0]!;
    const waiting = call(p, "agent_wait", { timeoutSec: 10 });
    void child.askUi({ id: "q1", kind: "question", title: "Kiro has a question", questions: [{ question: "Which file?", options: [] }] });
    const r = await waiting;
    expect(r.text).toContain("waiting for the user");
    expect(r.text).toContain("Which file?");
    expect(p.subagents[0]!.status).toBe("waiting");
    await until(() => p.activity("xa:a")!.latest?.includes("Waiting for you"));
    await Bun.sleep(40);
    expect(p.sent).toHaveLength(0);
  });

  test("a parent that was closed is opened to hear it", async () => {
    const w = world();
    const p = w.parent(repo());
    await call(p, "agent_start", { task: "x", name: "a", cwd: "shared" });
    const child = w.created[0]!;
    // The parent's process goes; its links stay in its prefs.
    p.savePrefs();
    p.closed = true;
    const again = w.parent(p.projectPath);
    // Same session id, as a resume would have.
    (again as any).nativeId = p.nativeId;
    byId.set(again.id, again);
    again.loadPrefs();
    expect(again.subagents[0]!.id).toBe("a");
    expect(again.activity("xa:a")).toMatchObject({ status: "running", sessionId: child.id });
    child.endTurn("done");
    await until(() => again.sent.length);
    expect(again.sent[0]).toContain(`${SUBAGENT_NOTE_PREFIX} "a"`);
  });
});

describe("agent_message, agent_status, agent_result, agent_stop", () => {
  test("agent_result: report, files, commits on its branch, and how to merge", async () => {
    const w = world();
    const dir = repo();
    const p = w.parent(dir);
    await call(p, "agent_start", { task: "Add minus", name: "minus" });
    const child = w.created[0]!;
    writeFileSync(join(child.projectPath, "math.ts"), "export const add = (a: number, b: number) => a + b;\nexport const minus = (a: number, b: number) => a - b;\n");
    git(child.projectPath, "commit", "-qam", "Add minus");
    writeFileSync(join(child.projectPath, "notes.md"), "left uncommitted\n");
    child.endTurn("Added minus; bun test passes.");
    const r = await call(p, "agent_result", { id: "minus" });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("## Report\nAdded minus; bun test passes.");
    expect(r.text).toMatch(/modified\s+math\.ts \+1 -0/);
    expect(r.text).toContain("notes.md");
    expect(r.text).toContain("Add minus");
    expect(r.text).toContain("Uncommitted changes in its worktree: yes");
    expect(r.text).toContain(`git merge ${p.subagents[0]!.worktree!.branch}`);
    expect(r.text).toContain("+export const minus");
    // The branch is in the parent's repository: it can merge it.
    expect(git(dir, "branch", "--list", p.subagents[0]!.worktree!.branch)).toContain("tether/");
  });

  test("agent_message steers a working one and restarts a finished one; agent_status says what it does", async () => {
    const w = world();
    const p = w.parent(repo());
    await call(p, "agent_start", { task: "x", name: "a", cwd: "shared" });
    const child = w.created[0]!;
    const s = await call(p, "agent_status", { id: "a" });
    expect(s.text).toContain("working");
    expect((await call(p, "agent_message", { id: "a", text: "use vitest" })).text).toContain("Steered");
    expect(child.t.state.pending![0]!.text).toBe("[From the agent that started you] use vitest");
    // The steer wasn't taken before the turn ended: it starts the next one.
    child.endTurn("first");
    await until(() => child.sent.at(-1) === "[From the agent that started you] use vitest");
    child.endTurn("done");
    await until(() => p.subagents[0]!.status === "finished");
    expect((await call(p, "agent_message", { id: "a", text: "also docs", mode: "queue" })).text).toContain("started a turn");
    expect(child.sent.at(-1)).toBe("[From the agent that started you] also docs");
    await until(() => p.subagents[0]!.status === "working");
    expect((await call(p, "agent_list")).text).toContain('"a"');
    expect((await call(p, "agent_status", { id: "nope" })).text).toContain('No subagent "nope"');
  });

  test("agent_stop, and a parent's Stop, stop subagents without messaging the parent", async () => {
    const w = world();
    const p = w.parent(repo());
    await call(p, "agent_start", { task: "x", name: "a", cwd: "shared" });
    await call(p, "agent_start", { task: "y", name: "b", cwd: "shared" });
    const [a, b] = w.created;
    expect((await call(p, "agent_stop", { id: "a" })).text).toContain('Stopped "a"');
    await until(() => p.subagents[0]!.status === "stopped");
    expect(a!.t.state.status).toBe("idle");
    p.setState({ status: "running" });
    await p.stop();
    await until(() => p.subagents[1]!.status === "stopped");
    expect(b!.t.state.status).toBe("idle");
    await Bun.sleep(50);
    expect(p.sent).toHaveLength(0);
    expect(p.t.state.pending ?? []).toHaveLength(0);
    expect(p.activeCount).toBe(0);
  });

  test("the Stop button on its item stops it, and the parent hears", async () => {
    const w = world();
    const p = w.parent(repo());
    await call(p, "agent_start", { task: "x", name: "a", cwd: "shared" });
    await p.stopActivity("xa:a");
    await until(() => p.sent.length);
    expect(p.sent[0]).toContain('"a" (Claude Code) was stopped');
  });
});

test("lastReport is the text after the last user message", () => {
  const msgs: any[] = [
    { id: "1", role: "assistant", parts: [{ type: "text", text: "old" }], ts: 1 },
    { id: "2", role: "user", parts: [{ type: "text", text: "go" }], ts: 2 },
    { id: "3", role: "assistant", parts: [{ type: "text", text: "a" }, { type: "tool", id: "t", name: "Bash", input: {}, status: "done" }], ts: 3 },
    { id: "4", role: "assistant", parts: [{ type: "text", text: "b" }], ts: 4 },
  ];
  expect(lastReport(msgs)).toBe("a\n\nb");
});

describe("handoffs", () => {
  test("a parent that hands off: the new session follows its subagents and hears from them", async () => {
    const w = world();
    const p = w.parent(repo());
    await call(p, "agent_start", { task: "x", name: "a", cwd: "shared" });
    const child = w.created[0]!;
    const next = makeFake("codex", p.projectPath, w.sink);
    const hd: HandoffDeps = {
      adapters: { codex: { create: () => next } } as any,
      sink: w.sink,
      context: { handoffMemory: async () => undefined },
      track: (x) => {
        byId.set(x.id, x);
        x.loadPrefs();
      },
    };
    p.savePrefs();
    await runHandoff(hd, p, { harness: "codex", model: "default" }, "test");
    expect(next.subagents.map((l) => l.id)).toEqual(["a"]);
    expect(next.activity("xa:a")).toMatchObject({ status: "running", sessionId: child.id });
    expect(p.subagents).toEqual([]);
    expect(p.activity("xa:a")).toBeUndefined();
    // The brief doesn't list it as a background task that was stopped.
    expect(next.sent[0]).not.toContain("background");
    next.setState({ status: "idle" });
    child.endTurn("done");
    await until(() => next.sent.some((t) => t.startsWith(SUBAGENT_NOTE_PREFIX)));
    expect(next.subagents[0]!.status).toBe("finished");
  });

  test("a subagent that hands off stays one: the parent's link follows it", async () => {
    const w = world();
    const p = w.parent(repo());
    await call(p, "agent_start", { task: "x", name: "a", cwd: "shared" });
    const child = w.created[0]!;
    const next = makeFake("pi", child.projectPath, w.sink);
    const hd: HandoffDeps = {
      adapters: { pi: { create: () => next } } as any,
      sink: w.sink,
      context: { handoffMemory: async () => undefined },
      track: (x) => {
        byId.set(x.id, x);
        x.loadPrefs();
      },
    };
    await runHandoff(hd, child, { harness: "pi", model: "default" }, "limit");
    expect(next.t.state.startedBy).toMatchObject({ sessionId: p.id, name: "a" });
    await until(() => p.subagents[0]!.sessionId === next.id);
    next.endTurn("finished on pi");
    await until(() => p.sent.length);
    expect(p.sent[0]).toContain("finished on pi");
  });
});
