import { describe, expect, test } from "bun:test";
import type { ToolServer } from "../../core/adapter";
import { claudeToolServerFor, claudeTools } from "../../adapters/claude/setup";
import { codexTools, withTools } from "../../adapters/codex/driver";
import { PhoneLine } from "../phoneLine";
import { CONCISE_RULE, sessionInstructions, TEXTING_RULE } from "./instructions";
import { Peers } from "./index";
import { TOOL_DEFS } from "./tools";

describe("the instructions Tether adds to its sessions", () => {
  test("concise replies on by default, off when turned off; the texting rule always", () => {
    expect(sessionInstructions({})).toContain(CONCISE_RULE);
    expect(sessionInstructions({ conciseReplies: true })).toContain(CONCISE_RULE);
    const off = sessionInstructions({ conciseReplies: false });
    expect(off).not.toContain(CONCISE_RULE);
    for (const s of [sessionInstructions({}), off]) {
      expect(s).toContain(TEXTING_RULE);
      expect(s).toContain("use the text_person tool");
    }
  });

  /** The tool server as the peers module gives it, with settings the test controls. */
  function server(settings: { conciseReplies?: boolean }): ToolServer {
    return {
      name: "tether",
      command: "bun",
      args: ["mcp.ts"],
      env: (id) => ({ ID: id }),
      timeoutMs: 60_000,
      instructions: () => sessionInstructions(settings),
    };
  }

  test("Claude: appended to the system prompt", () => {
    const settings: { conciseReplies?: boolean } = {};
    const unset = claudeTools.set(server(settings));
    try {
      const on = claudeToolServerFor("/p/app", "abc")!;
      expect(on.append).toContain(CONCISE_RULE);
      // Read at each process start: a changed setting applies from the next one.
      settings.conciseReplies = false;
      const off = claudeToolServerFor("/p/app", "abc")!;
      expect(off.append).not.toContain(CONCISE_RULE);
      expect(off.append).toContain(TEXTING_RULE);
    } finally {
      unset();
    }
  });

  test("Codex: developer instructions on start and resume", () => {
    const settings: { conciseReplies?: boolean } = {};
    const unset = codexTools.set(server(settings));
    try {
      const t: any = withTools("/p/app");
      expect(t.developerInstructions).toContain(CONCISE_RULE);
      expect(Object.keys(t.config)).toEqual(["mcp_servers.tether"]);
      settings.conciseReplies = false;
      expect((withTools("/p/app") as any).developerInstructions).not.toContain(CONCISE_RULE);
    } finally {
      unset();
    }
  });
});

describe("text_person", () => {
  function setup(line?: PhoneLine) {
    const rows: Record<string, any> = {
      "claude:main": { summary: { id: "claude:main", projectPath: "/p/app", title: "Main" }, state: { canText: true } },
      "claude:sub": { summary: { id: "claude:sub", projectPath: "/p/app", title: "Sub", parentSessionId: "claude:main" }, state: {} },
    };
    const ctx: any = { log: () => {}, phoneLine: line, session: (id: string) => rows[id], sessions: { list: () => [] } };
    return new Peers(ctx);
  }
  const call = (p: Peers, from: string, message: unknown) => p.call({ from, tool: "text_person", args: { message }, signal: new AbortController().signal });

  test("is one of the tools every session gets", () => {
    expect(TOOL_DEFS.map((t) => t.name)).toContain("text_person");
  });

  test("texts through Tether's texting for the session (a subagent's for its main session)", async () => {
    const line = new PhoneLine();
    const sent: [string, string][] = [];
    line.phone = { text: async (from, body) => (sent.push([from, body]), { text: "Texted the person." }) };
    const p = setup(line);
    expect(await call(p, "claude:main", "PR is up")).toEqual({ text: "Texted the person." });
    await call(p, "claude:sub", "blocked");
    expect(sent).toEqual([["claude:main", "PR is up"], ["claude:main", "blocked"]]);
  });

  test("texting off: an error, nothing sent", async () => {
    expect((await call(setup(new PhoneLine()), "claude:main", "hi")).isError).toBe(true);
    expect((await call(setup(), "claude:main", "hi")).isError).toBe(true);
  });
});
