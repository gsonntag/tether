// Hooks (hooks.ts and the hook section of session.ts): the store and its JSON, the import from
// Claude Code's settings, tool-name mapping and matchers, running fake hook scripts (exit codes,
// JSON answers, stdin, env, timeouts), and a session running PreToolUse, PostToolUse, Stop and
// UserPromptSubmit hooks. Scripts live in the scratch HOME (testenv.ts).

import { resetHome } from "./testenv";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HarnessId, Msg } from "../../web/src/shared/protocol";
import { config } from "./config";
import { capabilityMatrix } from "./connectors";
import {
  addHooks,
  claudeNativeKeys,
  codexNativeKeys,
  commandKey,
  hooksFile,
  hooksFor,
  hookTool,
  importHooks,
  listHooks,
  matches,
  parseHooks,
  resetHooksCache,
  runHooks,
  setHook,
} from "./hooks";
import { LiveSession, newId } from "./session";

let live: LiveSession[] = [];

beforeEach(() => {
  resetHome();
  resetHooksCache();
  config().sessions = {};
  config().guard = { ...(config().guard ?? {}), defaultMode: "auto" } as any;
});
afterEach(() => {
  live.splice(0).forEach((s) => s.close());
});

const home = () => process.env.HOME!;

/** A hook script in the scratch home: `body` is bash. */
function script(name: string, body: string): string {
  const dir = join(home(), "hooks");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

async function until(cond: () => unknown, ms = 5_000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(5);
  }
}

const add = (o: object) => addHooks(JSON.stringify(o));

describe("the hook store", () => {
  test("pasted JSON in Claude Code's shapes", () => {
    const one = parseHooks(JSON.stringify({ event: "PreToolUse", matcher: "Bash", hooks: [{ type: "command", command: "a.sh", timeout: 5 }] }));
    expect(one.entries).toEqual([{ event: "PreToolUse", matcher: "Bash", hooks: [{ type: "command", command: "a.sh", timeout: 5 }] }]);
    const settings = parseHooks(
      JSON.stringify({
        hooks: {
          PostToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: "fmt.sh" }] }],
          Stop: [{ hooks: [{ type: "command", command: "stop.sh" }] }],
          Notification: [{ hooks: [{ type: "command", command: "n.sh" }] }],
        },
      }),
    );
    expect(settings.entries.map((e) => [e.event, e.matcher])).toEqual([
      ["PostToolUse", "Edit|Write"],
      ["Stop", ""],
    ]);
    expect(settings.warnings.join()).toContain("Notification");
    // the bare event map, `*` as every tool, the short `command` form
    expect(parseHooks(JSON.stringify({ PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "x" }] }] })).entries[0]!.matcher).toBe("");
    expect(parseHooks(JSON.stringify({ event: "Stop", command: "s.sh" })).entries[0]!.hooks[0]!.command).toBe("s.sh");
    expect(() => parseHooks("{nope")).toThrow("valid JSON");
    expect(() => parseHooks(JSON.stringify({ event: "Nope", command: "x" }))).toThrow("must be one of");
    expect(() => parseHooks(JSON.stringify({ event: "PreToolUse", matcher: "(", command: "x" }))).toThrow("valid pattern");
    expect(() => parseHooks(JSON.stringify({ event: "Stop", hooks: [{ type: "prompt", prompt: "x" }] }))).toThrow("only commands");
  });

  test("add, edit, turn off, delete; a deleted import stays deleted, a paste brings it back", async () => {
    mkdirSync(join(home(), ".claude"), { recursive: true });
    const settings = { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "guard.sh" }] }], SessionStart: [{ hooks: [{ type: "command", command: "s.sh" }] }] } };
    writeFileSync(join(home(), ".claude", "settings.json"), JSON.stringify(settings));
    const before = readFileSync(join(home(), ".claude", "settings.json"), "utf8");

    const found = await importHooks();
    expect(found.added).toBe(1);
    expect(found.warnings.join()).toContain("SessionStart");
    expect(found.hooks[0]).toMatchObject({ event: "PreToolUse", matcher: "Bash", enabled: true, sources: ["claude:~/.claude/settings.json"], claudeNative: true });
    expect((await importHooks()).added).toBe(0); // merged, not added twice
    expect(readFileSync(join(home(), ".claude", "settings.json"), "utf8")).toBe(before); // read only
    expect((readFileSync(hooksFile()) && Bun.file(hooksFile()).size) > 0).toBe(true);

    let list = await add({ event: "Stop", command: "stop.sh" });
    expect(list).toHaveLength(2);
    const stop = list.find((h) => h.event === "Stop")!;
    expect(stop.sources).toEqual(["you"]);
    expect(stop.claudeNative).toBeUndefined();

    list = await setHook(stop.id, { json: JSON.stringify({ event: "PostToolUse", matcher: "Edit", hooks: [{ type: "command", command: "fmt.sh" }] }) });
    expect(list.find((h) => h.id === stop.id)).toMatchObject({ event: "PostToolUse", matcher: "Edit", hooks: [{ command: "fmt.sh" }] });
    await expect(setHook(stop.id, { json: JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "a" }] }], PreToolUse: [{ hooks: [{ type: "command", command: "b" }] }] } }) })).rejects.toThrow("one hook at a time");

    list = await setHook(stop.id, { enabled: false });
    expect(list.find((h) => h.id === stop.id)!.enabled).toBe(false);
    expect(hooksFor("PostToolUse", { tool: "Edit" })).toHaveLength(0);

    const imported = list.find((h) => h.event === "PreToolUse")!;
    list = await setHook(imported.id, { remove: true });
    expect(list.map((h) => h.id)).not.toContain(imported.id);
    expect((await importHooks()).added).toBe(0);
    list = await add({ event: "PreToolUse", matcher: "Bash", command: "guard.sh" });
    expect(list.some((h) => h.event === "PreToolUse" && h.sources.includes("you"))).toBe(true);
    await expect(setHook("nope", { enabled: true })).rejects.toThrow("No such hook");
  });

  test("the file is owner-only", async () => {
    await add({ event: "Stop", command: "x" });
    expect(Bun.file(hooksFile()).size).toBeGreaterThan(0);
    const { statSync } = await import("node:fs");
    expect(statSync(hooksFile()).mode & 0o777).toBe(0o600);
  });
});

