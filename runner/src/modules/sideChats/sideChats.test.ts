// Side chats through the modules (fork + sideChats), against a harness that is only its declarations.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Adapter, ForkRequest } from "../../core/adapter";
import type { Msg } from "../../../../shared/transcript";
import { BRING_BACK_PROMPT, SIDE_KEEPS, SIDE_READ_ONLY, SIDE_STAYS } from "../../../../shared/sideChat";
import { FROM_TETHER } from "../../../../shared/fromTether";
import { refusal as moveRefusal } from "../move";
import { saveConfig } from "../../config";
import { ask, askQuestion, FakeAdapter, idle, say } from "../../core/fakeAdapter";
import { createRunner } from "../../core/runner";
import { forkModule } from "../fork";
import { isBringBack, lastReply, sideChatsModule } from ".";

class Forking extends FakeAdapter {
  forks: ForkRequest[] = [];
  fork: Adapter["fork"];
  constructor() {
    super();
    this.capabilities = { ...this.capabilities, fork: true, readOnlyMode: "plan" };
    this.fork = {
      fork: async (r: ForkRequest) => {
        this.forks.push(r);
        const msgs = this.stored.get(r.nativeId)!.msgs;
        const id = `f${this.forks.length}`;
        this.addStored(id, r.upTo ? msgs.slice(0, msgs.findIndex((m) => m.id === r.upTo) + 1) : msgs, { title: r.title, projectPath: "/p" });
        return id;
      },
    };
  }
}

const user = (id: string, text = "q"): Msg => ({ id, role: "user", ts: 1, parts: [{ type: "text", text }] });
const reply = (id: string, text = "a"): Msg => ({ id, role: "assistant", ts: 2, parts: [{ type: "text", text }] });
const convo = [user("u1", "remember 7"), reply("a1", "ok"), user("u2", "and 9"), reply("a2", "ok")];

const stops: (() => void)[] = [];
afterEach(() => stops.splice(0).forEach((f) => f()));

async function setup(o: { homeFolder?: string } = {}) {
  const a = new Forking();
  const dir = mkdtempSync(join(tmpdir(), "tether-side-"));
  const prefsFile = join(dir, "runner.json");
  saveConfig({ runnerId: "t" }, prefsFile);
  const runner = createRunner({ url: "http://x", token: "t", runnerId: "t", name: "t", version: "0", detectHarnesses: async () => [], adapters: [a], prefsFile, core: { evictMs: 60_000 } });
  stops.push(() => runner.core.stop());
  const ctx = { ...runner.look, bus: runner.bus, ops: runner.ops, dataDir: join(dir, "mod"), log: () => {}, runnerId: "t", appUrl: "x", ...o } as any;
  await forkModule.start(ctx);
  await sideChatsModule.start(ctx);
  a.addStored("s1", convo, { title: "Numbers", projectPath: "/p" });
  const call = async (op: string, args: unknown) => {
    const r = await runner.ops.handle(op as any, args);
    if (!r.ok) throw new Error(r.error);
    return r.data as any;
  };
  return { a, runner, call, prefsFile };
}

