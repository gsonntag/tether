// Fork ("Fork from here", fork.ts) and /compact (session.ts compactCommand, handoffRun.ts
// runCompact): where a fork cuts, the native fork points Claude Code and Codex sessions record (live
// and from history), the native fork vs the brief, and each harness's compaction or Tether's
// restart on a brief. Harness processes are stubs; Claude Code's forkSession runs for real on a
// transcript written into the scratch HOME.

import { HOME, resetHome } from "./testenv";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HarnessId, Msg } from "../../web/src/shared/protocol";
import { kiroAdapter } from "./adapters/acp";
import { claudeAdapter, historyMessages } from "./adapters/claude";
import { codexAdapter, CodexSession, historyMsgs } from "./adapters/codex";
import { sessionDir } from "./attachments";
import { piAdapter } from "./adapters/pi";
import type { Sink } from "./adapters/types";
import { config, prefs } from "./config";
import { capabilityMatrix } from "./connectors";
import { forkCut, forkReason, promptOf, runFork, type ForkDeps } from "./fork";
import { buildBrief, isBrief } from "./handoff";
import { COMPACT_REASON, runCompact, type HandoffDeps } from "./handoffRun";
import { LiveSession, newId } from "./session";

let live: LiveSession[] = [];

beforeEach(() => {
  resetHome();
  config().sessions = {};
  config().archived = [];
  config().titles = {};
});
afterEach(() => {
  live.splice(0).forEach((s) => s.close());
});

const settle = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
const noticeTexts = (s: LiveSession) => s.t.messages.filter((m) => m.role === "notice").map((m) => (m.parts[0] as any).text as string);
const user = (id: string, text: string): Msg => ({ id, role: "user", parts: [{ type: "text", text }], ts: 1 });
const reply = (id: string, text: string): Msg => ({ id, role: "assistant", parts: [{ type: "text", text }], ts: 1 });
const note = (id: string, text: string): Msg => ({ id, role: "notice", parts: [{ type: "text", text }], ts: 1 });

const nullSink = (): Sink => ({ emit: () => {}, summary: () => {}, handoff: async () => {} });

/** A harness that records what it's sent; `marks` stand in for a native fork's points. */
function fake(harness: HarnessId = "claude-code", opts: { marks?: boolean; compact?: (focus?: string) => Promise<boolean>; sink?: Sink } = {}) {
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
    async abort() {}
    async applyModel(m: string) {
      this.setState({ model: m });
    }
    async setThinking() {}
    async setPermissionMode() {}
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
    forkPoint(n: number) {
      return opts.marks ? this.lastMark(n) : undefined;
    }
    protected async nativeCompact(focus?: string) {
      return opts.compact ? opts.compact(focus) : false;
    }
    mark(id: string, point: string) {
      this.forkMarks.set(id, point);
    }
    say(m: Msg) {
      this.emit({ type: "msg", msg: m });
    }
  }
  const s = new Fake(harness, { nativeId: crypto.randomUUID(), projectPath: HOME }, opts.sink ?? nullSink());
  s.t.state.status = "idle";
  s.loadPrefs();
  live.push(s);
  return Object.assign(s, { sent });
}

/** Deps whose adapters hand out the given sessions (create) and record native forks. */
function deps(targets: Partial<Record<HarnessId, LiveSession>>, fork?: (from: { nativeId: string; point: string }) => Promise<LiveSession>) {
  const created: string[] = [];
  const forks: { nativeId: string; point: string }[] = [];
  const adapters = Object.fromEntries(
    Object.entries(targets).map(([h, s]) => [
      h,
      {
        create: () => (created.push(h), s),
        ...(fork ? { fork: async (from: { nativeId: string; point: string }) => (forks.push({ nativeId: from.nativeId, point: from.point }), fork(from)) } : {}),
      },
    ]),
  );
  const d: ForkDeps & HandoffDeps = {
    adapters: adapters as any,
    sink: nullSink(),
    context: { handoffMemory: async () => undefined },
    track: (s) => s.loadPrefs(),
  };
  return { d, created, forks };
}

// ---------------- where a fork cuts ----------------

