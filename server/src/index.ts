// Tether backend: a relay between browsers and runners. It keeps no transcript state: runners
// own sessions, so redeploying this app never interrupts an agent.

import type { ServerWebSocket } from "bun";
import type {
  BrowserToServer,
  RunnerInfo,
  RunnerToServer,
  ServerToBrowser,
  ServerToRunner,
} from "../../web/src/shared/protocol";
import { DEV, isOwner, isRunner, viewerFrom, type Viewer } from "./identity";

type Conn = { kind: "browser"; viewer: Viewer } | { kind: "runner"; viewer: Viewer; runnerId?: string };

const browsers = new Set<ServerWebSocket<Conn>>();
const runners = new Map<string, { ws: ServerWebSocket<Conn>; info: RunnerInfo }>();
/** server rpc id -> waiting browser */
const pending = new Map<string, { ws: ServerWebSocket<Conn>; id: string; timer: ReturnType<typeof setTimeout> }>();
let rpcSeq = 0;

const RPC_TIMEOUT_MS = 120_000;

function toBrowsers(m: ServerToBrowser) {
  const s = JSON.stringify(m);
  for (const b of browsers) b.send(s);
}

function runnerList(): RunnerInfo[] {
  return [...runners.values()].map((r) => r.info);
}

function onRunnerMessage(ws: ServerWebSocket<Conn>, m: RunnerToServer) {
  const conn = ws.data as Extract<Conn, { kind: "runner" }>;
  switch (m.t) {
    case "hello": {
      const id = m.runner.id;
      const prev = runners.get(id);
      if (prev && prev.ws !== ws) prev.ws.close(4000, "replaced by a newer connection");
      conn.runnerId = id;
      runners.set(id, { ws, info: { ...m.runner, connected: true } });
      console.log(`runner ${id} connected (${m.runner.hostname}, ${m.runner.harnesses.join(", ")})`);
      toBrowsers({ t: "runners", runners: runnerList() });
      break;
    }
    case "result": {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      clearTimeout(p.timer);
      p.ws.send(JSON.stringify({ t: "result", id: p.id, ok: m.ok, data: m.data, error: m.error } satisfies ServerToBrowser));
      break;
    }
    case "event":
      if (conn.runnerId) toBrowsers({ t: "event", runnerId: conn.runnerId, sessionId: m.sessionId, seq: m.seq, event: m.event });
      break;
    case "sessions":
      if (conn.runnerId) toBrowsers({ t: "sessions", runnerId: conn.runnerId, projectPath: m.projectPath, session: m.session });
      break;
  }
}

function onBrowserMessage(ws: ServerWebSocket<Conn>, m: BrowserToServer) {
  if (m.t === "ping") return ws.send(JSON.stringify({ t: "pong" } satisfies ServerToBrowser));
  if (m.t !== "rpc") return;
  const r = runners.get(m.runnerId);
  if (!r) return ws.send(JSON.stringify({ t: "result", id: m.id, ok: false, error: "Runner is offline." } satisfies ServerToBrowser));
  const sid = `s${++rpcSeq}`;
  const timer = setTimeout(() => {
    pending.delete(sid);
    ws.send(JSON.stringify({ t: "result", id: m.id, ok: false, error: "Runner did not answer in time." } satisfies ServerToBrowser));
  }, RPC_TIMEOUT_MS);
  pending.set(sid, { ws, id: m.id, timer });
  r.ws.send(JSON.stringify({ t: "rpc", id: sid, op: m.op, args: m.args } satisfies ServerToRunner));
}

const port = Number(process.env.PORT ?? 8787);

const server = Bun.serve<Conn>({
  port,
  hostname: process.env.PORT && !DEV ? "0.0.0.0" : "127.0.0.1",
  idleTimeout: 120,
  async fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/api/health") return Response.json({ ok: true });

    const viewer = await viewerFrom(req);
    if (url.pathname === "/api/me") {
      if (!viewer) return Response.json({ error: "unauthenticated" }, { status: 401 });
      return Response.json({ ...viewer, allowed: isOwner(viewer), dev: DEV });
    }
    if (url.pathname === "/api/ws") {
      if (!isOwner(viewer)) return new Response("owners only", { status: 403 });
      if (srv.upgrade(req, { data: { kind: "browser", viewer: viewer! } })) return;
      return new Response("expected a WebSocket", { status: 426 });
    }
    if (url.pathname === "/api/runner") {
      if (!isRunner(viewer)) return new Response("runner service token required", { status: 403 });
      if (srv.upgrade(req, { data: { kind: "runner", viewer: viewer! } })) return;
      return new Response("expected a WebSocket", { status: 426 });
    }
    return new Response("not found", { status: 404 });
  },
  websocket: {
    idleTimeout: 120,
    sendPings: true,
    open(ws) {
      if (ws.data.kind === "browser") {
        browsers.add(ws);
        ws.send(JSON.stringify({ t: "hello", user: { name: ws.data.viewer.name, email: ws.data.viewer.email } } satisfies ServerToBrowser));
        ws.send(JSON.stringify({ t: "runners", runners: runnerList() } satisfies ServerToBrowser));
      }
    },
    message(ws, raw) {
      let m: any;
      try {
        m = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (ws.data.kind === "runner") onRunnerMessage(ws, m);
      else onBrowserMessage(ws, m);
    },
    close(ws) {
      if (ws.data.kind === "browser") {
        browsers.delete(ws);
        for (const [sid, p] of pending) if (p.ws === ws) (clearTimeout(p.timer), pending.delete(sid));
        return;
      }
      const id = ws.data.runnerId;
      if (id && runners.get(id)?.ws === ws) {
        runners.delete(id);
        console.log(`runner ${id} disconnected`);
        toBrowsers({ t: "runners", runners: runnerList() });
      }
    },
  },
});

console.log(`Tether server on ${server.hostname}:${server.port}${DEV ? " (dev mode: no Foliation identity)" : ""}`);
