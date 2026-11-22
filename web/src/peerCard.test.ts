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

test("a start card names the session it started", () => {
  const start = (status: ToolPart["status"], output?: string): ToolPart => ({ type: "tool", id: "t2", name: "mcp__tether__tether_start", kind: "peer", status, input: { harness: "antigravity", prompt: "x", title: "Bug fix" }, ...(output ? { output } : {}) });
  expect(peerHead(start("running"), undefined)).toEqual({ label: "Starting", sum: "antigravity · Bug fix" });
  const out = 'Started "Bug fix" (antigravity:c1) (Antigravity, accept-edits mode) in /p/app.';
  expect(peerTarget(out)).toEqual({ id: "antigravity:c1", title: "Bug fix" });
  expect(peerHead(start("done", out), "Bug fix")).toEqual({ label: "Started", sum: "“Bug fix”" });
  expect(peerHead(start("error", "Nothing was started: harness must be one of claude, codex, antigravity."), undefined).label).toBe("Didn't start");
});

test("an archive card names the session it archived", () => {
  const archive = (status: ToolPart["status"], output?: string): ToolPart => ({ type: "tool", id: "t3", name: "mcp__tether__tether_archive", kind: "peer", status, input: { to: "codex:c1" }, ...(output ? { output } : {}) });
  expect(peerHead(archive("running"), undefined)).toEqual({ label: "Archiving", sum: "codex:c1" });
  const out = 'Archived "Bug fix" (codex:c1). It\'s out of the person\'s sidebar.';
  expect(peerTarget(out)).toEqual({ id: "codex:c1", title: "Bug fix" });
  expect(peerHead(archive("done", out), "Bug fix")).toEqual({ label: "Archived", sum: "“Bug fix”" });
  expect(peerHead(archive("error", '"Bug fix" (codex:c1) is still working, so it wasn\'t archived.'), "Bug fix").label).toBe("Didn't archive");
});
