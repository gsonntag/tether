import { describe, expect, test } from "bun:test";
import type { LiveState, Msg } from "../../shared/transcript";
import { pendingSender, reconcile, startRow, type PendingIO, type PendingSend } from "./pendingSends";

const user = (id: string, text: string, extra: Partial<Msg> = {}): Msg => ({ id, role: "user", ts: 0, parts: [{ type: "text", text }], ...extra });
const said = (id: string): Msg => ({ id, role: "assistant", ts: 0, parts: [{ type: "text", text: "ok" }] });
const copy = (clientId: string, text: string, extra: Partial<PendingSend> = {}): PendingSend => ({ clientId, text, attachments: [], status: "sending", ...extra });
const idle: LiveState = { mode: "live", status: "idle", requests: [], queue: [] };

describe("reconcile", () => {
  test("the runner's message with the copy's clientId replaces it: one bubble, never two", () => {
    const list = [copy("c1", "hi", { after: "a0" })];
    expect(reconcile(list, [said("a0")])).toBe(list);
    expect(reconcile(list, [said("a0"), user("u1", "hi", { clientId: "c1" })])).toEqual([]);
  });

  test("by its text when untagged, only after the newest message at the send, each message once", () => {
    const list = [copy("c1", "same", { after: "a0" }), copy("c2", "same", { after: "a0" })];
    // An older message with the same words isn't it.
    expect(reconcile(list, [user("u0", "same"), said("a0")])).toBe(list);
    const one = reconcile(list, [user("u0", "same"), said("a0"), user("u1", "same")]);
    expect(one.map((p) => p.clientId)).toEqual(["c2"]);
    // Someone else's message (another session's) never counts.
    expect(reconcile(list, [said("a0"), user("x", "same", { origin: { kind: "peer" } })])).toBe(list);
    // A tagged message belongs to its own copy only.
    expect(reconcile(list, [said("a0"), user("u1", "same", { clientId: "other" })])).toBe(list);
  });

  test("a failed copy stays (Retry, Edit) unless its message came after all", () => {
    const list = [copy("c1", "hi", { status: "failed", error: "boom" })];
    expect(reconcile(list, [user("u1", "hi")])).toBe(list);
    expect(reconcile(list, [user("u1", "hi", { clientId: "c1" })])).toEqual([]);
  });

  test("a sent copy whose message went to the queue leaves it to the queue's row", () => {
    const list = [copy("c1", "later", { status: "sent" })];
    expect(reconcile(list, [], [{ text: "later" }])).toEqual([]);
    expect(reconcile([copy("c1", "later")], [], [{ text: "later" }])).toHaveLength(1);
  });
});

describe("the starting row", () => {
  const row = (state: Partial<LiveState>, pending: PendingSend[] = [], hasMessages = false) => startRow({ state: { ...idle, ...state }, pending, label: "Claude Code", hasMessages });

  test("follows a send through the start: sending, starting, then the running row", () => {
    const p = [copy("c1", "hi")];
    // Before the runner says anything: a session not live yet is starting.
    expect(row({ mode: "stored" }, p)).toEqual({ kind: "spinner", text: "Starting Claude Code session…" });
    expect(row({ mode: "stored" }, p, true)).toEqual({ kind: "spinner", text: "Resuming session…" });
    expect(row({}, p)).toEqual({ kind: "spinner", text: "Sending…" });
    // The runner is starting it.
    expect(row({ status: "running", starting: "start" }, p)).toEqual({ kind: "spinner", text: "Starting Claude Code session…" });
    expect(row({ status: "running", starting: "resume" }, p)).toEqual({ kind: "spinner", text: "Resuming session…" });
    // Started and streaming: the usual running row.
    expect(row({ status: "running" }, p)).toBeUndefined();
    expect(row({ status: "running" })).toBeUndefined();
  });

  test("a new session with nothing sent shows that it's starting", () => {
    expect(row({ starting: "start" })).toEqual({ kind: "spinner", text: "Starting Claude Code session…" });
    expect(row({})).toBeUndefined();
  });

  test("a failed send shows its error in the row", () => {
    expect(row({ mode: "stored", error: "x" }, [copy("c1", "hi", { status: "failed", error: "Couldn't start Claude Code: not signed in" })])).toEqual({ kind: "error", text: "Couldn't start Claude Code: not signed in" });
  });
});

describe("pendingSender", () => {
  const setup = () => {
    const calls: { args: any; ok: (v: unknown) => void; fail: (e: Error) => void }[] = [];
    const lists = new Map<string, PendingSend[]>();
    const failed: string[] = [];
    let messages: Msg[] = [said("a0")];
    const io: PendingIO = {
      list: (k) => lists.get(k),
      update: (k, f) => lists.set(k, f(lists.get(k) ?? [])),
      newest: () => messages.at(-1)?.id,
      settle: (k) => lists.set(k, reconcile(lists.get(k) ?? [], messages)),
      send: (_r, args) => new Promise((ok, fail) => calls.push({ args, ok, fail })),
      failed: (_r, _s, e) => failed.push(e),
      key: (r, s) => `${r}/${s}`,
    };
    return { send: pendingSender(io), calls, list: () => lists.get("r/s") ?? [], failed, io, arrive: (m: Msg) => (messages = [...messages, m]) };
  };

  test("shows at once and gives way to its own message: one bubble", async () => {
    const t = setup();
    const id = t.send("r", "s", "hello");
    expect(t.list()).toMatchObject([{ clientId: id, text: "hello", status: "sending", after: "a0" }]);
    expect(t.calls[0]!.args).toMatchObject({ sessionId: "s", text: "hello", clientId: id });
    // The runner's message, tagged, comes before the answer (as Claude's does).
    t.arrive(user("u1", "hello", { clientId: id }));
    t.io.settle("r/s");
    expect(t.list()).toEqual([]);
    t.calls[0]!.ok(null);
    await Bun.sleep(0);
    expect(t.list()).toEqual([]);
  });

  test("a failure keeps the copy with its error; Retry sends it again in its place", async () => {
    const t = setup();
    const id = t.send("r", "s", "hello");
    t.calls[0]!.fail(new Error("Couldn't start Claude Code: boom"));
    await Bun.sleep(0);
    expect(t.list()).toMatchObject([{ clientId: id, status: "failed", error: "Couldn't start Claude Code: boom" }]);
    expect(t.failed).toEqual([]);
    t.send("r", "s", "hello", [], { clientId: id });
    expect(t.list()).toHaveLength(1);
    expect(t.list()[0]).toMatchObject({ clientId: id, status: "sending" });
    expect(t.calls[1]!.args.clientId).toBe(id);
    t.calls[1]!.ok(null);
    await Bun.sleep(0);
    expect(t.list()[0]!.status).toBe("sent");
    t.arrive(user("u1", "hello", { clientId: id }));
    t.io.settle("r/s");
    expect(t.list()).toEqual([]);
  });

  test("a failure after its message came says so in the chat instead", async () => {
    const t = setup();
    const id = t.send("r", "s", "hello");
    t.arrive(user("u1", "hello", { clientId: id }));
    t.io.settle("r/s");
    t.calls[0]!.fail(new Error("turn failed"));
    await Bun.sleep(0);
    expect(t.list()).toEqual([]);
    expect(t.failed).toEqual(["turn failed"]);
  });
});
