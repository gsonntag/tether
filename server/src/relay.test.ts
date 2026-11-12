import { describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION, type BrowserToServer, type RunnerInfo, type RunnerToServer } from "../../shared/protocol";
import { Relay, type Socket } from "./relay";
import { runnerIdAllowed, runnerIdRefusal } from "./runnerIds";
import { Tickets } from "./tickets";

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

const runnerInfo = (id: string): Omit<RunnerInfo, "connectedAt"> => ({ id, name: id, hostname: `${id}.local`, version: "0.0.0", protocol: PROTOCOL_VERSION, harnesses: [{ id: "claude", version: "2.1.0" }] });

/** A runner connection opened with service token `token` says hello. */
function hi(relay: Relay, s: Socket, runner: Omit<RunnerInfo, "connectedAt">, token = "runner") {
  relay.addRunner(s, token);
  relay.onRunnerMessage(s, { t: "hello", runner });
}

function setup(opts: { rpcTimeoutMs?: number } = {}) {
  const relay = new Relay({ rpcTimeoutMs: opts.rpcTimeoutMs ?? 1000, now: () => 1000 });
  const browser = (name: string) => {
    const s = new FakeSocket(name);
    relay.addBrowser(s, { name, email: `${name}@x` }, 1);
    return s;
  };
  const runner = (id: string) => {
    const s = new FakeSocket(`runner:${id}`);
    hi(relay, s, runnerInfo(id));
    expect(s.take()).toEqual([{ t: "welcome" }, { t: "viewers", sessions: {} }]);
    return s;
  };
  const rpc = (b: FakeSocket, id: string, runnerId: string, op: string, args: unknown = {}) =>
    relay.onBrowserMessage(b, { t: "rpc", id, runnerId, op, args } as BrowserToServer);
  const fromRunner = (r: FakeSocket, m: RunnerToServer) => relay.onRunnerMessage(r, m);
  return { relay, browser, runner, rpc, fromRunner };
}

