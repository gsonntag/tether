import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rules } from "../guard";
import { additionalPermissions, CODEX_MODES, CodexProcess, collaborationMode, diffPairs, unwrapShell } from "./codex";

describe("command approvals that ask for more sandbox room (experimentalApi)", () => {
  test("only real requests count", () => {
    expect(additionalPermissions({ command: "ls" })).toBeUndefined();
    expect(additionalPermissions({ additionalPermissions: null })).toBeUndefined();
    expect(additionalPermissions({ additionalPermissions: { network: null, fileSystem: { read: null, write: [], entries: null } } })).toBeUndefined();
    expect(additionalPermissions({ additionalPermissions: { network: { enabled: true }, fileSystem: null } })).toEqual({ network: { enabled: true } });
    expect(additionalPermissions({ additionalPermissions: { fileSystem: { write: ["/etc"] } } })).toEqual({ fileSystem: { write: ["/etc"] } });
  });

  test("a read-only command carrying extra permissions is not waved through by the rules", () => {
    const cwd = "/home/u/proj";
    expect(rules({ tool: "bash", input: { command: "ls" }, cwd })?.decision).toBe("allow");
    expect(rules({ tool: "request_permissions", input: { command: "ls", permissions: { network: { enabled: true } } }, cwd })).toBeUndefined();
  });
});

describe("plan mode (collaboration mode)", () => {
  test("the app-server shape", () => {
    expect(CODEX_MODES).toEqual(["default", "plan"]);
    expect(collaborationMode("plan", "gpt-5.5", "high")).toEqual({ mode: "plan", settings: { model: "gpt-5.5", reasoning_effort: "high", developer_instructions: null } });
    expect(collaborationMode("default", "gpt-5.5").settings.reasoning_effort).toBeNull();
    expect(collaborationMode("weird", "m").mode).toBe("default");
  });

  // Against the real `codex app-server` (CODEX_LIVE_TEST=1), in a scratch CODEX_HOME; no turn runs.
  test.skipIf(!process.env.CODEX_LIVE_TEST || !Bun.which("codex"))("codex app-server accepts plan mode on a thread", async () => {
    const home = mkdtempSync(join(tmpdir(), "tether-codex-home-"));
    const cwd = join(home, "proj");
    mkdirSync(cwd);
    const prev = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
    const p = new CodexProcess(cwd);
    try {
      await p.init();
      const r: any = await p.call("thread/start", { cwd, approvalPolicy: "untrusted", sandbox: "workspace-write", model: "gpt-5.5" });
      expect(r.collaborationMode?.mode ?? "default").toBe("default");
      await p.call("thread/settings/update", { threadId: r.thread.id, collaborationMode: collaborationMode("plan", r.model) });
      const back: any = await p.call("thread/settings/update", { threadId: r.thread.id, collaborationMode: collaborationMode("default", r.model) });
      expect(back).toBeDefined();
    } finally {
      p.kill();
      if (prev === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prev;
    }
  }, 60_000);
});

describe("unwrapShell", () => {
  test("bash -lc", () => expect(unwrapShell("/bin/bash -lc 'cat hello.txt'")).toBe("cat hello.txt"));
  test("escaped quote", () => expect(unwrapShell(`bash -lc 'echo '\\''hi'\\'' > a'`)).toBe("echo 'hi' > a"));
  test("double quotes", () => expect(unwrapShell(`zsh -c "echo \\"x\\""`)).toBe(`echo "x"`));
  test("plain", () => expect(unwrapShell("ls -la")).toBe("ls -la"));
  test("not a lone wrapper", () => expect(unwrapShell("bash -lc 'a' && rm -rf /")).toBe("bash -lc 'a' && rm -rf /"));
});

describe("diffPairs", () => {
  test("hunks", () =>
    expect(diffPairs("--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n keep\n-old\n+new\n@@ -9 +9 @@\n-z\n+y", "update")).toEqual([
      { oldText: "keep\nold", newText: "keep\nnew" },
      { oldText: "z", newText: "y" },
    ]));
  test("added file content", () => expect(diffPairs("hi\n", "add")).toEqual([{ oldText: "", newText: "hi\n" }]));
});