describe("the cut", () => {
  const msgs = [user("u1", "Fix the login bug"), reply("a1", "Fixed it."), note("n1", "Goal set."), user("u2", "Now add tests"), reply("a2", "Added.")];

  test("at a reply: everything up to and including it", () => {
    const c = forkCut(msgs, "a1")!;
    expect(c.kept.map((m) => m.id)).toEqual(["u1", "a1"]);
    expect(c.ask).toBeUndefined();
    expect(c.later).toBe(true);
  });

  test("at one of your messages: what came before, and that message is asked again", () => {
    const c = forkCut(msgs, "u2")!;
    expect(c.kept.map((m) => m.id)).toEqual(["u1", "a1", "n1"]);
    expect(c.ask).toBe("Now add tests");
    expect(forkCut(msgs, "a2")!.later).toBe(false);
    expect(forkCut(msgs, "nope")).toBeUndefined();
  });

  test("a message is sent again as typed: its skill, its text, its files", () => {
    const m: Msg = {
      id: "u",
      role: "user",
      ts: 1,
      parts: [
        { type: "skill", name: "review", content: "SKILL.md" },
        { type: "text", text: "the auth module" },
        { type: "file", name: "spec.pdf", path: "/a/spec.pdf", mimeType: "application/pdf", size: 10 },
      ],
    } as Msg;
    expect(promptOf(m)).toBe("/review the auth module\n\nAttached files (open them with your file-reading tool):\n- /a/spec.pdf (application/pdf, 10 B)");
    expect(forkReason(user("x", "Fix the login bug in the session middleware and the cookie handling too"))).toBe("at “Fix the login bug in the session middleware and the cookie…”");
    expect(forkReason(reply("x", ""))).toBe("at one of its replies");
  });
});

// ---------------- the brief ----------------

describe("briefs for a fork and for /compact", () => {
  test("a fork's brief: the conversation up to the fork, a note that files may have moved on, and no work yet", async () => {
    const b = await buildBrief({ kind: "fork", messages: [user("u1", "Fix the login bug"), reply("a1", "Fixed it.")], cwd: HOME, fromLabel: "Claude Code, Opus", reason: "the user forked it at “Fixed it.”", later: true });
    expect(isBrief(user("b", b))).toBe(true);
    expect(b).toContain("forked from a conversation with another agent (Claude Code, Opus): the user forked it at “Fixed it.”");
    expect(b).toContain("The original conversation went on after that point");
    expect(b).toContain("### User\nFix the login bug");
    expect(b).toContain("## What to do\nDon't start any work yet.");
    const asked = await buildBrief({ kind: "fork", messages: [], cwd: HOME, fromLabel: "x", reason: "y", pendingPrompt: "Try it with Redis" });
    expect(asked).toContain("## What to do\nThe user's new message:\n\nTry it with Redis");
    expect(asked).not.toContain("went on after that point");
  });

  test("a compaction's brief: the same agent, a fresh context, the focus", async () => {
    const b = await buildBrief({ kind: "compact", messages: [user("u1", "Fix the login bug")], cwd: HOME, fromLabel: "pi, Sonnet", reason: COMPACT_REASON, focus: "the cookie handling" });
    expect(b).toContain("from an earlier session of your own (pi, Sonnet), restarted to free up context");
    expect(b).toContain("## Focus\nThe user asked to keep this in focus: the cookie handling");
    expect(b).toContain("Sum up where things stand in a few lines, with the focus above in mind");
  });
});

// ---------------- runFork ----------------

