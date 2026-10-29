import { describe, expect, test } from "bun:test";
import type { BrowserToServer, RunnerInfo, RunnerToServer } from "../../shared/protocol";
import { Relay, type Socket } from "./relay";

class FakeSocket implements Socket {
  sent: any[] = [];
  /** what send() returns: Bun's 0 means the frame was dropped */
  sendResult = 1;
  closed?: { code?: number; reason?: string };
  constructor(readonly name: string) {}
  send(data: string) {
    if (this.sendResult !== 0) this.sent.push(JSON.parse(data));
    return this.sendResult;
  }
  close(code?: number, reason?: string) {
    this.closed = { code, reason };
  }
  /** messages of one type, and clears the log */
  take(t?: string) {
    const out = t ? this.sent.filter((m) => m.t === t) : this.sent;
    this.sent = [];
    return out;
  }
}

const runnerInfo = (id: string): Omit<RunnerInfo, "connectedAt"> => ({ id, name: id, hostname: `${id}.local`, version: "0.0.0", protocol: 1, harnesses: [{ id: "claude", version: "2.1.0" }] });

function setup(opts: { rpcTimeoutMs?: number } = {}) {
  const relay = new Relay({ rpcTimeoutMs: opts.rpcTimeoutMs ?? 1000, now: () => 1000 });
  const browser = (name: string) => {
    const s = new FakeSocket(name);
    relay.addBrowser(s, { name, email: `${name}@x` }, 1);
    return s;
  };
  const runner = (id: string) => {
    const s = new FakeSocket(`runner:${id}`);
    relay.onRunnerMessage(s, { t: "hello", runner: runnerInfo(id) });
    return s;
  };
  const rpc = (b: FakeSocket, id: string, runnerId: string, op: string, args: unknown = {}) =>
    relay.onBrowserMessage(b, { t: "rpc", id, runnerId, op, args } as BrowserToServer);
  const fromRunner = (r: FakeSocket, m: RunnerToServer) => relay.onRunnerMessage(r, m);
  return { relay, browser, runner, rpc, fromRunner };
}

describe("connections", () => {
  test("a browser gets hello and the runner list; runner changes are broadcast", () => {
    const { browser, runner, relay } = setup();
    const b = browser("a");
    expect(b.take().map((m) => m.t)).toEqual(["hello", "runners"]);
    const r = runner("box");
    const [list] = b.take("runners");
    expect(list.runners.map((x: RunnerInfo) => x.id)).toEqual(["box"]);
    expect(list.runners[0].connectedAt).toBe(1000);
    relay.removeRunner(r);
    expect(b.take("runners")[0].runners).toEqual([]);
  });

  test("frames from a runner before hello are ignored", () => {
    const { relay, browser } = setup();
    const b = browser("a");
    b.take();
    const r = new FakeSocket("anon");
    relay.onRunnerMessage(r, { t: "summary", summary: { kind: "all", seq: 1, sessions: [] } });
    expect(b.sent).toEqual([]);
  });

  test("pings from browsers and runners are answered by the server", () => {
    const { relay, browser, runner } = setup();
    const b = browser("a");
    const r = runner("box");
    b.take();
    relay.onBrowserMessage(b, { t: "ping" });
    relay.onRunnerMessage(r, { t: "ping" });
    expect(b.take()).toEqual([{ t: "pong" }]);
    expect(r.take()).toEqual([{ t: "pong" }]);
  });
});

