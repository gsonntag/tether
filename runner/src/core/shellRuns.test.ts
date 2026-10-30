// `!` commands (SPEC §9 Shell commands): run at once, a card that streams, the output to the agent
// through the queue, Stop, restarts, huge output.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
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
import { STOPPED_WHY, ShellRuns } from "./shellRuns";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((f) => f()));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
/** Everything the store keeps of `!` cards (their own files beside notices.json). */
const savedCards = (dir: string) => {
  try {
    return readdirSync(join(dir, "shell-cards"))
      .map((f) => readFileSync(join(dir, "shell-cards", f), "utf8"))
      .join("\n");
  } catch {
    return "";
  }
};
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
  cleanups.push(() => (void runs.stopAll(0), core.stop()));
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

  test("Stop kills what ignores SIGTERM, even once the shell itself has exited", async () => {
    const t = setup();
    const pidFile = join(t.dir, "stubborn2.pid");
    const { id } = await t.runs.run("claude:s1", `(trap '' TERM; sleep 30 & echo $! > ${pidFile}; wait); echo after`);
    await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "");
    const stubborn = Number(readFileSync(pidFile, "utf8").trim());
    t.runs.stop("claude:s1", id);
    await until(() => t.shell(id).state !== "running", 5000);
    await until(() => !alive(stubborn), 4000);
  });

  test("the limit holds for commands sent together", async () => {
    const t = setup();
    const all = await Promise.allSettled(Array.from({ length: 8 }, () => t.runs.run("claude:s1", "sleep 5")));
    const ok = all.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<{ id: string }>[];
    expect(ok).toHaveLength(5);
    expect(all.filter((r) => r.status === "rejected").every((r) => /At most 5/.test(String((r as PromiseRejectedResult).reason)))).toBe(true);
    for (const r of ok) t.runs.stop("claude:s1", r.value.id);
    // Slots come back as commands end.
    await until(() => ok.every((r) => t.shell(r.value.id).state !== "running"), 5000);
    const again = await t.runs.run("claude:s1", "true");
    expect(again.id).toBeTruthy();
  });

  test("an escape sequence split between two chunks never shows", async () => {
    const t = setup();
    const { id } = await t.runs.run("claude:s1", "printf 'a\\033[3'; sleep 0.3; printf '1mred\\033[0m b\\n'");
    await until(() => t.shell(id).state !== "running");
    expect(t.tool(id).output).toBe("ared b\n");
  });

  test("a folder that's gone says so", async () => {
    const t = setup();
    t.adapter.addStored("s2", [], { projectPath: join(t.dir, "nope") });
    await expect(t.runs.run("claude:s2", "ls")).rejects.toThrow(/isn't there any more/);
    // The slot it took is free again.
    expect((t.runs as any).slots.get("claude:s2")).toBeUndefined();
  });

  test("a runaway command is paced: the runner stays responsive", async () => {
    const t = setup();
    await t.core.subscribe("claude:s1");
    const { id } = await t.runs.run("claude:s1", "yes RUNAWAY");
    let lag = 0;
    let last = performance.now();
    const tick = setInterval(() => {
      const now = performance.now();
      lag = Math.max(lag, now - last - 20);
      last = now;
    }, 20);
    await Bun.sleep(1500);
    clearInterval(tick);
    t.runs.stop("claude:s1", id);
    await until(() => t.shell(id).state !== "running", 5000);
    expect(lag).toBeLessThan(250);
    expect(utf8Length(t.tool(id).output!)).toBeLessThan(PART_TEXT_MAX);
    expect(t.shell(id).omitted).toBeGreaterThan(1_000_000);
  });

  test("49 queued outputs of commands full of control characters or long ones: the session still opens", async () => {
    const t = setup();
    const s = await t.core.open("claude:s1");
    await t.live.send("claude:s1", "busy");
    const ids: string[] = [];
    for (let i = 0; i < 49; i++) {
      const command = i % 2 ? `true #${"\x01".repeat(7990)}` : `true #${"x".repeat(7900)}`;
      const { id } = await t.runs.run("claude:s1", command);
      ids.push(id);
      await until(() => t.shell(id).state === "queued" || t.shell(id).state === "notSent");
    }
    // Control characters never ran nor wait.
    expect(t.tool(ids[1]!).command).toBe("true #");
    expect(s.state.queue.length).toBe(49);
    const snap = JSON.stringify(s.snapshot(50));
    expect(snap.length).toBeLessThan(1024 * 1024);
    const wire = s.snapshot(50).state.queue;
    expect(Math.max(...wire.map((m) => JSON.stringify(m.shell?.command ?? "").length))).toBeLessThanOrEqual(520);
    // The runner keeps the command whole.
    expect(s.state.queue[0]!.shell!.command.length).toBe(7906);
  });

  test("a command of control characters is too long only by what's left of it; JSON-escaped size counts", async () => {
    const t = setup();
    await expect(t.runs.run("claude:s1", "\x01\x02")).rejects.toThrow(/Type a command/);
    await expect(t.runs.run("claude:s1", `echo ${'"'.repeat(5000)}`)).rejects.toThrow(/too long/);
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

  test("a runner stop: a running command (and what ignores SIGTERM) ends, its card Not sent, never Running", async () => {
    const t = setup();
    await t.core.subscribe("claude:s1");
    const pidFile = join(t.dir, "stubborn.pid");
    const { id } = await t.runs.run("claude:s1", `echo before; (trap '' TERM; sleep 30 & echo $! > ${pidFile}; wait); echo after`);
    await until(() => (t.tool(id).output ?? "").includes("before") && existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "");
    const stubborn = Number(readFileSync(pidFile, "utf8").trim());
    await t.runs.stopAll(300);
    expect(t.shell(id).state).toBe("notSent");
    expect(t.shell(id).why).toBe(STOPPED_WHY);
    expect(t.shell(id).cutOff).toBe(true);
    expect(t.shell(id).stopped).toBeUndefined();
    // Gone by the time stopAll returns (SIGKILL after SIGTERM).
    await until(() => !alive(stubborn), 1000);
    expect(t.driver()).toBeUndefined();
  });

  test("a second signal: the runner gone before its SIGKILL, the next start ends what ignored SIGTERM", async () => {
    const t = setup();
    await t.core.subscribe("claude:s1");
    const pidFile = join(t.dir, "stubborn3.pid");
    const { id } = await t.runs.run("claude:s1", `(trap '' TERM; sleep 30 & echo $! > ${pidFile}; wait); echo after`);
    await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "");
    const stubborn = Number(readFileSync(pidFile, "utf8").trim());
    void t.runs.stopAll(60_000);
    // The card is ended but keeps its group until the SIGKILL.
    expect(t.shell(id).state).toBe("notSent");
    expect(savedCards(t.dir)).toContain('"pgid"');
    t.core.stop();
    await Bun.sleep(200);
    expect(alive(stubborn)).toBe(true);
    // The runner died there. The next start ends the group and forgets it.
    const t2 = setup({ dir: t.dir });
    await until(() => !alive(stubborn), 2000);
    await t2.core.subscribe("claude:s1");
    expect(t2.shell(id).pgid).toBeUndefined();
    expect(t2.shell(id).state).toBe("notSent");
  });

  test("a second signal while stopping: killNow SIGKILLs at once", async () => {
    const t = setup();
    const pidFile = join(t.dir, "stubborn4.pid");
    await t.runs.run("claude:s1", `(trap '' TERM; sleep 30 & echo $! > ${pidFile}; wait); echo after`);
    await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "");
    const stubborn = Number(readFileSync(pidFile, "utf8").trim());
    void t.runs.stopAll(60_000);
    t.runs.killNow();
    await until(() => !alive(stubborn), 1000);
  });

  test("a long-running card is never dropped by later ones: a crash still finds its group", async () => {
    const t = setup();
    await t.core.subscribe("claude:s1");
    const pidFile = join(t.dir, "dev.pid");
    const { id } = await t.runs.run("claude:s1", `sleep 300 & echo $! > ${pidFile}; wait`);
    await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "");
    const dev = Number(readFileSync(pidFile, "utf8").trim());
    for (let i = 0; i < 32; i++) {
      const r = await t.runs.run("claude:s1", "true");
      await until(() => t.shell(r.id).state !== "running");
    }
    t.notices.flush();
    expect(savedCards(t.dir)).toContain(id);
    t.core.stop();
    const t2 = setup({ dir: t.dir });
    await until(() => !alive(dev), 2000);
    await t2.core.subscribe("claude:s1");
    expect(t2.shell(id).state).toBe("notSent");
  }, 30_000);

  test("NUL and binary output: no control characters in the card or the message, frames stay small", async () => {
    const t = setup();
    await t.core.subscribe("claude:s1");
    const { id } = await t.runs.run("claude:s1", "head -c 3000000 /dev/zero; head -c 3000000 /dev/urandom");
    await until(() => t.shell(id).state === "sent", 15_000);
    expect(t.tool(id).output).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/);
    expect(t.driver()!.sent.at(-1)).not.toContain("\u0000");
    const big = Math.max(...t.frames.map((f) => JSON.stringify(f).length));
    expect(big).toBeLessThan(200 * 1024);
  }, 30_000);

  test("a runner crash: the next start ends what still runs (by its saved group) and keeps what it printed", async () => {
    const t = setup();
    await t.core.subscribe("claude:s1");
    const { id } = await t.runs.run("claude:s1", "echo before-crash; sleep 30");
    await until(() => (t.tool(id).output ?? "").includes("before-crash"));
    const pgid = t.shell(id).pgid!;
    expect(pgid).toBeGreaterThan(1);
    expect(t.shell(id).procStart).toBeTruthy();
    // Saved now and then while it runs.
    await until(() => savedCards(t.dir).includes("before-crash"), 5000);
    t.core.stop();
    // The runner died without stopping anything: a new one starts on the same files.
    const t2 = setup({ dir: t.dir });
    await until(() => !alive(pgid), 2000);
    await t2.core.subscribe("claude:s1");
    expect(t2.shell(id).state).toBe("notSent");
    expect(t2.shell(id).why).toBe(STOPPED_WHY);
    expect(t2.shell(id).pgid).toBeUndefined();
    expect(t2.tool(id).output).toContain("before-crash");
  });

  test("a crash's saved group isn't killed when its pid now belongs to another process", async () => {
    const { killLeftover } = await import("./shellRuns");
    const other = Bun.spawn(["sleep", "30"]);
    killLeftover(other.pid, "not-its-start-time");
    await Bun.sleep(100);
    expect(alive(other.pid)).toBe(true);
    other.kill();
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
