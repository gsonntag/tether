// The HTTP and WebSocket front of the server: authenticates browsers (owners only, same-origin)
// and runners (an app service token), then hands every parsed frame to the relay.

import type { Server, ServerWebSocket } from "bun";
import { PROTOCOL_VERSION } from "../../shared/protocol";
import { parseBrowserMessage, parseRunnerMessage } from "../../shared/wire";
import { DEV, isOwner, isRunner, viewerFrom, type Viewer } from "./identity";
import { Relay } from "./relay";

type Conn = { kind: "browser" | "runner"; viewer: Viewer };

export interface AppOptions {
  port: number;
  hostname: string;
  relay?: Relay;
  /** extra origins allowed to open the browser socket, e.g. a dev UI on another port */
  allowedOrigins?: string[];
  log?: (line: string) => void;
}

/** A send buffer this full means the other side can't keep up: Bun closes it (protocol.ts, slow sockets). */
const BACKPRESSURE_LIMIT = 8 * 1024 * 1024;

/**
 * A browser socket must come from a page on this app's own host: without the check, any site the
 * owner visits could open one with their cookies (cross-site WebSocket hijacking). A request with
 * no Origin isn't from a browser page, so it can't be that attack; it still needs an owner identity.
 */
export function originAllowed(req: Request, extra: string[] = []): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  // Foliation's edge keeps the public Host header; vite's dev proxy keeps the page's host too.
  if (host === req.headers.get("host")) return true;
  return extra.includes(origin);
}

export function startApp(opts: AppOptions): { server: Server<Conn>; relay: Relay } {
  const log = opts.log ?? ((l: string) => console.log(l));
  const relay = opts.relay ?? new Relay({ log });

  const guard = (what: string, fn: () => void) => {
    try {
      fn();
    } catch (e) {
      // One bad frame must never take the relay down: log it and carry on.
      log(`dropped a ${what} frame: ${(e as Error)?.stack ?? e}`);
    }
  };

  const server = Bun.serve<Conn>({
    port: opts.port,
    hostname: opts.hostname,
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
        if (!originAllowed(req, opts.allowedOrigins)) return new Response("cross-origin socket refused", { status: 403 });
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
      backpressureLimit: BACKPRESSURE_LIMIT,
      closeOnBackpressureLimit: true,
      maxPayloadLength: 16 * 1024 * 1024,
      open(ws) {
        if (ws.data.kind === "browser") guard("browser open", () => relay.addBrowser(ws, { name: ws.data.viewer.name, email: ws.data.viewer.email }, PROTOCOL_VERSION));
      },
      message(ws: ServerWebSocket<Conn>, raw) {
        if (ws.data.kind === "runner") {
          const m = parseRunnerMessage(raw);
          if (m) guard("runner", () => relay.onRunnerMessage(ws, m));
        } else {
          const m = parseBrowserMessage(raw);
          if (m) guard("browser", () => relay.onBrowserMessage(ws, m));
        }
      },
      close(ws) {
        guard("close", () => (ws.data.kind === "runner" ? relay.removeRunner(ws) : relay.removeBrowser(ws)));
      },
    },
  });
  return { server, relay };
}