describe("tool names and matchers", () => {
  test("each harness's tools as Claude Code names them", () => {
    expect(hookTool("bash", { command: "ls" })).toEqual({ name: "Bash", input: { command: "ls" } }); // codex, pi
    expect(hookTool("run_command", { CommandLine: "ls -la", Cwd: "/x" }).input.command).toBe("ls -la"); // agy
    expect(hookTool("apply_patch", { path: "/p/a.ts", edits: [] })).toMatchObject({ name: "Edit", input: { file_path: "/p/a.ts" } }); // codex
    expect(hookTool("write_to_file", { TargetFile: "/p/b.ts", CodeContent: "x" })).toMatchObject({ name: "Write", input: { file_path: "/p/b.ts", content: "x" } });
    expect(hookTool("view_file", { AbsolutePath: "/p/c.ts" })).toMatchObject({ name: "Read", input: { file_path: "/p/c.ts" } });
    expect(hookTool("read", { filePath: "/p/d.ts" })).toMatchObject({ name: "Read", input: { file_path: "/p/d.ts" } }); // opencode
    expect(hookTool("grep_search", { Query: "foo" })).toMatchObject({ name: "Grep", input: { pattern: "foo" } });
    expect(hookTool("find", {}).name).toBe("Glob");
    expect(hookTool("ls", {}).name).toBe("LS");
    expect(hookTool("read_url_content", { Url: "https://x" })).toMatchObject({ name: "WebFetch", input: { url: "https://x" } });
    expect(hookTool("web_search", { query: "q" }).name).toBe("WebSearch");
    expect(hookTool("update_plan", {}).name).toBe("TodoWrite");
    expect(hookTool("Edit", { file_path: "/x" }).name).toBe("Edit"); // already Claude's
    expect(hookTool("mcp__github__create_issue", { a: 1 })).toEqual({ name: "mcp__github__create_issue", input: { a: 1 } });
    // pi-mcp-adapter's one `mcp` tool, opencode's server_tool, tether-context everywhere
    expect(hookTool("mcp", { server: "github", tool: "create_issue", args: { a: 1 } })).toEqual({ name: "mcp__github__create_issue", input: { a: 1 } });
    expect(hookTool("github_create_issue", { a: 1 }, ["github"]).name).toBe("mcp__github__create_issue");
    expect(hookTool("tether-context_plan_set", {}).name).toBe("mcp__tether-context__plan_set");
    expect(hookTool("tether_context_goal_get", {}).name).toBe("mcp__tether-context__goal_get");
    expect(hookTool("some_tool", { x: 1 })).toEqual({ name: "some_tool", input: { x: 1 } });
  });

  test("Claude Code's matcher rules", () => {
    expect(matches("", "Bash")).toBe(true);
    expect(matches("*", "Read")).toBe(true);
    expect(matches("Bash", "Bash")).toBe(true);
    expect(matches("Bash", "BashOutput")).toBe(false);
    expect(matches("Edit|Write", "Write")).toBe(true);
    expect(matches("Edit|Write", "MultiEdit")).toBe(false);
    expect(matches("mcp__github__.*", "mcp__github__create_issue")).toBe(true);
    expect(matches("mcp__.*__write.*", "mcp__fs__write_file")).toBe(true);
    expect(matches("Notebook.*", "NotebookEdit")).toBe(true);
  });
});

