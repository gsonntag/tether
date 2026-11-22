// Forking through the module, against a harness that is only its declarations (the real adapters'
// own forks are tested beside them, on recorded stores).

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Adapter, ForkRequest } from "../../core/adapter";
import type { Msg } from "../../../../shared/transcript";
import { saveConfig } from "../../config";
import { FakeAdapter } from "../../core/fakeAdapter";
import { createRunner } from "../../core/runner";
import { Forker } from ".";

/** A harness that forks by copying its stored messages through `upTo`. */
class Forking extends FakeAdapter {
  forks: ForkRequest[] = [];
  copies: string[] = [];
  copyAll = false;
  discarded: string[] = [];
  fork: Adapter["fork"];
  constructor() {
    super();
    this.capabilities = { ...this.capabilities, fork: true };
    this.fork = {
      fork: async (r: ForkRequest) => {
        this.forks.push(r);
        const msgs = this.stored.get(r.nativeId)!.msgs;
        const id = `f${this.forks.length}`;
        this.addStored(id, r.upTo ? msgs.slice(0, msgs.findIndex((m) => m.id === r.upTo) + 1) : msgs, { title: r.title, projectPath: "/p" });
        return id;
      },
      copyInstead: () => this.copyAll,
      discard: async (n: string) => void this.discarded.push(n),
    };
  }
}

const user = (id: string, text = "q"): Msg => ({ id, role: "user", ts: 1, parts: [{ type: "text", text }] });
const reply = (id: string, text = "a"): Msg => ({ id, role: "assistant", ts: 2, parts: [{ type: "text", text }] });
const convo = [user("u1", "remember 7"), reply("a1", "ok"), user("u2", "and 9"), reply("a2", "ok")];

const stops: (() => void)[] = [];
afterEach(() => stops.splice(0).forEach((f) => f()));

function setup() {
  const a = new Forking();
  const dir = mkdtempSync(join(tmpdir(), "tether-fork-"));
  const prefsFile = join(dir, "runner.json");
  saveConfig({ runnerId: "t" }, prefsFile);
  const runner = createRunner({ url: "http://x", token: "t", runnerId: "t", name: "t", version: "0", detectHarnesses: async () => [], adapters: [a], prefsFile, core: { evictMs: 60_000 } });
  stops.push(() => runner.core.stop());
  const copied: [string, string | undefined, string][] = [];
  const forker = new Forker({ sessions: runner.look.sessions as any, log: () => {} }, async (id, upTo, title) => {
    copied.push([id, upTo, title]);
    a.addStored("c1", convo.slice(0, 2), { title, projectPath: "/p" });
    return "claude:c1";
  });
  runner.look.sessions.forker((id, o) => forker.fork(id, o));
  a.addStored("s1", convo, { title: "Numbers", projectPath: "/p" });
  return { a, runner, copied };
}