describe("rpc", () => {
  test("is forwarded with a server id and answered under the browser's id", () => {
    const { browser, runner, rpc, fromRunner } = setup();
    const b1 = browser("a");
    const b2 = browser("b");
    const r = runner("box");
    rpc(b1, "1", "box", "ping");
    rpc(b2, "1", "box", "ping");
    const [f1, f2] = r.take("rpc");
    expect(f1.id).not.toBe(f2.id);
    expect(f1.op).toBe("ping");
    b1.take();
    b2.take();
    fromRunner(r, { t: "result", id: f2.id, ok: true, data: "two" });
    fromRunner(r, { t: "result", id: f1.id, ok: true, data: "one" });
    expect(b1.take("result")).toEqual([{ t: "result", id: "1", ok: true, data: "one" }]);
    expect(b2.take("result")).toEqual([{ t: "result", id: "1", ok: true, data: "two" }]);
  });

  test("to an offline runner fails right away", () => {
    const { browser, rpc } = setup();
    const b = browser("a");
    rpc(b, "7", "nobody", "ping");
    const [res] = b.take("result");
    expect(res).toMatchObject({ id: "7", ok: false });
    expect(res.error).toContain("offline");
  });

  test("times out when the runner doesn't answer, and a late answer is dropped", async () => {
    const { browser, runner, rpc, fromRunner, relay } = setup({ rpcTimeoutMs: 20 });
    const b = browser("a");
    const r = runner("box");
    rpc(b, "1", "box", "ping");
    const [f] = r.take("rpc");
    await Bun.sleep(40);
    const [res] = b.take("result");
    expect(res).toMatchObject({ id: "1", ok: false });
    expect(res.error).toContain("in time");
    fromRunner(r, { t: "result", id: f.id, ok: true });
    expect(b.take("result")).toEqual([]);
    expect(relay.stats().pending).toBe(0);
  });

  test("a result from another runner can't settle someone else's rpc", () => {
    const { browser, runner, rpc, fromRunner } = setup();
    const b = browser("a");
    const r1 = runner("one");
    const r2 = runner("two");
    rpc(b, "1", "one", "ping");
    const [f] = r1.take("rpc");
    b.take();
    fromRunner(r2, { t: "result", id: f.id, ok: true, data: "forged" });
    expect(b.take("result")).toEqual([]);
    fromRunner(r1, { t: "result", id: f.id, ok: true, data: "real" });
    expect(b.take("result")[0].data).toBe("real");
  });

  test("pending rpcs fail when their runner disconnects", () => {
    const { browser, runner, rpc, relay } = setup();
    const b = browser("a");
    const r = runner("box");
    rpc(b, "1", "box", "ping");
    relay.removeRunner(r);
    const [res] = b.take("result");
    expect(res).toMatchObject({ id: "1", ok: false, error: "The runner disconnected." });
  });

  test("a browser that leaves takes its pending rpcs with it", () => {
    const { browser, runner, rpc, relay, fromRunner } = setup();
    const b = browser("a");
    const r = runner("box");
    rpc(b, "1", "box", "ping");
    const [f] = r.take("rpc");
    relay.removeBrowser(b);
    expect(relay.stats().pending).toBe(0);
    b.take();
    fromRunner(r, { t: "result", id: f.id, ok: true });
    expect(b.sent).toEqual([]);
  });
});

