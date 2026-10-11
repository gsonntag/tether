// The MCP OAuth callback end to end: the real server (index.ts, dev mode, on a free loopback
// port) relays the authorization server's answer to the runner the state names (askRunner), over a
// fake runner socket, and the tab gets a page saying how it went.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";

const TOKEN = "relay-test-token";
let proc: Subprocess<"ignore", "pipe", "pipe">;
let base = "";

beforeAll(async () => {
  // Dev mode (no FOLIATION_*): browsers are the owner, runners present TETHER_DEV_RUNNER_TOKEN.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(FOLIATION_|TETHER_URL|TETHER_TOKEN)/.test(k)) env[k] = v;
  proc = Bun.spawn([process.execPath, new URL("./index.ts", import.meta.url).pathname], {
    env: { ...env, PORT: "0", TETHER_DEV_RUNNER_TOKEN: TOKEN },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = proc.stdout.getReader();
  let out = "";
  const end = Date.now() + 10_000;
  while (!/on [\d.]+:(\d+)/.test(out)) {
    if (Date.now() > end) throw new Error(`server didn't start: ${out}`);
    const { value, done } = await reader.read();
    if (done) throw new Error(`server exited: ${out}${await new Response(proc.stderr).text()}`);
    out += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  base = `http://127.0.0.1:${out.match(/on [\d.]+:(\d+)/)![1]}`;
});

afterAll(() => proc?.kill());

const stateFor = (runnerId: string) => `${Buffer.from(runnerId).toString("base64url")}.r4nd0m`;

/** A runner on the relay: answers each rpc with `answer(op, args)`; `asked` records them. */
async function fakeRunner(id: string, answer: (op: string, args: any) => { ok: boolean; data?: unknown; error?: string } | undefined) {
  const asked: { op: string; args: any }[] = [];
  const ws = new WebSocket(`${base.replace("http", "ws")}/api/runner`, { headers: { Authorization: `Bearer ${TOKEN}` } } as any);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("runner socket failed"));
  });
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    if (m.t !== "rpc") return;
    asked.push({ op: m.op, args: m.args });
    const a = answer(m.op, m.args);
    if (a) ws.send(JSON.stringify({ t: "result", id: m.id, ...a }));
  };
  ws.send(JSON.stringify({ t: "hello", runner: { id, hostname: "test", version: "0", harnesses: [] } }));
  // The hello is handled before any later request reaches the server's fetch handler; give it a beat.
  await Bun.sleep(100);
  return { ws, asked };
}

const callback = (q: Record<string, string>) => fetch(`${base}/api/mcp-oauth/callback?${new URLSearchParams(q)}`);

describe("MCP OAuth callback relay", () => {
  test("the code and state go to the runner the state names; the page says it connected", async () => {
    const r = await fakeRunner("runner-ok", (op) => (op === "finishMcpAuth" ? { ok: true, data: { id: "mcp_1", name: "Linear" } } : undefined));
    const state = stateFor("runner-ok");
    const res = await callback({ state, code: "c0de", iss: "https://auth.example.com" });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Connected to Linear");
    expect(html).toContain('"mcp_1"'); // the BroadcastChannel message for the app's tabs
    expect(r.asked).toEqual([{ op: "finishMcpAuth", args: { state, code: "c0de", iss: "https://auth.example.com" } }]);
    r.ws.close();
  });

  test("an authorization server's error is relayed, and the runner's answer is shown", async () => {
    const r = await fakeRunner("runner-err", () => ({ ok: false, error: "Sign-in was refused: access_denied" }));
    const res = await callback({ state: stateFor("runner-err"), error: "access_denied", error_description: "The user said no" });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Sign-in was refused: access_denied");
    expect(r.asked[0]!.args).toMatchObject({ error: "access_denied", errorDescription: "The user said no" });
    r.ws.close();
  });

  test("no valid state, or its runner offline: nothing is relayed", async () => {
    const r = await fakeRunner("runner-idle", () => ({ ok: true, data: { id: "x", name: "x" } }));
    let res = await callback({ code: "c" });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("no valid state");
    res = await callback({ state: stateFor("runner-gone"), code: "c" });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Its runner is offline");
    expect(r.asked).toEqual([]);
    r.ws.close();
  });

  test("a runner that disconnected is offline for the next callback", async () => {
    const r = await fakeRunner("runner-bye", () => ({ ok: true, data: { id: "x", name: "x" } }));
    r.ws.close();
    await Bun.sleep(100);
    const res = await callback({ state: stateFor("runner-bye"), code: "c" });
    expect(await res.text()).toContain("Its runner is offline");
  });
});
