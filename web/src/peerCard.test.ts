import { expect, test } from "bun:test";
import type { ToolPart } from "../../shared/transcript";
import { peerTarget } from "../../shared/peers";
import { peerHead } from "./peerCard";

const ask = (status: ToolPart["status"], output?: string): ToolPart => ({ type: "tool", id: "t1", name: "mcp__tether__tether_ask", kind: "peer", status, input: { to: "Fix login", text: "port?" }, ...(output ? { output } : {}) });

test("a peer card names the session the runner reached, not the first title that matches", () => {
  expect(peerTarget('"Fix login" (claude:b2) answered:\n\n"Other" (claude:zz) 8080')).toEqual({ id: "claude:b2", title: "Fix login" });
  expect(peerTarget("2 sessions match \"Fix\": claude:a (\"Fix\")")).toBeUndefined();
});

test("an ask that went out and failed reads as failed; one that never went, as not asked", () => {
  expect(peerHead(ask("running"), undefined).label).toBe("Asking");
  expect(peerHead(ask("done", '"Fix login" (claude:b2) answered:\n\n8080'), "Fix login").label).toBe("Asked");
  expect(peerHead(ask("error", 'No answer within 15 minutes: "Fix login" (claude:b2) is still working on it.'), "Fix login").label).toBe("Ask failed");
  expect(peerHead(ask("error", "You already have 3 questions waiting for answers (at most 3)."), undefined).label).toBe("Not asked");
});
