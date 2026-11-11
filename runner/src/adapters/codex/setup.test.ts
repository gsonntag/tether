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
