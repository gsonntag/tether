import { afterEach, expect, test } from "bun:test";
import type { Server, ServerWebSocket } from "bun";
import { backoffDelay, Connection } from "./connection";
import { PROTOCOL_VERSION } from "../../../shared/protocol";

test("backoff doubles from 1 s to a 30 s cap, with jitter", () => {
  const mid = () => 0.5;
  expect([0, 1, 2, 3, 4, 5, 6, 40].map((a) => backoffDelay(a, mid))).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  expect(backoffDelay(0, () => 0)).toBe(800);
  expect(backoffDelay(0, () => 1)).toBe(1200);
});

/** A stand-in for the relay: records what the runner sends and lets the test talk back. */
function fakeServer(port = 0, opts: { pong?: boolean; token?: string; welcome?: boolean; onHello?: (ws: ServerWebSocket<unknown>) => void } = {}) {
  const frames: any[] = [];
  const socks: ServerWebSocket<unknown>[] = [];
  const server: Server<unknown> = Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      if (req.headers.get("authorization") !== `Bearer ${opts.token ?? "tok"}`) return new Response("no", { status: 403 });
      if (srv.upgrade(req, { data: undefined })) return;
      return new Response("expected a WebSocket", { status: 426 });
    },
    websocket: {
      open: (ws) => void socks.push(ws),
      message(ws, raw) {
        const m = JSON.parse(String(raw));
        frames.push(m);
        if (m.t === "ping" && opts.pong !== false) ws.send(JSON.stringify({ t: "pong" }));
        if (m.t === "hello") {
          if (opts.welcome !== false) ws.send(JSON.stringify({ t: "welcome" }));
          opts.onHello?.(ws);
        }
      },
    },
  });
  return { server, frames, socks, url: `http://127.0.0.1:${server.port}` };
}

async function until(cond: () => boolean, ms = 5000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await Bun.sleep(10);
  }
}

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((f) => f()));

function runner(url: string, extra: Partial<ConstructorParameters<typeof Connection>[0]> = {}) {
  const logs: string[] = [];
  const states: boolean[] = [];
  const conn = new Connection({
    url,
    token: "tok",
    hello: async () => ({ id: "box", name: "box", hostname: "box.local", version: "0", protocol: PROTOCOL_VERSION, harnesses: [] }),
    onRpc: async (op) => (op === "ping" ? { ok: true, data: "pong" } : { ok: false, error: "unknown" }),
    onState: (c) => states.push(c),
    log: (l) => logs.push(l),
    ...extra,
  });
  cleanup.push(() => conn.stop());
  return { conn, logs, states };
}

test("says hello with the token and answers rpcs", async () => {
  const s = fakeServer();
  cleanup.push(() => s.server.stop(true));
  const { conn, states } = runner(s.url);
  conn.start();
  await until(() => s.frames.length > 0);
  expect(s.frames[0]).toMatchObject({ t: "hello", runner: { id: "box" } });
  expect(conn.connected).toBe(true);
  expect(states).toEqual([true]);
  s.socks[0]!.send(JSON.stringify({ t: "rpc", id: "s1", op: "ping", args: {} }));
  await until(() => s.frames.some((m) => m.t === "result"));
  expect(s.frames.find((m) => m.t === "result")).toEqual({ t: "result", id: "s1", ok: true, data: "pong" });
});

test("reconnects after the server restarts on the same port", async () => {
  let s = fakeServer();
  const port = s.server.port!;
  const { conn, states } = runner(s.url);
  conn.start();
  await until(() => conn.connected);
  s.server.stop(true);
  await until(() => !conn.connected);
  s = fakeServer(port);
  cleanup.push(() => s.server.stop(true));
  await until(() => conn.connected, 8000);
  expect(s.frames[0]).toMatchObject({ t: "hello" });
  expect(states).toEqual([true, false, true]);
}, 10_000);

test("an answer to an rpc from a dropped connection is never sent on the next one", async () => {
  let s = fakeServer();
  const port = s.server.port!;
  let release!: () => void;
  const slow = new Promise<void>((ok) => (release = ok));
  const { conn } = runner(s.url, { onRpc: async () => (await slow, { ok: true, data: "late" }) });
  conn.start();
  await until(() => conn.connected);
  s.socks[0]!.send(JSON.stringify({ t: "rpc", id: "s1", op: "ping", args: {} }));
  await Bun.sleep(50);
  s.server.stop(true);
  await until(() => !conn.connected);
  s = fakeServer(port);
  cleanup.push(() => s.server.stop(true));
  await until(() => conn.connected, 8000);
  release();
  await Bun.sleep(100);
  expect(s.frames.filter((m) => m.t === "result")).toEqual([]);
}, 10_000);

test("a silent server counts as gone", async () => {
  const s = fakeServer(0, { pong: false });
  cleanup.push(() => s.server.stop(true));
  const { conn, logs, states } = runner(s.url, { heartbeatMs: 30, silenceMs: 100 });
  conn.start();
  await until(() => states.length >= 2, 3000);
  expect(states.slice(0, 2)).toEqual([true, false]);
  expect(logs.some((l) => l.includes("no word from the server"))).toBe(true);
});

test("a refused token is reported as such", async () => {
  const s = fakeServer(0, { token: "other" });
  cleanup.push(() => s.server.stop(true));
  const { conn, logs } = runner(s.url);
  conn.start();
  await until(() => logs.some((l) => l.includes("refused TETHER_TOKEN (403)")));
  expect(conn.connected).toBe(false);
});

