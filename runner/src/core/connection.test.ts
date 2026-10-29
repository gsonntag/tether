import { afterEach, expect, test } from "bun:test";
import type { Server, ServerWebSocket } from "bun";
import { backoffDelay, Connection } from "./connection";

test("backoff doubles from 1 s to a 30 s cap, with jitter", () => {
  const mid = () => 0.5;
  expect([0, 1, 2, 3, 4, 5, 6, 40].map((a) => backoffDelay(a, mid))).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  expect(backoffDelay(0, () => 0)).toBe(800);
  expect(backoffDelay(0, () => 1)).toBe(1200);
});

/** A stand-in for the relay: records what the runner sends and lets the test talk back. */
function fakeServer(port = 0, opts: { pong?: boolean; token?: string } = {}) {
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
    hello: async () => ({ id: "box", hostname: "box.local", version: "0", protocol: 1, harnesses: [] }),
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
