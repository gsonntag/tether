// Tether's MCP server on Codex: joined to a thread's config at start and resume (withTools).

import { expect, test } from "bun:test";

test("Tether's MCP server joins a thread's config as one dotted key", async () => {
  const { codexTools, withTools } = await import("./driver");
  expect(withTools("/p")).toEqual({});
  const unsetTools = codexTools.set({ name: "tether", command: "bun", args: ["mcp.ts"], env: (id) => ({ ID: id }), timeoutMs: 60_000 });
  try {
    const plain: any = withTools("/p");
    // Not `mcp_servers: {…}`: that would replace the person's own servers.
    expect(Object.keys(plain.config)).toEqual(["mcp_servers.tether"]);
    expect(plain.config["mcp_servers.tether"]).toMatchObject({ command: "bun", env: { ID: "codex:*" }, tool_timeout_sec: 60 });
  } finally {
    unsetTools();
  }
});
