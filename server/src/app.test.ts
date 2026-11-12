// The server's front door over real sockets (dev mode: no FOLIATION_ISSUER in tests).

import { afterEach, describe, expect, test } from "bun:test";
import { loopbackHost, originAllowed, startApp } from "./app";
import { Relay } from "./relay";
import type { Viewer } from "./identity";
import { PROTOCOL_VERSION } from "../../shared/protocol";

const stops: (() => void)[] = [];
afterEach(() => stops.splice(0).forEach((f) => f()));

function app(relay?: Relay, more: Partial<Parameters<typeof startApp>[0]> = {}) {
  const logs: string[] = [];
  const { server, stop } = startApp({ port: 0, hostname: "127.0.0.1", relay, log: (l) => logs.push(l), ...more });
  stops.push(stop);
  return { base: `127.0.0.1:${server.port}`, logs };
}

function open(url: string, init?: object): Promise<{ ws: WebSocket; frames: any[]; closed: { code?: number; reason?: string } }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, init as any);
    const frames: any[] = [];
    const closed: { code?: number; reason?: string } = {};
    ws.onmessage = (e) => frames.push(JSON.parse(String(e.data)));
    ws.addEventListener("close", (e) => Object.assign(closed, { code: e.code, reason: e.reason }));
    ws.onopen = () => resolve({ ws, frames, closed });
    ws.onerror = () => reject(new Error("refused"));
    stops.push(() => ws.close());
  });
}

const until = async (cond: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await Bun.sleep(5);
  }
};

const hello = { t: "hello", runner: { id: "u1", name: "box", hostname: "box", version: "0", protocol: PROTOCOL_VERSION, harnesses: [] } };

test("a malformed result from the runner fails the browser's rpc at once", async () => {
  const { base } = app();
  const runner = await open(`ws://${base}/api/runner`, { headers: { Authorization: "Bearer dev" } });
  const browser = await open(`ws://${base}/api/ws`);
  runner.ws.send(JSON.stringify(hello));
  await until(() => browser.frames.some((m) => m.t === "runners" && m.runners.length === 1));
  browser.ws.send(JSON.stringify({ t: "rpc", id: "1", runnerId: "u1", op: "ping", args: {} }));
  await until(() => runner.frames.some((m) => m.t === "rpc"));
  const id = runner.frames.find((m) => m.t === "rpc").id;
  runner.ws.send(JSON.stringify({ t: "result", id }));
  await until(() => browser.frames.some((m) => m.t === "result"));
  expect(browser.frames.find((m) => m.t === "result")).toMatchObject({ id: "1", ok: false });
});

test("malformed runner and browser frames are dropped and the server keeps working", async () => {
  const { base } = app();
  const runner = await open(`ws://${base}/api/runner`, { headers: { Authorization: "Bearer dev" } });
  const browser = await open(`ws://${base}/api/ws`);
  const junk = [
    '{"t":"hello","runner":{"id":"x"}}',
    `{"t":"hello","runner":{"id":"x","hostname":"h","version":"0","protocol":${PROTOCOL_VERSION},"harnesses":[null,{"id":"claude"}]}}`,
    '{"t":"event","sessionId":"s","seq":"1","event":{}}',
    '{"t":"result"}',
    "not json",
    "[]",
    "null",
  ];
  for (const j of junk) runner.ws.send(j);
  for (const j of ['{"t":"rpc","id":"1","runnerId":"u1","op":"ping","args":"x"}', '{"t":"rpc"}', "{"]) browser.ws.send(j);
  runner.ws.send(JSON.stringify(hello));
  await until(() => browser.frames.some((m) => m.t === "runners" && m.runners.length === 1));
  expect(runner.frames).toContainEqual({ t: "welcome" });
  // A malformed rpc whose id parses is answered at once instead of timing out.
  browser.ws.send('{"t":"rpc","id":"bad1","runnerId":"u1","op":7}');
  await until(() => browser.frames.some((m) => m.t === "result" && m.id === "bad1"));
  expect(browser.frames.find((m) => m.id === "bad1")).toMatchObject({ ok: false, error: "Malformed request." });
  browser.ws.send(JSON.stringify({ t: "rpc", id: "1", runnerId: "u1", op: "ping", args: {} }));
  await until(() => runner.frames.some((m) => m.t === "rpc"));
  expect(runner.frames.find((m) => m.t === "rpc")).toMatchObject({ op: "ping" });
});

