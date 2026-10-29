import { expect, test } from "bun:test";
import { codexAnswer, codexAsk } from "./requests";

const cmd = { threadId: "T", turnId: "t", itemId: "exec-1", command: "/bin/bash -lc 'rm -rf build'", cwd: "/p", reason: "Needs to delete", availableDecisions: ["accept", "cancel"] };

test("a command approval: the script, its kind, the call it's about, Codex's reason", () => {
  expect(codexAsk("item/commandExecution/requestApproval", cmd, "/p")).toEqual({ kind: "approval", tool: "bash", input: { command: "rm -rf build" }, toolKind: "shell", command: "rm -rf build", toolId: "exec-1", reason: "Needs to delete" });
  expect(codexAnswer("item/commandExecution/requestApproval", cmd, { allow: true })).toEqual({ decision: "accept" });
  // A plain Deny stops the turn (as Esc in Codex's TUI); with a reason Codex carries on.
  expect(codexAnswer("item/commandExecution/requestApproval", cmd, { allow: false, reason: "no", interrupt: true })).toEqual({ decision: "cancel" });
  expect(codexAnswer("item/commandExecution/requestApproval", cmd, { allow: false, reason: "use git clean" })).toEqual({ decision: "decline" });
});

test("a patch approval shows the patch (from its item)", () => {
  const item = { id: "f1", changes: [{ path: "a.txt", kind: { type: "update" }, diff: "@@\n-x\n+y" }] };
  expect(codexAsk("item/fileChange/requestApproval", { itemId: "f1" }, "/p", item)).toMatchObject({ kind: "approval", tool: "apply_patch", toolKind: "edit", path: "/p/a.txt", input: { edits: [{ old_string: "x", new_string: "y" }] } });
  expect(codexAnswer("item/fileChange/requestApproval", {}, { allow: true })).toEqual({ decision: "accept" });
});

test("a question: options as buttons; answers by question id", () => {
  const p = { itemId: "q", questions: [{ id: "color", header: "Color", question: "Which color?", isOther: true, isSecret: false, options: [{ label: "Red", description: "warm" }, { label: "Blue", description: "" }] }] };
  expect(codexAsk("item/tool/requestUserInput", p, "/p")).toMatchObject({ kind: "question", question: "Which color?", options: ["Red", "Blue"], questions: [{ question: "Which color?", header: "Color", options: [{ label: "Red", description: "warm" }, { label: "Blue" }] }] });
  expect(codexAnswer("item/tool/requestUserInput", p, { allow: true, answers: ["Teal, please"] })).toEqual({ answers: { color: { answers: ["Teal, please"] } } });
  expect(codexAnswer("item/tool/requestUserInput", p, { allow: false, reason: "x" })).toEqual({ answers: {} });
});

test("more sandbox access, MCP tool approvals; MCP forms aren't asked", () => {
  const perm = { itemId: "p", permissions: { network: { enabled: true } }, cwd: "/p" };
  expect(codexAsk("item/permissions/requestApproval", perm, "/p")).toMatchObject({ kind: "approval", tool: "request_permissions" });
  expect(codexAnswer("item/permissions/requestApproval", perm, { allow: true })).toEqual({ permissions: { network: { enabled: true } }, scope: "turn" });
  expect(codexAnswer("item/permissions/requestApproval", perm, { allow: false, reason: "no" })).toEqual({ permissions: {}, scope: "turn" });
  const mcp = { serverName: "gh", mode: "form", message: 'Allow the gh MCP server to run tool "search"?', _meta: { codex_approval_kind: "mcp_tool_call", tool_params: { q: "x" } } };
  expect(codexAsk("mcpServer/elicitation/request", mcp, "/p")).toMatchObject({ kind: "approval", tool: "mcp__gh__search", input: { q: "x" } });
  expect(codexAsk("mcpServer/elicitation/request", { serverName: "x", mode: "url", url: "https://x" }, "/p")).toBeUndefined();
});