describe("subscriptions", () => {
  const ev = (sessionId: string, seq: number): RunnerToServer => ({ t: "event", sessionId, seq, event: { type: "state", state: { status: "running" } } });

  test("session events go only to subscribers", () => {
    const { browser, runner, rpc, fromRunner } = setup();
    const a = browser("a");
    const b = browser("b");
    const r = runner("box");
    rpc(a, "1", "box", "subscribe", { sessionId: "claude:x" });
    expect(r.take("rpc")[0]).toMatchObject({ op: "subscribe", args: { sessionId: "claude:x" } });
    fromRunner(r, ev("claude:x", 1));
    fromRunner(r, ev("claude:y", 1));
    expect(a.take("event")).toEqual([{ t: "event", runnerId: "box", sessionId: "claude:x", seq: 1, event: { type: "state", state: { status: "running" } } }]);
    expect(b.take("event")).toEqual([]);
  });

  test("events flow from the moment subscribe is forwarded, before the snapshot", () => {
    const { browser, runner, rpc, fromRunner } = setup();
    const a = browser("a");
    const r = runner("box");
    rpc(a, "1", "box", "subscribe", { sessionId: "claude:x" });
    fromRunner(r, ev("claude:x", 5));
    expect(a.take("event")).toHaveLength(1);
  });

  test("subscriptions are per runner", () => {
    const { browser, runner, rpc, fromRunner } = setup();
    const a = browser("a");
    runner("one");
    const r2 = runner("two");
    rpc(a, "1", "one", "subscribe", { sessionId: "claude:x" });
    fromRunner(r2, ev("claude:x", 1));
    expect(a.take("event")).toEqual([]);
  });

  test("unsubscribe is answered by the server and stops events", () => {
    const { browser, runner, rpc, fromRunner, relay } = setup();
    const a = browser("a");
    const r = runner("box");
    rpc(a, "1", "box", "subscribe", { sessionId: "claude:x" });
    r.take();
    rpc(a, "2", "box", "unsubscribe", { sessionId: "claude:x" });
    expect(r.take("rpc")).toEqual([]);
    expect(a.take("result")).toEqual([{ t: "result", id: "2", ok: true, data: null }]);
    fromRunner(r, ev("claude:x", 1));
    expect(a.take("event")).toEqual([]);
    expect(relay.stats().subscriptions).toBe(0);
  });

  test("a failed subscribe leaves no subscription", () => {
    const { browser, runner, rpc, fromRunner, relay } = setup();
    const a = browser("a");
    const r = runner("box");
    rpc(a, "1", "box", "subscribe", { sessionId: "claude:gone" });
    const [f] = r.take("rpc");
    fromRunner(r, { t: "result", id: f.id, ok: false, error: "No such session." });
    expect(a.take("result")[0]).toMatchObject({ ok: false, error: "No such session." });
    expect(relay.stats().subscriptions).toBe(0);
  });

  test("a browser that leaves is unsubscribed; others keep theirs", () => {
    const { browser, runner, rpc, fromRunner, relay } = setup();
    const a = browser("a");
    const b = browser("b");
    const r = runner("box");
    rpc(a, "1", "box", "subscribe", { sessionId: "claude:x" });
    rpc(b, "1", "box", "subscribe", { sessionId: "claude:x" });
    relay.removeBrowser(a);
    a.take();
    b.take();
    fromRunner(r, ev("claude:x", 1));
    expect(a.sent).toEqual([]);
    expect(b.take("event")).toHaveLength(1);
  });

  test("summaries go to every browser, stamped with the runner", () => {
    const { browser, runner, fromRunner } = setup();
    const a = browser("a");
    const b = browser("b");
    const r = runner("box");
    fromRunner(r, { t: "summary", summary: { kind: "remove", seq: 1, ids: ["claude:x"] } });
    for (const s of [a, b]) expect(s.take("summary")).toEqual([{ t: "summary", runnerId: "box", summary: { kind: "remove", seq: 1, ids: ["claude:x"] } }]);
  });
});

