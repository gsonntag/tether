import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolPart } from "../../../../shared/transcript";
import { HARNESS_BINS } from "../detect";
import { TestSink } from "../codex/testSink";
import { AgyDriver } from "./driver";
import { keepPlan } from "./quota";

const dir = mkdtempSync(join(tmpdir(), "tether-agy-"));
// Antigravity's own folder is a throwaway one: no saved rules, no stores of the person's.
process.env.AGY_HOME = dir;
const was = HARNESS_BINS.antigravity;
beforeAll(() => {
  // `agy acp` is the fake: a script that runs fakeAgy.ts whatever its arguments.
  const bin = join(dir, "agy");
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, "fakeAgy.ts")}"\n`);
  chmodSync(bin, 0o755);
  HARNESS_BINS.antigravity = bin;
});
afterAll(() => void (HARNESS_BINS.antigravity = was));

const until = async (f: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(10);
  }
};

test("a session loads, takes the shown settings, and its turn streams after the stored messages", async () => {
  const sink = new TestSink();
  const d = await AgyDriver.open("s1", dir, { model: "claude-sonnet-4-6", effort: "low", permissionMode: "accept-edits" }, sink);
  try {
    expect(sink.lastWith("model")).toMatchObject({ model: "claude-sonnet-4-6", effort: "low", permissionMode: "accept-edits", billing: { kind: "plan", label: "Google AI Pro" } });
    await d.send("ping");
    await until(() => sink.status === "idle");
    // The stored conversation was m0 and m1: this turn goes on from there, as a replay will number it.
    expect(sink.t.messages.map((m) => [m.id, m.role, m.parts.map((p) => (p.type === "text" ? p.text : p.type)).join()])).toEqual([
      ["m2", "user", "ping"],
      ["m3", "assistant", "pong"],
    ]);
    expect(sink.t.messages[1]!.streaming).toBe(false);
    expect(sink.lastWith("context")?.context).toEqual({ used: 10000, total: 1048576 });
  } finally {
    await d.close();
  }
});

test("a permission prompt goes to the broker, and the answer back to Antigravity", async () => {
  const sink = new TestSink();
  const d = await AgyDriver.open("s2", dir, {}, sink);
  try {
    await d.send("needs permission");
    await until(() => sink.asks.length === 1);
    expect(sink.asks[0]!.ask).toMatchObject({ kind: "approval", tool: "run_command", toolKind: "shell", command: "echo hi", toolId: "call_1", noReason: true });
    sink.asks[0]!.resolve({ allow: true });
    await until(() => sink.status === "idle");
    const tool = sink.t.messages[1]!.parts[0] as ToolPart;
    expect([tool.status, tool.output]).toEqual(["done", "hi"]);
  } finally {
    await d.close();
  }
});

test("Stop cancels the turn: an open request closes, and the session goes idle without an error", async () => {
  const sink = new TestSink();
  const d = await AgyDriver.open("s3", dir, {}, sink);
  try {
    await d.send("wait for it");
    await until(() => sink.t.messages.length === 2);
    expect(d.busy()).toBe(true);
    await d.interrupt();
    await until(() => sink.status === "idle");
    expect(d.busy()).toBe(false);
    expect(sink.t.messages[1]!.error).toBeUndefined();
  } finally {
    await d.close();
  }
});

test("a process that dies says so", async () => {
  const sink = new TestSink();
  const d = await AgyDriver.open("s4", dir, {}, sink);
  const exit: { error?: string }[] = [];
  d.onExit = (error) => void exit.push({ error });
  (d as any).client.proc.kill(9);
  await until(() => exit.length > 0);
  expect(exit[0]!.error).toContain("It exited");
  await expect(d.send("hi")).rejects.toThrow("isn't running");
});

// ---------- phase 4: Tether's tools, side chats, plan review, turns without a prompt ----------

import { agyTools, savedAllowRules, timing } from "./driver";