describe("connections", () => {
  test("credential RPCs are forwarded once, never logged, retained as pending args, or broadcast", () => {
    const logs: string[] = [];
    const relay = new Relay({ log: (s) => logs.push(s) });
    const runner = new FakeSocket("runner"), browser = new FakeSocket("owner"), other = new FakeSocket("other");
    hi(relay, runner, runnerInfo("box"));
    relay.addBrowser(browser, { name: "owner", email: "owner@example.com" }, PROTOCOL_VERSION);
    relay.addBrowser(other, { name: "other", email: "other@example.com" }, PROTOCOL_VERSION);
    runner.take(); browser.take(); other.take();
    const key = `fake-relay-${crypto.randomUUID()}`;
    relay.onBrowserMessage(browser, { t: "rpc", id: "c1", runnerId: "box", op: "setCredential", args: { source: "anthropic", key } });
    const [request] = runner.take("rpc");
    expect(request.args.key).toBe(key);
    expect(other.take()).toEqual([]);
    expect(browser.take()).toEqual([]);
    expect(JSON.stringify(logs)).not.toContain(key);
    expect(JSON.stringify([...(relay as any).pending.values()])).not.toContain(key);
    relay.onRunnerMessage(runner, { t: "result", id: request.id, ok: true, data: { anthropic: { set: true } } });
    expect(JSON.stringify(browser.take())).not.toContain(key);
    expect(other.take()).toEqual([]);
  });
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
    relay.onRunnerMessage(r, { t: "summary", summary: { kind: "all", epoch: "e", seq: 1, sessions: [] } });
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
    fromRunner(r, { t: "summary", summary: { kind: "remove", epoch: "e", seq: 1, ids: ["claude:x"] } });
    for (const s of [a, b]) expect(s.take("summary")).toEqual([{ t: "summary", runnerId: "box", summary: { kind: "remove", epoch: "e", seq: 1, ids: ["claude:x"] } }]);
  });

  test("the Home agent's current chat goes to every browser, stamped with the runner", () => {
    const { browser, runner, fromRunner } = setup();
    const a = browser("a");
    const b = browser("b");
    const r = runner("box");
    fromRunner(r, { t: "homeChat", sessionId: "claude:x", rev: 1 });
    fromRunner(r, { t: "homeChat", rev: 2 });
    for (const s of [a, b]) expect(s.take("homeChat")).toEqual([{ t: "homeChat", runnerId: "box", sessionId: "claude:x", rev: 1 }, { t: "homeChat", runnerId: "box", rev: 2 }]);
    // The tabs' home names go along.
    fromRunner(r, { t: "homeChat", sessionId: "claude:x", chats: ["claude:x", "claude:y"], labels: { "claude:x": 0, "claude:y": 1 }, rev: 3 });
    for (const s of [a, b]) expect(s.take("homeChat")).toEqual([{ t: "homeChat", runnerId: "box", sessionId: "claude:x", chats: ["claude:x", "claude:y"], labels: { "claude:x": 0, "claude:y": 1 }, rev: 3 }]);
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
    hi(relay, r, runnerInfo("box"));
    relay.onBrowserMessage(a, { t: "rpc", id: "1", runnerId: "box", op: "subscribe", args: { sessionId: "claude:x" } });
    a.take();
    now = 5000;
    hi(relay, r, { ...runnerInfo("box"), harnesses: [] });
    expect(r.closed).toBeUndefined();
    const [list] = a.take("runners");
    expect(list.runners[0]).toMatchObject({ connectedAt: 1000, harnesses: [] });
    expect(relay.stats()).toMatchObject({ subscriptions: 1, pending: 1 });
  });

  test("on a new connection it gets a new connectedAt", () => {
    let now = 1000;
    const relay = new Relay({ now: () => now });
    hi(relay, new FakeSocket("r1"), runnerInfo("box"));
    now = 2000;
    hi(relay, new FakeSocket("r2"), runnerInfo("box"));
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
    fromRunner(r, { t: "summary", summary: { kind: "all", epoch: "e", seq: 1, sessions: [] } });
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
    const relay = new Relay({ protocol: PROTOCOL_VERSION + 1 });
    const a = new FakeSocket("a");
    relay.addBrowser(a, { name: "a", email: "" }, PROTOCOL_VERSION + 1);
    a.take();
    const r = new FakeSocket("r");
    hi(relay, r, runnerInfo("box"));
    expect(r.closed?.code).toBe(4003);
    expect(r.closed?.reason).toContain("update the runner");
    expect(relay.runnerList()).toEqual([]);
    expect(a.take("runners")).toEqual([]);
    const newer = new FakeSocket("n");
    hi(relay, newer, { ...runnerInfo("box"), protocol: PROTOCOL_VERSION + 2 });
    expect(newer.closed?.reason).toContain("update the app");
  });

  test("a runner already connected that says hello with another protocol is removed", () => {
    const relay = new Relay({ protocol: PROTOCOL_VERSION });
    const r = new FakeSocket("r");
    hi(relay, r, runnerInfo("box"));
    hi(relay, r, { ...runnerInfo("box"), protocol: 9 });
    expect(relay.runnerList()).toEqual([]);
    expect(r.closed?.code).toBe(4003);
  });
});

