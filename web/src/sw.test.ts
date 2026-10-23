// public/sw.js: Approve / Deny on approvals and blocked calls, and where a tap or a button goes.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(import.meta.dir, "../public/sw.js"), "utf8");

function worker() {
  const handlers: Record<string, (e: any) => void> = {};
  const shown: { title: string; options: any }[] = [];
  const opened: string[] = [];
  const self = {
    location: { origin: "https://tether.example" },
    addEventListener: (type: string, f: (e: any) => void) => (handlers[type] = f),
    skipWaiting() {},
    clients: { claim: async () => {}, matchAll: async () => [], openWindow: async (url: string) => void opened.push(url) },
    registration: { showNotification: async (title: string, options: any) => void shown.push({ title, options }) },
  };
  new Function("self", source)(self);
  const run = async (type: string, e: any) => {
    let p: Promise<unknown> | undefined;
    handlers[type]!({ ...e, waitUntil: (x: Promise<unknown>) => (p = x) });
    await p;
  };
  const push = (n: object) => run("push", { data: { json: () => n } });
  const click = (options: any, action = "") => run("notificationclick", { action, notification: { close() {}, data: options.data } });
  return { shown, opened, push, click };
}

const base = { runnerId: "r1", sessionId: "claude-code:abc", title: "t", body: "b", id: "n1" };

describe("approvals and blocked calls get Approve / Deny", () => {
  test("a permission request: actions, kept on screen; the buttons answer through the app", async () => {
    const w = worker();
    await w.push({ ...base, kind: "question", requestId: "perm1" });
    const { options } = w.shown[0]!;
    expect(options.actions).toEqual([
      { action: "approve", title: "Approve" },
      { action: "deny", title: "Deny" },
    ]);
    expect(options.requireInteraction).toBe(true);
    await w.click(options, "approve");
    await w.click(options, "deny");
    await w.click(options);
    expect(w.opened).toEqual([
      "https://tether.example/#/r/r1/s/claude-code%3Aabc?respond=request:perm1:approve",
      "https://tether.example/#/r/r1/s/claude-code%3Aabc?respond=request:perm1:deny",
      "https://tether.example/#/r/r1/s/claude-code%3Aabc?card=perm1",
    ]);
  });

  test("a blocked call: the tool", async () => {
    const w = worker();
    await w.push({ ...base, kind: "blocked", toolId: "toolu_1" });
    expect(w.shown[0]!.options.requireInteraction).toBe(true);
    await w.click(w.shown[0]!.options, "approve");
    expect(w.opened).toEqual(["https://tether.example/#/r/r1/s/claude-code%3Aabc?respond=tool:toolu_1:approve"]);
  });

  test("anything else: no actions, a tap opens the session", async () => {
    const w = worker();
    await w.push({ ...base, kind: "finished" });
    expect(w.shown[0]!.options.actions).toBeUndefined();
    expect(w.shown[0]!.options.requireInteraction).toBe(false);
    await w.click(w.shown[0]!.options);
    expect(w.opened).toEqual(["https://tether.example/#/r/r1/s/claude-code%3Aabc"]);
  });
});