test("an exception inside the relay is logged and the frame dropped, not fatal", async () => {
  const secret = `fake-relay-error-${crypto.randomUUID()}`;
  class Throwing extends Relay {
    override onRunnerMessage(): void {
      throw new Error(`boom ${secret}`);
    }
  }
  const { base, logs } = app(new Throwing());
  const runner = await open(`ws://${base}/api/runner`, { headers: { Authorization: "Bearer dev" } });
  runner.ws.send(JSON.stringify(hello));
  await until(() => logs.some((l) => l.includes("dropped a runner frame")));
  expect(logs.join("\n")).not.toContain(secret);
  expect(logs.join("\n")).not.toContain("boom");
  const res = await fetch(`http://${base}/api/health`);
  expect(await res.json()).toEqual({ ok: true });
});

test("a browser socket from another site is refused; same host and no Origin are accepted", async () => {
  const { base } = app();
  await expect(open(`ws://${base}/api/ws`, { headers: { Origin: "https://evil.example" } })).rejects.toThrow();
  const res = await fetch(`http://${base}/api/ws`, { headers: { Origin: "https://evil.example", Upgrade: "websocket" } });
  expect(res.status).toBe(403);
  await open(`ws://${base}/api/ws`, { headers: { Origin: `http://${base}` } });
  await open(`ws://${base}/api/ws`);
});

test("origin rules", () => {
  const req = (origin: string | null, host = "tether.example") => new Request("http://x/api/ws", { headers: { host, ...(origin ? { origin } : {}) } });
  expect(originAllowed(req("https://tether.example"))).toBe(true);
  expect(originAllowed(req("https://tether.example.evil.com"))).toBe(false);
  expect(originAllowed(req("null"))).toBe(false);
  expect(originAllowed(req(null))).toBe(true);
  expect(originAllowed(req("http://127.0.0.1:5180"), ["http://127.0.0.1:5180"])).toBe(true);
});

test("a runner without the token is refused", async () => {
  const { base } = app();
  await expect(open(`ws://${base}/api/runner`, { headers: { Authorization: "Bearer nope" } })).rejects.toThrow();
});

test("production without FOLIATION_AUDIENCE refuses to start", async () => {
  const proc = Bun.spawn(["bun", "src/index.ts"], {
    cwd: `${import.meta.dir}/..`,
    env: { ...process.env, FOLIATION_ISSUER: "https://issuer.example", FOLIATION_AUDIENCE: "", PORT: "0" },
    stderr: "pipe",
    stdout: "pipe",
  });
  expect(await proc.exited).toBe(1);
  expect(await new Response(proc.stderr).text()).toContain("FOLIATION_AUDIENCE");
});

test("dev mode: a request addressed to any non-loopback host is refused (DNS rebinding)", async () => {
  const { base } = app();
  const port = base.split(":")[1];
  for (const host of ["evil.example", `evil.example:${port}`, "10.0.0.5", "127.0.0.1.evil.example", "localhost.evil.example"]) {
    const me = await fetch(`http://${base}/api/me`, { headers: { Host: host } });
    expect(me.status).toBe(403);
    await expect(open(`ws://${base}/api/ws`, { headers: { Host: host, Origin: `http://${host}` } })).rejects.toThrow();
  }
  for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`, "localhost"]) {
    expect((await fetch(`http://${base}/api/me`, { headers: { Host: host } })).status).toBe(200);
  }
  await open(`ws://${base}/api/ws`, { headers: { Host: `localhost:${port}`, Origin: `http://localhost:${port}` } });
  // The health check stays open (Foliation probes it).
  expect((await fetch(`http://${base}/api/health`, { headers: { Host: "evil.example" } })).status).toBe(200);
});

test("loopback host names", () => {
  const req = (host: string) => new Request("http://x/", { headers: { host } });
  expect(["localhost:5180", "127.0.0.1", "[::1]:8790"].map((h) => loopbackHost(req(h)))).toEqual([true, true, true]);
  expect(["evil.example", "127.0.0.2", "localhost.evil", ""].map((h) => loopbackHost(req(h)))).toEqual([false, false, false, false]);
});

// Production-shaped identities without the edge: X-Test-As picks who is calling.
const people: Record<string, Viewer> = {
  owner: { id: "u-owner", email: "o@x", name: "Owner", role: "owner", service: false, picture: "" },
  owner2: { id: "u-owner2", email: "p@x", name: "Other owner", role: "owner", service: false, picture: "" },
  guest: { id: "u-guest", email: "g@x", name: "Guest", role: "editor", service: false, picture: "" },
  runner: { id: "svc:1", email: "", name: "runner", role: "editor", service: true, picture: "" },
  alice: { id: "svc:2", email: "", name: "runner-alice", role: "editor", service: true, picture: "" },
};
const identify = async (req: Request) => people[req.headers.get("x-test-as") ?? ""] ?? null;
const as = (who: string, extra: Record<string, string> = {}) => ({ headers: { "X-Test-As": who, ...extra } });

