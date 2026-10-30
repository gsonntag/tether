// `!` commands from the composer (SPEC §9 Shell commands). `!npm test` runs at once as a one-off
// `$SHELL -c` in the session's folder, here on the runner, whatever the agent is doing: no stdin,
// no time limit, in a process group of its own so Stop ends all of it.
//
// Its card is a transcript message of the person's that only Tether has (an "n-sh-" id, kept with
// Tether's notices in notices.json): the command, its output streaming in (bounded, shared/shellRun.ts),
// how it ended, and where its output is on its way to the agent:
//
//   Running ──► Waiting in queue ──► Sent to <agent>          (or Not sent, saying why)
//
// When it ends, the command and its output go to the agent as a message through the queue (core/
// queue.ts): like any queued message it waits for a running turn to end (it never steers), obeys a
// held queue, the queue's limits and runner.json. A stopped command sends what it printed, marked
// stopped. A command the runner's stop (or crash) cut off is ended and its card says Not sent.
//
// Output is read as raw bytes and only decoded when it goes out (every 100 ms, or every second once
// the card's middle is being cut): a runaway command costs the runner little, whatever it prints.

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { jsonBytes, stripControls } from "../../../shared/limits";
import {
  OutputBuffer,
  SHELL_AGENT_HEAD,
  SHELL_AGENT_TAIL,
  SHELL_CARD_TAIL,
  SHELL_COMMAND_MAX,
  SHELL_RUNS_MAX,
  SHELL_SAVED_HEAD,
  SHELL_SAVED_TAIL,
  shellMessage,
  shellToolId,
  stripAnsi,
  type ShellRun,
} from "../../../shared/shellRun";
import type { Msg, QueuedMessage, ToolPart } from "../../../shared/transcript";
import { cleanEnv } from "../terminal/tmux";
import type { LiveControl } from "./live";
import type { OpRegistry } from "./ops";
import type { Session } from "./session";
import type { SessionCore } from "./sessions";

/** How often new output goes out (as appended deltas). */
const FLUSH_MS = 100;
/** A delta carries at most this many characters (frames stay small). */
const DELTA_MAX = 16 * 1024;
/** Once output is cut in the middle, the card's output goes out (whole) at most this often. */
const FULL_MS = 1000;
/** A running card's output is saved to notices.json at most this often (a crash keeps it). */
const SAVE_MS = 2000;
/** Stop: SIGTERM to the group, then SIGKILL after this, whatever happened meanwhile. */
export const KILL_MS = 2000;
/** After the shell exits, how long its pipes may stay open (a background job holding them). */
const DRAIN_MS = 1000;
/**
 * Output is read at most this fast (bytes a second): a runaway command (`yes`) waits on its pipe
 * instead of keeping the runner busy. What it prints is never lost, only paced.
 */
export const READ_RATE = 16 * 1024 * 1024;
/** Raw bytes waiting to be decoded are cut to the newest this many once the card's head is full. */
const RAW_KEEP = 2 * SHELL_CARD_TAIL;

interface Run {
  id: string;
  toolId: string;
  s: Session;
  command: string;
  proc?: ChildProcess;
  buf: OutputBuffer;
  /** raw output not decoded yet, in order, by stream */
  raw: { b: Buffer; err: boolean }[];
  rawBytes: number;
  decoders: { out: TextDecoder; err: TextDecoder };
  /** the end of decoded text that may be half an escape sequence (the rest comes in the next chunk) */
  carry: string;
  /** the card's output as browsers have it */
  shown: string;
  lastFull: number;
  lastSave: number;
  timer?: ReturnType<typeof setTimeout>;
  stopped: boolean;
  done: boolean;
  /** bytes read in the current tenth of a second, and when it started (READ_RATE) */
  paceBytes: number;
  paceAt: number;
  paused?: ReturnType<typeof setTimeout>;
}

export const STOPPED_WHY = "The runner stopped while it ran, so it was ended and nothing was sent.";

/** The start time of a process (/proc/<pid>/stat field 22), to tell it from a later one with its pid. */
export function procStart(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  } catch {
    return undefined;
  }
}

/** Kills a process group a crashed runner left running, when it is surely still that one. */
export function killLeftover(pgid: number | undefined, start: string | undefined) {
  if (!pgid || pgid <= 1) return;
  const now = procStart(pgid);
  // The leader is still there: only the same process (its start time matches). Gone: the group's id
  // can't have been reused while members of it live, so whatever answers to it is the command's.
  if (now !== undefined && now !== start) return;
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {}
}

