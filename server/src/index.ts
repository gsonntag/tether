// Tether server: the Foliation app's backend. It authenticates browsers (owners only) and runners
// (an app service token), then hands every frame to the relay.

import type { ServerWebSocket } from "bun";
import { PROTOCOL_VERSION } from "../../shared/protocol";
import { parseBrowserMessage, parseRunnerMessage } from "../../shared/wire";
import { DEV, isOwner, isRunner, viewerFrom, type Viewer } from "./identity";
import { Relay } from "./relay";

type Conn = { kind: "browser" | "runner"; viewer: Viewer };

const relay = new Relay({ log: (line) => console.log(line) });
const port = Number(process.env.PORT ?? 8790);

const server = Bun.serve<Conn>({
  port,
  // Dev mode treats every browser as the owner, so it never listens beyond loopback.
  hostname: process.env.PORT && !DEV ? "0.0.0.0" : "127.0.0.1",
  idleTimeout: 120,
  async fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/api/health") return Response.json({ ok: true });

    const viewer = await viewerFrom(req);
    if (url.pathname === "/api/me") {
      if (!viewer) return Response.json({ error: "unauthenticated" }, { status: 401 });
      return Response.json({ name: viewer.name, email: viewer.email, allowed: isOwner(viewer), dev: DEV });
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
      if (ws.data.kind === "browser") relay.addBrowser(ws, { name: ws.data.viewer.name, email: ws.data.viewer.email }, PROTOCOL_VERSION);
    },
    message(ws: ServerWebSocket<Conn>, raw) {
      if (ws.data.kind === "runner") {
        const m = parseRunnerMessage(raw);
        if (m) relay.onRunnerMessage(ws, m);
      } else {
        const m = parseBrowserMessage(raw);
        if (m) relay.onBrowserMessage(ws, m);
      }
    },
    close(ws) {
      if (ws.data.kind === "runner") relay.removeRunner(ws);
      else relay.removeBrowser(ws);
    },
  },
});

console.log(`Tether server on ${server.hostname}:${server.port}${DEV ? " (dev mode: no Foliation identity)" : ""}`);
