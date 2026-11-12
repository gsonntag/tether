// Several tenants on one app (tenancy.ts): alice and bob each have a runner, and neither may see,
// open, drive or watch the other's.

import { afterEach, describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION, type BrowserToServer, type RunnerInfo } from "../../shared/protocol";
import { startApp } from "./app";
import type { Viewer } from "./identity";
import { Relay, type Socket } from "./relay";
import { listedTenant, mayUseRunner, parseRunnerOwners } from "./tenancy";

class FakeSocket implements Socket {
  sent: any[] = [];
  closed?: { code?: number; reason?: string };
  send(data: string) {
    this.sent.push(JSON.parse(data));
    return 1;
  }
  close(code?: number, reason?: string) {
    this.closed = { code, reason };
  }
  take(t?: string) {
    const out = t ? this.sent.filter((m) => m.t === t) : this.sent;
    this.sent = [];
    return out;
  }
}

const OWNERS = '{"runner-alice":["Alice@Example.com"],"runner-bob":["bob@example.com","u-bob-2"],"runner":["ops@example.com"]}';
const info = (id: string): Omit<RunnerInfo, "connectedAt"> => ({ id, name: id, hostname: "h", version: "0", protocol: PROTOCOL_VERSION, harnesses: [], homeFolder: "/home/x/.tether-home" });

function world() {
  const relay = new Relay({ rpcTimeoutMs: 1000, owners: parseRunnerOwners(OWNERS) });
  const runner = (token: string, id = token) => {
    const s = new FakeSocket();
    relay.addRunner(s, token);
    relay.onRunnerMessage(s, { t: "hello", runner: info(id) });
    return s;
  };
  const browser = (id: string, email: string) => {
    const s = new FakeSocket();
    relay.addBrowser(s, { name: id, email }, PROTOCOL_VERSION, id);
    return s;
  };
  const rpc = (b: FakeSocket, id: string, runnerId: string, op: string, args: unknown = {}) => relay.onBrowserMessage(b, { t: "rpc", id, runnerId, op, args } as BrowserToServer);
  const aliceR = runner("runner-alice");
  const bobR = runner("runner-bob", "runner-bob:laptop");
  const alice = browser("u-alice", "alice@example.com");
  const bob = browser("u-bob", "BOB@example.com");
  const ops = browser("u-ops", "ops@example.com");
  const stranger = browser("u-x", "x@example.com");
  for (const s of [aliceR, bobR, alice, bob, ops, stranger]) s.take();
  return { relay, runner, browser, rpc, aliceR, bobR, alice, bob, ops, stranger };
}

describe("TETHER_RUNNER_OWNERS", () => {
  test("parses, ignores case, and fails closed on anything malformed", () => {
    expect(parseRunnerOwners(undefined)).toBeNull();
    expect(parseRunnerOwners("  ")).toBeNull();
    const o = parseRunnerOwners(OWNERS)!;
    expect(mayUseRunner(o, "runner-alice", { id: "u1", email: "ALICE@example.com" })).toBe(true);
    expect(mayUseRunner(o, "runner-alice", { id: "u1", email: "bob@example.com" })).toBe(false);
    expect(mayUseRunner(o, "runner-bob", { id: "u-bob-2", email: "" })).toBe(true);
    expect(mayUseRunner(o, "runner-carol", { id: "u1", email: "alice@example.com" })).toBe(false);
    expect(mayUseRunner(o, "runner-alice", { id: "", email: "" })).toBe(false);
    expect(mayUseRunner(null, "anything", { id: "", email: "" })).toBe(true);
    expect(listedTenant(o, { id: "u9", email: "bob@example.com" })).toBe(true);
    expect(listedTenant(o, { id: "u9", email: "eve@example.com" })).toBe(false);
    for (const bad of ["{", "[]", "{}", '{"alice":["a@x"]}', '{"runner-a":"a@x"}', '{"runner-a":[""]}', '{"runner-a":["anon:abc"]}', '{"runner-a":["svc:1"]}', '{"runner-a":[1]}'])
      expect(() => parseRunnerOwners(bad)).toThrow();
  });
});

