export {};

// A stand-in for `agy acp` in tests: just enough of Antigravity's ACP server (shapes recorded from
// 1.5.13) to drive a session. A prompt containing "permission" asks to run a command; "wait" runs
// until cancelled; anything else answers "pong".

const config = (model: string, effort: string, mode: string) => [
  { id: "model", category: "model", type: "select", currentValue: model, options: [{ value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" }, { value: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Thinking)" }] },
  { id: "thought_level", category: "thought_level", type: "select", currentValue: effort, options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }] },
  { id: "mode", category: "mode", type: "select", currentValue: mode, options: [{ value: "default", name: "Default" }, { value: "accept-edits", name: "Accept edits" }, { value: "plan", name: "Plan" }] },
];
let model = "gemini-3.8-flash";
let effort = "high";
let mode = "default";
const out = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n");
const update = (sessionId: string, u: unknown) => out({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: u } });
const waiting = new Map<string, (r: any) => void>();
let cancel: (() => void) | undefined;

/** What the last session/load carried (MCP servers, _meta), for tests to read back. */
let loaded: any;

async function prompt(id: number, p: any) {
  const sid = p.sessionId;
  const text: string = p.prompt?.[0]?.text ?? "";
  update(sid, { sessionUpdate: "usage_update", used: 10000, size: 1048576 });
  if (text.includes("permission")) {
    const call = { toolCallId: "call_1", name: "run_command", kind: "execute", title: "echo hi", rawInput: { CommandLine: "echo hi" } };
    update(sid, { sessionUpdate: "tool_call", ...call, status: "in_progress" });
    const answer = await new Promise<any>((ok) => {
      waiting.set("p1", ok);
      out({ jsonrpc: "2.0", id: "p1", method: "session/request_permission", params: { sessionId: sid, toolCall: { sessionUpdate: "tool_call", ...call, status: "pending" }, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }] } });
    });
    const allowed = answer?.outcome?.optionId === "allow";
    update(sid, { sessionUpdate: "tool_call_update", ...call, status: allowed ? "completed" : "failed", rawOutput: { output: allowed ? "hi" : "denied" } });
    update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: allowed ? "ran it" : "skipped" } });
    return out({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
  }
  if (text.includes("loaded?")) {
    update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify({ mcpServers: loaded?.mcpServers, _meta: loaded?._meta }) } });
    return out({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
  }
  if (text.includes("tether tool")) {
    const call = { toolCallId: "call_t", name: "mcp_tether_tether_sessions", kind: "other", title: "Run mcp_tether_tether_sessions", rawInput: {} };
    update(sid, { sessionUpdate: "tool_call", ...call, status: "pending" });
    const answer = await new Promise<any>((ok) => {
      waiting.set("p2", ok);
      out({ jsonrpc: "2.0", id: "p2", method: "session/request_permission", params: { sessionId: sid, toolCall: call, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }] } });
    });
    update(sid, { sessionUpdate: "tool_call_update", ...call, status: answer?.outcome?.optionId === "allow" ? "completed" : "failed" });
    return out({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
  }
  if (text.includes("plan it")) {
    const path = `${process.env.FAKE_AGY_BRAIN ?? "/tmp"}/plan_${sid}.md`;
    const content = "# Plan\n\n1. Do the thing.\n";
    await Bun.write(path, content);
    const call = { toolCallId: "call_plan", name: "write_file", kind: "edit", title: "File plan.md", rawInput: { ArtifactMetadata: { RequestFeedback: true, UserFacing: true }, Content: content, Path: path } };
    update(sid, { sessionUpdate: "tool_call", ...call, status: "completed" });
    update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Please review the plan." } });
    return out({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
  }
  if (text.includes("report later")) {
    // The turn ends; then, as after a subagent's report, the agent goes on by itself.
    update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Waiting for its report." } });
    out({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
    await Bun.sleep(300);
    update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: " The report says hi." } });
    return;
  }
  if (text.includes("wait")) {
    update(sid, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking…" } });
    await new Promise<void>((ok) => (cancel = ok));
    return out({ jsonrpc: "2.0", id, result: { stopReason: "cancelled" } });
  }
  update(sid, { sessionUpdate: "session_info_update", title: "Ping" });
  update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "po" } });
  update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ng" } });
  out({ jsonrpc: "2.0", id, result: { stopReason: "end_turn", usage: { inputTokens: 11, outputTokens: 2, cachedReadTokens: 7, cachedWriteTokens: 3, thoughtTokens: 5, totalTokens: 28 } } });
}

let buf = "";
for await (const chunk of Bun.stdin.stream()) {
  buf += new TextDecoder().decode(chunk);
  let n: number;
  while ((n = buf.indexOf("\n")) >= 0) {
    const m = JSON.parse(buf.slice(0, n));
    buf = buf.slice(n + 1);
    if (m.method === undefined) {
      waiting.get(String(m.id))?.(m.result);
      continue;
    }
    const ok = (result: unknown) => out({ jsonrpc: "2.0", id: m.id, result });
    switch (m.method) {
      case "initialize":
        ok({ protocolVersion: 1, agentCapabilities: { loadSession: true }, agentInfo: { name: "Antigravity ACP Server", version: "1.5.13" } });
        break;
      case "session/load":
        loaded = m.params;
        update(m.params.sessionId, { sessionUpdate: "user_message_chunk", content: { type: "text", text: "earlier" } });
        update(m.params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "before" } });
        ok({ sessionId: m.params.sessionId, modes: { currentModeId: mode }, configOptions: config(model, effort, mode), _meta: { antigravity: { tier: { name: "Google AI Pro" } } } });
        break;
      case "session/set_config_option":
        if (m.params.configId === "model") model = m.params.value;
        if (m.params.configId === "thought_level") effort = m.params.value;
        ok({ configOptions: config(model, effort, mode) });
        break;
      case "session/set_mode":
        mode = m.params.modeId;
        update(m.params.sessionId, { sessionUpdate: "current_mode_update", currentModeId: mode });
        ok({});
        // As the real one can: a settings snapshot after the change, carrying the mode from before it.
        update(m.params.sessionId, { sessionUpdate: "config_option_update", configOptions: config(model, effort, "default") });
        break;
      case "session/prompt":
        void prompt(m.id, m.params);
        break;
      case "session/cancel":
        cancel?.();
        break;
      default:
        ok({});
    }
  }
}
