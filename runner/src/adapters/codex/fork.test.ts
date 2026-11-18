import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { forkPoints, wholeForkPoint } from "../../../../shared/fork";
import { setConnector } from "./daemon";
import { codexFork, forkTurn } from "./fork";
import { FORK_SOURCE_GONE, forkError } from "./forkGone";
import { historyMsgs } from "./items";
import { remember, remembered, rememberIn } from "./remember";
import { CodexRpc } from "./rpc";

const ORIG = "01a187c7-9ae6-7631-b0cc-596277bb8c13";
/** A thread with a message steered into its second turn (recorded). */
const TURNS: any[] = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "approval-steer-turns.json"), "utf8"));

/** A scripted daemon with threads: thread/fork copies turns through lastTurnId, as the real one does. */
function daemon(fail?: string, message = `${fail} failed`) {
  const threads = new Map<string, any[]>([[ORIG, TURNS]]);
  const sent: any[] = [];
  const rpc = new CodexRpc();
  const answer = (method: string, p: any): unknown => {
    if (method === fail) throw new Error(message);
    if (method === "thread/read") return { thread: { id: p.threadId, cwd: "/p", status: { type: "idle" } } };
    if (method === "thread/turns/list") return { data: threads.get(p.threadId) ?? [], nextCursor: null };
    if (method === "thread/fork") {
      const turns = threads.get(p.threadId)!;
      const id = `fork-${threads.size}`;
      threads.set(id, turns.slice(0, turns.findIndex((t) => t.id === p.lastTurnId) + 1));
      return { thread: { id, forkedFromId: p.threadId, status: { type: "idle" } } };
    }
    return {};
  };
  rpc.wire = {
    send: (text) => {
      const m = JSON.parse(text);
      sent.push(m);
      if (m.method && m.id !== undefined)
        queueMicrotask(() => {
          let reply: any;
          try {
            reply = { id: m.id, result: answer(m.method, m.params) };
          } catch (e: any) {
            reply = { id: m.id, error: { code: -32600, message: e.message } };
          }
          rpc.receive(JSON.stringify(reply));
        });
    },
    close: () => {},
  };
  setConnector(async () => rpc);
  return { threads, calls: (method: string) => sent.filter((m) => m.method === method).map((m) => m.params) };
}

afterEach(() => setConnector(undefined));