describe("terminal routing", () => {
  function attached() {
    const t = setup();
    const a = t.browser("a");
    const b = t.browser("b");
    const r = t.runner("box");
    t.rpc(a, "1", "box", "openTerminal", { sessionId: "claude:x", cols: 80, rows: 24 });
    const [f] = r.take("rpc");
    const attachId: string = f.args.attachId;
    t.fromRunner(r, { t: "result", id: f.id, ok: true, data: { attachId } });
    a.take();
    b.take();
    return { ...t, a, b, r, attachId };
  }

  test("the server names the attach and output goes to that browser only", () => {
    const { a, b, r, fromRunner, attachId } = attached();
    expect(attachId).toMatch(/^a/);
    fromRunner(r, { t: "term", attachId, data: "aGk=" });
    expect(a.take()).toEqual([{ t: "term", attachId, data: "aGk=" }]);
    expect(b.take()).toEqual([]);
  });

  test("a browser can't send input to someone else's attach", () => {
    const { b, r, rpc, attachId } = attached();
    rpc(b, "9", "box", "terminalInput", { attachId, data: "bHM=" });
    expect(r.take("rpc")).toEqual([]);
    expect(b.take("result")[0]).toMatchObject({ id: "9", ok: false });
  });

  test("the owner's input and resize are forwarded", () => {
    const { a, r, rpc, attachId } = attached();
    rpc(a, "2", "box", "terminalInput", { attachId, data: "bHM=" });
    rpc(a, "3", "box", "terminalResize", { attachId, cols: 40, rows: 20 });
    expect(r.take("rpc").map((m) => m.op)).toEqual(["terminalInput", "terminalResize"]);
  });

  test("output for an unknown attach makes the runner close it", () => {
    const { r, fromRunner } = attached();
    fromRunner(r, { t: "term", attachId: "nope", data: "" });
    expect(r.take()).toEqual([{ t: "detach", attachIds: ["nope"] }]);
  });

  test("a browser that leaves detaches its terminals", () => {
    const { a, r, relay, attachId } = attached();
    relay.removeBrowser(a);
    expect(r.take()).toEqual([{ t: "detach", attachIds: [attachId] }]);
    expect(relay.stats().attaches).toBe(0);
  });

  test("termEnd reaches the owner and ends the route", () => {
    const { a, r, fromRunner, relay, attachId } = attached();
    fromRunner(r, { t: "termEnd", attachId, reason: "exited" });
    expect(a.take()).toEqual([{ t: "termEnd", attachId, reason: "exited" }]);
    expect(relay.stats().attaches).toBe(0);
  });

  test("closeTerminal ends the route right away", () => {
    const { a, r, rpc, fromRunner, attachId } = attached();
    rpc(a, "4", "box", "closeTerminal", { attachId });
    expect(r.take("rpc")[0].op).toBe("closeTerminal");
    fromRunner(r, { t: "term", attachId, data: "" });
    expect(a.take("term")).toEqual([]);
  });

  test("a failed open leaves no route", () => {
    const { browser, runner, rpc, fromRunner, relay } = setup();
    const a = browser("a");
    const r = runner("box");
    rpc(a, "1", "box", "openTerminal", { sessionId: "claude:x", cols: 80, rows: 24 });
    const [f] = r.take("rpc");
    fromRunner(r, { t: "result", id: f.id, ok: false, error: "tmux missing" });
    expect(relay.stats().attaches).toBe(0);
  });
});

describe("runner replacement", () => {
  test("a second hello with the same id replaces the first connection", () => {
    const { browser, runner, rpc, fromRunner, relay } = setup();
    const a = browser("a");
    const old = runner("box");
    rpc(a, "1", "box", "ping");
    a.take();
    const fresh = runner("box");
    expect(old.closed?.code).toBe(4000);
    // The old connection's pending rpc fails instead of hanging.
    expect(a.take("result")[0]).toMatchObject({ id: "1", ok: false });
    // Its late close must not remove the new one.
    relay.removeRunner(old);
    expect(relay.runnerList().map((r) => r.id)).toEqual(["box"]);
    // Frames from the old connection are ignored; the new one routes.
    rpc(a, "2", "box", "ping");
    const [f] = fresh.take("rpc");
    expect(f).toBeDefined();
    fromRunner(old, { t: "result", id: f.id, ok: true, data: "stale" });
    expect(a.take("result")).toEqual([]);
    fromRunner(fresh, { t: "result", id: f.id, ok: true, data: "fresh" });
    expect(a.take("result")[0].data).toBe("fresh");
  });

  test("replacement drops the runner's subscriptions and ends its terminals", () => {
    const { browser, runner, rpc, fromRunner, relay } = setup();
    const a = browser("a");
    const old = runner("box");
    rpc(a, "1", "box", "subscribe", { sessionId: "claude:x" });
    rpc(a, "2", "box", "openTerminal", { sessionId: "claude:x", cols: 80, rows: 24 });
    const attachId = old.take("rpc")[1].args.attachId;
    a.take();
    const fresh = runner("box");
    expect(a.take("termEnd")).toEqual([{ t: "termEnd", attachId, reason: "The runner reconnected." }]);
    fromRunner(fresh, { t: "event", sessionId: "claude:x", seq: 1, event: { type: "reset", messages: [], hasOlder: false } });
    expect(a.take("event")).toEqual([]);
    expect(relay.stats()).toMatchObject({ subscriptions: 0, attaches: 0 });
  });

  test("runners with different ids coexist", () => {
    const { runner, relay } = setup();
    runner("one");
    runner("two");
    expect(relay.runnerList().map((r) => r.id).sort()).toEqual(["one", "two"]);
  });
});