describe("forking", () => {
  test("into another harness: a new session on a brief of the conversation up to there, linked back", async () => {
    const from = fake("claude-code");
    from.say(user("u1", "Fix the login bug"));
    from.say(reply("a1", "Fixed it in auth.ts."));
    from.say(user("u2", "Now add tests"));
    from.say(reply("a2", "Added tests."));
    from.setTitle("Login bug");
    const to = fake("codex");
    const { d, created } = deps({ codex: to });
    const next = await runFork(d, from, { msgId: "a1", harness: "codex", model: "gpt-6" });
    expect(next).toBe(to);
    expect(created).toEqual(["codex"]);
    expect(to.sent).toHaveLength(1);
    expect(to.sent[0]).toContain("Fixed it in auth.ts.");
    expect(to.sent[0]).not.toContain("Now add tests");
    expect(to.sent[0]).toContain("Don't start any work yet.");
    expect(to.t.state.forkedFrom).toEqual({ sessionId: from.id, reason: "at “Fixed it in auth.ts.”" });
    expect(prefs(to.id).forkedFrom).toEqual(to.t.state.forkedFrom!);
    expect(to.t.state.model).toBe("gpt-6");
    expect(to.title).toBe("Login bug (fork)");
    expect(noticeTexts(to)[0]).toContain("The files on disk include the changes made after that point.");
    // The original goes on untouched.
    expect(from.t.state.handoffTo).toBeUndefined();
    expect(from.t.messages).toHaveLength(4);
  });

  test("at one of your messages: the new agent answers it again, with what you add", async () => {
    const from = fake("claude-code");
    from.say(user("u1", "Fix the login bug"));
    from.say(reply("a1", "Fixed it."));
    from.say(user("u2", "Now add tests"));
    const to = fake("pi");
    const { d } = deps({ pi: to });
    await runFork(d, from, { msgId: "u2", harness: "pi", prompt: "Use vitest." });
    expect(to.sent[0]).toContain("The user's new message:\n\nNow add tests\n\nUse vitest.");
    expect(to.sent[0]).not.toContain("### User\nNow add tests");
    // The message shows as yours; the brief is the folded card after it.
    expect(to.t.messages.filter((m) => m.role === "user").map((m) => (m.parts[0] as any).text.slice(0, 20))).toEqual(["Now add tests\n\nUse v", "You are taking over "]);
  });

  test("at the first message: nothing to brief, the new session just gets it", async () => {
    const from = fake("claude-code");
    from.say(user("u1", "Fix the login bug"));
    from.say(reply("a1", "Fixed it."));
    const to = fake("codex");
    const { d } = deps({ codex: to });
    await runFork(d, from, { msgId: "u1", harness: "codex" });
    expect(to.sent).toEqual(["Fix the login bug"]);
  });

  test("a message's inline images are sent again as stored files, an image-only message too", async () => {
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex").toString("base64");
    const shot = (id: string, text?: string): Msg => ({ id, role: "user", ts: 1, parts: [...(text ? [{ type: "text" as const, text }] : []), { type: "image", mimeType: "image/png", data: png }] });
    expect(forkCut([shot("u1")], "u1")).toMatchObject({ kept: [], ask: "" });
    const from = fake("claude-code");
    from.say(shot("u1"));
    const to = fake("codex");
    const { d } = deps({ codex: to });
    await runFork(d, from, { msgId: "u1", harness: "codex" });
    const path = to.sent[0]!.match(/^- (\S+) \(image\/png/m)?.[1];
    expect(to.sent[0]).toStartWith("Attached files (");
    expect(path).toStartWith(sessionDir(from.id));
    expect(readFileSync(path!).toString("base64")).toBe(png);
    // With text and history: the brief's new message lists it.
    const from2 = fake("claude-code");
    from2.say(user("u1", "Fix the login bug"));
    from2.say(reply("a1", "Fixed it."));
    from2.say(shot("u2", "Now this layout"));
    const to2 = fake("pi");
    await runFork(deps({ pi: to2 }).d, from2, { msgId: "u2", harness: "pi" });
    expect(to2.sent[0]).toContain("The user's new message:\n\nNow this layout\n\nAttached files (");
  });

  test("the source's memory capture is left alone: a fork carries memories only", async () => {
    const asked: any[] = [];
    const from = fake("claude-code");
    from.say(user("u1", "Fix the login bug"));
    from.say(reply("a1", "Fixed it."));
    from.say(user("u2", "Now add tests"));
    const { d } = deps({ pi: fake("pi") });
    d.context = { handoffMemory: async (o) => void asked.push(o) };
    await runFork(d, from, { msgId: "a1", harness: "pi" });
    expect(asked).toHaveLength(1);
    expect(asked[0].capture).toBe(false);
    expect(asked[0].messages.map((m: Msg) => m.id)).toEqual(["u1", "a1"]);
  });

  test("on the same harness with a native fork point: the harness's own fork", async () => {
    const from = fake("claude-code", { marks: true });
    from.say(user("u1", "Fix the login bug"));
    from.mark("u1", "e-u1");
    from.say(reply("a1", "Fixed it."));
    from.mark("a1", "e-a1");
    from.say(note("n1", "Checkpoint."));
    from.say(user("u2", "Now add tests"));
    from.mark("u2", "e-u2");
    const native = fake("claude-code");
    const { d, forks, created } = deps({ "claude-code": fake("claude-code") }, async () => native);
    await runFork(d, from, { msgId: "u2", harness: "claude-code", prompt: "Use vitest." });
    // Cut before your message (the notice after the reply doesn't count), which is asked again.
    expect(forks).toEqual([{ nativeId: from.nativeId, point: "e-a1" }]);
    expect(created).toEqual([]);
    expect(native.sent).toEqual(["Now add tests\n\nUse vitest."]);
    expect(native.t.state.forkedFrom?.sessionId).toBe(from.id);
    expect(noticeTexts(native)[0]).toBe("Forked from a Claude Code session at “Now add tests”: Claude Code copied the conversation up to there.");
  });

  test("no fork point there, another harness, or a failing native fork: the brief", async () => {
    const from = fake("claude-code", { marks: true });
    from.say(user("u1", "Fix the login bug"));
    from.mark("u1", "e-u1");
    from.say(reply("a1", "Fixed it.")); // no mark: Tether can't place it
    const brief1 = fake("claude-code");
    const r1 = deps({ "claude-code": brief1 }, async () => fake("claude-code"));
    await runFork(r1.d, from, { msgId: "a1", harness: "claude-code" });
    expect(r1.forks).toEqual([]);
    expect(brief1.sent[0]).toContain("You are taking over");

    from.mark("a1", "e-a1");
    const brief2 = fake("claude-code");
    const r2 = deps({ "claude-code": brief2 }, async () => {
      throw new Error("no such entry");
    });
    await runFork(r2.d, from, { msgId: "a1", harness: "claude-code" });
    expect(r2.forks).toEqual([{ nativeId: from.nativeId, point: "e-a1" }]);
    expect(brief2.sent[0]).toContain("You are taking over");
  });

  test("an unknown message is refused", async () => {
    const from = fake();
    const { d } = deps({ codex: fake("codex") });
    await expect(runFork(d, from, { msgId: "gone", harness: "codex" })).rejects.toThrow("That message isn't in this session any more.");
  });
});

// ---------------- native fork points ----------------

const meta = () => ({ flags: new Map(), times: new Map() });

describe("Claude Code fork points", () => {
  test("from history: each message ends at its last entry, tool results included", () => {
    const marks = new Map<string, string>();
    const list = [
      { type: "user", uuid: "e1", parent_tool_use_id: null, message: { role: "user", content: "Fix the bug" } },
      { type: "assistant", uuid: "e2", parent_tool_use_id: null, message: { id: "api1", content: [{ type: "text", text: "Looking." }] } },
      { type: "assistant", uuid: "e3", parent_tool_use_id: null, message: { id: "api1", content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.ts" } }] } },
      { type: "user", uuid: "e4", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "code" }] } },
      { type: "assistant", uuid: "e5", parent_tool_use_id: null, message: { id: "api2", content: [{ type: "text", text: "Fixed." }] } },
      { type: "system", uuid: "e6", parent_tool_use_id: null, message: { subtype: "compact_boundary" } },
    ];
    const msgs = historyMessages(list as any, meta(), marks);
    expect(msgs.map((m) => m.id)).toEqual(["e1", "e2", "e5", "e6"]);
    expect(Object.fromEntries(marks)).toEqual({ e1: "e1", e2: "e4", e5: "e5", e6: "e6" });
  });

  test("live: your messages go out under their own uuid, replies end at their last entry", async () => {
    const s: any = claudeAdapter.create(HOME, {}, nullSink());
    s.q = { supportedCommands: async () => [], interrupt: async () => {}, getContextUsage: async () => ({}) };
    s.t.state.status = "idle";
    s.loadPrefs();
    live.push(s);
    await s.prompt("Fix the bug");
    const sent = s.input.items[0];
    const u = s.t.messages.find((m: Msg) => m.role === "user");
    expect(sent.uuid).toBe(u.id);
    s.onMessage({ type: "stream_event", event: { type: "message_start", message: { id: "api1", model: "opus", usage: {} } }, parent_tool_use_id: null });
    s.onMessage({ type: "assistant", uuid: "e2", parent_tool_use_id: null, message: { id: "api1", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }], model: "opus", stop_reason: null } });
    s.onMessage({ type: "user", uuid: "e3", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "x" }] } });
    const a = s.t.messages.find((m: Msg) => m.role === "assistant");
    expect(s.forkPoint(1)).toBe(u.id);
    expect(s.forkPoint(s.t.messages.indexOf(a) + 1)).toBe("e3");
    // A notice of Tether's own after it doesn't move the point; a message Claude Code doesn't have does.
    s.notice("Checking usage…");
    expect(s.forkPoint(s.t.messages.length)).toBe("e3");
    s.addUserMessage("a correction");
    expect(s.forkPoint(s.t.messages.length)).toBeUndefined();
  });

  test("forkSession copies the transcript up to the entry, into a session Tether resumes", async () => {
    const dir = join(HOME, "proj");
    mkdirSync(dir, { recursive: true });
    const sid = crypto.randomUUID();
    const enc = dir.replace(/[^a-zA-Z0-9]/g, "-");
    const pdir = join(HOME, ".claude", "projects", enc);
    mkdirSync(pdir, { recursive: true });
    const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    const base = { sessionId: sid, cwd: dir, version: "2.1.0", userType: "external", isSidechain: false };
    const lines = [
      { ...base, type: "user", uuid: ids[0], parentUuid: null, timestamp: "2026-10-11T10:00:00.000Z", message: { role: "user", content: "first" } },
      { ...base, type: "assistant", uuid: ids[1], parentUuid: ids[0], timestamp: "2026-10-11T10:00:01.000Z", message: { id: "m1", role: "assistant", model: "x", type: "message", content: [{ type: "text", text: "one" }] } },
      { ...base, type: "user", uuid: ids[2], parentUuid: ids[1], timestamp: "2026-10-11T10:00:02.000Z", message: { role: "user", content: "second" } },
      { ...base, type: "assistant", uuid: ids[3], parentUuid: ids[2], timestamp: "2026-10-11T10:00:03.000Z", message: { id: "m2", role: "assistant", model: "x", type: "message", content: [{ type: "text", text: "two" }] } },
    ];
    writeFileSync(join(pdir, `${sid}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const saved = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = join(HOME, ".claude");
    try {
      const s: any = await claudeAdapter.fork!({ nativeId: sid, projectPath: dir, point: ids[1]! }, { model: "sonnet" }, nullSink());
      live.push(s);
      expect(s.nativeId).not.toBe(sid);
      expect(s.resumeId).toBe(s.nativeId);
      const copy = readFileSync(join(pdir, `${s.nativeId}.jsonl`), "utf8");
      expect(copy).toContain('"first"');
      expect(copy).toContain('"one"');
      expect(copy).not.toContain('"second"');
      expect(s.opts.model).toBe("sonnet");
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = saved;
    }
  });
});

/** A Codex session on a stub app-server: turn/start hands out turn ids. */
function codex() {
  const s: any = codexAdapter.create(HOME, {}, nullSink());
  const calls: [string, any][] = [];
  let n = 0;
  s.p = { call: async (m: string, p: any) => (calls.push([m, p]), m === "turn/start" ? { turn: { id: `t${++n}` } } : {}), kill() {} };
  s.nativeId = "thread-1";
  s.t.state.status = "idle";
  s.loadPrefs();
  live.push(s);
  const notify = (method: string, p: any) => s.onNotify(method, { threadId: "thread-1", ...p });
  /** one whole turn: your message, a reply, the end */
  const turn = async (text: string, replyText: string) => {
    await s.prompt(text);
    const id = s.turnId;
    notify("turn/started", { turn: { id } });
    notify("item/started", { item: { type: "agentMessage", id: `i-${id}`, text: "" } });
    notify("item/completed", { item: { type: "agentMessage", id: `i-${id}`, text: replyText } });
    notify("turn/completed", { turn: { id, status: "completed" } });
    await settle();
    return id as string;
  };
  return { s, calls, notify, turn };
}

describe("Codex fork points", () => {
  test("from history: each message takes its turn", () => {
    const marks = new Map<string, string>();
    const turns = [
      { id: "T1", items: [{ type: "userMessage", id: "x1", content: [{ type: "text", text: "one" }] }, { type: "agentMessage", id: "x2", text: "ok" }] },
      { id: "T2", items: [{ type: "userMessage", id: "x3", content: [{ type: "text", text: "two" }] }, { type: "agentMessage", id: "x4", text: "ok" }] },
    ];
    const msgs = historyMsgs(turns, "/p", "gpt", undefined, marks);
    expect(msgs.map((m) => marks.get(m.id))).toEqual(["T1", "T1", "T2", "T2"]);
  });

  test("live: only where a turn ends, and never in the running turn", async () => {
    const { s, notify, turn } = codex();
    const t1 = await turn("one", "first reply");
    const t2 = await turn("two", "second reply");
    const at = (id: string) => s.t.messages.findIndex((m: Msg) => m.id === id);
    const [u1, a1, u2, a2] = s.t.messages.filter((m: Msg) => m.role !== "notice");
    expect([u1.role, a1.role, u2.role, a2.role]).toEqual(["user", "assistant", "user", "assistant"]);
    // After a reply that ends a turn, before your message that starts the next, at the end.
    expect(s.forkPoint(at(a1.id) + 1)).toBe(t1);
    expect(s.forkPoint(at(u2.id))).toBe(t1);
    expect(s.forkPoint(s.t.messages.length)).toBe(t2);
    // Inside a turn: no native point.
    expect(s.forkPoint(at(u1.id) + 1)).toBeUndefined();
    // The turn running now can't be forked through.
    await s.prompt("three");
    notify("turn/started", { turn: { id: s.turnId } });
    expect(s.forkPoint(s.t.messages.length)).toBeUndefined();
    expect(s.forkPoint(at(a2.id) + 1)).toBe(t2);
  });

  test("Codex's fork starts a forked thread through that turn", async () => {
    const s: any = await codexAdapter.fork!({ nativeId: "thread-1", projectPath: HOME, point: "T1" }, { model: "gpt-6" }, nullSink());
    expect(s.opts).toEqual({ model: "gpt-6", fork: { threadId: "thread-1", lastTurnId: "T1" } });
  });
});

// ---------------- /compact ----------------

describe("/compact", () => {
  test("Claude Code: its own /compact, focus included, without a Finished notification", async () => {
    const s: any = claudeAdapter.create(HOME, {}, nullSink());
    s.q = { supportedCommands: async () => [], interrupt: async () => {}, getContextUsage: async () => ({}) };
    s.t.state.status = "idle";
    s.loadPrefs();
    live.push(s);
    await s.prompt("/compact keep the API notes");
    expect(s.input.items.map((m: any) => m.message.content)).toEqual(["/compact keep the API notes"]);
    expect(s.t.state.status).toBe("running");
    expect(s.loopTurn).toBe(true);
  });

  test("busy or handed off: not now", async () => {
    const compacted: (string | undefined)[] = [];
    const s = fake("pi", { compact: async (f) => (compacted.push(f), true) });
    s.setState({ status: "running" });
    await s.prompt("/compact");
    expect(noticeTexts(s).at(-1)).toBe("The agent is busy. Compact once it's done, or stop it first.");
    s.setState({ status: "idle", handoffTo: { sessionId: "x", reason: "y" } });
    await s.prompt("/compact");
    expect(noticeTexts(s).at(-1)).toBe("This conversation continues in another session. Compact it there.");
    expect(compacted).toEqual([]);
    expect(s.sent).toEqual([]);
    // "/compacting" is just a message.
    expect(await s.compactCommand("/compacting the logs")).toBe(false);
  });

  test("Codex: thread/compact/start; with a focus it can't take, Tether's restart", async () => {
    const restarts: (string | undefined)[] = [];
    const { s, calls } = codex();
    s.sink = { ...nullSink(), compact: async (_: LiveSession, focus?: string) => void restarts.push(focus) };
    await s.prompt("/compact");
    expect(calls.map((c) => c[0])).toEqual(["thread/compact/start"]);
    expect(s.t.state.status).toBe("running");
    s.onNotify("turn/completed", { threadId: "thread-1", turn: { id: "c1", status: "completed" } });
    await settle();
    expect(s.t.state.status).toBe("idle");
    await s.prompt("/compact the auth flow");
    expect(restarts).toEqual(["the auth flow"]);
    expect(calls).toHaveLength(1);
  });

  test("pi: its compact RPC with the focus as instructions", async () => {
    const s: any = piAdapter.create(HOME, {}, nullSink());
    const calls: [string, any][] = [];
    s.rpc = { call: async (type: string, args: any) => (calls.push([type, args]), {}), close() {} };
    s.t.state.status = "idle";
    s.loadPrefs();
    live.push(s);
    await s.prompt("/compact the failing tests");
    expect(calls).toEqual([["compact", { customInstructions: "the failing tests" }]]);
    expect(s.t.state.status).toBe("idle");
  });

  test("ACP: an agent's own /compact command when it lists one, else Tether's restart", async () => {
    const restarts: (string | undefined)[] = [];
    const prompts: string[] = [];
    const s: any = kiroAdapter.create(HOME, {}, { ...nullSink(), compact: async (_, focus) => void restarts.push(focus) });
    s.p = { conn: { prompt: async (p: any) => (prompts.push(p.prompt[0].text), { stopReason: "end_turn" }), cancel: async () => {} }, caps: {}, kill() {} };
    s.t.state.status = "idle";
    s.loadPrefs();
    live.push(s);
    await s.prompt("/compact");
    expect(restarts).toEqual([undefined]);
    s.commands = [{ name: "compact" }];
    await s.prompt("/compact the parser");
    await settle();
    expect(prompts).toEqual(["/compact the parser"]);
  });

  test("Tether's restart: a new session on a brief with the focus, linked, the old one marked done", async () => {
    const to = fake("antigravity");
    const { d } = deps({ antigravity: to });
    const from = fake("antigravity", { sink: { ...nullSink(), compact: (f, focus) => runCompact(d, f, focus).then(() => {}) } });
    from.setTitle("Parser rewrite");
    from.say(user("u1", "Rewrite the parser"));
    from.say(reply("a1", "Done with the lexer."));
    await from.prompt("/compact the error recovery");
    expect(to.sent).toHaveLength(1);
    expect(to.sent[0]).toContain("restarted to free up context");
    expect(to.sent[0]).toContain("## Focus\nThe user asked to keep this in focus: the error recovery");
    expect(to.sent[0]).toContain("Done with the lexer.");
    expect(to.t.state.handoffFrom).toEqual({ sessionId: from.id, reason: COMPACT_REASON });
    expect(from.t.state.handoffTo).toEqual({ sessionId: to.id, reason: COMPACT_REASON });
    expect(noticeTexts(from).at(-1)).toBe("Restarted to free up context: this conversation goes on in a new session.");
    expect(noticeTexts(to)[0]).toContain(", and asked to keep “the error recovery” in focus.");
    expect(config().archived).toContain(from.id);
    expect(config().titles[to.id]).toBe("Parser rewrite");
    expect(from.closed).toBe(true);
  });

  test("Tether's restart: what you send meanwhile waits and moves over; a second /compact is refused", async () => {
    const to = fake("antigravity");
    const { d } = deps({ antigravity: to });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    d.context = { handoffMemory: async () => void (await gate) };
    const from = fake("antigravity", { sink: { ...nullSink(), compact: (f, focus) => runCompact(d, f, focus).then(() => {}) } });
    from.say(user("u1", "Rewrite the parser"));
    from.say(reply("a1", "Done with the lexer."));
    const done = from.prompt("/compact");
    await settle();
    expect(noticeTexts(from).at(-1)).toBe("Compacting: starting a new session with a brief of this conversation.");
    await from.prompt("also check the tests");
    await from.prompt("/compact");
    expect(noticeTexts(from).at(-1)).toBe("Already compacting: a new session is starting.");
    expect(from.sent).toEqual([]);
    release();
    await done;
    expect(to.sent).toHaveLength(1);
    expect(to.t.state.pending?.map((p) => p.text)).toEqual(["also check the tests"]);
    expect(from.t.state.pending ?? []).toEqual([]);
  });

  test("Tether's restart failed: what you sent meanwhile goes out here", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const from = fake("antigravity", { sink: { ...nullSink(), compact: async () => (await gate, Promise.reject(new Error("no harness"))) } });
    const done = from.prompt("/compact");
    await settle();
    await from.prompt("also check the tests");
    expect(from.sent).toEqual([]);
    release();
    await done;
    expect(noticeTexts(from)).toContain("Compacting failed: no harness");
    expect(from.sent).toEqual(["also check the tests"]);
  });

  test("Codex: a failed thread/compact/start sends no Finished", async () => {
    const { s } = codex();
    s.p.call = async () => {
      throw new Error("no rollout yet");
    };
    const alerts: string[] = [];
    s.alert = (kind: string) => void alerts.push(kind);
    await s.prompt("/compact");
    expect(s.t.state.status).toBe("idle");
    expect(noticeTexts(s).at(-1)).toBe("Compacting failed: no rollout yet");
    expect(alerts).not.toContain("finished");
    expect(s.loopTurn).toBe(false);
  });

  test("Codex: the compaction's fallback to idle never ends a later turn", async () => {
    CodexSession.COMPACT_FALLBACK_MS = 30;
    try {
      const { s, notify } = codex();
      await s.prompt("/compact");
      notify("turn/started", { turn: { id: "c1" } });
      notify("turn/completed", { turn: { id: "c1", status: "completed" } });
      await settle();
      expect(s.t.state.status).toBe("idle");
      // The next turn/start is slow to answer.
      let answer!: () => void;
      s.p.call = (m: string) => (m === "turn/start" ? new Promise((r) => (answer = () => r({ turn: { id: "t9" } }))) : Promise.resolve({}));
      const sending = s.prompt("next");
      await Bun.sleep(80);
      expect(s.t.state.status).toBe("running");
      answer();
      await sending;
    } finally {
      CodexSession.COMPACT_FALLBACK_MS = 15_000;
    }
  });

  test("Tether's restart waits for background work, which it would stop", async () => {
    const restarts: (string | undefined)[] = [];
    const s = fake("antigravity", { sink: { ...nullSink(), compact: async (_, focus) => void restarts.push(focus) } });
    s.upsertActivity({ id: "sh1", kind: "shell", title: "npm run dev", status: "running", startedAt: Date.now() } as any);
    await s.prompt("/compact");
    expect(restarts).toEqual([]);
    expect(noticeTexts(s).at(-1)).toBe("Background tasks are still running here, and compacting would stop them. Compact once they're done, or stop them first.");
  });

  test("Tether's /compact is in the / menu and the capability matrix", async () => {
    const s = fake();
    expect((await s.slashMenu()).filter((c) => c.name === "compact")).toEqual([expect.objectContaining({ kind: "tether" })]);
    const m = capabilityMatrix();
    expect(m["claude-code"].fork.level).toBe("native");
    expect(m.codex.fork.level).toBe("native");
    expect(m.pi.fork.level).toBe("emulated");
    expect(m.antigravity.compact.level).toBe("emulated");
    expect(m.pi.compact.level).toBe("native");
    for (const h of ["claude-code", "codex", "pi", "opencode", "kiro", "antigravity"] as const) {
      expect(m[h].fork.note).toBeTruthy();
      expect(m[h].compact.note).toBeTruthy();
    }
  });
});

void newId;