describe("runner ids through the front door", () => {
  test("a runner-<name> token can't claim the owner's runner id, and is told what it may use", async () => {
    const { base, logs } = app(undefined, { dev: false, identify });
    const owner = await open(`ws://${base}/api/runner`, as("runner"));
    owner.ws.send(JSON.stringify({ ...hello, runner: { ...hello.runner, id: "instance-x" } }));
    await until(() => owner.frames.some((m) => m.t === "welcome"));
    const alice = await open(`ws://${base}/api/runner`, as("alice"));
    alice.ws.send(JSON.stringify({ ...hello, runner: { ...hello.runner, id: "instance-x" } }));
    await until(() => alice.closed.code !== undefined);
    expect(alice.closed).toEqual({ code: 4004, reason: `runner id "instance-x" isn't allowed for token "runner-alice": use "runner-alice" or "runner-alice:<anything>"` });
    expect(owner.closed.code).toBeUndefined();
    expect(logs.some((l) => l.includes("refused runner instance-x"))).toBe(true);
    const ok = await open(`ws://${base}/api/runner`, as("alice"));
    ok.ws.send(JSON.stringify({ ...hello, runner: { ...hello.runner, id: "runner-alice:laptop" } }));
    await until(() => ok.frames.some((m) => m.t === "welcome"));
  });

  test("dev mode: the dev runner token is the owner token", async () => {
    const { base } = app();
    const r = await open(`ws://${base}/api/runner`, { headers: { Authorization: "Bearer dev" } });
    r.ws.send(JSON.stringify({ ...hello, runner: { ...hello.runner, id: "runner-alice" } }));
    await until(() => r.closed.code !== undefined);
    expect(r.closed.code).toBe(4004);
  });
});

describe("/api/ws-ticket", () => {
  test("owners get a fresh, uncached ticket; nobody else does", async () => {
    const { base } = app(undefined, { dev: false, identify });
    const url = `http://${base}/api/ws-ticket`;
    const ok = await fetch(url, as("owner"));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect((await ok.json()).ticket).toMatch(/^[\w-]+\.[\w-]+$/);
    expect((await fetch(url)).status).toBe(401);
    for (const who of ["guest", "runner", "alice"]) expect((await fetch(url, as(who))).status).toBe(403);
    expect((await fetch(url, as("owner", { Origin: "https://evil.example" }))).status).toBe(403);
    expect((await fetch(url, as("owner", { Origin: `http://${base}` }))).status).toBe(200);
    expect((await fetch(url, { method: "POST", ...as("owner") })).status).toBe(405);
  });

  test("dev mode: the dev browser gets tickets, only on loopback", async () => {
    const { base } = app();
    expect((await fetch(`http://${base}/api/ws-ticket`)).status).toBe(200);
    expect((await fetch(`http://${base}/api/ws-ticket`, { headers: { Host: "evil.example" } })).status).toBe(403);
    expect((await fetch(`http://${base}/api/ws-ticket`, { headers: { Authorization: "Bearer dev" } })).status).toBe(403);
  });

  test("a browser socket that doesn't renew is closed; one that renews stays open", async () => {
    const relay = new Relay({ reauthMs: 300 });
    const { base } = app(relay, { dev: false, identify, sweepMs: 20 });
    const idle = await open(`ws://${base}/api/ws`, as("owner"));
    const kept = await open(`ws://${base}/api/ws`, as("owner"));
    const wrong = await open(`ws://${base}/api/ws`, as("owner2"));
    const ticket = async (who: string) => (await (await fetch(`http://${base}/api/ws-ticket`, as(who))).json()).ticket;
    kept.ws.send(JSON.stringify({ t: "renew", ticket: await ticket("owner") }));
    // another owner's ticket doesn't count for this socket
    wrong.ws.send(JSON.stringify({ t: "renew", ticket: await ticket("owner") }));
    await until(() => idle.closed.code !== undefined && wrong.closed.code !== undefined);
    expect(idle.closed).toEqual({ code: 4005, reason: "sign-in needs refreshing" });
    expect(wrong.closed.code).toBe(4005);
    await Bun.sleep(200);
    expect(kept.closed.code).toBeUndefined();
    kept.ws.send(JSON.stringify({ t: "ping" }));
    await until(() => kept.frames.some((m) => m.t === "pong"));
  });
});
