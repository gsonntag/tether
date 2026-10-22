// MCP elicitations from Codex (`mcpServer/elicitation/request`): tool approvals go to the guard,
// forms become question cards. Shapes from `codex app-server generate-ts` (codex-cli 0.162.0).

import { afterEach, describe, expect, test } from "bun:test";
import type { UiRequest } from "../../../web/src/shared/protocol";
import { config } from "../config";
import { CodexSession, mcpApprovalTool } from "./codex";
import { formContent, formRequest, SKIP } from "./elicitation";

const sessions: CodexSession[] = [];
afterEach(() => sessions.splice(0).forEach((s) => s.close()));

function session(guard: "ask" | "full") {
  const sink = { emit: () => {}, summary: () => {}, handoff: async () => {} };
  const s = new CodexSession({ nativeId: crypto.randomUUID(), projectPath: process.env.HOME! }, sink);
  s.t.state.guard = guard;
  sessions.push(s);
  const elicit = (p: any) => (s as any).onRequest("mcpServer/elicitation/request", { threadId: "t", turnId: null, ...p }) as Promise<any>;
  const pending = async (): Promise<UiRequest> => {
    for (let i = 0; i < 100 && !s.t.state.pendingUi.length; i++) await Bun.sleep(5);
    return s.t.state.pendingUi[0]!;
  };
  return { s, elicit, pending };
}

/** What Codex sends before an MCP tool call (core/src/mcp_tool_call.rs). */
const approval = (persist?: unknown) => ({
  serverName: "foliation",
  mode: "form",
  message: 'Allow the foliation MCP server to run tool "deploy"?',
  requestedSchema: { type: "object", properties: {} },
  _meta: { codex_approval_kind: "mcp_tool_call", ...(persist ? { persist } : {}), tool_params: { app: "x" } },
});

describe("Codex MCP tool approvals", () => {
  test("the tool name: from _meta, else from Codex's message", () => {
    expect(mcpApprovalTool(approval())).toBe("mcp__foliation__deploy");
    expect(mcpApprovalTool({ serverName: "s", message: "x", _meta: { tool_name: "t", tool_title: "T" } })).toBe("mcp__s__t");
    expect(mcpApprovalTool({ serverName: "s", message: "Allow?", _meta: { tool_title: "Title" } })).toBe("mcp__s__Title");
  });

  test("go to the guard like any tool call; allowed is accept", async () => {
    const { elicit } = session("full");
    expect(await elicit(approval())).toEqual({ action: "accept", content: null, _meta: null });
  });

  test("asked in ask mode: the card names the tool and its arguments; deny is decline", async () => {
    const { s, elicit, pending } = session("ask");
    const r = elicit(approval());
    const req = await pending();
    expect(req.kind).toBe("permission");
    expect(req.tool).toEqual({ name: "mcp__foliation__deploy", input: { app: "x" } });
    s.uiRespond({ id: req.id, allow: false });
    expect(await r).toEqual({ action: "decline", content: null, _meta: null });
  });

  test("always: remembered for the session when Codex offers it", async () => {
    const { s, elicit, pending } = session("ask");
    let r = elicit(approval(["session", "always"]));
    s.uiRespond({ id: (await pending()).id, allow: true, always: true });
    expect(await r).toEqual({ action: "accept", content: null, _meta: { persist: "session" } });
    // Tether remembers it for the project too (Settings → Approvals): the next call isn't asked.
    expect(await elicit(approval())).toEqual({ action: "accept", content: null, _meta: null });
    // Not offered: a plain accept.
    const other = approval();
    r = elicit({ ...other, _meta: { ...other._meta, tool_name: "status" } });
    s.uiRespond({ id: (await pending()).id, allow: true, always: true });
    expect(await r).toEqual({ action: "accept", content: null, _meta: null });
    config().approvals = [];
  });
});