export class ShellRuns {
  private runs = new Map<string, Run>();
  /** commands running or starting, by session: the limit counts these, claimed before any await */
  private slots = new Map<string, number>();
  /** finished cards' output as notices.json keeps it (smaller than the card's), by card id */
  private saved = new Map<string, string>();

  constructor(
    private core: SessionCore,
    private live: LiveControl,
    private o: { shell?: string; env?: () => Record<string, string> } = {},
  ) {
    live.queue.gone = (s, m, how) => this.queueGone(s, m, how);
    // Cards of commands a runner crash cut off: whatever still runs of them is ended, and they end
    // as not sent, never stuck at Running.
    // A card that still carries a group (a stop whose SIGKILL the runner didn't live to send): ended now.
    core.notices.rewrite((_id, m) => {
      if (m.shell?.state !== "running" && !m.shell?.pgid) return undefined;
      killLeftover(m.shell.pgid, m.shell.procStart);
      if (m.shell.state !== "running") {
        const { pgid: _p, procStart: _s, ...rest } = m.shell;
        return { ...m, shell: rest };
      }
      return cutOff(m, this.core.now());
    });
  }

  /** Runs `command` in the session's folder now; its card's message id. */
  async run(sessionId: string, command: string): Promise<{ id: string }> {
    // Control characters (but tab and newlines) never run or wait: each would take 6 bytes in a frame.
    command = stripControls(command).trim();
    if (!command) throw new Error("Type a command after the !.");
    if (jsonBytes(command) > SHELL_COMMAND_MAX) throw new Error("That command is too long.");
    // The slot is taken before anything waits, so commands sent together can't pass the limit.
    const taken = this.slots.get(sessionId) ?? 0;
    if (taken >= SHELL_RUNS_MAX) throw new Error(`At most ${SHELL_RUNS_MAX} commands can run at once here. Stop one first.`);
    this.slots.set(sessionId, taken + 1);
    let s: Session;
    try {
      s = await this.core.open(sessionId);
      if (s.summary.parentSessionId) throw new Error("Run commands from the main session.");
      const cwd = s.summary.projectPath;
      if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error(`The session's folder ${cwd} isn't there any more, so nothing ran.`);
      await this.core.load(s);
    } catch (e) {
      this.release(sessionId);
      throw e;
    }
    const now = this.core.now();
    const id = `n-sh-${randomUUID()}`;
    const toolId = shellToolId(id);
    const tool: ToolPart = { type: "tool", id: toolId, name: "Shell", kind: "shell", input: { command }, command, status: "running", output: "" };
    const run: Run = {
      id,
      toolId,
      s,
      command,
      buf: new OutputBuffer(),
      raw: [],
      rawBytes: 0,
      decoders: { out: new TextDecoder(), err: new TextDecoder() },
      carry: "",
      shown: "",
      lastFull: 0,
      lastSave: 0,
      stopped: false,
      done: false,
      paceBytes: 0,
      paceAt: 0,
    };
    this.runs.set(id, run);
    s.shellsRunning++;
    const shell = this.o.shell ?? process.env.SHELL ?? "/bin/bash";
    let proc: ChildProcess | undefined;
    let error: string | undefined;
    try {
      proc = spawn(shell, ["-c", command], {
        cwd: s.summary.projectPath,
        env: this.o.env?.() ?? cleanEnv(),
        stdio: ["ignore", "pipe", "pipe"],
        // Its own process group: Stop ends the command and everything it started.
        detached: true,
      });
    } catch (e: any) {
      error = e?.code === "ENOENT" ? `there's no shell at ${shell}` : (e?.message ?? String(e));
    }
    const pgid = proc?.pid;
    // Saved with the card: a runner that crashes can end the group when it starts again.
    const card: Msg = { id, role: "user", ts: now, parts: [tool], shell: { state: "running", startedAt: now, ...(pgid ? { pgid, procStart: procStart(pgid) } : {}) } };
    // Saved with the store's next write (within a second), not synchronously for every command.
    s.apply({ type: "msg", msg: card });
    if (!proc || error) {
      this.failed(run, error ?? "it didn't start");
      return { id };
    }
    run.proc = proc;
    proc.stdout!.on("data", (b: Buffer) => this.data(run, b, false));
    proc.stderr!.on("data", (b: Buffer) => this.data(run, b, true));
    proc.on("error", (e: any) => this.failed(run, e?.code === "ENOENT" ? `there's no shell at ${shell}` : e.message));
    let closed = false;
    proc.on("close", (code, signal) => {
      closed = true;
      void this.finish(run, code, signal);
    });
    // The shell is done, but a job it left in the background may hold its output open.
    proc.on("exit", (code, signal) =>
      setTimeout(() => {
        if (closed || run.done) return;
        proc.stdout?.destroy();
        proc.stderr?.destroy();
        void this.finish(run, code, signal);
      }, DRAIN_MS).unref?.(),
    );
    return { id };
  }

