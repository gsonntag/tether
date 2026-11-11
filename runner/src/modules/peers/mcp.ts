// Tether's MCP server for one agent (SPEC §9a), run by the harness over stdio with `bun`. It lists
// the peer tools and passes each call to the runner's peers socket, with this session's identity
// from its environment (TETHER_PEERS_*). The harness may outlive the runner (Codex's daemon), so a
// runner that's away is an error for that call, never a crash.

import { TOOL_DEFS } from "./tools";

const SOCKET = process.env.TETHER_PEERS_SOCKET ?? "";
const ID = process.env.TETHER_PEERS_ID ?? "";
const TOKEN = process.env.TETHER_PEERS_TOKEN ?? "";

const write = (m: unknown) => process.stdout.write(JSON.stringify(m) + "\n");
const reply = (id: unknown, result: unknown) => write({ jsonrpc: "2.0", id, result });
const text = (t: string, isError = false) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

/** Calls in flight, by request id: a cancelled call stops waiting. */
const calls = new Map<unknown, AbortController>();

async function call(id: unknown, params: any) {
  const abort = new AbortController();
  calls.set(id, abort);
  try {
    const res = await fetch("http://tether/call", {
      method: "POST",
      unix: SOCKET,
      signal: abort.signal,
      // An ask waits for its answer: as long as the harness lets the call run.
      timeout: false,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: ID, token: TOKEN, tool: params?.name, args: params?.arguments ?? {}, meta: params?._meta ?? {} }),
    } as RequestInit);
    const r = (await res.json()) as { text?: string; isError?: boolean };
    reply(id, text(r.text ?? "", !!r.isError));
  } catch (e) {
    if (abort.signal.aborted) return;
    reply(id, text(`Tether's runner can't be reached right now (it may be restarting), so nothing was sent. Try again in a minute. (${(e as Error)?.message ?? e})`, true));
  } finally {
    calls.delete(id);
  }
}

function handle(m: any) {
  switch (m?.method) {
    case "initialize":
      return reply(m.id, { protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "tether", version: "1.0.0" } });
    case "tools/list":
      return reply(m.id, { tools: TOOL_DEFS });
    case "tools/call":
      return void call(m.id, m.params);
    case "notifications/cancelled":
      return calls.get(m.params?.requestId)?.abort();
    case "ping":
      return reply(m.id, {});
    default:
      if (m?.id !== undefined && m?.method) write({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `Unknown method ${m.method}` } });
  }
}

let buf = "";
process.stdin.on("data", (d) => {
  buf += d.toString();
  let i: number;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      handle(JSON.parse(line));
    } catch {}
  }
});
process.stdin.on("end", () => process.exit(0));