test("Tether's tools go to Antigravity with the session's env and instructions, and run without asking", async () => {
  const undo = agyTools.set({ name: "tether", command: "/bin/tether-mcp", args: ["--x"], env: (id) => ({ TETHER_SESSION: id }), timeoutMs: 1000, instructions: () => "Be brief." });
  const sink = new TestSink();
  const d = await AgyDriver.open("t1", dir, {}, sink);
  try {
    await d.send("loaded?");
    await until(() => sink.status === "idle");
    const said = JSON.parse((sink.t.messages[1]!.parts[0] as any).text);
    expect(said.mcpServers).toEqual([{ name: "tether", command: "/bin/tether-mcp", args: ["--x"], env: [{ name: "TETHER_SESSION", value: "antigravity:t1" }] }]);
    expect(said._meta).toEqual({ antigravity: { systemPrompt: { append: "Be brief." } } });
    await d.send("use a tether tool");
    await until(() => sink.status === "idle" && sink.t.messages.length >= 4);
    expect(sink.asks.length).toBe(0);
    expect((sink.t.messages[3]!.parts[0] as ToolPart)).toMatchObject({ kind: "peer", status: "done" });
  } finally {
    await d.close();
    undo();
  }
});

test("a side chat gets no tools, is told it's read-only, stays in default mode, and refuses approvals without asking", async () => {
  const undo = agyTools.set({ name: "tether", command: "/bin/tether-mcp", args: [], env: () => ({}), timeoutMs: 1000 });
  const sink = new TestSink();
  const d = await AgyDriver.open("t2", dir, { readOnly: true, permissionMode: "accept-edits" }, sink);
  try {
    expect(sink.lastWith("permissionMode")?.permissionMode).toBe("default");
    await d.send("loaded?");
    await until(() => sink.status === "idle");
    const said = JSON.parse((sink.t.messages[1]!.parts[0] as any).text);
    expect(said.mcpServers).toEqual([]);
    expect(said._meta.antigravity.systemPrompt.append).toContain("read-only side chat");
    await d.send("needs permission");
    await until(() => sink.status === "idle" && sink.t.messages.length >= 4);
    expect(sink.asks.length).toBe(0);
    expect((sink.t.messages[3]!.parts[0] as ToolPart).status).toBe("error");
    await expect(d.setPermissionMode("accept-edits")).rejects.toThrow("read-only");
  } finally {
    await d.close();
    undo();
  }
});

test("saved Always-allow rules are read from Antigravity's settings", () => {
  const f = join(dir, "settings.json");
  writeFileSync(f, JSON.stringify({ permissions: { allow: ["command(echo)"] } }));
  expect(savedAllowRules(f)).toEqual(["command(echo)"]);
  writeFileSync(f, JSON.stringify({ trustedWorkspaces: [] }));
  expect(savedAllowRules(f)).toEqual([]);
  expect(savedAllowRules(join(dir, "missing.json"))).toEqual([]);
});

test("a plan mode turn that writes a plan for review raises a plan request Tether answers", async () => {
  process.env.FAKE_AGY_BRAIN = dir;
  const sink = new TestSink();
  const d = await AgyDriver.open("t3", dir, { permissionMode: "plan" }, sink);
  try {
    await d.send("plan it");
    await until(() => sink.asks.length === 1);
    expect(sink.asks[0]!.ask).toMatchObject({ kind: "approval", tool: "plan", planFollowUp: true, approveMode: "default", plan: "# Plan\n\n1. Do the thing.\n" });
  } finally {
    await d.close();
  }
});

test("out of plan mode, the same turn raises nothing", async () => {
  const sink = new TestSink();
  const d = await AgyDriver.open("t4", dir, {}, sink);
  try {
    await d.send("plan it");
    await until(() => sink.status === "idle");
    await Bun.sleep(100);
    expect(sink.asks.length).toBe(0);
  } finally {
    await d.close();
  }
});

