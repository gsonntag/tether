// The Home agent: its tools start and drive sessions through the core, each finished turn of a
// session it started is reported back to its chat, and a session the person steps into is theirs.

import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FROM_TETHER } from "../../../../shared/fromTether";
import type { HomeChatUpdate } from "../../../../shared/protocol";
import type { Adapter, AgentSetup } from "../../core/adapter";
import { askQuestion, FakeAdapter, idle, say } from "../../core/fakeAdapter";
import { createRunner } from "../../core/runner";
import { CredentialStore } from "../../credentials";
import type { SessionSummary } from "../../../../shared/transcript";
import { ago, homeAgentModule, inProject, lastPrompt, lastReply, MAX_REPORTS, settingsOf, stateOf } from ".";
import { ANSWER_TAG } from "./checkIn";

const stops: (() => void)[] = [];
afterEach(() => stops.splice(0).forEach((f) => f()));

async function until(f: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(10);
  }
}

async function setup(o: { anthropicKey?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "tether-home-"));
  stops.push(() => rmSync(dir, { recursive: true, force: true }));
  const homeFolder = join(dir, "home");
  const project = join(dir, "project");
  mkdirSync(homeFolder);
  mkdirSync(project);
  const fake = new FakeAdapter();
  fake.capabilities = { ...fake.capabilities, sourceSwitch: true };
  const setups = new Map<string, (nativeId: string) => AgentSetup>();
  (fake as Adapter).agentSetup = (folder, make) => (setups.set(folder, make), () => void setups.delete(folder));
  const credentials = new CredentialStore(join(dir, "credentials.json"));
  if (o.anthropicKey) credentials.set("anthropic", "sk-ant-test-0000000000000000");
  const runner = createRunner({ url: "http://x", token: "t", runnerId: "t", name: "t", version: "0", detectHarnesses: async () => [], adapters: [fake], prefsFile: join(dir, "runner.json"), homeFolder, core: { evictMs: 60_000 }, credentials });
  stops.push(() => runner.core.stop());
  mkdirSync(join(dir, "data"));
  const announced: HomeChatUpdate[] = [];
  const stop = await homeAgentModule.start({ bus: runner.bus, ops: runner.ops, dataDir: join(dir, "data"), log: () => {}, runnerId: "t", appUrl: "http://x", ...runner.look, announceHomeChat: (u: HomeChatUpdate) => announced.push(u) } as any);
  if (stop) stops.push(stop);
  const op = async (name: string, args: unknown = {}): Promise<any> => {
    const r = await runner.ops.handle(name, args);
    if (!r.ok) throw new Error(r.error);
    return r.data;
  };
  const chat = (await op("homeAgentNew")).sessionId as string;
  const tools = (sessionId: string) => Object.fromEntries(setups.get(homeFolder)!(sessionId.split(":")[1]!).tools.map((t) => [t.name, t.run]));
  const driverOf = (id: string) => fake.drivers.find((d) => `claude:${d.nativeId}` === id);
  return { runner, fake, op, chat, tools, driverOf, project, homeFolder, setups, announced, dataDir: join(dir, "data") };
}

test("the chat is current, and only its folder gets the tools", async () => {
  const { op, chat, setups, homeFolder } = await setup();
  expect((await op("homeAgent")).sessionId).toBe(chat);
  expect([...setups.keys()]).toEqual([homeFolder]);
  const s = setups.get(homeFolder)!("x");
  expect(s.tools.map((t) => t.name)).toEqual(["list_projects", "project_overview", "start_session", "list_sessions", "session_status", "check_in_sessions", "archive_session", "send_to_session"]);
  expect(s.deny).toContain("Bash");
  expect(s.deny).toContain("Edit");
  // Brief replies, always (a relayed report was "a big wall of text").
  expect(s.instructions).toContain("at most one casual sentence");
  expect(s.instructions).toContain("Never confirm that something works, that tests pass, or that it was verified");
  expect(s.instructions).toContain("No file lists, no cause analysis, no caveats");
});

