// `!` commands (SPEC §9 Shell commands): run at once, a card that streams, the output to the agent
// through the queue, Stop, restarts, huge output.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerToServer } from "../../../shared/protocol";
import { SHELL_CARD_HEAD, SHELL_CARD_TAIL, type ShellRun } from "../../../shared/shellRun";
import type { Msg, ToolPart } from "../../../shared/transcript";
import { PART_TEXT_MAX, utf8Length } from "../../../shared/limits";
import { saveConfig } from "../config";
import { RequestBroker } from "./broker";
import { EventBus } from "./bus";
import type { CoreEvents } from "./events";
import { FakeAdapter, say } from "./fakeAdapter";
import { LiveControl } from "./live";
import { NoticeStore } from "./notices";
import { Prefs } from "./prefs";
import { SessionCore } from "./sessions";
import { RESTART_WHY, ShellRuns } from "./shellRuns";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((f) => f()));
const until = async (f: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(10);
  }
};

function setup(o: { dir?: string } = {}) {
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), "tether-sh-"));
  const prefsFile = join(dir, "runner.json");
  if (!existsSync(prefsFile)) saveConfig({ runnerId: "test" }, prefsFile);
  const adapter = new FakeAdapter();
  adapter.script = (text) => [say(`a-${text.slice(0, 10)}`, "ok")];
  adapter.addStored("s1", [], { projectPath: dir });
  const bus = new EventBus<CoreEvents>();
  const frames: RunnerToServer[] = [];
  const notices = new NoticeStore(join(dir, "notices.json"));
  const core = new SessionCore({ adapters: [adapter], bus, send: (m) => (frames.push(m), true), epoch: "e1", prefs: new Prefs(prefsFile, 0), notices, evictMs: 60_000, log: () => {} });
  const live = new LiveControl(core, new RequestBroker(), { idleMs: 60_000 });
  const runs = new ShellRuns(core, live, { shell: "/bin/sh" });
  cleanups.push(() => (runs.stopAll(), core.stop()));
  const driver = () => adapter.drivers.at(-1);
  const end = () => driver()!.sink.state({ status: "idle" });
  const card = (id: string) => core.sessions.get("claude:s1")!.transcript!.get(id)!;
  const shell = (id: string): ShellRun => card(id).shell!;
  const tool = (id: string) => card(id).parts[0] as ToolPart;
  return { dir, adapter, core, live, runs, frames, driver, end, card, shell, tool, notices };
}