describe("overlapping subscribe and unsubscribe", () => {
  test("unsubscribe while a subscribe is in flight: the late answer leaves no route", () => {
    const { browser, runner, rpc, fromRunner, relay } = setup();
    const a = browser("a");
    const r = runner("box");
    rpc(a, "1", "box", "subscribe", { sessionId: "claude:x" });
    const [f] = r.take("rpc");
    rpc(a, "2", "box", "unsubscribe", { sessionId: "claude:x" });
    expect(r.take()).toEqual([{ t: "unwatched", sessionIds: ["claude:x"] }]);
    fromRunner(r, { t: "result", id: f.id, ok: true, data: {} });
    fromRunner(r, { t: "event", sessionId: "claude:x", seq: 1, event: { type: "state", state: {} } });
    expect(a.take("event")).toEqual([]);
    expect(relay.stats().subscriptions).toBe(0);
  });

  test("subscribe, unsubscribe, subscribe: the first one failing late keeps the newer route", () => {
    const { browser, runner, rpc, fromRunner, relay } = setup();
    const a = browser("a");
    const r = runner("box");
    rpc(a, "1", "box", "subscribe", { sessionId: "claude:x" });
    const [f1] = r.take("rpc");
    rpc(a, "2", "box", "unsubscribe", { sessionId: "claude:x" });
    rpc(a, "3", "box", "subscribe", { sessionId: "claude:x" });
    r.take();
    fromRunner(r, { t: "result", id: f1.id, ok: false, error: "late" });
    expect(r.take()).toEqual([]);
    expect(relay.stats().subscriptions).toBe(1);
  });
});

describe("malformed frames", () => {
  test("a malformed rpc with a readable id is answered with an error", () => {
    const { browser, relay } = setup();
    const a = browser("a");
    a.take();
    relay.malformedRpc(a, "9");
    expect(a.take()).toEqual([{ t: "result", id: "9", ok: false, error: "Malformed request." }]);
  });

  test("a malformed result fails its rpc now, only from the runner it was sent to", () => {
    const { browser, runner, rpc, relay } = setup();
    const a = browser("a");
    const r = runner("box");
    const other = runner("other");
    rpc(a, "1", "box", "ping");
    const [f] = r.take("rpc");
    a.take();
    relay.malformedResult(other, f.id);
    expect(a.take()).toEqual([]);
    relay.malformedResult(r, f.id);
    expect(a.take("result")[0]).toMatchObject({ id: "1", ok: false });
    expect(relay.stats().pending).toBe(0);
  });
});

describe("round 4: subscribe answers and routes", () => {
  test("a subscribe that succeeds after its unsubscribe tells the runner unwatched again", () => {
    const { browser, runner, rpc, fromRunner } = setup();
    const a = browser("a");
    const r = runner("box");
    rpc(a, "1", "box", "subscribe", { sessionId: "claude:x" });
    const [f] = r.take("rpc");
    rpc(a, "2", "box", "unsubscribe", { sessionId: "claude:x" });
    expect(r.take()).toEqual([{ t: "unwatched", sessionIds: ["claude:x"] }]);
    fromRunner(r, { t: "result", id: f.id, ok: true, data: {} });
    expect(r.take()).toEqual([{ t: "unwatched", sessionIds: ["claude:x"] }]);
  });

  test("...but not when another browser still watches the session", () => {
    const { browser, runner, rpc, fromRunner } = setup();
    const a = browser("a");
    const b = browser("b");
    const r = runner("box");
    rpc(b, "1", "box", "subscribe", { sessionId: "claude:x" });
    rpc(a, "1", "box", "subscribe", { sessionId: "claude:x" });
    const [, fa] = r.take("rpc");
    rpc(a, "2", "box", "unsubscribe", { sessionId: "claude:x" });
    fromRunner(r, { t: "result", id: fa.id, ok: true, data: {} });
    expect(r.take()).toEqual([]);
  });

  test("a browser that leaves mid-subscribe: the late success is unwatched too", () => {
    const { browser, runner, rpc, fromRunner, relay } = setup();
    const a = browser("a");
    const r = runner("box");
    rpc(a, "1", "box", "subscribe", { sessionId: "claude:x" });
    const [f] = r.take("rpc");
    relay.removeBrowser(a);
    r.take();
    fromRunner(r, { t: "result", id: f.id, ok: true, data: {} });
    expect(r.take()).toEqual([{ t: "unwatched", sessionIds: ["claude:x"] }]);
    expect(relay.stats().pending).toBe(0);
  });

  test("two subscribes in flight: the first failing keeps the route for the second, which succeeds", () => {
    const { browser, runner, rpc, fromRunner, relay } = setup();
    const a = browser("a");
    const r = runner("box");
    rpc(a, "1", "box", "subscribe", { sessionId: "claude:x" });
    rpc(a, "2", "box", "subscribe", { sessionId: "claude:x" });
    const [f1, f2] = r.take("rpc");
    fromRunner(r, { t: "result", id: f1.id, ok: false, error: "busy" });
    expect(relay.stats().subscriptions).toBe(1);
    fromRunner(r, { t: "result", id: f2.id, ok: true, data: {} });
    a.take();
    fromRunner(r, { t: "event", sessionId: "claude:x", seq: 1, event: { type: "state", state: {} } });
    expect(a.take("event")).toHaveLength(1);
  });

  test("two subscribes in flight that both fail leave no route", () => {
    const { browser, runner, rpc, fromRunner, relay } = setup();
    const a = browser("a");
    const r = runner("box");
    rpc(a, "1", "box", "subscribe", { sessionId: "claude:x" });
    rpc(a, "2", "box", "subscribe", { sessionId: "claude:x" });
    const [f1, f2] = r.take("rpc");
    fromRunner(r, { t: "result", id: f2.id, ok: false, error: "no" });
    expect(relay.stats().subscriptions).toBe(1);
    fromRunner(r, { t: "result", id: f1.id, ok: false, error: "no" });
    expect(relay.stats().subscriptions).toBe(0);
    expect(r.take()).toEqual([{ t: "unwatched", sessionIds: ["claude:x"] }]);
  });
});