describe("forking a session", () => {
  test("the whole conversation: a stored session with the same settings and source, nothing started", async () => {
    const { a, runner } = setup();
    const s = await runner.core.open("claude:s1");
    s.setState({ model: "m1", effort: "low", permissionMode: "ask" });
    const id = await runner.look.sessions.fork("claude:s1");
    expect(id).toBe("claude:f1");
    expect(a.forks).toEqual([{ nativeId: "s1", projectPath: "/p", title: "Numbers (fork)" }]);
    // Nothing runs until its first send: no driver, no turn.
    expect(a.drivers).toHaveLength(0);
    const f = await runner.core.open(id);
    expect(f.state.mode).toBe("stored");
    expect(f.state).toMatchObject({ model: "m1", effort: "low", permissionMode: "ask" });
    expect(f.summary.forkedFrom).toEqual({ sessionId: "claude:s1", title: "Numbers" });
    expect(runner.core.o.prefs.get(id)).toMatchObject({ source: "subscription", forkedFrom: { sessionId: "claude:s1" } });
    // Listed, with where it came from.
    expect(runner.core.book.all().sessions.find((r) => r.id === id)?.forkedFrom?.sessionId).toBe("claude:s1");
    // A notice under what it took, pointing back.
    const msgs = (await runner.core.load(f)).newest(50).messages;
    expect(msgs.at(-1)).toMatchObject({ role: "notice", link: { sessionId: "claude:s1" } });
    // It took everything, so it says no more.
    expect((msgs.at(-1)!.parts[0] as any).text).toBe("Forked from “Numbers”.");
    // The original is as it was.
    expect((await a.readHistory("s1")).map((m) => m.id)).toEqual(["u1", "a1", "u2", "a2"]);
  });

  test("from a reply that ends a turn: the conversation ends there", async () => {
    const { a, runner } = setup();
    const id = await runner.look.sessions.fork("claude:s1", { messageId: "a1" });
    expect(a.forks[0]!.upTo).toBe("a1");
    expect((await a.readHistory(id.slice(7))).map((m) => m.id)).toEqual(["u1", "a1"]);
    expect((await runner.core.open(id)).summary.forkedFrom).toEqual({ sessionId: "claude:s1", messageId: "a1", title: "Numbers" });
  });

  test("anywhere else is refused, saying where a fork can end", async () => {
    const { a, runner } = setup();
    await expect(runner.look.sessions.fork("claude:s1", { messageId: "u2" })).rejects.toThrow("reply that ends a turn");
    await expect(runner.look.sessions.fork("claude:s1", { messageId: "nope" })).rejects.toThrow("isn't in the session");
    expect(a.forks).toHaveLength(0);
  });

  test("while a turn runs: its finished part, never the running turn", async () => {
    const { a, runner } = setup();
    const s = await runner.core.open("claude:s1");
    s.setState({ status: "running" });
    await runner.look.sessions.fork("claude:s1");
    expect(a.forks[0]!.upTo).toBe("a1");
    await expect(runner.look.sessions.fork("claude:s1", { messageId: "a2" })).rejects.toThrow("hasn't finished");
  });

  test("a TUI that took the session over may be mid-turn: only finished turns are forked", async () => {
    const { a, runner } = setup();
    const s = await runner.core.open("claude:s1");
    s.setState({ mode: "terminal" });
    await runner.look.sessions.fork("claude:s1");
    expect(a.forks[0]!.upTo).toBe("a1");
  });

  test("a store that ends mid-turn (a turn outside Tether) forks through its last finished turn", async () => {
    const { a, runner } = setup();
    a.addStored("s2", [...convo, user("u3", "and 11")], { title: "Busy", projectPath: "/p" });
    await runner.look.sessions.fork("claude:s2");
    expect(a.forks[0]!.upTo).toBe("a2");
    // Its notice says what it left out.
    const f = await runner.core.open("claude:f1");
    const n = (await runner.core.load(f)).newest(50).messages.at(-1)!;
    expect((n.parts[0] as any).text).toBe("Forked from “Busy”. Forked through the last finished turn; the unfinished turn after it isn't included.");
  });

  test("the fork keeps the last key and starts with fallback off", async () => {
    const { runner } = setup();
    const s = await runner.core.open("claude:s1");
    s.setState({ lastKey: "anthropic", fallbackChain: { enabled: true, steps: [{ harness: "claude", source: "anthropic", model: "sonnet" }] } });
    const id = await runner.look.sessions.fork("claude:s1");
    const p = runner.core.o.prefs.get(id);
    expect(p).toMatchObject({ lastKey: "anthropic" });
    expect(p.fallbackChain).toBeUndefined();
  });

  test("a fork of a session in a worktree is one of its users too (cleanup waits for it); a side chat isn't", async () => {
    const { runner } = setup();
    const s = await runner.core.open("claude:s1");
    runner.core.setWorktree(s, { path: "/p", branch: "tether/x", repo: "/r", known: { a: [1, 2] } });
    const id = await runner.look.sessions.fork("claude:s1");
    expect(runner.look.sessions.worktree!(id)).toEqual({ path: "/p", branch: "tether/x", repo: "/r", joined: true });
    expect(runner.look.sessions.worktreeUsers!("/p").map((u) => u.id).sort()).toEqual(["claude:s1", id].sort());
    const side = await runner.look.sessions.fork("claude:s1", { sideOf: "claude:s1" });
    expect(runner.look.sessions.worktree!(side)).toBeUndefined();
  });

  test("a fork that can't be adopted is removed, not left half-made", async () => {
    const { a, runner } = setup();
    const sessions = { ...runner.look.sessions, notice: async () => { throw new Error("disk full"); } };
    const forker = new Forker({ sessions: sessions as any, log: () => {} });
    await expect(forker.fork("claude:s1")).rejects.toThrow("disk full");
    expect(a.discarded).toEqual(["f1"]);
  });

  test("a subagent isn't forked, nor a harness that can't, nor an empty session", async () => {
    const { a, runner } = setup();
    a.addStored("child", convo, { parentSessionId: "claude:s1", projectPath: "/p" });
    await expect(runner.look.sessions.fork("claude:child")).rejects.toThrow("subagent");
    a.addStored("empty", [], { projectPath: "/p" });
    await expect(runner.look.sessions.fork("claude:empty")).rejects.toThrow("Nothing to fork");
    a.capabilities = { ...a.capabilities, fork: undefined };
    await expect(runner.look.sessions.fork("claude:s1")).rejects.toThrow("can't be forked");
  });

  test("a session its harness can't fork itself is copied, still recorded as a fork", async () => {
    const { a, runner, copied } = setup();
    a.copyAll = true;
    const id = await runner.look.sessions.fork("claude:s1", { messageId: "a1" });
    expect(copied).toEqual([["claude:s1", "a1", "Numbers (fork)"]]);
    expect(a.forks).toHaveLength(0);
    expect(id).toBe("claude:c1");
  });

  test("the op answers with the fork's id", async () => {
    const { runner } = setup();
    const { forkModule } = await import(".");
    // The real module, on this runner's context.
    await forkModule.start({ ...runner.look, bus: runner.bus, ops: runner.ops, dataDir: mkdtempSync(join(tmpdir(), "tether-fork-mod-")), log: () => {}, runnerId: "t", appUrl: "x" } as any);
    expect(await runner.ops.handle("forkSession", { sessionId: "claude:s1", messageId: "a1" })).toEqual({ ok: true, data: { sessionId: "claude:f1" } });
  });
});
