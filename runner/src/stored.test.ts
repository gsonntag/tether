// Sessions that aren't running: opening one shows its stored conversation and saved settings
// without starting the agent; settings changed meanwhile apply when it starts.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Msg, SessionSummary } from "../../web/src/shared/protocol";

if (!process.env.TETHER_TEST_ROOT) process.env.TETHER_CONFIG_DIR = mkdtempSync(join(tmpdir(), "tether-stored-"));
const { settingChange, storedSnapshot, storedState, StoredSessions } = await import("./stored");
const { LiveSession, storedSlashMenu } = await import("./session");
const { config, prefs } = await import("./config");

const summary = (updatedAt: number, id = "claude-code:abc"): SessionSummary => ({
  id,
  harness: "claude-code",
  nativeId: id.split(":")[1]!,
  projectPath: "/tmp/p",
  title: "T",
  createdAt: 1,
  updatedAt,
  live: false,
  status: "idle",
});
const toolMsg = (): Msg => ({ id: "a1", role: "assistant", ts: 1, parts: [{ type: "tool", id: "t1", name: "Bash", input: { command: "ls" }, status: "done" }] });

describe("storedState", () => {
  test("idle with the saved settings; the store fills what Tether didn't keep", () => {
    const st = storedState({
      prefs: { model: "haiku", thinking: "low", guard: "ask", chain: ["claude-code:opus"], profile: "p", checkpoints: [{ id: "c1", sha: "s", ts: 1, label: "x" }], pending: [{ id: "q", text: "hi", mode: "followUp", ts: 1 }] },
      history: { model: "claude-opus-4", permissionMode: "plan", context: { used: 1000, max: 200_000, model: "haiku" } },
      modes: ["default", "plan"],
      plans: { p1: { held: 5 } },
      defaultGuard: "auto",
    });
    expect(st).toMatchObject({ status: "idle", model: "haiku", thinking: "low", permissionMode: "plan", modes: ["default", "plan"], guard: "ask", chain: ["claude-code:opus"], profile: "p", preferEarlier: true, activity: [], plans: { p1: { held: 5 } }, pendingUi: [] });
    expect(st.context?.used).toBe(1000);
    expect(st.checkpoints).toHaveLength(1);
    // Nothing waits or runs on a session without its agent.
    expect(st.pending).toBeUndefined();
    expect("thinkingLevels" in st).toBe(false);
  });

  test("defaults: the configured guard, no context when none is known", () => {
    const st = storedState({ history: {}, defaultGuard: "edits" });
    expect(st.guard).toBe("edits");
    expect(st.context).toBeUndefined();
    expect(st.modes).toBeUndefined();
  });

  test("the context of the last request moves into a model chosen since", () => {
    const st = storedState({ prefs: { model: "claude-sonnet-5-0", context: { used: 5000, max: 200_000, model: "claude-sonnet-4-5" } }, history: {}, defaultGuard: "auto" });
    expect(st.context).toMatchObject({ used: 5000, max: 1_000_000, model: "claude-sonnet-5-0" });
  });

  test("the snapshot says it isn't running", () => {
    const snap = storedSnapshot({ ...summary(1), live: true, status: "running", needsInput: true }, { messages: [] }, storedState({ history: {}, defaultGuard: "auto" }), 7);
    expect(snap.session).toMatchObject({ live: false, status: "idle", needsInput: false });
    expect(snap.seq).toBe(7);
  });
});

describe("settingChange", () => {
  test("a model clears the chain; a chain or profile picks its first model in this harness", () => {
    expect(settingChange("claude-code", { op: "model", model: "haiku" })).toEqual({ profile: undefined, chain: undefined, model: "haiku" });
    expect(settingChange("claude-code", { op: "chain", chain: ["claude-code:sonnet", "pi:x/y"], preferEarlier: false })).toEqual({ chain: ["claude-code:sonnet", "pi:x/y"], profile: undefined, preferEarlier: false, model: "sonnet" });
    // Another harness first: the model stays (a handoff happens when it next sends).
    expect(settingChange("claude-code", { op: "chain", chain: ["pi:x/y"] })).toEqual({ chain: ["pi:x/y"], profile: undefined });
    expect(settingChange("pi", { op: "model", profile: "luna" })).toMatchObject({ profile: "luna", model: "openai-codex/gpt-6-luna" });
    expect(() => settingChange("pi", { op: "model", profile: "nope" })).toThrow(/No model profile/);
  });

  test("effort, mode and guard", () => {
    expect(settingChange("codex", { op: "thinking", level: "high" })).toEqual({ thinking: "high" });
    expect(settingChange("codex", { op: "mode", mode: "plan" })).toEqual({ permissionMode: "plan" });
    expect(settingChange("codex", { op: "guard", mode: "full" })).toEqual({ guard: "full" });
  });
});

