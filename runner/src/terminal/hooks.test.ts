import { afterAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hookCommand, hookSettings, HookServer, HOOK_EVENTS, parseHook, shq, type HookReport } from "./hooks";

const dir = mkdtempSync(join(tmpdir(), "tether-hooks-"));
const servers: HookServer[] = [];
afterAll(() => servers.forEach((s) => s.stop()));

test("shell quoting survives quotes", () => {
  expect(shq("it's")).toBe(`'it'\\''s'`);
});

test("the settings add one command hook per event, and nothing else", () => {
  const s = JSON.parse(hookSettings("/x/hooks.sock", "claude:abc", "/usr/bin/curl"));
  expect(Object.keys(s)).toEqual(["hooks"]);
  expect(Object.keys(s.hooks)).toEqual([...HOOK_EVENTS]);
  const h = s.hooks.Stop[0].hooks[0];
  expect(h.type).toBe("command");
  expect(h.command).toContain("--unix-socket '/x/hooks.sock'");
  expect(h.command).toContain("s=claude%3Aabc");
  // A hook must never fail (exit 2 from a Stop hook would keep Claude going).
  expect(h.command).toEndWith("exit 0");
});

test("a hook's payload becomes a report", () => {
  expect(parseHook("claude:a", { hook_event_name: "Notification", session_id: "a", notification_type: "permission_prompt", message: "Claude needs your permission to use Bash" })).toEqual({
    sessionId: "claude:a",
    event: "Notification",
    nativeId: "a",
    notificationType: "permission_prompt",
    message: "Claude needs your permission to use Bash",
  });
  expect(parseHook("claude:a", { hook_event_name: "SessionStart", source: "clear", session_id: "b" })).toMatchObject({ source: "clear", nativeId: "b" });
  expect(parseHook(null, { hook_event_name: "Stop" })).toBeNull();
  expect(parseHook("claude:a", { nope: 1 })).toBeNull();
  expect(parseHook("claude:a", "x")).toBeNull();
});

for (const via of ["curl", "bun"] as const)
  test(`the hook command reaches the runner's socket (${via})`, async () => {
    const got: HookReport[] = [];
    const sock = join(dir, `${via}.sock`);
    const srv = new HookServer(sock, (r) => got.push(r));
    servers.push(srv);
    srv.start();
    const cmd = hookCommand(sock, "claude:x y", via === "curl" ? Bun.which("curl") : null);
    const p = Bun.spawn(["sh", "-c", cmd], { stdin: new TextEncoder().encode(JSON.stringify({ hook_event_name: "Stop", session_id: "x" })) });
    expect(await p.exited).toBe(0);
    expect(got).toEqual([{ sessionId: "claude:x y", event: "Stop", nativeId: "x" }]);
  });

test("a hook whose runner is down still exits 0", async () => {
  const p = Bun.spawn(["sh", "-c", hookCommand(join(dir, "nobody.sock"), "claude:x")], { stdin: new TextEncoder().encode("{}") });
  expect(await p.exited).toBe(0);
});

test("a stale socket file from a crashed runner is replaced", async () => {
  const sock = join(dir, "stale.sock");
  await Bun.write(sock, "");
  const got: HookReport[] = [];
  const srv = new HookServer(sock, (r) => got.push(r));
  servers.push(srv);
  srv.start();
  const res = await fetch("http://tether/hook?s=claude%3Az", { method: "POST", unix: sock, body: JSON.stringify({ hook_event_name: "UserPromptSubmit" }) } as any);
  expect(res.status).toBe(204);
  expect(got).toEqual([{ sessionId: "claude:z", event: "UserPromptSubmit" }]);
});
