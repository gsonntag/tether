import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolPart } from "../../../../shared/transcript";
import { HARNESS_BINS } from "../detect";
import { TestSink } from "../codex/testSink";
import { AgyDriver } from "./driver";

const dir = mkdtempSync(join(tmpdir(), "tether-agy-"));
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