test("start_session starts a session with full permissions, and its finished turn is reported to the chat", async () => {
  const { runner, op, chat, tools, driverOf, project } = await setup();
  await op("send", { sessionId: chat, text: "fix the tests in project" });
  await until(() => runner.core.sessions.get(chat)?.state.status === "idle" && !!driverOf(chat));
  const said = await tools(chat).start_session!({ project_path: project, prompt: "Fix the failing tests.", title: "Fix tests" });
  const child = /session (\S+) in/.exec(said)![1]!;
  const s = runner.core.sessions.get(child)!;
  expect(s.summary.projectPath).toBe(project);
  expect(s.state.permissionMode).toBe("bypassPermissions");
  expect(s.summary.title).toBe("Fix tests");
  expect(driverOf(child)!.sent[0]).toBe(`${FROM_TETHER}Fix the failing tests.`);
  // The chat gets a link to it.
  const link = runner.core.sessions.get(chat)!.transcript!.messages.find((m) => m.link?.sessionId === child);
  expect(link?.parts[0]).toEqual({ type: "text", text: "Started “Fix tests” in project." });
  // The child's reply goes to the chat as a message from Tether.
  await until(() => driverOf(chat)!.sent.length === 2);
  const report = driverOf(chat)!.sent[1]!;
  expect(report.startsWith(FROM_TETHER)).toBe(true);
  expect(report).toContain(`echo ${FROM_TETHER}Fix the failing tests.`);
  expect(report).toContain(`Report 1 of ${MAX_REPORTS}`);
  expect(report).toContain("one casual sentence");
  // send_to_session keeps it going, and that turn is reported too.
  await until(() => runner.core.sessions.get(chat)?.state.status === "idle");
  await tools(chat).send_to_session!({ session_id: child, message: "Run them again." });
  await until(() => driverOf(child)!.sent.length === 2);
  expect(driverOf(child)!.sent[1]).toBe(`${FROM_TETHER}Run them again.`);
  await until(() => driverOf(chat)!.sent.length === 3);
  expect(driverOf(chat)!.sent[2]).toContain("Report 2 of");
  // session_status reads it.
  expect(await tools(chat).session_status!({ session_id: child })).toContain("Latest reply:");
});

test("another chat that messages it follows it from then on, and the agent's own folder isn't a project", async () => {
  const { op, chat, tools, project, homeFolder, runner, driverOf } = await setup();
  const said = await tools(chat).start_session!({ project_path: project, prompt: "Go." });
  const child = /session (\S+) in/.exec(said)![1]!;
  await until(() => driverOf(chat)?.sent.length === 1 && runner.core.sessions.get(child)?.state.status === "idle");
  const other = (await op("homeAgentNew")).sessionId as string;
  expect(other).not.toBe(chat);
  expect(await tools(other).send_to_session!({ session_id: child, message: "hi" })).toContain("Sent.");
  await until(() => driverOf(child)!.sent.length === 2);
  // Its report goes to the chat that messaged it, not the one that started it.
  await until(() => driverOf(other)?.sent.length === 1);
  expect(driverOf(other)!.sent[0]).toContain("Report 1 of");
  expect(driverOf(chat)!.sent.length).toBe(1);
  // Never one of its own chats.
  await expect(tools(other).send_to_session!({ session_id: chat, message: "hi" })).rejects.toThrow("your own chats");
  await expect(tools(chat).start_session!({ project_path: homeFolder, prompt: "x" })).rejects.toThrow("your own folder");
  await expect(tools(chat).start_session!({ project_path: join(project, "nope"), prompt: "x" })).rejects.toThrow("no folder");
});

test("a session the person types into is theirs: no more reports until the agent messages it again", async () => {
  const { op, chat, tools, project, runner, driverOf } = await setup();
  const said = await tools(chat).start_session!({ project_path: project, prompt: "Go." });
  const child = /session (\S+) in/.exec(said)![1]!;
  await until(() => driverOf(chat)?.sent.length === 1);
  await until(() => runner.core.sessions.get(chat)?.state.status === "idle");
  await op("send", { sessionId: child, text: "I'll take it from here" });
  await until(() => driverOf(child)!.sent.length === 2 && runner.core.sessions.get(child)?.state.status === "idle");
  await Bun.sleep(50);
  expect(driverOf(chat)!.sent.length).toBe(1);
  expect(await tools(chat).session_status!({ session_id: child })).toContain("taken this session over");
  // When the person asks the agent to message it, it follows it again.
  await tools(chat).send_to_session!({ session_id: child, message: "more" });
  await until(() => driverOf(chat)!.sent.length === 2);
  expect(driverOf(chat)!.sent[1]).toContain("Report 1 of");
});

