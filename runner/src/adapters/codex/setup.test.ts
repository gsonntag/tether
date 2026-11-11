// The Home agent on Codex: Tether's tools as dynamic tools on thread/start, answered by the driver.

import { expect, test } from "bun:test";
import { z } from "zod";
import { codexResumeExtras, codexStartExtras, codexToolCall, setCodexSetup } from "./setup";

test("a thread in the agent's folder starts with its tools, instructions and config; others get nothing", async () => {
  const seen: string[] = [];
  const unset = setCodexSetup("/home-agent", (nativeId) => ({
    server: "tether",
    instructions: "Be brief.",
    tools: [{ name: "echo", description: "Says it back.", input: { text: z.string() }, run: async (a: { text: string }) => (seen.push(nativeId), `${nativeId}: ${a.text}`) }],
  }));
  try {
    const x: any = codexStartExtras("/home-agent");
    expect(x.developerInstructions).toBe("Be brief.");
    expect(x.config["features.shell_tool"]).toBe(false);
    expect(x.dynamicTools).toEqual([{ type: "function", name: "echo", description: "Says it back.", inputSchema: expect.objectContaining({ type: "object", properties: { text: { type: "string" } }, required: ["text"] }) }]);
    expect(codexResumeExtras("/home-agent")).toEqual({ config: x.config });
    expect(codexStartExtras("/elsewhere")).toEqual({});
    expect(codexResumeExtras("/elsewhere")).toEqual({});

    expect(await codexToolCall("/home-agent", "t1", { tool: "echo", arguments: { text: "hi" } })).toEqual({ contentItems: [{ type: "inputText", text: "t1: hi" }], success: true });
    expect(seen).toEqual(["t1"]);
    expect((await codexToolCall("/home-agent", "t1", { tool: "echo", arguments: {} }))!.success).toBe(false);
    expect(await codexToolCall("/home-agent", "t1", { tool: "nope", arguments: {} })).toEqual({ contentItems: [{ type: "inputText", text: "There's no tool nope." }], success: false });
    expect(await codexToolCall("/elsewhere", "t1", { tool: "echo" })).toBeUndefined();
  } finally {
    unset();
  }
  expect(codexStartExtras("/home-agent")).toEqual({});
});

test("Tether's MCP server joins a thread's config as one dotted key, beside the Home agent's", async () => {
  const { codexTools, withTools } = await import("./driver");
  const unsetTools = codexTools.set({ name: "tether", command: "bun", args: ["mcp.ts"], env: (id) => ({ ID: id }), timeoutMs: 60_000, skip: (p) => p === "/skip" });
  const unset = setCodexSetup("/home-agent", () => ({ server: "tether", instructions: "", tools: [] }));
  try {
    const plain: any = withTools({}, "/p");
    // Not `mcp_servers: {…}`: that would replace the person's own servers.
    expect(Object.keys(plain.config)).toEqual(["mcp_servers.tether"]);
    expect(plain.config["mcp_servers.tether"]).toMatchObject({ command: "bun", env: { ID: "codex:*" }, tool_timeout_sec: 60 });
    const both: any = withTools(codexResumeExtras("/home-agent"), "/home-agent");
    expect(both.config["features.shell_tool"]).toBe(false);
    expect(both.config["mcp_servers.tether"]).toBeDefined();
    expect(withTools({}, "/skip")).toEqual({});
  } finally {
    unset();
    unsetTools();
  }
});