describe("presence and push keys", () => {
  test("runners hear which devices look at their sessions; changes only", () => {
    const { relay, browser, runner } = setup();
    const r1 = runner("one");
    const r2 = runner("two");
    const a = browser("a");
    const b = browser("b");
    relay.onBrowserMessage(a, { t: "presence", deviceId: "dev-a", runnerId: "one", sessionId: "claude:s1" });
    expect(r1.take("viewers")).toEqual([{ t: "viewers", sessions: { "claude:s1": ["dev-a"] } }]);
    relay.onBrowserMessage(b, { t: "presence", deviceId: "dev-b", runnerId: "one", sessionId: "claude:s1" });
    expect(r1.take("viewers")).toEqual([{ t: "viewers", sessions: { "claude:s1": ["dev-a", "dev-b"] } }]);
    // The same again: nothing new to say.
    relay.onBrowserMessage(b, { t: "presence", deviceId: "dev-b", runnerId: "one", sessionId: "claude:s1" });
    expect(r1.take("viewers")).toEqual([]);
    // b moves to the other runner: both hear.
    relay.onBrowserMessage(b, { t: "presence", deviceId: "dev-b", runnerId: "two", sessionId: "codex:t" });
    expect(r1.take("viewers")).toEqual([{ t: "viewers", sessions: { "claude:s1": ["dev-a"] } }]);
    expect(r2.take("viewers")).toEqual([{ t: "viewers", sessions: { "codex:t": ["dev-b"] } }]);
    // a hides its page, b disconnects.
    relay.onBrowserMessage(a, { t: "presence", deviceId: "dev-a" });
    expect(r1.take("viewers")).toEqual([{ t: "viewers", sessions: {} }]);
    relay.removeBrowser(b);
    expect(r2.take("viewers")).toEqual([{ t: "viewers", sessions: {} }]);
  });

  test("a runner that reconnects is told the viewers again", () => {
    const { relay, browser, runner } = setup();
    runner("one");
    const a = browser("a");
    relay.onBrowserMessage(a, { t: "presence", deviceId: "dev-a", runnerId: "one", sessionId: "x:1" });
    const again = new FakeSocket("runner:one:2");
    hi(relay, again, runnerInfo("one"));
    expect(again.take()).toEqual([{ t: "welcome" }, { t: "viewers", sessions: { "x:1": ["dev-a"] } }]);
  });

  test("browsers get the public key, runners the pair", () => {
    const push = { publicKey: "PUB", privateKey: "PRIV", subject: "mailto:x@y" };
    const relay = new Relay({ push });
    const b = new FakeSocket("b");
    relay.addBrowser(b, { name: "b", email: "b@x" }, 1);
    expect(b.take("hello")[0].push).toEqual({ publicKey: "PUB" });
    const r = new FakeSocket("r");
    hi(relay, r, runnerInfo("one"));
    expect(r.take("welcome")[0].push).toEqual(push);
  });
});