test("after MAX_REPORTS reports it stops following", async () => {
  const { chat, tools, project, runner, driverOf } = await setup();
  const said = await tools(chat).start_session!({ project_path: project, prompt: "Go." });
  const child = /session (\S+) in/.exec(said)![1]!;
  await until(() => driverOf(chat)?.sent.length === 1);
  for (let n = 2; n <= MAX_REPORTS; n++) {
    await until(() => runner.core.sessions.get(chat)?.state.status === "idle" && runner.core.sessions.get(child)?.state.status === "idle");
    await tools(chat).send_to_session!({ session_id: child, message: `again ${n}` });
    await until(() => driverOf(chat)!.sent.length === n);
  }
  expect(driverOf(chat)!.sent.at(-1)).toContain("stopped following");
  await expect(tools(chat).send_to_session!({ session_id: child, message: "more" })).rejects.toThrow("stopped following");
});

test("/new and /clear: no current chat until the next message, which starts a fresh one; every device is told", async () => {
  const { op, chat, tools, project, runner, driverOf, announced, dataDir } = await setup();
  const first = await op("homeAgent");
  expect(first.sessionId).toBe(chat);
  expect(announced).toEqual([{ sessionId: chat, rev: first.rev }]);
  const said = await tools(chat).start_session!({ project_path: project, prompt: "Go." });
  const child = /session (\S+) in/.exec(said)![1]!;
  await until(() => driverOf(chat)?.sent.length === 1 && runner.core.sessions.get(chat)?.state.status === "idle" && runner.core.sessions.get(child)?.state.status === "idle");

  const { rev } = await op("homeAgentClear");
  expect(rev).toBeGreaterThan(first.rev);
  expect(announced.at(-1)).toEqual({ rev });
  expect(await op("homeAgent")).toEqual({ folder: expect.any(String), rev, settings: { harness: "claude", source: "subscription" }, harnesses: ["claude"] });
  // Kept across a restart.
  expect(JSON.parse(readFileSync(join(dataDir, "state.json"), "utf8"))).toMatchObject({ rev });
  expect(JSON.parse(readFileSync(join(dataDir, "state.json"), "utf8")).current).toBeUndefined();

  // The old chat let go of what it started: the child's next turn wakes nobody, and it can't be driven from there.
  await runner.look.sessions.send(child, `${FROM_TETHER}more`);
  await until(() => driverOf(child)!.sent.length === 2 && runner.core.sessions.get(child)?.state.status === "idle");
  await Bun.sleep(50);
  expect(driverOf(chat)!.sent.length).toBe(1);
  expect(await tools(chat).session_status!({ session_id: child })).toContain("stopped following");

  // The next message's chat is a new session: none of the old context.
  const next = await op("homeAgentNew");
  expect(next.sessionId).not.toBe(chat);
  expect(next.rev).toBeGreaterThan(rev);
  expect(announced.at(-1)).toEqual({ sessionId: next.sessionId, rev: next.rev });
  expect((await op("homeAgent")).sessionId).toBe(next.sessionId);
});

test("clearing a chat that's working stops it", async () => {
  const { op, chat, runner, driverOf } = await setup();
  await op("send", { sessionId: chat, text: "hi" });
  await until(() => runner.core.sessions.get(chat)?.state.status === "idle" && !!driverOf(chat));
  runner.core.sessions.get(chat)!.setState({ status: "running" });
  await op("homeAgentClear");
  expect(driverOf(chat)!.interrupted).toBe(1);
  // An idle one is left alone.
  const other = (await op("homeAgentNew")).sessionId;
  await op("send", { sessionId: other, text: "hi" });
  await until(() => runner.core.sessions.get(other)?.state.status === "idle" && !!driverOf(other));
  await op("homeAgentClear");
  expect(driverOf(other)!.interrupted).toBe(0);
});

