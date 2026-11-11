import { describe, expect, test } from "bun:test";
import type { ToolServer } from "../../core/adapter";
import { claudeToolServerFor, claudeTools } from "../../adapters/claude/setup";
import { codexTools, withTools } from "../../adapters/codex/driver";
import { HomeLine } from "../homeLine";
import { CONCISE_RULE, SESSION_ENV, sessionInstructions, TEXTING_RULE } from "./instructions";
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
      expect(s).toContain("never the text-me skill or the textme CLI");
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
      skip: (p) => p === "/home-agent",
      instructions: () => sessionInstructions(settings),
      shellEnv: (id) => ({ [SESSION_ENV]: id }),
    };
  }

  test("Claude: appended to the system prompt, TETHER_SESSION in its shell; not for the Home agent's folder", () => {
    const settings: { conciseReplies?: boolean } = {};
    const unset = claudeTools.set(server(settings));
    try {
      const on = claudeToolServerFor("/p/app", "abc")!;
      expect(on.append).toContain(CONCISE_RULE);
      expect(on.env).toEqual({ TETHER_SESSION: "claude:abc" });
      // Read at each process start: a changed setting applies from the next one.
      settings.conciseReplies = false;
      const off = claudeToolServerFor("/p/app", "abc")!;
      expect(off.append).not.toContain(CONCISE_RULE);
      expect(off.append).toContain(TEXTING_RULE);
      expect(claudeToolServerFor("/home-agent", "h")).toBeUndefined();
    } finally {
      unset();
    }
  });

  test("Codex: developer instructions on start and resume, TETHER_SESSION through the shell policy; not for the Home agent", () => {
    const settings: { conciseReplies?: boolean } = {};
    const unset = codexTools.set(server(settings));
    try {
      const t: any = withTools({}, "/p/app");
      expect(t.developerInstructions).toContain(CONCISE_RULE);
      // Dotted to the variable: the person's own shell_environment_policy stays.
      expect(t.config["shell_environment_policy.set.TETHER_SESSION"]).toBe("codex:*");
      settings.conciseReplies = false;
      expect((withTools({}, "/p/app") as any).developerInstructions).not.toContain(CONCISE_RULE);
      // A folder's own instructions (the Home agent's) are never replaced.
      expect((withTools({ developerInstructions: "home rules" }, "/p/app") as any).developerInstructions).toBe("home rules");
      expect(withTools({}, "/home-agent")).toEqual({});
    } finally {
      unset();
    }
  });
});

describe("text_person", () => {
  function setup(line?: HomeLine) {
    const rows: Record<string, any> = {
      "claude:main": { summary: { id: "claude:main", projectPath: "/p/app", title: "Main" }, state: {} },
      "claude:sub": { summary: { id: "claude:sub", projectPath: "/p/app", title: "Sub", parentSessionId: "claude:main" }, state: {} },
    };
    const ctx: any = { log: () => {}, homeLine: line, session: (id: string) => rows[id], sessions: { list: () => [] } };
    return new Peers(ctx);
  }
  const call = (p: Peers, from: string, message: unknown) => p.call({ from, tool: "text_person", args: { message }, signal: new AbortController().signal });

  test("is one of the tools every session gets", () => {
    expect(TOOL_DEFS.map((t) => t.name)).toContain("text_person");
  });

  test("texts through Tether's texting for the session (a subagent's for its main session)", async () => {
    const line = new HomeLine();
    const sent: [string, string][] = [];
    line.phone = { send: async () => true, text: async (from, body) => (sent.push([from, body]), { text: "Texted the person." }) };
    const p = setup(line);
    expect(await call(p, "claude:main", "PR is up")).toEqual({ text: "Texted the person." });
    await call(p, "claude:sub", "blocked");
    expect(sent).toEqual([["claude:main", "PR is up"], ["claude:main", "blocked"]]);
  });

  test("a session the Home agent drives is sent to it as a report, not texted; one it doesn't drive texts", async () => {
    const line = new HomeLine();
    const sent: [string, string][] = [];
    const relayed: [string, string][] = [];
    line.phone = { send: async () => true, text: async (from, body) => (sent.push([from, body]), { text: "Texted the person." }) };
    line.home = {
      take: async () => {},
      isTextsChat: () => false,
      relay: async (id, msg) => (id === "claude:main" ? (relayed.push([id, msg]), "Not texted: the Home agent drives this session.") : undefined),
    };
    const p = setup(line);
    // Owned (a subagent speaks for its main session): to the Home agent.
    expect((await call(p, "claude:sub", "blocked on the DB")).text).toContain("Not texted");
    expect(relayed).toEqual([["claude:main", "blocked on the DB"]]);
    expect(sent).toEqual([]);
    // Not owned: straight to the person.
    const other: any = setup(line);
    (other as any).ctx.session = (id: string) => ({ summary: { id, projectPath: "/p/x", title: "X" }, state: {} });
    expect(await call(other, "claude:mine", "PR is up")).toEqual({ text: "Texted the person." });
    expect(sent).toEqual([["claude:mine", "PR is up"]]);
  });

  test("texting off: an error, nothing sent", async () => {
    expect((await call(setup(new HomeLine()), "claude:main", "hi")).isError).toBe(true);
    expect((await call(setup(), "claude:main", "hi")).isError).toBe(true);
  });
});