describe("forking a Codex thread", () => {
  test("the whole thread: thread/fork through its last turn, named, starting no turn", async () => {
    rememberIn(undefined);
    remember(ORIG, { billing: { kind: "plan", label: "ChatGPT plan" } });
    const d = daemon();
    const id = await codexFork.fork({ nativeId: ORIG, projectPath: "/p", title: "Steer (fork)" });
    expect(d.calls("thread/fork")).toEqual([{ threadId: ORIG, lastTurnId: TURNS[2].id, excludeTurns: true }]);
    expect(d.threads.get(id)!.length).toBe(3);
    expect(d.calls("thread/name/set")).toEqual([{ threadId: id, name: "Steer (fork)" }]);
    expect(d.calls("turn/start")).toEqual([]);
    expect(remembered(id)?.billing).toEqual({ kind: "plan", label: "ChatGPT plan" });
    // The original is left as it was.
    expect(d.threads.get(ORIG)).toBe(TURNS);
  });

  test("a side chat's fork is loaded read-only: its MCP servers off", async () => {
    rememberIn(undefined);
    const d = daemon();
    await codexFork.fork({ nativeId: ORIG, projectPath: "/p", title: "Side chat: x", readOnly: true });
    expect(d.calls("config/read")).toEqual([{ cwd: "/p" }]);
    expect(d.calls("thread/fork")[0]).toMatchObject({ threadId: ORIG, sandbox: "read-only", approvalPolicy: "never", config: { "features.apps": false } });
  });

  test("from a reply: the turns after its turn are never copied", async () => {
    rememberIn(undefined);
    const d = daemon();
    const msgs = historyMsgs(TURNS, "/p");
    const first = msgs.find((m) => forkPoints(msgs, false).has(m.id))!;
    const id = await codexFork.fork({ nativeId: ORIG, projectPath: "/p", upTo: first.id, title: "x" });
    expect(d.threads.get(id)!.map((t) => t.id)).toEqual([TURNS[0].id]);
    expect(historyMsgs(d.threads.get(id)!, "/p").at(-1)!.id).toBe(first.id);
  });

  test("a reply a steered message follows in its turn isn't a fork point here", () => {
    const steered = `a-${TURNS[1].items[1].id}`;
    expect(() => forkTurn(TURNS, steered)).toThrow("middle of a turn");
    expect(forkTurn(TURNS, `a-${TURNS[1].items[3].id}`)).toBe(TURNS[1].id);
    expect(() => forkTurn(TURNS, "m-imported")).toThrow("can't be forked from");
    expect(() => forkTurn([{ ...TURNS[0], status: "inProgress" }], `a-${TURNS[0].items[1].id}`)).toThrow("hasn't finished");
  });

  test("a fork that fails after it was made is archived", async () => {
    rememberIn(undefined);
    const d = daemon("thread/name/set");
    await expect(codexFork.fork({ nativeId: ORIG, projectPath: "/p", title: "x" })).rejects.toThrow("thread/name/set failed");
    expect(d.calls("thread/archive").map((p) => p.threadId)).toEqual(["fork-1"]);
  });

  test("a thread on a key's own process, or with history brought in, is copied instead", async () => {
    rememberIn(undefined);
    expect(codexFork.copyInstead!(ORIG)).toBe(false);
    remember(ORIG, { source: { id: "a".repeat(32), source: "openai", projectPath: "/p" } });
    expect(codexFork.copyInstead!(ORIG)).toBe(true);
    await expect(codexFork.fork({ nativeId: ORIG, projectPath: "/p", title: "x" })).rejects.toThrow("copied");
    rememberIn(undefined);
    remember(ORIG, { imported: true });
    expect(codexFork.copyInstead!(ORIG)).toBe(true);
  });

  test("a carried thread: the earlier thread's messages aren't fork points; right after the change, Fork copies it whole", async () => {
    rememberIn(undefined);
    daemon();
    remember("NEW", { carriedFrom: ORIG, imported: true });
    const { codexAdapter } = await import("./index");
    const msgs = await codexAdapter.readHistory("NEW", "/p");
    expect(msgs.length).toBe(historyMsgs(TURNS, "/p").length);
    expect(msgs.every((m) => m.noFork)).toBe(true);
    expect(forkPoints(msgs, false).size).toBe(0);
    expect(wholeForkPoint(msgs, false)).toEqual({});
    expect(codexFork.copyInstead!("NEW")).toBe(true);
    // The earlier thread itself is its own: forkable.
    expect(forkPoints(await codexAdapter.readHistory(ORIG, "/p"), false).size).toBeGreaterThan(0);
  });

  test("a failed adoption's fork is archived", async () => {
    rememberIn(undefined);
    const d = daemon();
    await codexFork.discard!("fork-9", "/p");
    expect(d.calls("thread/archive")).toEqual([{ threadId: "fork-9" }]);
  });
});

describe("a fork whose original rollout was removed", () => {
  test("opening it says so plainly, as does reading its history", async () => {
    rememberIn(undefined);
    const { CodexDriver } = await import("./driver");
    const { TestSink } = await import("./testSink");
    const { threadTurns } = await import("./discovery");
    daemon("thread/resume", "thread/resume failed: missing source rollout");
    await expect(CodexDriver.open("fork-1", "/tmp", {}, new TestSink() as any, true)).rejects.toThrow(FORK_SOURCE_GONE);
    daemon("thread/turns/list", "missing source rollout");
    await expect(threadTurns("fork-1")).rejects.toThrow(FORK_SOURCE_GONE);
    expect(forkError(new Error("other"))).toEqual(new Error("other"));
  });
});