test("lastReply is the newest assistant text", () => {
  expect(
    lastReply([
      { id: "1", role: "assistant", ts: 1, parts: [{ type: "text", text: "first" }] },
      { id: "2", role: "user", ts: 2, parts: [{ type: "text", text: "q" }] },
      { id: "3", role: "assistant", ts: 3, parts: [{ type: "text", text: "second" }] },
      { id: "4", role: "assistant", ts: 4, parts: [{ type: "tool", id: "t", name: "Bash", kind: "shell", input: {}, status: "done" }] },
    ]),
  ).toBe("second");
});

/** Sessions the person started themselves: one finished in `project`, one running and one waiting on a question in `other`. */
async function others() {
  const t = await setup();
  const { op, fake, runner, project } = t;
  const other = join(project, "..", "other");
  mkdirSync(other);
  fake.script = (text) => (text.includes("hang") ? [say(`a-${text}`, "Looking at the login flow now.")] : text.includes("ask") ? [askQuestion("Which color?", ["red", "blue"])] : [say(`a-${text}`, `echo ${text}`), idle]);
  const make = async (folder: string, text: string) => {
    const id = (await op("newSession", { harness: "claude", projectPath: folder })).sessionId as string;
    // A turn that asks only returns once it's answered.
    const sent = op("send", { sessionId: id, text });
    if (!text.includes("ask")) await sent;
    else sent.catch(() => {});
    return id;
  };
  const done = await make(project, "Fix the login bug");
  const running = await make(other, "hang: refactor the payment module");
  const waiting = await make(other, "ask about the theme");
  await until(() => runner.core.sessions.get(done)?.state.status === "idle" && runner.core.sessions.get(running)?.state.status === "running" && runner.core.sessions.get(waiting)?.state.requests.length === 1);
  return { ...t, other, done, running, waiting };
}

test("list_sessions sees every session, whoever started it, with its state and what it's on", async () => {
  const { chat, tools, done, running, waiting } = await others();
  const all: string = await tools(chat).list_sessions!({});
  const lines = all.split("\n");
  // Not the Home agent's own chat.
  expect(all).not.toContain(chat);
  const row = (id: string) => lines[lines.findIndex((l) => l.startsWith(id))]! + "\n" + lines[lines.findIndex((l) => l.startsWith(id)) + 1];
  expect(row(done)).toContain("· project · Claude");
  expect(row(done)).toContain("· finished ·");
  expect(row(done)).toContain("replied: echo Fix the login bug");
  expect(row(running)).toContain("· other ·");
  expect(row(running)).toContain("· running ·");
  expect(row(running)).toContain("replied: Looking at the login flow now.");
  expect(row(waiting)).toContain("· waiting on you ·");
  expect(row(waiting)).toContain("asked: ask about the theme");
  expect(all).toContain("just now");
});

test("list_sessions filters by state and project, and says when nothing matches", async () => {
  const { chat, tools, done, running, waiting } = await others();
  const list = tools(chat).list_sessions!;
  const finished: string = await list({ state: "finished" });
  expect(finished).toContain(done);
  expect(finished).not.toContain(running);
  expect(finished).not.toContain(waiting);
  const active: string = await list({ state: "active" });
  expect(active).toContain(running);
  expect(active).toContain(waiting);
  expect(active).not.toContain(done);
  expect(await list({ state: "running" })).not.toContain(waiting);
  const inOther: string = await list({ project: "other" });
  expect(inOther).toContain(running);
  expect(inOther).not.toContain(done);
  expect(await list({ project: "Project" })).toContain(done);
  expect(await list({ state: "failed" })).toBe("No sessions failed.");
  expect(await list({ state: "running", project: "project" })).toBe("No sessions running in project.");
  const one: string = await list({ limit: 1 });
  expect(one).toContain("(1 of 3:");
});

