// How a connection answers the daemon's own requests (approvals and the like).
import { expect, test } from "bun:test";
import { CodexRpc } from "./rpc";

function wired() {
  const sent: any[] = [];
  const rpc = new CodexRpc();
  rpc.wire = { send: (t) => sent.push(JSON.parse(t)), close: () => {} };
  return { rpc, sent };
}
const approval = { id: 3, method: "item/commandExecution/requestApproval", params: { threadId: "sub", itemId: "i" } };

test("a connection with no handler (discovery's shared one) leaves a request for the session's own: no answer", async () => {
  // Answering "not handled" here made Codex reject a subagent's approval before its card showed.
  const { rpc, sent } = wired();
  rpc.receive(JSON.stringify(approval));
  await Bun.sleep(5);
  expect(sent).toEqual([]);
});

test("a handler: undefined is answered as not handled, null left unanswered, a result sent", async () => {
  const { rpc, sent } = wired();
  rpc.onRequest = (m) => (m === "none" ? undefined : m === "other" ? null : Promise.resolve({ decision: "decline" }));
  rpc.receive(JSON.stringify({ id: 1, method: "none", params: {} }));
  rpc.receive(JSON.stringify({ id: 2, method: "other", params: {} }));
  rpc.receive(JSON.stringify(approval));
  await Bun.sleep(5);
  expect(sent).toEqual([
    { id: 1, error: { code: -32601, message: "Tether doesn't handle none" } },
    { id: 3, result: { decision: "decline" } },
  ]);
});