describe("! commands", () => {
  test("run now, stream into the card, and go to the agent when done", async () => {
    const t = setup();
    // (The session subscribed, as the composer's view is.)
    await t.core.subscribe("claude:s1");
    const { id } = await t.runs.run("claude:s1", "echo one; sleep 0.3; echo two; exit 3");
    expect(t.shell(id).state).toBe("running");
    expect(t.card(id).role).toBe("user");
    await until(() => (t.tool(id).output ?? "").includes("one"));
    expect(t.shell(id).state).toBe("running");
    // Streamed as deltas on the card's tool part.
    expect(t.frames.some((f) => f.t === "event" && f.event.type === "delta" && f.event.msgId === id)).toBe(true);
    await until(() => t.shell(id).state === "sent");
    expect(t.shell(id).exitCode).toBe(3);
    expect(t.tool(id).status).toBe("error");
    expect(t.tool(id).output).toBe("one\ntwo\n");
    const sent = t.driver()!.sent[0]!;
    expect(sent).toContain("$ echo one; sleep 0.3; echo two; exit 3");
    expect(sent).toContain("exited with code 3");
    expect(sent).toContain("one\ntwo");
  });

  test("mid-turn: the output waits in the queue and goes when the turn ends (never steers)", async () => {
    const t = setup();
    await t.live.send("claude:s1", "busy");
    const { id } = await t.runs.run("claude:s1", "echo hi");
    await until(() => t.shell(id).state === "queued");
    const s = t.core.sessions.get("claude:s1")!;
    expect(s.state.queue).toHaveLength(1);
    expect(s.state.queue[0]!.shell).toEqual({ command: "echo hi", cardId: id });
    expect(t.shell(id).queuedId).toBe(s.state.queue[0]!.id);
    expect(t.driver()!.steered).toEqual([]);
    await Bun.sleep(100);
    expect(t.driver()!.sent).toEqual(["busy"]);
    t.end();
    await until(() => t.shell(id).state === "sent");
    expect(t.driver()!.sent[1]).toContain("$ echo hi");
  });

  test("a held queue holds it; cancelling it from the queue says Not sent", async () => {
    const t = setup();
    const s = await t.core.open("claude:s1");
    await t.live.send("claude:s1", "busy");
    const b = await t.runs.run("claude:s1", "echo b");
    await until(() => t.shell(b.id).state === "queued" && !!t.shell(b.id).queuedId);
    // Stop holds the queue: the output waits, untouched.
    await t.live.interrupt("claude:s1");
    t.end();
    await until(() => s.state.status === "idle");
    expect(s.state.queueHeld).toBe(true);
    await Bun.sleep(150);
    expect(t.shell(b.id).state).toBe("queued");
    expect(t.driver()!.sent).toEqual(["busy"]);
    await t.live.queue.cancel("claude:s1", t.shell(b.id).queuedId!);
    expect(t.shell(b.id).state).toBe("notSent");
    expect(t.shell(b.id).why).toMatch(/removed it from the queue/);
    // A command's output can't be edited in the queue.
    await t.live.send("claude:s1", "busy3");
    const c = await t.runs.run("claude:s1", "echo c");
    await until(() => !!t.shell(c.id).queuedId);
    await expect(t.live.queue.edit("claude:s1", t.shell(c.id).queuedId!, "x")).rejects.toThrow(/can't be edited/);
  });

  test("Stop kills the whole process group and still sends what it printed, marked stopped", async () => {
    const t = setup();
    const pidFile = join(t.dir, "child.pid");
    const { id } = await t.runs.run("claude:s1", `echo started; (sleep 30 & echo $! > ${pidFile}; wait) ; echo never`);
    await until(() => (t.tool(id).output ?? "").includes("started") && existsSync(pidFile));
    const child = Number(readFileSync(pidFile, "utf8").trim());
    t.runs.stop("claude:s1", id);
    await until(() => t.shell(id).state !== "running");
    expect(t.shell(id).stopped).toBe(true);
    await until(() => t.shell(id).state === "sent");
    expect(t.driver()!.sent[0]).toContain("I stopped it before it finished");
    expect(t.driver()!.sent[0]).toContain("started");
    // The grandchild is gone too.
    await until(() => {
      try {
        process.kill(child, 0);
        return false;
      } catch {
        return true;
      }
    });
    expect(() => t.runs.stop("claude:s1", id)).toThrow(/isn't running/);
  });

  test("huge output: the card and the agent's message stay bounded, start and end kept", async () => {
    const t = setup();
    await t.core.subscribe("claude:s1");
    const { id } = await t.runs.run("claude:s1", "seq 1 400000");
    await until(() => t.shell(id).state === "sent", 15_000);
    const out = t.tool(id).output!;
    expect(out.startsWith("1\n2\n3\n")).toBe(true);
    expect(out.endsWith("399999\n400000\n")).toBe(true);
    expect(out).toContain("cut from the middle");
    expect(utf8Length(out)).toBeLessThanOrEqual(SHELL_CARD_HEAD + SHELL_CARD_TAIL + 100);
    expect(utf8Length(out)).toBeLessThan(PART_TEXT_MAX);
    expect(t.shell(id).omitted).toBeGreaterThan(1_000_000);
    const sent = t.driver()!.sent[0]!;
    expect(utf8Length(sent)).toBeLessThan(32 * 1024);
    expect(sent).toContain("400000");
    // Every frame stayed small.
    const biggest = Math.max(...t.frames.map((f) => JSON.stringify(f).length));
    expect(biggest).toBeLessThan(200 * 1024);
  });

  test("no stdin: a command reading it gets end of file", async () => {
    const t = setup();
    const { id } = await t.runs.run("claude:s1", "cat; echo done");
    await until(() => t.shell(id).state !== "running");
    expect(t.tool(id).output).toBe("done\n");
  });

  test("subagents and empty commands are refused; at most a few at once", async () => {
    const t = setup();
    await expect(t.runs.run("claude:s1", "  ")).rejects.toThrow(/Type a command/);
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push((await t.runs.run("claude:s1", "sleep 5")).id);
    await expect(t.runs.run("claude:s1", "sleep 5")).rejects.toThrow(/At most 5/);
    for (const id of ids) t.runs.stop("claude:s1", id);
  });

  test("a runner restart: a running command ends as Not sent, never stuck at Running", async () => {
    const t = setup();
    await t.core.subscribe("claude:s1");
    const { id } = await t.runs.run("claude:s1", "echo before; sleep 30");
    await until(() => (t.tool(id).output ?? "").includes("before"));
    // A graceful stop.
    t.runs.stopAll();
    expect(t.shell(id).state).toBe("notSent");
    expect(t.shell(id).why).toBe(RESTART_WHY);
    t.core.stop();
    // A crash leaves it saved as running: the next start ends it.
    const saved: Record<string, { notices: { msg: Msg }[] }> = JSON.parse(readFileSync(join(t.dir, "notices.json"), "utf8"));
    const m = saved["claude:s1"]!.notices.find((n) => n.msg.id === id)!.msg;
    expect(m.shell!.state).toBe("notSent");
    m.shell!.state = "running";
    await Bun.write(join(t.dir, "notices.json"), JSON.stringify(saved));
    const t2 = setup({ dir: t.dir });
    await t2.core.subscribe("claude:s1");
    expect(t2.shell(id).state).toBe("notSent");
    expect(t2.shell(id).why).toBe(RESTART_WHY);
    expect(t2.tool(id).output).toContain("before");
  });

  test("the card stays put through a store reread (live to stored)", async () => {
    const t = setup();
    await t.core.subscribe("claude:s1");
    const { id } = await t.runs.run("claude:s1", "echo kept");
    await until(() => t.shell(id).state === "sent");
    t.adapter.write("s1", [{ id: "u1", role: "user", ts: 1, parts: [{ type: "text", text: "x" }] }]);
    await t.core.syncFromStore(t.core.sessions.get("claude:s1")!);
    expect(t.card(id).shell!.state).toBe("sent");
    expect(t.tool(id).output).toBe("kept\n");
  });
});