test("a turn the agent runs without a prompt shows as working, joins its reply, and ends when quiet", async () => {
  const was = timing.quietMs;
  timing.quietMs = 200;
  const sink = new TestSink();
  const d = await AgyDriver.open("t5", dir, {}, sink);
  try {
    await d.send("report later");
    await until(() => sink.states.filter((s) => s.status === "running").length >= 2, 3000);
    expect(d.busy()).toBe(true);
    await until(() => sink.status === "idle" && !d.busy(), 3000);
    // As a replay groups it: one reply.
    expect(sink.t.messages.map((m) => [m.id, m.role])).toEqual([["m2", "user"], ["m3", "assistant"]]);
    expect((sink.t.messages[1]!.parts[0] as any).text).toBe("Waiting for its report. The report says hi.");
    expect(sink.t.messages[1]!.streaming).toBe(false);
  } finally {
    timing.quietMs = was;
    await d.close();
  }
});

test("a message to a subagent asks the main agent to send_message it, and its call is the delivery", async () => {
  const sink = new TestSink();
  const d = await AgyDriver.open("t6", dir, {}, sink);
  try {
    expect(d.relayMessage("kid", "hello")).toContain('Recipient "kid"');
    const call = (Recipient: string, Message: string): ToolPart => ({ type: "tool", id: "x", name: "send_message", kind: "other", status: "done", input: { raw: { Recipient, Message } } });
    expect(d.relayedBy("kid", call("kid", "hello there"), "hello")).toBe(true);
    expect(d.relayedBy("kid", call("other", "hello"), "hello")).toBe(false);
  } finally {
    await d.close();
  }
});

test("a late update to the last turn's call doesn't start a turn of its own", async () => {
  const sink = new TestSink();
  const d = await AgyDriver.open("t7", dir, {}, sink);
  try {
    await d.send("needs permission");
    await until(() => sink.asks.length === 1);
    sink.asks[0]!.resolve({ allow: true });
    await until(() => sink.status === "idle");
    const runs = sink.states.filter((s) => s.status === "running").length;
    (d as any).update({ sessionUpdate: "tool_call_update", toolCallId: "call_1", status: "completed" });
    expect(sink.states.filter((s) => s.status === "running").length).toBe(runs);
    expect(d.busy()).toBe(false);
  } finally {
    await d.close();
  }
});

test("Bypass permissions: Antigravity runs in accept-edits, every request is approved without asking, and it can be turned off", async () => {
  const sink = new TestSink();
  const d = await AgyDriver.open("t8", dir, { permissionMode: "bypassPermissions" }, sink);
  try {
    expect(sink.lastWith("permissionMode")?.permissionMode).toBe("bypassPermissions");
    await d.send("needs permission");
    await until(() => sink.status === "idle" && sink.t.messages.length >= 2);
    expect(sink.asks.length).toBe(0);
    expect((sink.t.messages[1]!.parts[0] as ToolPart).status).toBe("done");
    await d.setPermissionMode("default");
    expect(sink.lastWith("permissionMode")?.permissionMode).toBe("default");
    await d.send("needs permission");
    await until(() => sink.asks.length === 1);
    sink.asks[0]!.resolve({ allow: false, reason: "no" });
    await until(() => sink.status === "idle");
  } finally {
    await d.close();
  }
});

test("a side chat can't bypass", async () => {
  const sink = new TestSink();
  const d = await AgyDriver.open("t9", dir, { readOnly: true, permissionMode: "bypassPermissions" }, sink);
  try {
    expect(sink.lastWith("permissionMode")?.permissionMode).toBe("default");
    await expect(d.setPermissionMode("bypassPermissions")).rejects.toThrow("read-only");
  } finally {
    await d.close();
  }
});

test("AgyDriver reports plan to sink when keptPlan is present", async () => {
  const mockPlan = {
    complete: true,
    pools: [
      { id: "gemini", name: "Gemini Models", fiveHour: { percent: 8 } },
      { id: "other", name: "Claude and GPT models", fiveHour: { percent: 100, exhausted: true } },
    ],
  };
  keepPlan(mockPlan);
  const sink = new TestSink();
  let reportedPlan: any;
  sink.plan = (p) => {
    reportedPlan = p;
  };
  const d = await AgyDriver.open("s-plan", dir, {}, sink);
  try {
    await until(() => !!reportedPlan);
    expect(reportedPlan.pools?.length).toBe(2);
    expect(reportedPlan.pools[0].id).toBe("gemini");
    expect(reportedPlan.pools[1].id).toBe("other");
  } finally {
    await d.close();
  }
});