describe("running hooks", () => {
  test("exit 2 denies with stderr; stdin is Claude's JSON; the env has the project and no relay token", async () => {
    const seen = join(home(), "seen.json");
    const s = script("deny.sh", `cat > ${seen}; env > ${seen}.env; echo "no rm here" >&2; exit 2`);
    await add({ event: "PreToolUse", matcher: "Bash", command: s });
    process.env.TETHER_TOKEN = "secret-relay-token";
    try {
      const o = await runHooks("PreToolUse", { session_id: "s1", tool_name: "Bash", tool_input: { command: "rm -rf x" } }, { cwd: home(), tool: "Bash" });
      expect(o).toMatchObject({ decision: "deny", reason: "no rm here", ran: 1 });
    } finally {
      delete process.env.TETHER_TOKEN;
    }
    expect(JSON.parse(readFileSync(seen, "utf8"))).toMatchObject({ session_id: "s1", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "rm -rf x" }, cwd: home() });
    const env = readFileSync(seen + ".env", "utf8");
    expect(env).toContain(`CLAUDE_PROJECT_DIR=${home()}`);
    expect(env).not.toContain("secret-relay-token");
    // a matcher that doesn't match runs nothing
    expect((await runHooks("PreToolUse", {}, { cwd: home(), tool: "Read" })).ran).toBe(0);
  });

  test("JSON answers: permission decisions, deny over allow, blocks, context, continue false", async () => {
    const allow = script("allow.sh", `echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"fine"}}'`);
    const deny = script("deny.sh", `echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"not that"}}'`);
    await add({ event: "PreToolUse", matcher: "Read", command: allow });
    expect(await runHooks("PreToolUse", {}, { cwd: home(), tool: "Read" })).toMatchObject({ decision: "allow", reason: "fine" });
    await add({ event: "PreToolUse", matcher: "Read", command: deny });
    expect(await runHooks("PreToolUse", {}, { cwd: home(), tool: "Read" })).toMatchObject({ decision: "deny", reason: "not that", ran: 2 });

    const post = script("post.sh", `echo '{"decision":"block","reason":"lint failed","hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"2 errors"}}'`);
    await add({ event: "PostToolUse", matcher: "Edit", command: post });
    expect(await runHooks("PostToolUse", {}, { cwd: home(), tool: "Edit" })).toMatchObject({ decision: "block", reason: "lint failed", context: ["2 errors"] });

    const plain = script("plain.sh", `echo "branch: main"`);
    await add({ event: "UserPromptSubmit", command: plain });
    expect(await runHooks("UserPromptSubmit", { prompt: "hi" }, { cwd: home() })).toMatchObject({ context: ["branch: main"] });

    const halt = script("halt.sh", `echo '{"continue":false,"stopReason":"budget spent","systemMessage":"heads up"}'`);
    await add({ event: "Stop", command: halt });
    expect(await runHooks("Stop", {}, { cwd: home() })).toMatchObject({ stop: "budget spent", messages: ["heads up"] });
  });

  test("other exit codes and timeouts don't block; they're reported", async () => {
    const fail = script("fail.sh", `echo oops >&2; exit 1`);
    const slow = script("slow.sh", `sleep 5`);
    await add({ event: "Stop", hooks: [{ type: "command", command: fail }, { type: "command", command: slow, timeout: 0.3 }] });
    const t0 = Date.now();
    const o = await runHooks("Stop", {}, { cwd: home() });
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect(o.decision).toBeUndefined();
    expect(o.messages.join("\n")).toContain("failed (exit 1)");
    expect(o.messages.join("\n")).toContain("oops");
    expect(o.messages.join("\n")).toContain("timed out");
  });

  test("hooks the harness runs itself are skipped", async () => {
    mkdirSync(join(home(), "proj", ".claude"), { recursive: true });
    mkdirSync(join(home(), ".claude"), { recursive: true });
    writeFileSync(join(home(), ".claude", "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "user.sh" }] }] } }));
    writeFileSync(join(home(), "proj", ".claude", "settings.local.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "local.sh" }] }] } }));
    const keys = claudeNativeKeys(join(home(), "proj"));
    expect(keys.has(commandKey("PreToolUse", "Bash", "user.sh"))).toBe(true);
    expect(keys.has(commandKey("Stop", "", "local.sh"))).toBe(true);
    await add({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "user.sh" }, { type: "command", command: "mine.sh" }] }] } });
    expect(hooksFor("PreToolUse", { tool: "Bash", skip: keys }).map((r) => r.command)).toEqual(["mine.sh"]);

    // Codex's hooks/list: only trusted, enabled command hooks count as running there
    const codex = codexNativeKeys({
      data: [
        {
          hooks: [
            { eventName: "preToolUse", handlerType: "command", command: "mine.sh", matcher: "Bash", enabled: true, trustStatus: "trusted" },
            { eventName: "stop", handlerType: "command", command: "x.sh", matcher: null, enabled: true, trustStatus: "untrusted" },
          ],
        },
      ],
    });
    expect([...codex]).toEqual([commandKey("PreToolUse", "Bash", "mine.sh")]);
  });

  test("the capability matrix says how each harness gets them", () => {
    const m = capabilityMatrix();
    expect(m["claude-code"].hooks.level).toBe("native");
    for (const h of ["codex", "pi", "opencode", "kiro", "antigravity"] as HarnessId[]) expect(m[h].hooks.level).toBe("emulated");
    expect(m.opencode.hooks.note).toContain("only on calls it asks permission for");
  });
});

