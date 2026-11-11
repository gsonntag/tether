// The Home agent: its tools start and drive sessions through the core, each finished turn of a
// session it started is reported back to its chat, and a session the person steps into is theirs.

import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FROM_TETHER } from "../../../../shared/fromTether";
import type { HomeChatUpdate } from "../../../../shared/protocol";
import type { Adapter, AgentSetup } from "../../core/adapter";
import { FakeAdapter } from "../../core/fakeAdapter";
import { createRunner } from "../../core/runner";
import { homeAgentModule, lastReply, MAX_REPORTS } from ".";

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
  expect(s.tools.map((t) => t.name)).toEqual(["list_projects", "project_overview", "start_session", "session_status", "send_to_session"]);
  expect(s.deny).toContain("Bash");
  expect(s.deny).toContain("Edit");
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