describe("runner ids per token", () => {
  test("the owner token may claim any id outside other tokens' namespaces", () => {
    for (const id of ["instance-x", "runner", "runner:x", "3f2a-uuid", "tether-dev"]) expect(runnerIdAllowed("runner", id)).toBe(true);
    for (const id of ["runner-alice", "runner-alice:x", "runner-"]) expect(runnerIdAllowed("runner", id)).toBe(false);
    // a token name with ":" would overlap another token's namespace
    expect(runnerIdAllowed("runner-a:b", "runner-a:b")).toBe(false);
    expect(runnerIdAllowed("runner-a", "runner-a:b")).toBe(true);
  });

  test("a runner-<name> token may claim only its own name and name:*", () => {
    for (const id of ["runner-alice", "runner-alice:x", "runner-alice:"]) expect(runnerIdAllowed("runner-alice", id)).toBe(true);
    for (const id of ["instance-x", "runner", "runner:x", "runner-alicex", "runner-al", "runner-bob", ""]) expect(runnerIdAllowed("runner-alice", id)).toBe(false);
    expect(runnerIdAllowed("", "anything")).toBe(false);
  });

  test("a refused hello is closed with a reason naming the allowed ids, and logged", () => {
    const logs: string[] = [];
    const relay = new Relay({ log: (l) => logs.push(l) });
    const r = new FakeSocket("r");
    hi(relay, r, runnerInfo("instance-x"), "runner-alice");
    expect(r.closed?.code).toBe(4004);
    expect(r.closed?.reason).toBe(`runner id "instance-x" isn't allowed for token "runner-alice": use "runner-alice" or "runner-alice:<anything>"`);
    expect(r.sent).toEqual([]);
    expect(relay.runnerList()).toEqual([]);
    expect(logs.some((l) => l.includes('refused runner "instance-x"'))).toBe(true);
  });

  test("the close reason always fits a WebSocket close frame", () => {
    const name = `runner-${"é".repeat(200)}`;
    const reason = runnerIdRefusal(name, "x".repeat(500));
    expect(new TextEncoder().encode(reason).length).toBeLessThanOrEqual(123);
    expect(reason).not.toContain("\uFFFD");
    expect(runnerIdRefusal("runner", "runner-alice")).toContain(`any id not starting with "runner-"`);
  });

  test("a socket that never registered a token can't claim anything", () => {
    const relay = new Relay();
    const r = new FakeSocket("r");
    relay.onRunnerMessage(r, { t: "hello", runner: runnerInfo("box") });
    expect(r.closed?.code).toBe(4004);
    expect(relay.runnerList()).toEqual([]);
  });

  test("a refused hello doesn't disturb the runner that holds the id", () => {
    const { relay, browser, rpc } = setup();
    const a = browser("a");
    const owner = new FakeSocket("owner");
    hi(relay, owner, runnerInfo("instance-x"));
    rpc(a, "1", "instance-x", "subscribe", { sessionId: "claude:s" });
    rpc(a, "2", "instance-x", "setCredential", { source: "anthropic", key: "k" });
    owner.take();
    a.take();
    const thief = new FakeSocket("thief");
    hi(relay, thief, runnerInfo("instance-x"), "runner-alice");
    expect(thief.closed?.code).toBe(4004);
    expect(owner.closed).toBeUndefined();
    expect(owner.take()).toEqual([]);
    expect(a.take()).toEqual([]);
    expect(relay.stats()).toMatchObject({ runners: 1, subscriptions: 1, pending: 2 });
    // Its rpcs still reach the owner's runner, and nothing from the refused socket counts.
    relay.onRunnerMessage(thief, { t: "event", sessionId: "claude:s", seq: 1, event: { type: "state", state: {} } as any });
    expect(a.take()).toEqual([]);
    rpc(a, "3", "instance-x", "ping");
    expect(owner.take("rpc")).toHaveLength(1);
  });

  test("a repeated hello on the same connection is checked again", () => {
    const { relay, browser } = setup();
    const a = browser("a");
    const r = new FakeSocket("alice");
    hi(relay, r, runnerInfo("runner-alice"), "runner-alice");
    expect(r.take()[0]).toEqual({ t: "welcome" });
    expect(relay.runnerList().map((x) => x.id)).toEqual(["runner-alice"]);
    a.take();
    // No addRunner this time: the token recorded at connect is the one checked.
    relay.onRunnerMessage(r, { t: "hello", runner: runnerInfo("instance-x") });
    expect(r.closed?.code).toBe(4004);
    expect(relay.runnerList()).toEqual([]);
    expect(a.take("runners")[0].runners).toEqual([]);
  });

  test("the same token's newer connection still replaces the old one", () => {
    const relay = new Relay();
    const old = new FakeSocket("old");
    hi(relay, old, runnerInfo("runner-alice:laptop"), "runner-alice");
    const fresh = new FakeSocket("fresh");
    hi(relay, fresh, runnerInfo("runner-alice:laptop"), "runner-alice");
    expect(old.closed?.code).toBe(4000);
    expect(fresh.closed).toBeUndefined();
  });
});