describe("StoredSessions", () => {
  test("reads a conversation once per version, tags its tools, and reads again when it moved", async () => {
    let reads = 0;
    const s = new StoredSessions(async () => (reads++, { messages: [toolMsg()] }));
    const h = await s.history(summary(10));
    expect((h!.messages[0]!.parts[0] as any).kind).toBe("shell");
    await s.history(summary(10));
    expect(reads).toBe(1);
    await s.history(summary(11));
    expect(reads).toBe(2);
    expect(s.path("claude-code:abc")).toBe("/tmp/p");
  });

  test("a failed or impossible read is tried again", async () => {
    let n = 0;
    const s = new StoredSessions(async () => {
      n++;
      if (n === 1) throw new Error("locked");
      return n === 2 ? undefined : { messages: [] };
    });
    await expect(s.history(summary(1))).rejects.toThrow("locked");
    expect(await s.history(summary(1))).toBeUndefined();
    expect(await s.history(summary(1))).toEqual({ messages: [] });
    expect(n).toBe(3);
  });

  test("keeps a bounded number", async () => {
    let reads = 0;
    const s = new StoredSessions(async () => (reads++, { messages: [] }));
    for (let i = 0; i <= StoredSessions.MAX_CACHED; i++) await s.history(summary(1, `claude-code:s${i}`));
    await s.history(summary(1, "claude-code:s0"));
    expect(reads).toBe(StoredSessions.MAX_CACHED + 2);
  });

  test("event numbers go on across the process stopping, changes and a new process", () => {
    const s = new StoredSessions(async () => undefined);
    expect(s.seq("x")).toBe(0);
    s.closed("x", 41, "/tmp/p");
    expect(s.nextSeq("x")).toBe(42);
    s.closed("x", 3); // never back
    expect(s.seq("x")).toBe(42);
    expect(s.path("x")).toBe("/tmp/p");
  });
});

// ---- with a session ----

const sink = { emit: (..._a: any[]) => {}, summary: () => {}, handoff: async () => {} };
const sessions: InstanceType<typeof LiveSession>[] = [];
afterEach(() => sessions.splice(0).forEach((s) => s.close()));

function fake(nativeId = crypto.randomUUID(), commands: { name: string; description?: string }[] = []) {
  const log: string[] = [];
  const events: number[] = [];
  class Fake extends LiveSession {
    async start() {
      this.setState({ status: "idle", model: "default", thinking: "high", thinkingLevels: ["low", "high"], modes: ["default", "plan"], permissionMode: "default" });
    }
    protected async send() {}
    async abort() {}
    async applyModel(m: string) {
      log.push(`model ${m}`);
      this.setState({ model: m });
    }
    async setThinking(l: string) {
      log.push(`effort ${l}`);
      this.setState({ thinking: l });
    }
    async setPermissionMode(m: string) {
      log.push(`mode ${m}`);
      this.setState({ permissionMode: m });
    }
    async rename() {}
    async listCommands() {
      return commands;
    }
    async continueTurn() {}
    protected shutdown() {}
  }
  const s = new Fake("claude-code", { nativeId, projectPath: "/tmp/stored-proj" }, { ...sink, emit: (_id: string, seq: number) => events.push(seq) });
  sessions.push(s);
  return { s, log, events };
}

describe("a session that isn't running", () => {
  test("its modes and effort levels are kept for its pickers", async () => {
    const { s } = fake();
    await s.start();
    s.loadPrefs();
    expect(prefs(s.id)).toMatchObject({ modes: ["default", "plan"], thinkingLevels: ["low", "high"] });
  });

  test("settings changed while closed are applied when it starts, its events numbered on", async () => {
    const id = crypto.randomUUID();
    const sid = `claude-code:${id}`;
    Object.assign(prefs(sid), settingChange("claude-code", { op: "model", model: "haiku" }), settingChange("claude-code", { op: "thinking", level: "low" }), settingChange("claude-code", { op: "mode", mode: "plan" }));
    // Read before it starts, as getLive does: starting saves its defaults over them.
    const { model, thinking, permissionMode } = config().sessions[sid]!;
    const { s, log, events } = fake(id);
    s.seq = 12; // as getLive does
    await s.start();
    s.loadPrefs();
    await s.reapplyChoices({ model, thinking, permissionMode });
    expect(log).toEqual(["model haiku", "effort low", "mode plan"]);
    expect(events[0]).toBe(13);
  });

  test("its / menu has the commands its harness reported when it last ran", async () => {
    const { s } = fake(undefined, [{ name: "compact", description: "Compact" }]);
    await s.start();
    await s.slashMenu();
    expect(storedSlashMenu("claude-code", "/tmp/stored-proj").some((c) => c.name === "compact" && c.kind === "command")).toBe(true);
    // elsewhere, what it reported anywhere
    expect(storedSlashMenu("claude-code", "/tmp/elsewhere").some((c) => c.name === "compact")).toBe(true);
    expect(storedSlashMenu("kiro", "/tmp/stored-proj").some((c) => c.name === "compact")).toBe(false);
  });

  test("its changes are read from its saved checkpoints", async () => {
    const { sessionFiles } = await import("./session");
    const f = sessionFiles({ projectPath: "/tmp/stored-proj", checkpoints: [{ id: "c1", sha: "abc", ts: 1, label: "x" }] });
    await expect(f.diff("missing")).rejects.toThrow(/no longer kept/);
  });
});