describe("relay with several tenants", () => {
  test("each person's runner list holds only their own runners, also as runners come and go", () => {
    const { relay, runner, alice, bob, ops, stranger, browser } = world();
    const list = (s: FakeSocket) => s.take("runners").at(-1)?.runners.map((r: RunnerInfo) => r.id);
    const fresh = (id: string, email: string) => list(browser(id, email));
    expect(fresh("u-alice", "alice@example.com")).toEqual(["runner-alice"]);
    expect(fresh("u-bob", "bob@example.com")).toEqual(["runner-bob:laptop"]);
    expect(fresh("u-ops", "ops@example.com")).toEqual([]);
    expect(fresh("u-x", "x@example.com")).toEqual([]);
    runner("runner-alice", "runner-alice:desk");
    expect(list(alice)).toEqual(["runner-alice", "runner-alice:desk"]);
    expect(list(bob)).toEqual(["runner-bob:laptop"]);
    expect(list(ops)).toEqual([]);
    expect(list(stranger)).toEqual([]);
    runner("runner", "ops-box");
    expect(list(ops)).toEqual(["ops-box"]);
    expect(list(alice)).toEqual(["runner-alice", "runner-alice:desk"]);
    expect(relay.runnerList().length).toBe(4);
  });

  test("an rpc to someone else's runner is answered like an offline runner and never reaches it", () => {
    const { rpc, alice, bobR } = world();
    for (const op of ["listSessions", "subscribe", "send", "archive", "resolveLink", "openTerminal", "setCredential", "updateHarness", "peerSend"]) {
      rpc(alice, op, "runner-bob:laptop", op, { sessionId: "s1", code: "abc", text: "hi" });
      expect(alice.take("result")).toEqual([{ t: "result", id: op, ok: false, error: "That runner is offline." }]);
    }
    expect(bobR.take()).toEqual([]);
  });

  test("own runner: rpcs pass and the answer goes only to the asker", () => {
    const { relay, rpc, alice, bob, ops, aliceR } = world();
    rpc(alice, "1", "runner-alice", "listSessions");
    const [req] = aliceR.take("rpc");
    expect(req.op).toBe("listSessions");
    relay.onRunnerMessage(aliceR, { t: "result", id: req.id, ok: true, data: ["secret"] });
    expect(alice.take("result")).toEqual([{ t: "result", id: "1", ok: true, data: ["secret"] }]);
    expect(bob.take()).toEqual([]);
    expect(ops.take()).toEqual([]);
  });

  test("summaries, Home chats and session events from a runner reach only its owner's browsers", () => {
    const { relay, rpc, alice, bob, ops, stranger, aliceR, bobR } = world();
    relay.onRunnerMessage(aliceR, { t: "summary", summary: { seq: 1, full: true, sessions: [] } } as any);
    relay.onRunnerMessage(aliceR, { t: "homeChat", rev: 1, chats: [] } as any);
    expect(alice.take().map((m) => m.t)).toEqual(["summary", "homeChat"]);
    for (const s of [bob, ops, stranger]) expect(s.take()).toEqual([]);
    relay.onRunnerMessage(bobR, { t: "summary", summary: { seq: 1, full: true, sessions: [] } } as any);
    expect(bob.take().map((m) => m.t)).toEqual(["summary"]);
    expect(alice.take()).toEqual([]);
    // bob tries to subscribe to alice's session: refused, so alice's events never reach him
    rpc(bob, "s", "runner-alice", "subscribe", { sessionId: "a-session" });
    expect(bob.take("result")[0]).toMatchObject({ ok: false });
    expect(aliceR.take()).toEqual([]);
    rpc(alice, "s", "runner-alice", "subscribe", { sessionId: "a-session" });
    const [sub] = aliceR.take("rpc");
    relay.onRunnerMessage(aliceR, { t: "result", id: sub.id, ok: true, data: null });
    relay.onRunnerMessage(aliceR, { t: "event", sessionId: "a-session", seq: 1, event: { kind: "x" } } as any);
    expect(alice.take().map((m) => m.t)).toEqual(["result", "event"]);
    expect(bob.take()).toEqual([]);
  });

  test("presence on someone else's runner is ignored: that runner never learns of the device", () => {
    const { relay, alice, bob, aliceR, bobR } = world();
    relay.onBrowserMessage(bob, { t: "presence", deviceId: "bob-phone", runnerId: "runner-alice", sessionId: "a-session" });
    expect(aliceR.take()).toEqual([]);
    relay.onBrowserMessage(alice, { t: "presence", deviceId: "alice-phone", runnerId: "runner-alice", sessionId: "a-session" });
    expect(aliceR.take("viewers")).toEqual([{ t: "viewers", sessions: { "a-session": ["alice-phone"] } }]);
    expect(bobR.take()).toEqual([]);
  });

  test("a runner whose token nobody owns is refused at hello, and can't take over a listed runner's id", () => {
    const { runner, alice, aliceR } = world();
    const carol = runner("runner-carol");
    expect(carol.closed?.code).toBe(4004);
    expect(carol.closed?.reason).toContain("TETHER_RUNNER_OWNERS");
    // the owner token can't claim a runner-<name> id (runnerIds.ts), so alice's runner stays hers
    const squat = runner("runner", "runner-alice");
    expect(squat.closed?.code).toBe(4004);
    expect(aliceR.closed).toBeUndefined();
    expect(alice.take("runners")).toEqual([]);
  });

  test("terminal output never crosses: bob can't attach to alice's runner or send to her attach", () => {
    const { relay, rpc, alice, bob, aliceR } = world();
    rpc(alice, "t", "runner-alice", "openTerminal", { sessionId: "a" });
    const [open] = aliceR.take("rpc");
    const attachId = open.args.attachId;
    rpc(bob, "w", "runner-alice", "terminalInput", { attachId, data: "rm -rf ~\n" });
    expect(bob.take("result")[0]).toMatchObject({ ok: false });
    rpc(bob, "w2", "runner-bob:laptop", "terminalInput", { attachId, data: "x" });
    expect(bob.take("result")[0]).toMatchObject({ ok: false });
    expect(aliceR.take()).toEqual([]);
    relay.onRunnerMessage(aliceR, { t: "term", attachId, data: "c2VjcmV0" });
    expect(alice.take("term")).toHaveLength(1);
    expect(bob.take()).toEqual([]);
  });
});