test("session_status reads any session, and send_to_session messages one the agent didn't start and follows it", async () => {
  const { chat, tools, done, waiting, runner, driverOf } = await others();
  const st: string = await tools(chat).session_status!({ session_id: done });
  expect(st).toContain("State: finished");
  expect(st).toContain("You didn't start it. You can message it");
  expect(st).toContain("Latest prompt:\nFix the login bug");
  expect(st).toContain("Latest reply:\necho Fix the login bug");
  const w: string = await tools(chat).session_status!({ session_id: waiting });
  expect(w).toContain("State: waiting on you");
  expect(w).toContain("Waiting for the person: Which color?");
  await expect(tools(chat).session_status!({ session_id: "claude:nope" })).rejects.toThrow();
  // Waiting on the person: only they can answer it.
  await expect(tools(chat).send_to_session!({ session_id: waiting, message: "pick red" })).rejects.toThrow("waiting for the person (Which color?)");
  // An idle one it didn't start: it goes now, and its turn is reported like one it started.
  expect(await tools(chat).send_to_session!({ session_id: done, message: "Add a test for it." })).toContain("Sent.");
  await until(() => driverOf(done)!.sent.length === 2);
  expect(driverOf(done)!.sent[1]).toBe(`${FROM_TETHER}Add a test for it.`);
  await until(() => driverOf(chat)?.sent.length === 1);
  expect(driverOf(chat)!.sent[0]).toContain("finished a turn");
  expect(driverOf(chat)!.sent[0]).toContain(`echo ${FROM_TETHER}Add a test for it.`);
  expect(driverOf(chat)!.sent[0]).toContain("Report 1 of");
  await until(() => runner.core.sessions.get(done)?.state.status === "idle");
  expect(await tools(chat).session_status!({ session_id: done })).toContain("You messaged it. Reports so far: 1 of");
});

test("a busy session it didn't start gets the message after its turn, and only that turn is reported", async () => {
  const t = await setup();
  const { op, fake, runner, chat, tools, driverOf, project } = t;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  fake.script = (text) => (text.includes("long") ? [say(`a-${text}`, "the person's long turn"), async () => await gate, idle] : [say(`a-${text}`, `echo ${text}`), idle]);
  const id = (await op("newSession", { harness: "claude", projectPath: project })).sessionId as string;
  // The person's turn: it holds until released (and the send with it).
  const sent = op("send", { sessionId: id, text: "a long task" });
  await until(() => runner.core.sessions.get(id)?.state.status === "running");
  expect(await tools(chat).send_to_session!({ session_id: id, message: "Then open a PR." })).toContain("Queued: it goes after the session's current turn");
  expect(driverOf(id)!.sent.length).toBe(1);
  release();
  await sent;
  // The person's turn ends unreported; the queued message goes, and its turn is the report.
  await until(() => driverOf(id)!.sent.length === 2);
  expect(driverOf(id)!.sent[1]).toBe(`${FROM_TETHER}Then open a PR.`);
  await until(() => driverOf(chat)?.sent.length === 1);
  await Bun.sleep(50);
  expect(driverOf(chat)!.sent.length).toBe(1);
  expect(driverOf(chat)!.sent[0]).toContain(`echo ${FROM_TETHER}Then open a PR.`);
  expect(driverOf(chat)!.sent[0]).not.toContain("the person's long turn");
  expect(driverOf(chat)!.sent[0]).toContain("Report 1 of");
});

test("send_to_session refuses archived sessions, ones open in a terminal, and subagents", async () => {
  const { op, runner, chat, tools, driverOf, project } = await setup();
  const make = async () => {
    const id = (await op("newSession", { harness: "claude", projectPath: project })).sessionId as string;
    await op("send", { sessionId: id, text: "work" });
    await until(() => runner.core.sessions.get(id)?.state.status === "idle");
    return id;
  };
  const archived = await make();
  await runner.look.sessions.setArchived(archived, true);
  await expect(tools(chat).send_to_session!({ session_id: archived, message: "hi" })).rejects.toThrow("archived");
  const inTerminal = await make();
  runner.core.sessions.get(inTerminal)!.setState({ mode: "terminal" } as any);
  await expect(tools(chat).send_to_session!({ session_id: inTerminal, message: "hi" })).rejects.toThrow("open in a terminal");
  const sub = await make();
  (runner.core.sessions.get(sub)!.summary as any).parentSessionId = archived;
  await expect(tools(chat).send_to_session!({ session_id: sub, message: "hi" })).rejects.toThrow("subagent");
  await expect(tools(chat).send_to_session!({ session_id: "claude:nope", message: "hi" })).rejects.toThrow("no session");
  for (const id of [archived, inTerminal, sub]) expect(driverOf(id)!.sent.length).toBe(1);
  // Nothing refused is followed.
  expect(await tools(chat).session_status!({ session_id: archived })).toContain("You didn't start it");
});