/** A non-Claude harness whose turns the test ends (Tether runs the hooks for it). */
function fake(harness: HarnessId = "pi") {
  const sent: string[] = [];
  const sink = { emit: () => {}, summary: () => {}, handoff: async () => {} };
  class Fake extends LiveSession {
    async start() {}
    protected async send(text: string) {
      sent.push(text);
      this.addUserMessage(text);
      this.setState({ status: "running" });
    }
    async abort() {}
    async applyModel() {}
    async setThinking() {}
    async setPermissionMode() {}
    async rename() {}
    async listCommands() {
      return [];
    }
    async continueTurn(text = "Continue.") {
      sent.push(text);
      this.addUserMessage(text);
      this.setState({ status: "running" });
    }
    protected shutdown() {}
    reply(parts: Msg["parts"]) {
      const id = newId("a");
      this.emit({ type: "msg", msg: { id, role: "assistant", parts, ts: Date.now() } });
      return id;
    }
    endTurn(text = "Done.") {
      this.reply([{ type: "text", text }]);
      this.setState({ status: "idle" });
    }
  }
  const projectPath = join(home(), "proj");
  mkdirSync(projectPath, { recursive: true });
  const s = new Fake(harness, { nativeId: crypto.randomUUID(), projectPath }, sink);
  s.t.state.status = "idle";
  s.loadPrefs();
  live.push(s);
  return Object.assign(s, { sent });
}