  /** Stop: the command's whole process group ends: SIGTERM, and SIGKILL 2 s later whatever happened meanwhile. */
  stop(sessionId: string, id: string) {
    const r = this.runs.get(id);
    if (!r || r.s.id !== sessionId || r.done) throw new Error("That command isn't running any more.");
    r.stopped = true;
    this.kill(r, "SIGTERM");
    // Even once the shell is gone: what it started and that ignores SIGTERM goes too.
    setTimeout(() => this.kill(r, "SIGKILL"), KILL_MS).unref?.();
  }

  /**
   * Runner shutdown: every command is ended (SIGTERM, then SIGKILL before this returns), its card
   * ends as not sent (it can't be sent now).
   */
  async stopAll(killMs = KILL_MS) {
    const all = [...this.runs.values()].filter((r) => !r.done);
    this.stopping = all;
    for (const r of all) {
      this.kill(r, "SIGTERM");
      // The card keeps its group until the SIGKILL is sent: a runner gone before that (a second
      // signal, a crash) leaves the next start to end it.
      this.end(r, { cutOff: true }, { state: "notSent", why: STOPPED_WHY }, { keepGroup: true });
    }
    this.core.notices.flush();
    if (!all.length) return;
    await Bun.sleep(killMs);
    this.killNow();
  }

  /** The groups a stop is waiting to SIGKILL, now (a second signal: the runner exits at once). */
  killNow() {
    const all = this.stopping;
    this.stopping = [];
    for (const r of all) {
      this.kill(r, "SIGKILL");
      const card = this.current(r.s, r.id);
      if (card?.shell?.pgid) {
        const { pgid: _p, procStart: _s, ...rest } = card.shell;
        this.put(r.s, { ...card, shell: rest });
      }
    }
    this.core.notices.flush();
  }

  /** runs stopAll ended and still has to SIGKILL */
  private stopping: Run[] = [];

  private kill(r: Run, sig: NodeJS.Signals) {
    const pid = r.proc?.pid;
    if (!pid) return;
    try {
      process.kill(-pid, sig);
    } catch {
      if (!r.done)
        try {
          r.proc?.kill(sig);
        } catch {}
    }
  }

  private release(sessionId: string) {
    const n = (this.slots.get(sessionId) ?? 1) - 1;
    if (n > 0) this.slots.set(sessionId, n);
    else this.slots.delete(sessionId);
  }

  // ---------------- output ----------------

  /** Raw output: kept as it came (only the newest of it once the card's head is full), decoded later. */
  private data(r: Run, b: Buffer, err: boolean) {
    if (r.done || !b.length) return;
    this.pace(r, b.length);
    r.raw.push({ b, err });
    r.rawBytes += b.length;
    // A runaway command: what can't reach the card anyway (between its head and its tail) is only counted.
    if (r.buf.headFull && r.rawBytes > 2 * RAW_KEEP) {
      let drop = 0;
      while (r.raw.length > 1 && r.rawBytes - r.raw[0]!.b.length >= RAW_KEEP) {
        const x = r.raw.shift()!;
        r.rawBytes -= x.b.length;
        drop += x.b.length;
      }
      if (drop) {
        r.buf.skip(drop);
        // Decoding starts afresh after the gap.
        r.decoders = { out: new TextDecoder(), err: new TextDecoder() };
        r.carry = "";
      }
    }
    // Before the head is full nothing can be dropped: fill it now rather than pile up raw bytes.
    else if (!r.buf.headFull && r.rawBytes > 2 * RAW_KEEP) this.decode(r);
    r.timer ??= setTimeout(() => this.flush(r), r.buf.omitted ? FULL_MS : FLUSH_MS);
  }

