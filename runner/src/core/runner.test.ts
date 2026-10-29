import { afterEach, expect, test } from "bun:test";
import type { Server } from "bun";
import { createRunner } from "./runner";

const stops: (() => void)[] = [];
afterEach(() => stops.splice(0).forEach((f) => f()));

async function until(cond: () => boolean, ms = 8000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await Bun.sleep(10);
  }
}

function server(port = 0): Server<unknown> {
  const s = Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch: (req, srv) => (srv.upgrade(req, { data: undefined }) ? undefined : new Response("no", { status: 400 })),
    websocket: {
      message(ws, raw) {
        const m = JSON.parse(String(raw));
        if (m.t === "hello") ws.send(JSON.stringify({ t: "welcome" }));
      },
    },
  });
  return s;
}

test("the core hears about connects and disconnects on its bus", async () => {
  let s = server();
  const port = s.port!;
  const r = createRunner({ url: `http://127.0.0.1:${port}`, token: "t", runnerId: "u1", name: "box", version: "0", detectHarnesses: async () => [], log: () => {}, prefsFile: "/nonexistent/tether-test/runner.json" });
  stops.push(() => r.stop());
  const seen: string[] = [];
  r.bus.on("connected", () => seen.push("connected"));
  r.bus.on("disconnected", () => seen.push("disconnected"));
  r.start();
  await until(() => seen.length === 1);
  s.stop(true);
  await until(() => seen.length === 2);
  s = server(port);
  stops.push(() => s.stop(true));
  await until(() => seen.length === 3);
  expect(seen).toEqual(["connected", "disconnected", "connected"]);
  expect(r.epoch).toMatch(/^[0-9a-f-]{36}$/);
}, 15_000);
