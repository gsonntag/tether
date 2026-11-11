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
import type { SessionSummary } from "../../../../shared/transcript";
import { ago, homeAgentModule, inProject, lastPrompt, lastReply, MAX_REPORTS, stateOf } from ".";

const stops: (() => void)[] = [];
afterEach(() => stops.splice(0).forEach((f) => f()));

async function until(f: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(10);
  }
}

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "tether-home-"));
  stops.push(() => rmSync(dir, { recursive: true, force: true }));
  const homeFolder = join(dir, "home");
  const project = join(dir, "project");
  mkdirSync(homeFolder);
  mkdirSync(project);
  const fake = new FakeAdapter();
  const setups = new Map<string, (nativeId: string) => AgentSetup>();
  (fake as Adapter).agentSetup = (folder, make) => (setups.set(folder, make), () => void setups.delete(folder));
  const runner = createRunner({ url: "http://x", token: "t", runnerId: "t", name: "t", version: "0", detectHarnesses: async () => [], adapters: [fake], prefsFile: join(dir, "runner.json"), homeFolder, core: { evictMs: 60_000 } });
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
  expect(s.tools.map((t) => t.name)).toEqual(["list_projects", "project_overview", "start_session", "list_sessions", "session_status", "send_to_session"]);
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

test("another chat can't drive it, and the agent's own folder isn't a project", async () => {
  const { op, chat, tools, project, homeFolder, runner, driverOf } = await setup();
  const said = await tools(chat).start_session!({ project_path: project, prompt: "Go." });
  const child = /session (\S+) in/.exec(said)![1]!;
  await until(() => runner.core.sessions.get(child)?.state.status === "idle");
  const other = (await op("homeAgentNew")).sessionId as string;
  expect(other).not.toBe(chat);
  await expect(tools(other).send_to_session!({ session_id: child, message: "hi" })).rejects.toThrow("isn't a session you started");
  await expect(tools(chat).start_session!({ project_path: homeFolder, prompt: "x" })).rejects.toThrow("your own folder");
  await expect(tools(chat).start_session!({ project_path: join(project, "nope"), prompt: "x" })).rejects.toThrow("no folder");
  expect(driverOf(child)!.sent.length).toBe(1);
});

test("a session the person types into is theirs: no more reports, and the agent can't message it", async () => {
  const { op, chat, tools, project, runner, driverOf } = await setup();
  const said = await tools(chat).start_session!({ project_path: project, prompt: "Go." });
  const child = /session (\S+) in/.exec(said)![1]!;
  await until(() => driverOf(chat)?.sent.length === 1);
  await until(() => runner.core.sessions.get(chat)?.state.status === "idle");
  await op("send", { sessionId: child, text: "I'll take it from here" });
  await until(() => driverOf(child)!.sent.length === 2 && runner.core.sessions.get(child)?.state.status === "idle");
  await Bun.sleep(50);
  expect(driverOf(chat)!.sent.length).toBe(1);
  await expect(tools(chat).send_to_session!({ session_id: child, message: "more" })).rejects.toThrow("taken this session over");
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
  expect(await op("homeAgent")).toEqual({ folder: expect.any(String), rev });
  // Kept across a restart.
  expect(JSON.parse(readFileSync(join(dataDir, "state.json"), "utf8"))).toMatchObject({ rev });
  expect(JSON.parse(readFileSync(join(dataDir, "state.json"), "utf8")).current).toBeUndefined();

  // The old chat let go of what it started: the child's next turn wakes nobody, and it can't be driven from there.
  await runner.look.sessions.send(child, `${FROM_TETHER}more`);
  await until(() => driverOf(child)!.sent.length === 2 && runner.core.sessions.get(child)?.state.status === "idle");
  await Bun.sleep(50);
  expect(driverOf(chat)!.sent.length).toBe(1);
  await expect(tools(chat).send_to_session!({ session_id: child, message: "more" })).rejects.toThrow("cleared this chat");
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

test("session_status reads any session, and the agent still can't message one it didn't start", async () => {
  const { chat, tools, done, waiting } = await others();
  const st: string = await tools(chat).session_status!({ session_id: done });
  expect(st).toContain("State: finished");
  expect(st).toContain("You didn't start it");
  expect(st).toContain("Latest prompt:\nFix the login bug");
  expect(st).toContain("Latest reply:\necho Fix the login bug");
  const w: string = await tools(chat).session_status!({ session_id: waiting });
  expect(w).toContain("State: waiting on you");
  expect(w).toContain("Waiting for the person: Which color?");
  await expect(tools(chat).send_to_session!({ session_id: done, message: "more" })).rejects.toThrow("isn't a session you started");
  await expect(tools(chat).session_status!({ session_id: "claude:nope" })).rejects.toThrow();
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