  /** Past READ_RATE in this tenth of a second: the pipes wait until the next one. */
  private pace(r: Run, n: number) {
    const now = Date.now();
    if (now - r.paceAt >= 100) {
      r.paceAt = now;
      r.paceBytes = 0;
    }
    r.paceBytes += n;
    if (r.paceBytes < READ_RATE / 10 || r.paused || !r.proc) return;
    r.proc.stdout?.pause();
    r.proc.stderr?.pause();
    r.paused = setTimeout(() => {
      r.paused = undefined;
      r.proc?.stdout?.resume();
      r.proc?.stderr?.resume();
    }, Math.max(1, r.paceAt + 100 - now));
  }

  /** What came in since the last time, decoded into the bounded buffer. */
  private decode(r: Run, end = false) {
    if (!r.raw.length && !end) return;
    let text = r.carry;
    for (const { b, err } of r.raw) text += (err ? r.decoders.err : r.decoders.out).decode(b, { stream: true });
    r.raw = [];
    r.rawBytes = 0;
    if (end) text += r.decoders.out.decode() + r.decoders.err.decode();
    // An escape sequence cut between two chunks: its start waits for the rest.
    const esc = end ? -1 : text.lastIndexOf("\x1b");
    if (esc >= 0 && text.length - esc < 64 && stripAnsi(text.slice(esc)).startsWith("\x1b")) {
      r.carry = text.slice(esc);
      text = text.slice(0, esc);
    } else r.carry = "";
    // Colors and other escapes go, then every other control character but tab and newlines (a NUL
    // would take 6 bytes in a frame).
    r.buf.push(stripControls(stripAnsi(text).replace(/\r\n/g, "\n")));
  }

  /** New output to the card: appended in bounded deltas, or (cut in the middle) whole, at most once a second. */
  private flush(r: Run) {
    r.timer = undefined;
    if (r.done) return;
    this.decode(r);
    const next = r.buf.text().text;
    if (next !== r.shown) {
      if (next.startsWith(r.shown)) {
        for (const piece of slices(next.slice(r.shown.length), DELTA_MAX)) r.s.apply({ type: "delta", msgId: r.id, part: 0, text: piece });
      } else {
        const wait = r.lastFull + FULL_MS - this.core.now();
        if (wait > 0) return void (r.timer = setTimeout(() => this.flush(r), wait));
        r.s.apply({ type: "tool", msgId: r.id, toolId: r.toolId, patch: { output: next } });
        r.lastFull = this.core.now();
      }
      r.shown = next;
      this.syncOverlay(r.s, r.id);
    }
    // Now and then into notices.json too: a crash keeps what it printed.
    if (this.core.now() - r.lastSave >= SAVE_MS) {
      r.lastSave = this.core.now();
      const card = this.current(r.s, r.id);
      const tool = card?.parts[0];
      if (card && tool?.type === "tool") this.core.notices.update(r.s.id, { ...card, parts: [{ ...tool, output: r.buf.text(SHELL_SAVED_HEAD, SHELL_SAVED_TAIL).text }] });
    }
  }

  // ---------------- ending ----------------

  private failed(r: Run, error: string) {
    if (r.done) return;
    r.buf.push(`Couldn't run it: ${error}.\n`);
    this.end(r, { exitCode: 127 }, { state: "notSent", why: "It couldn't start." });
  }

  private async finish(r: Run, code: number | null, signal: NodeJS.Signals | null) {
    if (r.done) return;
    const how: Partial<ShellRun> = r.stopped ? { stopped: true, ...(signal ? { signal } : {}) } : signal ? { signal } : { exitCode: code ?? 0 };
    // Waiting in the queue from now: the queue's own send (50 ms on) finds the card already there.
    const card = this.end(r, how, { state: "queued" });
    if (!card) return;
    const agent = r.buf.text(SHELL_AGENT_HEAD, SHELL_AGENT_TAIL);
    const text = shellMessage(r.command, agent.text, { ...how, omitted: agent.omitted });
    try {
      const q = await this.live.queue.add(r.s.id, text, [], { shell: { command: r.command, cardId: r.id } });
      const now = this.current(r.s, r.id);
      if (now?.shell?.state === "queued") this.put(r.s, { ...now, shell: { ...now.shell, queuedId: q.id } });
    } catch (e: any) {
      const now = this.current(r.s, r.id) ?? card;
      this.put(r.s, { ...now, shell: { ...now.shell!, state: "notSent", why: e?.message ?? String(e) } });
    }
  }