describe("one tenant (no owner map): unchanged", () => {
  test("every owner sees every runner", () => {
    const relay = new Relay();
    const r = new FakeSocket();
    relay.addRunner(r, "runner-alice");
    relay.onRunnerMessage(r, { t: "hello", runner: info("runner-alice") });
    const b = new FakeSocket();
    relay.addBrowser(b, { name: "o", email: "o@x" }, PROTOCOL_VERSION, "u-o");
    expect(b.take("runners")[0].runners.map((x: RunnerInfo) => x.id)).toEqual(["runner-alice"]);
  });
});

// The front door: who may open the app at all.
const stops: (() => void)[] = [];
afterEach(() => stops.splice(0).forEach((f) => f()));
const people: Record<string, Viewer> = {
  owner: { id: "u-owner", email: "owner@example.com", name: "Operator", role: "owner", service: false, picture: "" },
  alice: { id: "u-alice", email: "alice@example.com", name: "Alice", role: "viewer", service: false, picture: "" },
  eve: { id: "u-eve", email: "eve@example.com", name: "Eve", role: "editor", service: false, picture: "" },
  anon: { id: "anon:abc", email: "", name: "", role: "viewer", service: false, picture: "" },
  svc: { id: "svc:9", email: "alice@example.com", name: "runner-alice", role: "editor", service: true, picture: "" },
};
const identify = async (req: Request) => people[req.headers.get("x-test-as") ?? ""] ?? null;

describe("front door with several tenants", () => {
  test("listed people may sign in with any role; unlisted non-owners, anonymous visitors and tokens may not", async () => {
    const { server, stop } = startApp({ port: 0, hostname: "127.0.0.1", log: () => {}, dev: false, identify, owners: parseRunnerOwners('{"runner-alice":["alice@example.com"]}') });
    stops.push(stop);
    const url = `http://127.0.0.1:${server.port}`;
    const status = async (who: string, path: string) => (await fetch(`${url}${path}`, { headers: { "X-Test-As": who } })).status;
    for (const path of ["/api/ws-ticket"]) {
      expect(await status("alice", path)).toBe(200);
      expect(await status("owner", path)).toBe(200);
      for (const who of ["eve", "anon", "svc"]) expect(await status(who, path)).toBe(403);
    }
    expect(await status("eve", "/api/ws")).toBe(403);
    expect(await status("anon", "/api/ws")).toBe(403);
    expect((await (await fetch(`${url}/api/me`, { headers: { "X-Test-As": "alice" } })).json()).allowed).toBe(true);
    expect((await (await fetch(`${url}/api/me`, { headers: { "X-Test-As": "eve" } })).json()).allowed).toBe(false);
  });

  test("without an owner map only app owners get in", async () => {
    const { server, stop } = startApp({ port: 0, hostname: "127.0.0.1", log: () => {}, dev: false, identify });
    stops.push(stop);
    const status = async (who: string) => (await fetch(`http://127.0.0.1:${server.port}/api/ws-ticket`, { headers: { "X-Test-As": who } })).status;
    expect(await status("owner")).toBe(200);
    expect(await status("alice")).toBe(403);
  });
});