const notices = (s: LiveSession) => s.t.messages.filter((m) => m.role === "notice").map((m) => `${m.title ?? ""}|${(m.parts[0] as any)?.text ?? ""}`);

describe("a session running your hooks", () => {
  test("PreToolUse denies in the guard path, by name across harnesses, and shows on the card", async () => {
    const s = fake("codex");
    const log = join(home(), "pre.log");
    await add({ event: "PreToolUse", matcher: "Bash", command: script("pre.sh", `cat >> ${log}; echo "use the make target" >&2; exit 2`) });
    await s.prompt("clean up");
    const msgId = s.reply([{ type: "tool", id: "c1", name: "bash", input: { command: "rm -rf build" }, status: "running" }]);
    const v = await s.checkTool("bash", { command: "rm -rf build" }, "c1");
    expect(v).toMatchObject({ allow: false, reason: "use the make target" });
    const card = s.t.messages.find((m) => m.id === msgId)!.parts[0] as any;
    expect(card.guard).toMatchObject({ decision: "deny", by: "hook" });
    const input = JSON.parse(readFileSync(log, "utf8"));
    expect(input).toMatchObject({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "rm -rf build" }, tool_use_id: "c1", session_id: s.id, tether: { harness: "codex", tool_name: "bash" } });
    // other tools aren't matched; "Approve & retry" lets the exact call through
    expect((await s.checkTool("read", { path: join(s.projectPath, "a.ts") })).allow).toBe(true);
    await s.approveBlocked("c1");
    expect((await s.checkTool("bash", { command: "rm -rf build" }, "c1")).allow).toBe(true);
  });

  test("a hook's allow skips the judge, but the guard's own deny rules still hold", async () => {
    const s = fake();
    await add({ event: "PreToolUse", matcher: "Bash", command: script("ok.sh", `echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}'`) });
    // an unknown program would go to the judge (turned off in tests: denied)
    expect(await s.checkTool("bash", { command: "some-deploy-tool --dry-run" })).toMatchObject({ allow: true });
    expect(await s.checkTool("bash", { command: "sudo rm -rf /" })).toMatchObject({ allow: false });
  });

  test("PostToolUse feedback goes to the agent as the call finishes", async () => {
    const s = fake();
    await add({ event: "PostToolUse", matcher: "Edit|Write", command: script("post.sh", `echo "fix the lint error on line 3" >&2; exit 2`) });
    await s.prompt("edit it");
    const msgId = s.reply([{ type: "tool", id: "e1", name: "edit", input: { path: "a.ts" }, status: "running" }]);
    s.emit({ type: "tool", msgId, toolId: "e1", patch: { status: "done", output: "ok" } });
    await until(() => (s.t.state.pending ?? []).length);
    expect(s.t.state.pending![0]!.text).toBe("PostToolUse hook feedback for Edit:\nfix the lint error on line 3");
    expect(s.t.state.pending![0]!.mode).toBe("followUp"); // this fake can't steer
    // a call that doesn't match runs nothing
    s.reply([{ type: "tool", id: "r1", name: "read", input: {}, status: "done" }]);
    await Bun.sleep(100);
    expect(s.t.state.pending).toHaveLength(1);
  });

  test("Stop sends the agent on with the reason, with stop_hook_active the second time", async () => {
    const s = fake();
    const log = join(home(), "stop.log");
    // blocks once, then lets it stop when stop_hook_active is set
    await add({ event: "Stop", command: script("stop.sh", `in=$(cat); echo "$in" >> ${log}; echo "$in" | grep -q '"stop_hook_active":true' && exit 0; echo "run the tests first" >&2; exit 2`) });
    await s.prompt("do it");
    s.endTurn("All done.");
    await until(() => s.sent.length === 2);
    expect(s.sent[1]).toBe("Stop hook feedback:\nrun the tests first");
    expect(s.t.state.status).toBe("running");
    s.endTurn("Tests pass.");
    await until(() => readFileSync(log, "utf8").trim().split("\n").length === 2);
    await Bun.sleep(100);
    expect(s.sent).toHaveLength(2);
    const [first, second] = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(first).toMatchObject({ hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: "All done." });
    expect(second).toMatchObject({ stop_hook_active: true, last_assistant_message: "Tests pass." });
  });

  test("Stop hooks don't run after Stop or a failed turn", async () => {
    const s = fake();
    const log = join(home(), "stop2.log");
    await add({ event: "Stop", command: script("stop2.sh", `cat >> ${log}`) });
    await s.prompt("go");
    await s.stop();
    s.setState({ status: "idle" });
    await Bun.sleep(150);
    expect(existsSync(log)).toBe(false);
  });

  test("UserPromptSubmit adds context, or holds the message back with the reason inline", async () => {
    const s = fake();
    await add({ event: "UserPromptSubmit", command: script("ctx.sh", `in=$(cat); echo "$in" | grep -q secret && { echo "That looks like a secret." >&2; exit 2; }; echo "On branch main"`) });
    await s.prompt("fix the bug");
    expect(s.sent[0]).toBe("fix the bug\n\n<user-prompt-submit-hook>\nOn branch main\n</user-prompt-submit-hook>");
    // the transcript shows the message as typed
    const user = s.t.messages.filter((m) => m.role === "user").pop()!;
    expect(JSON.stringify(user.parts)).not.toContain("user-prompt-submit-hook");
    s.endTurn();

    await s.prompt("here is my secret key");
    expect(s.sent).toHaveLength(1);
    expect(s.t.state.status).toBe("idle");
    expect(notices(s).join("\n")).toContain("A hook held your message back|That looks like a secret.");
  });

  test("a held-back queued message lets the next one go", async () => {
    const s = fake();
    await add({ event: "UserPromptSubmit", command: script("block.sh", `grep -q nope && { echo "not this one" >&2; exit 2; }; exit 0`) });
    await s.prompt("first");
    await s.prompt("nope", "followUp");
    await s.prompt("second", "followUp");
    s.endTurn();
    // the adapter's turn end drains the list (as each adapter does)
    expect(await (s as any).drainPending()).toBe(true);
    expect(s.sent).toEqual(["first", "second"]);
  });

  test("a message sent while a slow UserPromptSubmit hook runs waits behind it", async () => {
    const s = fake();
    await add({ event: "UserPromptSubmit", command: script("slow.sh", `in=$(cat); sleep 0.3; echo "$in" | grep -q nope && { echo "not this one" >&2; exit 2; }; exit 0`) });
    const a = s.prompt("first");
    await Bun.sleep(50);
    await s.prompt("second", "followUp");
    await a;
    expect(s.sent).toEqual(["first"]);
    expect(s.t.state.pending?.map((p) => p.text)).toEqual(["second"]);
    s.endTurn();
    expect(await (s as any).drainPending()).toBe(true);
    s.endTurn();
    // held back: what was sent meanwhile goes instead
    const b = s.prompt("nope");
    await Bun.sleep(50);
    await s.prompt("third", "followUp");
    await b;
    expect(s.sent).toEqual(["first", "second", "third"]);
    expect(s.t.state.pending ?? []).toEqual([]);
  });

  test("PreToolUse continue false denies the call and stops the agent", async () => {
    const s = fake();
    await add({ event: "PreToolUse", matcher: "Bash", command: script("halt.sh", `cat >/dev/null; echo '{"continue":false,"stopReason":"enough"}'`) });
    await s.prompt("go");
    expect(await s.checkTool("bash", { command: "ls" })).toMatchObject({ allow: false, reason: "enough" });
  });

  test("PostToolUse feedback after you press Stop waits for your next message", async () => {
    const s = fake();
    await add({ event: "PostToolUse", matcher: "Bash", command: script("late.sh", `cat >/dev/null; sleep 0.3; echo "lint failed" >&2; exit 2`) });
    await s.prompt("go");
    const msgId = s.reply([{ type: "tool", id: "b1", name: "bash", input: { command: "make" }, status: "running" }]);
    s.emit({ type: "tool", msgId, toolId: "b1", patch: { status: "done", output: "ok" } });
    await Bun.sleep(30);
    await s.stop();
    s.setState({ status: "idle" });
    await until(() => (s.t.state.pending ?? []).length);
    expect(s.sent).toEqual(["go"]);
    expect(s.t.state.status).toBe("idle");
    expect(s.t.state.pendingHeld).toBe(true);
    expect(s.t.state.pending![0]!.text).toBe("PostToolUse hook feedback for Bash:\nlint failed");
  });

  test("Claude Code: SDK hook callbacks, minus the hooks in its own settings", async () => {
    const { ClaudeSession } = await import("./adapters/claude");
    const projectPath = join(home(), "proj");
    mkdirSync(projectPath, { recursive: true });
    mkdirSync(join(home(), ".claude"), { recursive: true });
    const native = script("native.sh", `exit 2`);
    writeFileSync(join(home(), ".claude", "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: native }] }] } }));
    await importHooks();
    const s = new ClaudeSession({ nativeId: crypto.randomUUID(), projectPath }, { emit: () => {}, summary: () => {}, handoff: async () => {} } as any);
    live.push(s);
    const signal = new AbortController().signal;
    const call = (input: any, id?: string) => (s as any).runSdkHook({ session_id: "x", transcript_path: "/t", cwd: projectPath, ...input }, id, signal);
    // the imported hook is Claude's own: it runs there, not again here
    expect(await call({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "t1" }, "t1")).toEqual({});
    await add({ event: "PreToolUse", matcher: "Bash", command: script("deny.sh", `echo "not here" >&2; exit 2`) });
    expect(await call({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "t2" }, "t2")).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "not here" },
    });
    // an allow is kept for the guard, not passed to Claude (which would skip canUseTool)
    await add({ event: "PreToolUse", matcher: "Read", command: script("allow.sh", `echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}'`) });
    expect(await call({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/x" }, tool_use_id: "t3" }, "t3")).toEqual({});
    expect((s as any).hookAllows.has("t3")).toBe(true);
    await add({ event: "Stop", command: script("stop.sh", `echo "keep going" >&2; exit 2`) });
    expect(await call({ hook_event_name: "Stop", stop_hook_active: false })).toEqual({ decision: "block", reason: "keep going" });
    await add({ event: "UserPromptSubmit", command: script("ups.sh", `echo "on main"`) });
    expect(await call({ hook_event_name: "UserPromptSubmit", prompt: "hi" })).toEqual({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "on main" } });
    // events Tether doesn't run
    expect(await call({ hook_event_name: "SessionStart", source: "startup" })).toEqual({});
  });

  test("Codex on Full access still asks while you have a PreToolUse hook, so the hook sees its calls", async () => {
    const { CodexSession } = await import("./adapters/codex");
    const s = new CodexSession({ nativeId: crypto.randomUUID(), projectPath: home() }, { emit: () => {}, summary: () => {}, handoff: async () => {} } as any);
    live.push(s);
    s.t.state.guard = "full";
    expect((s as any).policy()).toEqual({ approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } });
    await add({ event: "PreToolUse", matcher: "Bash", command: "true" });
    expect((s as any).policy()).toEqual({ approvalPolicy: "untrusted", sandboxPolicy: { type: "dangerFullAccess" } });
    // ...and the guard then allows what the hook lets through
    expect((await s.checkTool("bash", { command: "some-deploy-tool" })).allow).toBe(true);
    // a hook Codex runs itself doesn't count
    (s as any).hookSkip = new Set([commandKey("PreToolUse", "Bash", "true")]);
    expect((s as any).policy().approvalPolicy).toBe("never");
  });

  test("Claude Code sessions don't run them in Tether's emulation", async () => {
    const s = fake();
    (s as any).nativeHooks = true;
    const log = join(home(), "never.log");
    await add({ event: "PreToolUse", command: script("never.sh", `cat >> ${log}`) });
    await add({ event: "UserPromptSubmit", command: script("never2.sh", `cat >> ${log}`) });
    await s.prompt("hi");
    await s.checkTool("bash", { command: "ls" });
    expect(existsSync(log)).toBe(false);
  });
});