test("replaced by another runner with the same id: backs off long and says why", async () => {
  const s = fakeServer();
  cleanup.push(() => s.server.stop(true));
  const { conn, logs } = runner(s.url, { replacedBackoffMs: 400 });
  conn.start();
  await until(() => conn.connected);
  s.socks[0]!.close(4000, "replaced by a newer connection with the same runner id");
  await until(() => !conn.connected);
  await until(() => logs.some((l) => l.includes("another runner connected with this runner's id")));
  // Not the usual 1 s retry: nothing for a while, then it comes back.
  await Bun.sleep(250);
  expect(s.socks.length).toBe(1);
  await until(() => conn.connected && s.socks.length === 2, 2000);
});

test("a dial that never opens is abandoned and retried", async () => {
  // Accepts TCP but never answers the HTTP upgrade.
  let accepted = 0;
  const tcp = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open: () => void accepted++, data() {} } });
  cleanup.push(() => tcp.stop(true));
  const { conn, logs } = runner(`http://127.0.0.1:${tcp.port}`, { dialTimeoutMs: 150 });
  conn.start();
  await until(() => logs.some((l) => l.startsWith("no answer from")), 3000);
  await until(() => accepted >= 2, 4000);
});

test("unwatched sessions reach the handler", async () => {
  const s = fakeServer();
  cleanup.push(() => s.server.stop(true));
  const seen: string[][] = [];
  const { conn } = runner(s.url, { onUnwatched: (ids) => seen.push(ids) });
  conn.start();
  await until(() => conn.connected);
  s.socks[0]!.send(JSON.stringify({ t: "unwatched", sessionIds: ["claude:x"] }));
  await until(() => seen.length > 0);
  expect(seen).toEqual([["claude:x"]]);
});

test("refused for its protocol version: says so and backs off long", async () => {
  const s = fakeServer();
  cleanup.push(() => s.server.stop(true));
  const { conn, logs } = runner(s.url, { protocolBackoffMs: 400 });
  conn.start();
  await until(() => conn.connected);
  s.socks[0]!.close(4003, "protocol mismatch: the app speaks 2, the runner 1; update the runner");
  await until(() => logs.some((l) => l.includes("the server refused this runner: protocol mismatch")));
  await Bun.sleep(250);
  expect(s.socks.length).toBe(1);
  await until(() => s.socks.length === 2, 2000);
});

test("not connected until the server welcomes the hello", async () => {
  let accept!: () => void;
  const s = fakeServer(0, { welcome: false, onHello: (ws) => (accept = () => ws.send(JSON.stringify({ t: "welcome" }))) });
  cleanup.push(() => s.server.stop(true));
  const { conn, logs, states } = runner(s.url);
  conn.start();
  await until(() => s.frames.some((m) => m.t === "hello"));
  await Bun.sleep(50);
  expect(conn.connected).toBe(false);
  expect(states).toEqual([]);
  expect(logs.some((l) => l.startsWith("connected"))).toBe(false);
  accept();
  await until(() => conn.connected);
  expect(logs.some((l) => l.startsWith("connected to") && l.includes("box (box)"))).toBe(true);
});

test("a hello that is refused every time backs off instead of retrying every second", async () => {
  // Accepts the socket, then closes it on hello without a welcome.
  const s = fakeServer(0, { welcome: false, onHello: (ws) => ws.close(1008, "no") });
  cleanup.push(() => s.server.stop(true));
  const { conn, logs } = runner(s.url);
  conn.start();
  await until(() => logs.filter((l) => l.startsWith("retrying in")).length >= 3, 9000);
  const delays = logs.filter((l) => l.startsWith("retrying in")).map((l) => parseFloat(l.slice(12)));
  expect(delays[2]!).toBeGreaterThan(delays[0]! * 2);
}, 10_000);

test("an answer over the frame limit goes out as an error; the connection survives", async () => {
  const s = fakeServer();
  cleanup.push(() => s.server.stop(true));
  const { conn, logs } = runner(s.url, { onRpc: async () => ({ ok: true, data: "x".repeat(17 * 1024 * 1024) }) });
  conn.start();
  await until(() => conn.connected);
  s.socks[0]!.send(JSON.stringify({ t: "rpc", id: "s1", op: "ping", args: {} }));
  await until(() => s.frames.some((m) => m.t === "result"));
  expect(s.frames.find((m) => m.t === "result")).toEqual({ t: "result", id: "s1", ok: false, error: "The answer was too large to send." });
  expect(logs.some((l) => l.includes("too large to send"))).toBe(true);
  expect(conn.connected).toBe(true);
});

test("events are capped on the way out, and one still too big becomes resync", async () => {
  const s = fakeServer();
  cleanup.push(() => s.server.stop(true));
  const { conn } = runner(s.url);
  conn.start();
  await until(() => conn.connected);
  const huge = "h".repeat(20 * 1024 * 1024);
  conn.send({ t: "event", sessionId: "claude:1", seq: 1, event: { type: "msg", isNew: true, msg: { id: "m", role: "user", ts: 0, parts: [{ type: "text", text: huge }] } } });
  // A field no cap knows about (summary titles are small by contract) trips the last-resort guard.
  conn.send({ t: "event", sessionId: "claude:1", seq: 2, event: { type: "state", state: { error: huge } } });
  await until(() => s.frames.filter((m) => m.t === "event").length === 2);
  const [capped, guarded] = s.frames.filter((m) => m.t === "event");
  expect(capped.event.msg.parts[0].truncated).toBe(huge.length);
  expect(JSON.stringify(capped).length).toBeLessThan(100 * 1024);
  expect(guarded).toEqual({ t: "event", sessionId: "claude:1", seq: 2, event: { type: "resync" } });
  expect(conn.connected).toBe(true);
});
