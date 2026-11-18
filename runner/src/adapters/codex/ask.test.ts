// The Codex side query against a scripted daemon connection: tools, MCP servers and AGENTS.md off;
// nothing starts after the deadline; a turn whose turn/start answers late is interrupted once its id
// is known; a connection that arrives late is closed.

import { expect, test } from "bun:test";
import type { CodexRpc } from "./rpc";
import { codexAsk } from "./ask";

test("a Codex side query on a key is refused before anything starts", async () => {
  await expect(codexAsk("/tmp", "hi", { credential: { source: "openai", revision: "r" } as never, system: "s", timeoutMs: 1000 })).rejects.toThrow("API key");
});

function fakeRpc(o: { turnStartMs?: number; answer?: string } = {}) {
  const calls: [string, any][] = [];
  const notify = new Set<(m: string, p: any) => void>();
  const rpc = {
    closed: false,
    calls,
    onNotify: (h: (m: string, p: any) => void) => (notify.add(h), () => notify.delete(h)),
    onClose: () => () => {},
    close() {
      rpc.closed = true;
    },
    async call(method: string, params: any) {
      calls.push([method, params]);
      if (method === "model/list") return { data: [{ id: "big", isDefault: true }, { id: "small-mini" }] };
      if (method === "config/read") return { config: { mcp_servers: { docs: { command: "x" } } } };
      if (method === "thread/start") return { thread: { id: "t1" }, modelProvider: "openai" };
      if (method === "account/read") return { account: { type: "chatgpt" } };
      if (method === "turn/start") {
        await Bun.sleep(o.turnStartMs ?? 0);
        if (o.answer !== undefined)
          setTimeout(() => {
            for (const h of notify) h("item/completed", { threadId: "t1", item: { type: "agentMessage", text: o.answer } });
            for (const h of notify) h("turn/completed", { threadId: "t1", turn: { status: "completed" } });
          }, 5);
        return { turn: { id: "u1" } };
      }
      return {};
    },
  };
  return rpc;
}
const methods = (r: ReturnType<typeof fakeRpc>) => r.calls.map((c) => c[0]);

test("answers on the smallest model, read-only, with tools, MCP servers and AGENTS.md off", async () => {
  const r = fakeRpc({ answer: "Add README" });
  expect(await codexAsk("/repo", "p", { system: "s", timeoutMs: 2000 }, async () => r as unknown as CodexRpc)).toBe("Add README");
  const start = r.calls.find((c) => c[0] === "thread/start")![1];
  expect(start).toMatchObject({ ephemeral: true, model: "small-mini", sandbox: "read-only", approvalPolicy: "never" });
  expect(start.config).toMatchObject({ "mcp_servers.docs.enabled": false, project_doc_max_bytes: 0, "features.shell_tool": false });
  expect(methods(r)).not.toContain("turn/interrupt");
  expect(r.closed).toBe(true);
});

test("turn/start still on its way at the deadline: rejected then, interrupted once its id arrives", async () => {
  const r = fakeRpc({ turnStartMs: 300 });
  const t = Date.now();
  await expect(codexAsk("/repo", "p", { system: "s", timeoutMs: 100 }, async () => r as unknown as CodexRpc)).rejects.toThrow("in time");
  expect(Date.now() - t).toBeLessThan(250);
  await Bun.sleep(400);
  expect(r.calls.find((c) => c[0] === "turn/interrupt")?.[1]).toEqual({ threadId: "t1", turnId: "u1" });
  expect(r.closed).toBe(true);
});

test("a connection that arrives after the deadline is closed, and nothing starts on it", async () => {
  const r = fakeRpc();
  await expect(codexAsk("/repo", "p", { system: "s", timeoutMs: 50 }, async () => (await Bun.sleep(150), r as unknown as CodexRpc))).rejects.toThrow("in time");
  await Bun.sleep(250);
  expect(r.closed).toBe(true);
  expect(methods(r)).toEqual([]);
});
