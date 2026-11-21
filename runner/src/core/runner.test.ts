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

test("setRunnerAccess keeps the share list in runner.json and says hello with it", async () => {
  const { mkdtempSync, readFileSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const file = join(mkdtempSync(join(tmpdir(), "tether-share-")), "runner.json");
  writeFileSync(file, JSON.stringify({ runnerId: "u3", name: "Box", sessions: {} }));
  const hellos: unknown[] = [];
  const s = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req, srv) => (srv.upgrade(req, { data: undefined }) ? undefined : new Response("no", { status: 400 })),
    websocket: {
      message(ws, raw) {
        const m = JSON.parse(String(raw));
        if (m.t === "hello") (hellos.push(m.runner.shared), ws.send(JSON.stringify({ t: "welcome" })));
      },
    },
  });
  stops.push(() => s.stop(true));
  const r = createRunner({ url: `http://127.0.0.1:${s.port}`, token: "t", runnerId: "u3", name: "Box", version: "0", detectHarnesses: async () => [], log: () => {}, prefsFile: file });
  stops.push(() => r.stop());
  r.start();
  await until(() => hellos.length === 1);
  expect(hellos[0]).toBeUndefined();
  const people = [{ email: " Ed@X.com ", access: "drive" }, { email: "ed@x.com", access: "view" }, { email: "nope" }, { email: "v@x.com", access: "admin" }];
  const want = [{ email: "ed@x.com", access: "drive" }, { email: "v@x.com", access: "view" }];
  expect(await r.ops.handle("setRunnerAccess", { people })).toEqual({ ok: true, data: { people: want } });
  await until(() => hellos.length === 2);
  expect(hellos[1]).toEqual(want);
  const saved = JSON.parse(readFileSync(file, "utf8"));
  expect(saved.sharedWith).toEqual(want);
  expect(saved.name).toBe("Box");
  expect(await r.ops.handle("setRunnerAccess", { people: [] })).toEqual({ ok: true, data: { people: [] } });
  expect(JSON.parse(readFileSync(file, "utf8")).sharedWith).toBeUndefined();
}, 15_000);

test("setRunnerName renames in runner.json and says hello again; blank goes back to the default", async () => {
  const { mkdtempSync, readFileSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const file = join(mkdtempSync(join(tmpdir(), "tether-rename-")), "runner.json");
  writeFileSync(file, JSON.stringify({ runnerId: "u2", sessions: {} }));
  const hellos: string[] = [];
  const pinning: unknown[] = [];
  const canText: unknown[] = [];
  const spawned: unknown[] = [];
  const s = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req, srv) => (srv.upgrade(req, { data: undefined }) ? undefined : new Response("no", { status: 400 })),
    websocket: {
      message(ws, raw) {
        const m = JSON.parse(String(raw));
        if (m.t === "hello") (hellos.push(m.runner.name), pinning.push(m.runner.pinning), canText.push(m.runner.canText), spawned.push(m.runner.spawnedFamily), ws.send(JSON.stringify({ t: "welcome" })));
      },
    },
  });
  stops.push(() => s.stop(true));
  const r = createRunner({ url: `http://127.0.0.1:${s.port}`, token: "t", runnerId: "u2", name: "Teal Quail", defaultName: "Teal Quail", version: "0", detectHarnesses: async () => [], log: () => {}, prefsFile: file });
  stops.push(() => r.stop());
  r.start();
  await until(() => hellos.length === 1);
  // it says it takes pinSession (the browser shows pin buttons only then)
  expect(pinning[0]).toBe(true);
  // and that it takes setCanText (the browser shows the "Session can text me" box only then)
  expect(canText[0]).toBe(true);
  // and spawnedFamily (sessions an agent started show under their starter)
  expect(spawned[0]).toBe(process.env.TETHER_PEERS === "0" ? undefined : true);
  expect(await r.ops.handle("setRunnerName", { name: "  Work\nbox  " })).toEqual({ ok: true, data: { name: "Work box" } });
  await until(() => hellos.length === 2);
  expect(hellos[1]).toBe("Work box");
  const saved = JSON.parse(readFileSync(file, "utf8"));
  expect(saved.name).toBe("Work box");
  expect(saved.runnerId).toBe("u2");
  expect(await r.ops.handle("setRunnerName", { name: "" })).toEqual({ ok: true, data: { name: "Teal Quail" } });
  expect(JSON.parse(readFileSync(file, "utf8")).name).toBeUndefined();
}, 15_000);

test("detectBuild refreshes build and re-sends hello when changed", async () => {
  const hellos: any[] = [];
  const s = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req, srv) => (srv.upgrade(req, { data: undefined }) ? undefined : new Response("no", { status: 400 })),
    websocket: {
      message(ws, raw) {
        const m = JSON.parse(String(raw));
        if (m.t === "hello") {
          hellos.push(m.runner);
          ws.send(JSON.stringify({ t: "welcome" }));
        }
      },
    },
  });
  stops.push(() => s.stop(true));
  let buildInfo = { commit: "1111111", date: "2026-11-21", branch: "main", dirty: false, behind: 0 };
  const r = createRunner({
    url: `http://127.0.0.1:${s.port}`,
    token: "t",
    runnerId: "u4",
    name: "Build Box",
    version: "0",
    build: buildInfo,
    detectBuild: async () => buildInfo,
    buildCheckMs: 20,
    detectHarnesses: async () => [],
    log: () => {},
    prefsFile: "/nonexistent/runner.json",
  });
  stops.push(() => r.stop());
  r.start();
  await until(() => hellos.length >= 1);
  expect(hellos[0].build).toEqual(buildInfo);

  // Change build and wait for periodic refresh:
  buildInfo = { commit: "1111111", date: "2026-11-21", branch: "main", dirty: false, behind: 2 };
  await until(() => hellos.some((h) => h.build?.behind === 2));
  expect(hellos.at(-1).build.behind).toBe(2);
}, 15_000);