describe("browser sign-in renewal", () => {
  function renewSetup() {
    let now = 1_000_000;
    const logs: string[] = [];
    const relay = new Relay({ now: () => now, reauthMs: 300_000, log: (l) => logs.push(l) });
    const b = new FakeSocket("b");
    relay.addBrowser(b, { name: "b", email: "b@x" }, 1, "user-1");
    b.take();
    return { relay, b, logs, tick: (ms: number) => (now += ms), renew: (ticket: string) => relay.onBrowserMessage(b, { t: "renew", ticket }) };
  }

  test("a socket that never renews is closed after the TTL", () => {
    const { relay, b, tick } = renewSetup();
    tick(299_999);
    relay.sweep();
    expect(b.closed).toBeUndefined();
    tick(1);
    relay.sweep();
    expect(b.closed).toEqual({ code: 4005, reason: "sign-in needs refreshing" });
    expect(relay.stats().browsers).toBe(0);
  });

  test("renewing every 2 minutes keeps it open; a valid ticket extends to the ticket's expiry", () => {
    const { relay, b, tick, renew } = renewSetup();
    for (let i = 0; i < 10; i++) {
      tick(120_000);
      renew(relay.tickets.issue("user-1"));
      relay.sweep();
      expect(b.closed).toBeUndefined();
    }
    tick(299_000);
    relay.sweep();
    expect(b.closed).toBeUndefined();
    tick(1_000);
    relay.sweep();
    expect(b.closed?.code).toBe(4005);
  });

  test("expired, tampered, foreign and other-person tickets don't extend it", () => {
    const { relay, b, tick, renew, logs } = renewSetup();
    const stale = relay.tickets.issue("user-1");
    tick(200_000);
    const fresh = relay.tickets.issue("user-1");
    tick(100_000 - 1);
    // stale expired just now (issued 300 s ago) and must not count
    tick(1);
    const [p, sig] = fresh.split(".");
    const forged = Buffer.from(JSON.stringify({ sub: "user-1", exp: 9e15 })).toString("base64url");
    const other = new Tickets({ now: () => 1_300_000 }).issue("user-1");
    for (const t of [stale, `${forged}.${sig}`, `${p}.${sig!.slice(0, -2)}AA`, other, relay.tickets.issue("user-2")]) {
      // renew is checked before the deadline is: keep the socket alive to test each one
      (relay as any).browsers.get(b).deadline = 1_300_001;
      renew(t);
      expect((relay as any).browsers.get(b).deadline).toBe(1_300_001);
    }
    expect(logs.filter((l) => l.includes("renew"))).toHaveLength(1);
    expect(logs.join("\n")).not.toContain(p!);
  });

  test("past the deadline, before the sweep: a valid renew is accepted, anything else closes", () => {
    const { relay, b, tick, renew } = renewSetup();
    tick(300_000);
    renew(relay.tickets.issue("user-1"));
    expect(b.closed).toBeUndefined();
    tick(299_999);
    relay.sweep();
    expect(b.closed).toBeUndefined();

    const late = renewSetup();
    late.tick(300_000);
    late.relay.onBrowserMessage(late.b, { t: "ping" });
    expect(late.b.closed?.code).toBe(4005);
    expect(late.b.take()).toEqual([]);

    const bad = renewSetup();
    bad.tick(300_000);
    bad.renew(bad.relay.tickets.issue("user-2"));
    expect(bad.b.closed?.code).toBe(4005);
  });

  test("tickets must be canonical base64url", () => {
    const tickets = new Tickets({ now: () => 0 });
    const t = tickets.issue("user-1");
    expect(tickets.verify(t)).toMatchObject({ sub: "user-1" });
    const [p, sig] = t.split(".") as [string, string];
    for (const bad of [`${p}.${sig}=`, `${p}=.${sig}`, `${p}.${sig}.`, `${p}.+${sig.slice(1)}`, `${p} .${sig}`]) expect(tickets.verify(bad)).toBeNull();
    // a different last character that decodes to the same bytes (unused trailing bits)
    const last = sig.at(-1)!;
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const twin = [...alphabet].find((c) => c !== last && Buffer.from(sig.slice(0, -1) + c, "base64url").equals(Buffer.from(sig, "base64url")));
    if (twin) expect(tickets.verify(`${p}.${sig.slice(0, -1)}${twin}`)).toBeNull();
  });

  test("a browser added without a viewer id can never renew", () => {
    let now = 0;
    const relay = new Relay({ now: () => now, reauthMs: 1000 });
    const b = new FakeSocket("b");
    relay.addBrowser(b, { name: "b", email: "" }, 1);
    relay.onBrowserMessage(b, { t: "renew", ticket: relay.tickets.issue("") });
    now = 1000;
    relay.sweep();
    expect(b.closed?.code).toBe(4005);
  });
});

describe("logs", () => {
  test("runner-supplied id, name and hostname are quoted, escaped and capped", () => {
    const logs: string[] = [];
    const relay = new Relay({ log: (l) => logs.push(l) });
    const evil = { ...runnerInfo("box"), id: "box\nrunner fake connected\u0085", name: "n\u001b[31m", hostname: "h".repeat(500), harnesses: [{ id: "claude" as const, version: "1\r2" }] };
    hi(relay, new FakeSocket("a"), evil);
    hi(relay, new FakeSocket("b"), { ...evil, id: "runner-x\n" });
    hi(relay, new FakeSocket("c"), { ...evil, protocol: 99 });
    expect(logs).toHaveLength(3);
    for (const l of logs) {
      expect(l).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
      expect(l.length).toBeLessThan(400);
    }
    expect(logs[0]).toContain('runner "box\\nrunner fake connected\\u0085"');
  });
});