test("stateOf, inProject, lastPrompt and ago", () => {
  const row = (over: Partial<SessionSummary>): SessionSummary => ({ id: "claude:x", harness: "claude", nativeId: "x", projectPath: "/p", title: "t", mode: "stored", status: "idle", updatedAt: 0, ...over });
  expect(stateOf(row({}))).toBe("finished");
  expect(stateOf(row({ status: "running" }))).toBe("running");
  expect(stateOf(row({ backgroundSubagents: 1 }))).toBe("running");
  expect(stateOf(row({ status: "running", requests: 1 }))).toBe("waiting");
  expect(stateOf(row({ queuePaused: true }))).toBe("waiting");
  expect(stateOf(row({ unread: "failed", failure: "boom" }))).toBe("failed");
  expect(stateOf(row({}), "boom")).toBe("failed");
  expect(inProject("/home/me/code/tether", "tether")).toBe(true);
  expect(inProject("/home/me/code/tether", "/home/me/code/tether/")).toBe(true);
  expect(inProject("/home/me/code/tether", "/home/me/code")).toBe(false);
  expect(inProject("/home/me/code/tether-2", "tether")).toBe(false);
  expect(
    lastPrompt([
      { id: "1", role: "user", ts: 1, parts: [{ type: "text", text: `${FROM_TETHER}Fix it.` }] },
      { id: "2", role: "user", ts: 2, origin: { kind: "shell" }, parts: [{ type: "text", text: "ls output" }] },
      { id: "3", role: "assistant", ts: 3, parts: [{ type: "text", text: "Done." }] },
    ]),
  ).toBe("Fix it.");
  expect(ago(1_000_000, 1_000_000 + 30_000)).toBe("just now");
  expect(ago(0, 5 * 60_000)).toBe("5m ago");
  expect(ago(0, 3 * 3_600_000)).toBe("3h ago");
  expect(ago(0, 3 * 86_400_000)).toBe("3d ago");
});

test("its model and source are kept for every chat, and the current chat takes them", async () => {
  const { runner, op, chat } = await setup();
  const first = await op("homeAgent");
  expect(first.settings).toEqual({ harness: "claude", source: "subscription" });
  expect(first.harnesses).toEqual(["claude"]);
  // A model, on the same harness and source: the same chat, its model changed.
  const r = await op("homeAgentSet", { harness: "claude", source: "subscription", model: "claude-opus-5-5" });
  expect(r.sessionId).toBe(chat);
  expect(r.settings).toEqual({ harness: "claude", source: "subscription", model: "claude-opus-5-5" });
  expect(runner.core.sessions.get(chat)!.state.model).toBe("claude-opus-5-5");
  expect((await op("homeAgent")).settings.model).toBe("claude-opus-5-5");
  // A new chat starts on it.
  const next = (await op("homeAgentNew")).sessionId;
  expect(next).not.toBe(chat);
  expect(runner.core.sessions.get(next)!.state.model).toBe("claude-opus-5-5");
  // "default" is no model: the harness's own.
  expect((await op("homeAgentSet", { harness: "claude", source: "subscription", model: "default" })).settings).toEqual({ harness: "claude", source: "subscription" });
});

test("a source that isn't set up, or a harness that can't run it, is refused and nothing is kept", async () => {
  const { op } = await setup();
  await expect(op("homeAgentSet", { harness: "claude", source: "anthropic" })).rejects.toThrow("Anthropic API key isn't set up on this runner.");
  await expect(op("homeAgentSet", { harness: "codex", source: "subscription" })).rejects.toThrow("Codex can't run the Home agent on this runner.");
  await expect(op("homeAgentSet", { harness: "claude" })).rejects.toThrow("Pick an agent and a source.");
  expect((await op("homeAgent")).settings).toEqual({ harness: "claude", source: "subscription" });
});