describe("watching", () => {
  test("the runner hears when the last subscriber unsubscribes, not before", () => {
    const { browser, runner, rpc } = setup();
    const a = browser("a");
    const b = browser("b");
    const r = runner("box");
    rpc(a, "1", "box", "subscribe", { sessionId: "claude:x" });
    rpc(b, "1", "box", "subscribe", { sessionId: "claude:x" });
    r.take();
    rpc(a, "2", "box", "unsubscribe", { sessionId: "claude:x" });
    expect(r.take()).toEqual([]);
    rpc(b, "2", "box", "unsubscribe", { sessionId: "claude:x" });
    expect(r.take()).toEqual([{ t: "unwatched", sessionIds: ["claude:x"] }]);
    // Unsubscribing again (or from something never watched) says nothing.
    rpc(b, "3", "box", "unsubscribe", { sessionId: "claude:x" });
    expect(r.take()).toEqual([]);
  });

  test("a browser that leaves unwatches everything it alone watched, per runner", () => {
    const { browser, runner, rpc, relay } = setup();
    const a = browser("a");
    const b = browser("b");
    const r1 = runner("one");
    const r2 = runner("two");
    rpc(a, "1", "one", "subscribe", { sessionId: "claude:x" });
    rpc(a, "2", "one", "subscribe", { sessionId: "claude:y" });
    rpc(a, "3", "two", "subscribe", { sessionId: "codex:z" });
    rpc(b, "1", "one", "subscribe", { sessionId: "claude:y" });
    r1.take();
    r2.take();
    relay.removeBrowser(a);
    expect(r1.take()).toEqual([{ t: "unwatched", sessionIds: ["claude:x"] }]);
    expect(r2.take()).toEqual([{ t: "unwatched", sessionIds: ["codex:z"] }]);
  });

  test("a failed subscribe unwatches when it was the only one", () => {
    const { browser, runner, rpc, fromRunner } = setup();
    const a = browser("a");
    const r = runner("box");
    rpc(a, "1", "box", "subscribe", { sessionId: "claude:gone" });
    const [f] = r.take("rpc");
    fromRunner(r, { t: "result", id: f.id, ok: false, error: "No such session." });
    expect(r.take()).toEqual([{ t: "unwatched", sessionIds: ["claude:gone"] }]);
  });

  test("subscribe without a session id is refused by the server", () => {
    const { browser, runner, rpc } = setup();
    const a = browser("a");
    const r = runner("box");
    rpc(a, "1", "box", "subscribe", {});
    rpc(a, "2", "box", "unsubscribe", { sessionId: 5 });
    expect(r.take()).toEqual([]);
    expect(a.take("result").map((m) => m.ok)).toEqual([false, false]);
  });
});

