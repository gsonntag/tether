import { expect, test } from "bun:test";
import { codexAnswer, codexAsk, stdinRefusal, stdinTarget } from "./requests";

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

test("a network approval is flagged as one (pushes say only that)", () => {
  const r = codexAsk("item/commandExecution/requestApproval", { itemId: "e", command: "psql -h db1", networkApprovalContext: { host: "db1" } }, "/p");
  expect(r).toMatchObject({ network: true, reason: "Network access to db1" });
});

// As codex-cli 0.171.0 sends them (recorded 2026-11-21): input from a read-only turn to a python REPL
// a Full access turn left running, asked of the client, and the same reviewed by Codex's reviewer.
const stdinAsk = { kind: "writeStdin", threadId: "T", turnId: "t2", itemId: "exec-c7cc", startedAtMs: 1, approvalId: "exec-e896", environmentId: "local", reason: "Send input to an existing terminal. This terminal runs without a filesystem sandbox.", command: "write_stdin --session-id 89156 \"open('x','w').write('x')\n\"", cwd: "/p", availableDecisions: ["accept", "cancel"] };
const stdinReview = { threadId: "T", turnId: "t2", reviewId: "r1", targetItemId: "exec-86a8", review: { status: "inProgress" }, action: { type: "writeStdin", approvalId: "exec-a252", processId: "38180", stdin: "x\n", cwd: "/p" } };

test("input to a running command (write_stdin): the command it's for, from Tether's request or Codex's reviewer; the card says what it is", () => {
  expect(stdinTarget("item/commandExecution/requestApproval", stdinAsk)).toEqual({ itemId: "exec-c7cc", processId: "89156" });
  expect(stdinTarget("item/autoApprovalReview/started", stdinReview)).toEqual({ itemId: "exec-86a8", processId: "38180" });
  // A plain command approval, or a review of anything else, isn't input.
  expect(stdinTarget("item/commandExecution/requestApproval", cmd)).toBeUndefined();
  expect(stdinTarget("item/autoApprovalReview/started", { ...stdinReview, action: { type: "command", command: "ls" } })).toBeUndefined();
  expect(codexAsk("item/commandExecution/requestApproval", stdinAsk, "/p")).toMatchObject({ kind: "approval", title: "Send input to a running command", toolId: "exec-c7cc" });
  expect(stdinRefusal("full-access", "read-only")).toBe("Tether refused input to that process: it was started with more access (Full access) than this session now has (Read only). Nothing was written to it. Start a new one under the current mode, or ask the person to stop it.");
  expect(stdinRefusal(undefined, "auto@codex-reviews", true)).toContain("stopped it: it was started with access Tether can't confirm is no more than this session now has (Auto (Codex reviews))");
});
