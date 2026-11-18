// A read-only (side chat) Codex thread: loaded with its MCP servers off, by fork and by resume.
import { afterEach, expect, test } from "bun:test";
import { setConnector } from "./daemon";
import { CodexDriver, codexTools, createThread, dropPending } from "./driver";
import { assertNoMcp, readOnlyLoad } from "./readOnly";
import { rememberIn } from "./remember";
import { CodexRpc } from "./rpc";
import { TestSink } from "./testSink";

const MAIN = "01a187c7-9ae6-7631-b0cc-596277bb8c13";

function daemon(answers: Record<string, (p: any) => unknown>) {
  const sent: any[] = [];
  const rpc = new CodexRpc();
  rpc.wire = {
    send: (text) => {
      const m = JSON.parse(text);
      sent.push(m);
      if (m.method && m.id !== undefined)
        queueMicrotask(() => {
          let reply: any;
          try {
            reply = { id: m.id, result: answers[m.method]?.(m.params) ?? {} };
          } catch (e: any) {
            reply = { id: m.id, error: { code: -32600, message: e.message } };
          }
          rpc.receive(JSON.stringify(reply));
        });
    },
    close: () => {},
  };
  setConnector(async () => rpc);
  return (method: string) => sent.filter((m) => m.method === method && m.id !== undefined).map((m) => m.params);
}
afterEach(() => setConnector(undefined));

const resumed = () => ({ thread: { id: MAIN, status: { type: "idle" } }, model: "m", approvalPolicy: "never", approvalsReviewer: "user", sandbox: { type: "readOnly", networkAccess: false } });

test("every MCP server the config names is off, apps and subagents too; read-only sandbox, no approvals", async () => {
  const load = await readOnlyLoad(async () => ({ config: { mcp_servers: { docs: { command: "x" }, "my-db": { url: "y" } } } }), "/p");
  expect(load).toMatchObject({ sandbox: "read-only", approvalPolicy: "never", config: { "mcp_servers.docs.enabled": false, "mcp_servers.my-db.enabled": false, "features.apps": false, "features.plugins": false, "features.multi_agent": false, "features.hooks": false } });
  // Failing closed: no config, no load.
  await expect(readOnlyLoad(async () => { throw new Error("down"); }, "/p")).rejects.toThrow("Couldn't read Codex's config");
  await expect(readOnlyLoad(async () => ({ config: { mcp_servers: "weird" } }), "/p")).rejects.toThrow("can't start");
});

test("a read-only resume carries that load and never Tether's own server", async () => {
  rememberIn(undefined);
  const unset = codexTools.set({ name: "tether", command: "bun", args: ["mcp.ts"], env: (id) => ({ ID: id }), timeoutMs: 60_000 });
  const calls = daemon({ "config/read": () => ({ config: { mcp_servers: { docs: {} } } }), "thread/resume": resumed, "mcpServerStatus/list": () => ({ data: [{ name: "docs", runtimeStatus: "disabled" }] }) });
  await CodexDriver.open(MAIN, "/tmp", { readOnly: true, permissionMode: "never+read-only" }, new TestSink(), true);
  const r = calls("thread/resume")[0];
  expect(r).toMatchObject({ threadId: MAIN, sandbox: "read-only", approvalPolicy: "never", config: { "mcp_servers.docs.enabled": false } });
  expect(Object.keys(r.config).some((k) => k.startsWith("mcp_servers.tether"))).toBe(false);
  unset();
});

test("no config read, no resume", async () => {
  rememberIn(undefined);
  const calls = daemon({ "config/read": () => { throw new Error("down"); }, "thread/resume": resumed });
  await expect(CodexDriver.open(MAIN, "/tmp", { readOnly: true }, new TestSink(), true)).rejects.toThrow("Couldn't read Codex's config");
  expect(calls("thread/resume")).toEqual([]);
});

test("a read-only thread made new (a side chat's copy) starts with that load, never Tether's server", async () => {
  rememberIn(undefined);
  const unset = codexTools.set({ name: "tether", command: "bun", args: ["mcp.ts"], env: (id) => ({ ID: id }), timeoutMs: 60_000 });
  const calls = daemon({ "config/read": () => ({ config: { mcp_servers: { docs: {} } } }), "thread/start": () => ({ thread: { id: "NEW", status: { type: "idle" } } }) });
  const id = await createThread("/tmp", { readOnly: true, permissionMode: "never+read-only" });
  dropPending(id);
  const r = calls("thread/start")[0];
  expect(r).toMatchObject({ sandbox: "read-only", approvalPolicy: "never", config: { "mcp_servers.docs.enabled": false, "features.plugins": false } });
  expect(Object.keys(r.config).some((k) => k.startsWith("mcp_servers.tether"))).toBe(false);
  unset();
});

test("after loading, the daemon must say no MCP server runs, else it fails", async () => {
  const say = (data: unknown) => async () => ({ data });
  await assertNoMcp(say([{ name: "docs", runtimeStatus: "disabled", tools: {} }, { name: "x", runtimeStatus: null }]), "t");
  await expect(assertNoMcp(say([{ name: "docs", runtimeStatus: "connected", tools: {} }]), "t")).rejects.toThrow("MCP servers on (docs)");
  await expect(assertNoMcp(say([{ name: "docs", runtimeStatus: "notStarted", tools: { write: {} } }]), "t")).rejects.toThrow("docs");
  await expect(assertNoMcp(async () => ({}), "t")).rejects.toThrow("Couldn't check");
  await expect(assertNoMcp(async () => { throw new Error("unknown method"); }, "t")).rejects.toThrow("Couldn't check");
  // A resume whose thread still runs one (another client loaded it) doesn't open.
  rememberIn(undefined);
  daemon({ "config/read": () => ({ config: {} }), "thread/resume": resumed, "mcpServerStatus/list": () => ({ data: [{ name: "tether", runtimeStatus: "connected" }] }) });
  await expect(CodexDriver.open(MAIN, "/tmp", { readOnly: true }, new TestSink(), true)).rejects.toThrow("MCP servers on (tether)");
});