const schema = {
  type: "object",
  properties: {
    env: { type: "string", title: "Environment", oneOf: [{ const: "prod", title: "Production" }, { const: "dev", title: "Development" }] },
    region: { type: "string", enum: ["eu", "us"], enumNames: ["Europe", "United States"] },
    tags: { type: "array", title: "Tags", items: { anyOf: [{ const: "a", title: "Alpha" }, { const: "b", title: "Beta" }] } },
    confirm: { type: "boolean", title: "Sure?" },
    count: { type: "integer", title: "Count", description: "How many" },
    note: { type: "string", title: "Note" },
  },
  required: ["env", "confirm"],
};

describe("form elicitations", () => {
  test("one question per field, enum labels as options, optional fields skippable", () => {
    const req = formRequest("Deploy settings", schema)!;
    expect(req.kind).toBe("question");
    expect(req.title).toBe("Deploy settings");
    const q = Object.fromEntries(req.questions!.map((x) => [x.question, { options: x.options.map((o) => o.label), multi: x.multiSelect }]));
    expect(q).toEqual({
      Environment: { options: ["Production", "Development"], multi: undefined },
      region: { options: ["Europe", "United States", SKIP], multi: undefined },
      Tags: { options: ["Alpha", "Beta", SKIP], multi: true },
      "Sure?": { options: ["Yes", "No"], multi: undefined },
      "Count: How many": { options: [SKIP], multi: undefined },
      Note: { options: [SKIP], multi: undefined },
    });
    expect(formRequest("x", { type: "object", properties: {} })).toBeUndefined();
  });

  test("answers come back typed, by value, skipped fields left out", () => {
    const answers = { Environment: "Production", region: "United States", Tags: "Alpha, Beta", "Sure?": "Yes", "Count: How many": "3.7", Note: SKIP };
    expect(formContent(schema, { id: "q", answers })).toEqual({ env: "prod", region: "us", tags: ["a", "b"], confirm: true, count: 3 });
    // Free text through "Other": kept as typed; a non-number is left out.
    expect(formContent(schema, { id: "q", answers: { Environment: "staging", "Sure?": "No", "Count: How many": "lots" } })).toEqual({ env: "staging", confirm: false });
  });

  test("Codex: a form is a question card; answered is accept with content, dismissed is cancel", async () => {
    const { s, elicit, pending } = session("ask");
    let r = elicit({ serverName: "db", mode: "form", message: "Which table?", requestedSchema: { type: "object", properties: { table: { type: "string", enum: ["users", "orders"] } }, required: ["table"] }, _meta: null });
    let req = await pending();
    expect(req.title).toBe("Which table?");
    s.uiRespond({ id: req.id, answers: { table: "orders" } });
    expect(await r).toEqual({ action: "accept", content: { table: "orders" }, _meta: null });
    r = elicit({ serverName: "db", mode: "form", message: "Which table?", requestedSchema: { type: "object", properties: { table: { type: "string" } } }, _meta: null });
    req = await pending();
    s.uiRespond({ id: req.id, cancelled: true });
    expect(await r).toEqual({ action: "cancel", content: null, _meta: null });
  });

  test("Codex: a URL elicitation asks to open the link; an empty form is a yes/no", async () => {
    const { s, elicit, pending } = session("ask");
    let r = elicit({ serverName: "gh", mode: "url", message: "Sign in", url: "https://example.com/auth", elicitationId: "e1", _meta: null });
    let req = await pending();
    expect(req.kind).toBe("confirm");
    expect(req.message).toContain("https://example.com/auth");
    s.uiRespond({ id: req.id, confirmed: true });
    expect((await r).action).toBe("accept");
    r = elicit({ serverName: "gh", mode: "form", message: "Proceed?", requestedSchema: { type: "object", properties: {} }, _meta: null });
    req = await pending();
    s.uiRespond({ id: req.id, confirmed: false });
    expect(await r).toEqual({ action: "decline", content: null, _meta: null });
  });
});