test("a Claude source change keeps the same chat, from its next start", async () => {
  const { runner, op, chat } = await setup({ anthropicKey: true });
  const r = await op("homeAgentSet", { harness: "claude", source: "anthropic" });
  expect(r.sessionId).toBe(chat);
  expect(runner.core.o.prefs.get(chat).source).toBe("anthropic");
  const next = (await op("homeAgentNew")).sessionId;
  expect(runner.core.o.prefs.get(next).source).toBe("anthropic");
});

test("the choice is saved with the module's state", async () => {
  const { op, dataDir } = await setup();
  await op("homeAgentSet", { harness: "claude", source: "subscription", model: "claude-haiku-5-5" });
  expect(JSON.parse(readFileSync(join(dataDir, "state.json"), "utf8")).settings).toEqual({ harness: "claude", source: "subscription", model: "claude-haiku-5-5" });
});

test("settingsOf keeps only what's valid", () => {
  expect(settingsOf({ harness: "codex", source: "azure", model: " dep " })).toEqual({ harness: "codex", source: "azure", model: "dep" });
  expect(settingsOf({ harness: "other", source: "subscription" })).toBeUndefined();
  expect(settingsOf(null)).toBeUndefined();
});

test("check_in_sessions asks idle sessions, archives the finished ones, skips busy ones, and reports once", async () => {
  const { runner, fake, op, chat, tools, driverOf, project } = await setup();
  // What each session answers the check-in with, by native id; "busy" never ends its first turn.
  const answers = new Map<string, string>();
  const busy = new Set<string>();
  fake.script = (text) =>
    text.includes(ANSWER_TAG)
      ? [(s, d) => say(`c-${d.sent.length}`, answers.get(d.nativeId) ?? "Not sure.")(s, d), idle]
      : [(s, d) => say(`a-${d.sent.length}`, `did ${text}`)(s, d), (s, d) => (busy.has(d.nativeId) ? undefined : idle(s, d))];
  const make = async (what: string, answer?: string, isBusy = false) => {
    const id = (await op("newSession", { harness: "claude", projectPath: project })).sessionId as string;
    const native = id.split(":")[1]!;
    if (answer) answers.set(native, answer);
    if (isBusy) busy.add(native);
    await op("renameSession", { sessionId: id, title: what });
    await op("send", { sessionId: id, text: what });
    await until(() => !!driverOf(id)?.sent.length && (isBusy || runner.core.sessions.get(id)?.state.status === "idle"));
    return id;
  };
  const finished = await make("task a", `Merged.\n${ANSWER_TAG} {"done": true, "merged": true, "cleaned_up": true, "branch": null, "worktree": null, "note": "PR merged"}`);
  const halfway = await make("task b", `${ANSWER_TAG} {"done": false, "merged": false, "branch": "b", "worktree": null, "note": "tests still failing"}`);
  const vague = await make("task c", "I think so?");
  const messy = await make("task e", `${ANSWER_TAG} {"done": true, "merged": true, "cleaned_up": false, "note": "worktree has a stray build"}`);
  const working = await make("task d", undefined, true);

  const said = await tools(chat).check_in_sessions!({});
  expect(said).toContain("Asked 4 sessions");
  expect(said).toContain(`${working} "task d" (${project}): it's running a turn`);
  expect(said).not.toContain(chat);
  // The running session wasn't sent anything.
  expect(driverOf(working)!.sent.length).toBe(1);
  // One report, after all three answered.
  await until(() => driverOf(chat)?.sent.length === 1);
  const report = driverOf(chat)!.sent[0]!;
  expect(report.startsWith(FROM_TETHER)).toBe(true);
  expect(report).toContain("Archived (1):");
  expect(report).toContain(`${finished} "task a" (${project}): PR merged`);
  expect(report).toContain("Not archived (3):");
  expect(report).toContain(`${messy} "task e" (${project}): done and merged, but it didn't clean up its worktrees: worktree has a stray build`);
  expect(report).toContain(`${halfway} "task b" (${project}): not done: tests still failing`);
  expect(report).toContain(`${vague} "task c" (${project}): its reply had no check-in line to go by`);
  expect(report).toContain("Not asked (1):");
  expect(runner.core.sessions.get(finished)!.summary.archived).toBe(true);
  expect(runner.core.sessions.get(halfway)!.summary.archived).toBeUndefined();
  expect(runner.core.sessions.get(messy)!.summary.archived).toBeUndefined();
  // Each asked session was told to clean up.
  expect(driverOf(finished)!.sent[1]).toContain("git worktree remove");
  // Archived sessions aren't asked again.
  await until(() => runner.core.sessions.get(chat)?.state.status === "idle");
  expect(await tools(chat).check_in_sessions!({ session_ids: [finished] })).toContain("No recent sessions");
  // archive_session archives one on request, but never a chat.
  expect(await tools(chat).archive_session!({ session_id: vague })).toContain("Archived");
  expect(runner.core.sessions.get(vague)!.summary.archived).toBe(true);
  await expect(tools(chat).archive_session!({ session_id: chat })).rejects.toThrow("your own chats");
});

