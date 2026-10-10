// opencode's `task` tool over ACP, shaped after opencode 1.18's ACP agent (tool_call kind "think").
import { expect, test } from "bun:test";
import { AcpActivity } from "./acpActivity";

test("an opencode task call is a subagent while it runs", () => {
  let t = 0;
  const act = new AcpActivity(() => t);
  const rawInput = { description: "Find the flaky test", prompt: "Look through tests/", subagent_type: "general" };
  const [a] = act.onUpdate({ sessionUpdate: "tool_call", toolCallId: "tc1", title: "task", kind: "think", status: "pending", rawInput });
  expect(a).toMatchObject({ id: "tc1", kind: "subagent", title: "Find the flaky test", agentType: "general", status: "running", background: false });
  expect(act.onUpdate({ sessionUpdate: "tool_call_update", toolCallId: "tc1", status: "in_progress", rawInput })).toEqual([]);
  t = 9;
  const [done] = act.onUpdate({
    sessionUpdate: "tool_call_update",
    toolCallId: "tc1",
    status: "completed",
    rawOutput: { output: "tests/login.spec.ts is flaky", metadata: { sessionId: "s2", model: { providerID: "opencode", modelID: "big-pickle" } } },
  });
  expect(done).toMatchObject({ status: "done", endedAt: 9, summary: "tests/login.spec.ts is flaky", model: "opencode/big-pickle" });
});

test("other tool calls aren't activity", () => {
  const act = new AcpActivity(() => 0);
  expect(act.onUpdate({ sessionUpdate: "tool_call", toolCallId: "x", kind: "execute", rawInput: { command: "ls" } })).toEqual([]);
});