describe("side chats", () => {
  test("a read-only fork through the last finished turn, asked the question, while the session works on", async () => {
    const { a, runner, call } = await setup();
    const main = await runner.core.open("claude:s1");
    main.setState({ status: "running", permissionMode: "acceptEdits" });
    const { sessionId } = await call("openSideChat", { sessionId: "claude:s1", question: "What did we say about 7?" });
    expect(sessionId).toBe("claude:f1");
    // Its own conversation ends at the last finished turn, not the running one.
    expect(a.forks[0]).toMatchObject({ nativeId: "s1", upTo: "a1", title: "Side chat: What did we say about 7?" });
    const side = await runner.core.open(sessionId);
    expect(side.summary.sideOf).toBe("claude:s1");
    expect(side.state.permissionMode).toBe("plan");
    expect(runner.core.o.prefs.get(sessionId)).toMatchObject({ sideOf: "claude:s1", permissionMode: "plan" });
    // The question is the person's, sent there; the session itself got nothing.
    expect(a.drivers.find((d) => d.nativeId === "f1")?.sent).toEqual(["What did we say about 7?"]);
    // Its harness is told to stay read-only (Claude Code: a gate on every tool).
    expect(a.drivers.find((d) => d.nativeId === "f1")?.opts.readOnly).toBe(true);
    expect(a.drivers.find((d) => d.nativeId === "s1")).toBeUndefined();
    expect(main.state.status).toBe("running");
  });

  test("left out of the lists, listed under its session (archived ones too)", async () => {
    const { runner, call } = await setup();
    const { sessionId } = await call("openSideChat", { sessionId: "claude:s1" });
    await runner.core.discover();
    // Rows carry sideOf: the page leaves them out of its lists and shows them under the session.
    expect(runner.core.book.list().find((r) => r.id === sessionId)?.sideOf).toBe("claude:s1");
    // What modules list (peers, the Home agent): not there.
    expect(runner.look.sessions.list().map((r) => r.id)).not.toContain(sessionId);
    expect((await runner.core.listSessions({ projectPath: "/p" })).sessions.map((r) => r.id)).not.toContain(sessionId);
    expect((await runner.core.listSessions({ query: "Side" })).sessions).toHaveLength(0);
    expect((await call("listSessions", { sideOf: "claude:s1" })).sessions.map((r: any) => r.id)).toEqual([sessionId]);
    await runner.look.sessions.setArchived(sessionId, true);
    expect((await runner.look.sessions.archived()).map((r) => r.id)).not.toContain(sessionId);
    expect((await call("listSessions", { sideOf: "claude:s1" })).sessions).toMatchObject([{ id: sessionId, archived: true }]);
  });

  test("stays read-only: its mode can't change, and nothing it asks to do is allowed; questions still go to you", async () => {
    const { a, runner, call } = await setup();
    const { sessionId } = await call("openSideChat", { sessionId: "claude:s1" });
    await expect(call("setPermissionMode", { sessionId, mode: "acceptEdits" })).rejects.toThrow(SIDE_STAYS);
    await call("setPermissionMode", { sessionId, mode: "plan" });
    a.script = () => [ask("Write", { file_path: "/p/x" }), ask("ExitPlanMode", { plan: "do it" }), say("r", "done"), idle];
    await runner.live.send(sessionId, "write x");
    const d = a.drivers.find((x) => x.nativeId === "f1")!;
    expect(d.decisions).toEqual([
      { allow: false, reason: SIDE_READ_ONLY },
      { allow: false, reason: SIDE_READ_ONLY },
    ]);
    a.script = () => [askQuestion("Which?", ["A", "B"]), idle];
    void runner.live.send(sessionId, "ask me");
    await Bun.sleep(10);
    expect((await runner.core.open(sessionId)).state.requests).toHaveLength(1);
  });

  test("Bring back: a turn of its own writes the summary, which comes back as a draft", async () => {
    const { a, runner, call } = await setup();
    const { sessionId } = await call("openSideChat", { sessionId: "claude:s1", question: "why 7?" });
    a.script = (text) => (text === BRING_BACK_PROMPT ? [say("sum", "7 was the first number.\nNothing to change."), idle] : [say("x", "because"), idle]);
    expect(await call("bringBack", { sessionId })).toEqual({ text: "From a side chat:\n\n7 was the first number.\nNothing to change." });
    expect(a.drivers.find((d) => d.nativeId === "f1")?.sent.at(-1)).toBe(BRING_BACK_PROMPT);
    // The session itself is untouched.
    expect(a.drivers.find((d) => d.nativeId === "s1")).toBeUndefined();
    // Not while it answers; not on a session that isn't a side chat.
    (await runner.core.open(sessionId)).setState({ status: "running" });
    await expect(call("bringBack", { sessionId })).rejects.toThrow("still answering");
    await expect(call("bringBack", { sessionId: "claude:s1" })).rejects.toThrow("isn't a side chat");
  });

  test("a failed summary turn says so", async () => {
    const { a, call } = await setup();
    const { sessionId } = await call("openSideChat", { sessionId: "claude:s1" });
    a.script = () => [(s) => s.state({ status: "idle", error: "overloaded" })];
    await expect(call("bringBack", { sessionId })).rejects.toThrow("couldn't write a summary");
  });

  test("it keeps its session's source, harness and conversation: no source change, key switch, move, fork or shell", async () => {
    const { runner, call } = await setup();
    const { sessionId } = await call("openSideChat", { sessionId: "claude:s1" });
    await expect(runner.live.setSource(sessionId, "anthropic")).rejects.toThrow(SIDE_KEEPS.source);
    await expect(runner.live.setAutoKey(sessionId, true)).rejects.toThrow(SIDE_KEEPS.source);
    await expect(call("runShell", { sessionId, command: "touch x" })).rejects.toThrow(SIDE_KEEPS.shell);
    await expect(runner.look.sessions.fork(sessionId)).rejects.toThrow(SIDE_KEEPS.fork);
    expect(moveRefusal(await runner.look.sessions.open(sessionId))).toBe(SIDE_KEEPS.move);
  });

  test("read-only reaches the harness again after a restart", async () => {
    const { a, runner, call, prefsFile } = await setup();
    const { sessionId } = await call("openSideChat", { sessionId: "claude:s1" });
    runner.core.o.prefs.flush();
    runner.core.stop();
    const again = createRunner({ url: "http://x", token: "t", runnerId: "t", name: "t", version: "0", detectHarnesses: async () => [], adapters: [a], prefsFile, core: { evictMs: 60_000 } });
    stops.push(() => again.core.stop());
    a.drivers = [];
    await again.live.send(sessionId, "again");
    expect(a.drivers.find((d) => d.nativeId === "f1")?.opts).toMatchObject({ readOnly: true, permissionMode: "plan" });
    // And it's still listed under its session, from the index.
    expect((await again.core.listSessions({ sideOf: "claude:s1" })).sessions.map((r) => r.id)).toEqual([sessionId]);
  });

  test("its session going on under a new id takes its side chats along", async () => {
    const { runner, call } = await setup();
    const { sessionId } = await call("openSideChat", { sessionId: "claude:s1" });
    runner.core.moveSides("claude:s1", "claude:s2");
    expect(runner.core.o.prefs.get(sessionId).sideOf).toBe("claude:s2");
    expect((await runner.core.open(sessionId)).summary.sideOf).toBe("claude:s2");
    expect((await runner.core.listSessions({ sideOf: "claude:s2" })).sessions.map((r) => r.id)).toEqual([sessionId]);
    expect((await runner.core.listSessions({ sideOf: "claude:s1" })).sessions).toEqual([]);
  });

  test("closing stops a running turn, then archives", async () => {
    const { a, runner, call } = await setup();
    const { sessionId } = await call("openSideChat", { sessionId: "claude:s1", question: "q" });
    const d = a.drivers.find((x) => x.nativeId === "f1")!;
    (await runner.core.open(sessionId)).setState({ status: "running" });
    await call("closeSideChat", { sessionId });
    expect(d.interrupted).toBe(1);
    expect(runner.core.o.prefs.get(sessionId).archived).toBe(true);
    await expect(call("closeSideChat", { sessionId: "claude:s1" })).rejects.toThrow("isn't a side chat");
  });

  test("a / command never reaches its harness: sent, steered or queued", async () => {
    const { a, runner, call } = await setup();
    const { sessionId } = await call("openSideChat", { sessionId: "claude:s1" });
    for (const op of ["send", "steer", "queue"]) await expect(call(op, { sessionId, text: "/deploy now" })).rejects.toThrow("not / commands");
    expect(a.drivers.find((d) => d.nativeId === "f1")?.sent ?? []).toEqual([]);
    // A path isn't a command.
    await runner.live.send(sessionId, "/tmp/x is what?");
  });

  test("not in the Home agent's folder", async () => {
    const { a, call } = await setup({ homeFolder: "/home-agent" });
    a.addStored("h1", convo, { projectPath: "/home-agent" });
    await expect(call("openSideChat", { sessionId: "claude:h1" })).rejects.toThrow("Home agent");
  });

  test("refused: a side chat of a side chat, a subagent, a harness without a read-only mode", async () => {
    const { a, call } = await setup();
    const { sessionId } = await call("openSideChat", { sessionId: "claude:s1" });
    await expect(call("openSideChat", { sessionId })).rejects.toThrow("can't have side chats");
    a.addStored("child", convo, { parentSessionId: "claude:s1", projectPath: "/p" });
    await expect(call("openSideChat", { sessionId: "claude:child" })).rejects.toThrow("subagent");
    a.capabilities = { ...a.capabilities, readOnlyMode: undefined };
    await expect(call("openSideChat", { sessionId: "claude:s1" })).rejects.toThrow("can't have side chats yet");
  });
});

describe("lastReply", () => {
  test("Bring back's reply: after its own message, whatever came later from elsewhere", () => {
    const bb = user("b", BRING_BACK_PROMPT.slice(FROM_TETHER.length));
    expect(isBringBack(bb)).toBe(true);
    expect(lastReply([user("u1"), reply("a1", "old"), bb, reply("s", "summary")], isBringBack)).toBe("summary");
    expect(lastReply([user("u1"), reply("a1", "old")], isBringBack)).toBeUndefined();
  });

  test("the last reply's text after the last message sent", () => {
    expect(lastReply([user("u1"), reply("a1", "old"), user("u2"), reply("a2", "first"), { ...reply("a3", "second"), parts: [{ type: "text", text: "second" }, { type: "text", text: "more" }] }])).toBe("second\n\nmore");
    expect(lastReply([user("u1"), reply("a1", "old"), user("u2")])).toBeUndefined();
    expect(lastReply([user("u1"), { ...reply("a1", "boom"), error: "x" } as Msg])).toBeUndefined();
  });
});