test("a check-in answer from a session the agent started isn't one of its reports", async () => {
  const { runner, fake, chat, tools, driverOf, project } = await setup();
  fake.script = (text) => [say(`a-${text.length}`, text.includes(ANSWER_TAG) ? `${ANSWER_TAG} {"done": true, "merged": true, "cleaned_up": true}` : "done"), idle];
  const said = await tools(chat).start_session!({ project_path: project, prompt: "Go." });
  const child = /session (\S+) in/.exec(said)![1]!;
  await until(() => driverOf(chat)?.sent.length === 1 && runner.core.sessions.get(chat)?.state.status === "idle" && runner.core.sessions.get(child)?.state.status === "idle");
  expect(driverOf(chat)!.sent[0]).toContain("Report 1 of");
  await tools(chat).check_in_sessions!({ project_path: project });
  await until(() => driverOf(chat)!.sent.length === 2);
  expect(driverOf(chat)!.sent[1]).toContain("Check-in finished");
  expect(driverOf(chat)!.sent[1]).toContain("Archived (1):");
  await Bun.sleep(50);
  expect(driverOf(chat)!.sent.length).toBe(2);
  expect(await tools(chat).session_status!({ session_id: child })).toContain(`Reports so far: 1 of ${MAX_REPORTS}`);
});

test("a session with its worktree left isn't archived, and it's told to spare other sessions' worktrees", async () => {
  const { runner, fake, op, chat, tools, driverOf, project } = await setup();
  const git = async (cwd: string, ...args: string[]) => {
    const p = Bun.spawn(["git", ...args], { cwd, stdout: "ignore", stderr: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    if ((await p.exited) !== 0) throw new Error(await new Response(p.stderr).text());
  };
  await git(project, "init", "-q", "-b", "main");
  await git(project, "commit", "-q", "--allow-empty", "-m", "init");
  const left = join(project, "..", "left");
  const theirs = join(project, "..", "theirs");
  await git(project, "worktree", "add", "-qb", "left-branch", left);
  await git(project, "worktree", "add", "-qb", "their-branch", theirs);
  fake.script = (text) => [say(`a-${text.length}`, text.includes(ANSWER_TAG) ? `${ANSWER_TAG} {"done": true, "merged": true, "cleaned_up": true, "worktree": "${left}"}` : "ok"), idle];
  const start = async (folder: string, what: string) => {
    const id = (await op("newSession", { harness: "claude", projectPath: folder })).sessionId as string;
    await op("renameSession", { sessionId: id, title: what });
    await op("send", { sessionId: id, text: what });
    await until(() => !!driverOf(id)?.sent.length && runner.core.sessions.get(id)?.state.status === "idle");
    return id;
  };
  const mine = await start(project, "mine");
  const other = await start(theirs, "other");
  await tools(chat).check_in_sessions!({ session_ids: [mine] });
  // The worktree another session works in is named as off limits; the one it made isn't.
  await until(() => driverOf(mine)!.sent.length === 2);
  const asked = driverOf(mine)!.sent[1]!;
  expect(asked).toContain(`other sessions are using:\n     ${theirs}`);
  expect(asked).not.toContain(`     ${left}`);
  expect(driverOf(other)!.sent.length).toBe(1);
  await until(() => driverOf(chat)?.sent.length === 1);
  expect(driverOf(chat)!.sent[0]).toContain(`${mine} "mine" (${project}): done and merged, but its worktree is still there: ${left}`);
  expect(runner.core.sessions.get(mine)!.summary.archived).toBeUndefined();
});