describe("repeated hello", () => {
  test("on the same connection it updates the info but keeps connectedAt and the routes", () => {
    let now = 1000;
    const relay = new Relay({ now: () => now });
    const a = new FakeSocket("a");
    relay.addBrowser(a, { name: "a", email: "" }, 1);
    const r = new FakeSocket("r");
    relay.onRunnerMessage(r, { t: "hello", runner: runnerInfo("box") });
    relay.onBrowserMessage(a, { t: "rpc", id: "1", runnerId: "box", op: "subscribe", args: { sessionId: "claude:x" } });
    a.take();
    now = 5000;
    relay.onRunnerMessage(r, { t: "hello", runner: { ...runnerInfo("box"), harnesses: [] } });
    expect(r.closed).toBeUndefined();
    const [list] = a.take("runners");
    expect(list.runners[0]).toMatchObject({ connectedAt: 1000, harnesses: [] });
    expect(relay.stats()).toMatchObject({ subscriptions: 1, pending: 1 });
  });

  test("on a new connection it gets a new connectedAt", () => {
    let now = 1000;
    const relay = new Relay({ now: () => now });
    relay.onRunnerMessage(new FakeSocket("r1"), { t: "hello", runner: runnerInfo("box") });
    now = 2000;
    relay.onRunnerMessage(new FakeSocket("r2"), { t: "hello", runner: runnerInfo("box") });
    expect(relay.runnerList()[0]!.connectedAt).toBe(2000);
  });
});

describe("slow sockets", () => {
  test("a browser whose frames would be dropped is closed instead", () => {
    const { browser, runner, rpc, fromRunner } = setup();
    const a = browser("a");
    const r = runner("box");
    rpc(a, "1", "box", "openTerminal", { sessionId: "claude:x", cols: 80, rows: 24 });
    const attachId = r.take("rpc")[0].args.attachId;
    a.sendResult = 0;
    fromRunner(r, { t: "term", attachId, data: "aGk=" });
    expect(a.closed).toEqual({ code: 4002, reason: "too slow" });
  });

  test("backpressure that still queued the frame (-1) is fine", () => {
    const { browser, runner, fromRunner } = setup();
    const a = browser("a");
    const r = runner("box");
    a.sendResult = -1;
    fromRunner(r, { t: "summary", summary: { kind: "all", seq: 1, sessions: [] } });
    expect(a.closed).toBeUndefined();
  });
});

describe("subscribe again", () => {
  test("a failed refresh of a working subscription keeps it", () => {
    const { browser, runner, rpc, fromRunner, relay } = setup();
    const a = browser("a");
    const r = runner("box");
    rpc(a, "1", "box", "subscribe", { sessionId: "claude:x" });
    const [f1] = r.take("rpc");
    fromRunner(r, { t: "result", id: f1.id, ok: true, data: {} });
    rpc(a, "2", "box", "subscribe", { sessionId: "claude:x" });
    const [f2] = r.take("rpc");
    fromRunner(r, { t: "result", id: f2.id, ok: false, error: "busy" });
    expect(r.take()).toEqual([]);
    a.take();
    fromRunner(r, { t: "event", sessionId: "claude:x", seq: 1, event: { type: "state", state: {} } });
    expect(a.take("event")).toHaveLength(1);
    expect(relay.stats().subscriptions).toBe(1);
  });
});

describe("protocol version", () => {
  test("a runner speaking another protocol is refused with a reason and never listed", () => {
    const relay = new Relay({ protocol: 2 });
    const a = new FakeSocket("a");
    relay.addBrowser(a, { name: "a", email: "" }, 2);
    a.take();
    const r = new FakeSocket("r");
    relay.onRunnerMessage(r, { t: "hello", runner: runnerInfo("box") });
    expect(r.closed?.code).toBe(4003);
    expect(r.closed?.reason).toContain("update the runner");
    expect(relay.runnerList()).toEqual([]);
    expect(a.take("runners")).toEqual([]);
    const newer = new FakeSocket("n");
    relay.onRunnerMessage(newer, { t: "hello", runner: { ...runnerInfo("box"), protocol: 3 } });
    expect(newer.closed?.reason).toContain("update the app");
  });

  test("a runner already connected that says hello with another protocol is removed", () => {
    const relay = new Relay({ protocol: 1 });
    const r = new FakeSocket("r");
    relay.onRunnerMessage(r, { t: "hello", runner: runnerInfo("box") });
    relay.onRunnerMessage(r, { t: "hello", runner: { ...runnerInfo("box"), protocol: 9 } });
    expect(relay.runnerList()).toEqual([]);
    expect(r.closed?.code).toBe(4003);
  });
});