  /** The run is over: its card gets its final output and how it ended. */
  private end(r: Run, how: Partial<ShellRun>, next: Pick<ShellRun, "state" | "why">, o: { keepGroup?: boolean } = {}): Msg | undefined {
    if (r.done) return undefined;
    this.decode(r, true);
    r.done = true;
    clearTimeout(r.timer);
    this.runs.delete(r.id);
    this.release(r.s.id);
    r.s.shellsRunning = Math.max(0, r.s.shellsRunning - 1);
    // Back to the usual: it may leave memory once nothing else holds it.
    this.core.scheduleEvict(r.s);
    const card = this.current(r.s, r.id);
    if (!card?.shell) return undefined;
    const shown = r.buf.text();
    this.saved.set(r.id, r.buf.text(SHELL_SAVED_HEAD, SHELL_SAVED_TAIL).text);
    const failed = how.stopped || how.cutOff || !!how.signal || (how.exitCode ?? 0) !== 0;
    const tool = card.parts[0] as ToolPart;
    const { pgid: _p, procStart: _s, ...rest } = card.shell;
    const was = o.keepGroup ? card.shell : rest;
    const ended: Msg = {
      ...card,
      parts: [{ ...tool, output: shown.text, status: failed ? "error" : "done" }],
      shell: { ...was, ...how, ...next, omitted: shown.omitted || undefined, bytes: r.buf.total, endedAt: this.core.now() },
    };
    this.put(r.s, ended);
    return ended;
  }

  /** A waiting message left the queue: a command's card says whether the agent got it. */
  private queueGone(s: Session, m: QueuedMessage, how: "sent" | "cancelled") {
    if (!m.shell) return;
    const card = this.current(s, m.shell.cardId);
    if (!card?.shell) return;
    this.put(s, { ...card, shell: { ...card.shell, state: how === "sent" ? "sent" : "notSent", ...(how === "cancelled" ? { why: "You removed it from the queue." } : {}) } });
  }

  // ---------------- the card ----------------

  /** The card as it is now: in the transcript, else as Tether keeps it. */
  private current(s: Session, id: string): Msg | undefined {
    return s.transcript?.get(id) ?? s.overlay.find((n) => n.msg.id === id)?.msg;
  }

  /**
   * A changed card: to every device, to the session's overlay and to notices.json (smaller; written
   * at once only when it settles, Sent or Not sent, else with the store's next write).
   */
  private put(s: Session, card: Msg) {
    if (s.transcript?.get(card.id)) s.apply({ type: "msg", msg: card });
    const i = s.overlay.findIndex((n) => n.msg.id === card.id);
    if (i >= 0) s.overlay[i] = { ...s.overlay[i]!, msg: card };
    const saved = this.saved.get(card.id);
    const tool = card.parts[0];
    const small = saved !== undefined && tool?.type === "tool" ? { ...card, parts: [{ ...tool, output: saved }] } : card;
    this.core.notices.update(s.id, small);
    if (card.shell?.state === "sent" || card.shell?.state === "notSent") {
      this.core.notices.flush();
      this.saved.delete(card.id);
    }
  }

  /** The session's overlay keeps up with the transcript's copy of a running card (a store reread lays it over). */
  private syncOverlay(s: Session, id: string) {
    const m = s.transcript?.get(id);
    const i = s.overlay.findIndex((n) => n.msg.id === id);
    if (m && i >= 0) s.overlay[i] = { ...s.overlay[i]!, msg: m };
  }
}

/** A card whose command a runner crash cut off. */
function cutOff(m: Msg, now: number): Msg {
  const tool = m.parts[0];
  const { pgid: _p, procStart: _s, ...was } = m.shell!;
  return {
    ...m,
    parts: tool?.type === "tool" ? [{ ...tool, status: "error" as const }] : m.parts,
    shell: { ...was, state: "notSent", cutOff: true, why: STOPPED_WHY, endedAt: now },
  };
}

/** `s` in pieces of at most `n` characters, never splitting a surrogate pair. */
function slices(s: string, n: number): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    let end = Math.min(s.length, i + n);
    const c = s.charCodeAt(end - 1);
    if (end < s.length && c >= 0xd800 && c <= 0xdbff) end--;
    out.push(s.slice(i, end));
    i = end;
  }
  return out;
}

export function registerShellOps(ops: OpRegistry, runs: ShellRuns) {
  const str = (v: unknown, what: string): string => {
    if (typeof v !== "string" || !v) throw new Error(`${what} is required.`);
    return v;
  };
  ops.register("runShell", (a) => runs.run(str(a.sessionId, "sessionId"), typeof a.command === "string" ? a.command : ""));
  ops.register("stopShell", (a) => (runs.stop(str(a.sessionId, "sessionId"), str(a.id, "id")), null));
}
