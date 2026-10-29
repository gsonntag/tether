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
// stopped. A command the runner's restart cut off ends as Not sent.

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { utf8Length } from "../../../shared/limits";
import {
  OutputBuffer,
  SHELL_AGENT_HEAD,
  SHELL_AGENT_TAIL,
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
/** Once output is cut in the middle, the whole card's output goes out at most this often. */
const FULL_MS = 1000;
/** Stop: SIGTERM to the group, then SIGKILL after this. */
const KILL_MS = 2000;
/** After the shell exits, how long its pipes may stay open (a background job holding them). */
const DRAIN_MS = 1000;

interface Run {
  id: string;
  toolId: string;
  s: Session;
  command: string;
  proc?: ChildProcess;
  buf: OutputBuffer;
  /** the card's output as browsers have it */
  shown: string;
  lastFull: number;
  timer?: ReturnType<typeof setTimeout>;
  stopped: boolean;
  done: boolean;
}

export const RESTART_WHY = "The runner restarted while it ran, so it was stopped and nothing was sent.";

export class ShellRuns {
  private runs = new Map<string, Run>();
  /** finished cards' output as notices.json keeps it (smaller than the card's), by card id */
  private saved = new Map<string, string>();

  constructor(
    private core: SessionCore,
    private live: LiveControl,
    private o: { shell?: string; env?: () => Record<string, string> } = {},
  ) {
    live.queue.gone = (s, m, how) => this.queueGone(s, m, how);
    // Cards of commands a runner restart (or crash) cut off: ended, never stuck at Running.
    core.notices.rewrite((_id, m) => (m.shell?.state === "running" ? cutOff(m, this.core.now()) : undefined));
  }

  /** Runs `command` in the session's folder now; its card's message id. */
  async run(sessionId: string, command: string): Promise<{ id: string }> {
    command = command.trim();
    if (!command) throw new Error("Type a command after the !.");
    if (utf8Length(command) > SHELL_COMMAND_MAX) throw new Error("That command is too long.");
    const s = await this.core.open(sessionId);
    if (s.summary.parentSessionId) throw new Error("Run commands from the main session.");
    if (s.shellsRunning >= SHELL_RUNS_MAX) throw new Error(`At most ${SHELL_RUNS_MAX} commands can run at once here. Stop one first.`);
    await this.core.load(s);
    const now = this.core.now();
    const id = `n-sh-${randomUUID()}`;
    const toolId = shellToolId(id);
    const tool: ToolPart = { type: "tool", id: toolId, name: "Shell", kind: "shell", input: { command }, command, status: "running", output: "" };
    const card: Msg = { id, role: "user", ts: now, parts: [tool], shell: { state: "running", startedAt: now } };
    const run: Run = { id, toolId, s, command, buf: new OutputBuffer(), shown: "", lastFull: 0, stopped: false, done: false };
    this.runs.set(id, run);
    s.shellsRunning++;
    s.apply({ type: "msg", msg: card });
    this.core.notices.flush();
    let proc: ChildProcess;
    try {
      proc = spawn(this.o.shell ?? process.env.SHELL ?? "/bin/bash", ["-c", command], {
        cwd: s.summary.projectPath,
        env: this.o.env?.() ?? cleanEnv(),
        stdio: ["ignore", "pipe", "pipe"],
        // Its own process group: Stop ends the command and everything it started.
        detached: true,
      });
    } catch (e: any) {
      this.failed(run, e?.message ?? String(e));
      return { id };
    }
    run.proc = proc;
    const out = new TextDecoder();
    const err = new TextDecoder();
    proc.stdout!.on("data", (b: Buffer) => this.data(run, out.decode(b, { stream: true })));
    proc.stderr!.on("data", (b: Buffer) => this.data(run, err.decode(b, { stream: true })));
    proc.on("error", (e) => this.failed(run, e.message));
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

  /** Stop: the command's whole process group ends (SIGTERM, then SIGKILL). */
  stop(sessionId: string, id: string) {
    const r = this.runs.get(id);
    if (!r || r.s.id !== sessionId || r.done) throw new Error("That command isn't running any more.");
    r.stopped = true;
    this.kill(r, "SIGTERM");
    setTimeout(() => !r.done && this.kill(r, "SIGKILL"), KILL_MS).unref?.();
  }

  /** Runner shutdown: every command stops, its card ends as not sent (it can't be sent now). */
  stopAll() {
    for (const r of this.runs.values()) {
      if (r.done) continue;
      r.stopped = true;
      this.kill(r, "SIGTERM");
      this.end(r, { stopped: true }, { state: "notSent", why: RESTART_WHY });
    }
    this.core.notices.flush();
  }

  private kill(r: Run, sig: NodeJS.Signals) {
    const pid = r.proc?.pid;
    if (!pid) return;
    try {
      process.kill(-pid, sig);
    } catch {
      try {
        r.proc?.kill(sig);
      } catch {}
    }
  }

  // ---------------- output ----------------

  private data(r: Run, text: string) {
    if (r.done || !text) return;
    r.buf.push(stripAnsi(text).replace(/\r\n/g, "\n"));
    r.timer ??= setTimeout(() => this.flush(r), FLUSH_MS);
  }

  /** New output to the card: appended in bounded deltas, or (cut in the middle) whole, at most once a second. */
  private flush(r: Run) {
    r.timer = undefined;
    if (r.done) return;
    const next = r.buf.text().text;
    if (next === r.shown) return;
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

  // ---------------- ending ----------------

  private failed(r: Run, error: string) {
    if (r.done) return;
    r.buf.push(`Couldn't run it: ${error}\n`);
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
  private end(r: Run, how: Partial<ShellRun>, next: Pick<ShellRun, "state" | "why">): Msg | undefined {
    r.done = true;
    clearTimeout(r.timer);
    this.runs.delete(r.id);
    r.s.shellsRunning = Math.max(0, r.s.shellsRunning - 1);
    // Back to the usual: it may leave memory once nothing else holds it.
    this.core.scheduleEvict(r.s);
    const card = this.current(r.s, r.id);
    if (!card?.shell) return undefined;
    const shown = r.buf.text();
    this.saved.set(r.id, r.buf.text(SHELL_SAVED_HEAD, SHELL_SAVED_TAIL).text);
    const failed = how.stopped || !!how.signal || (how.exitCode ?? 0) !== 0;
    const tool = card.parts[0] as ToolPart;
    const ended: Msg = {
      ...card,
      parts: [{ ...tool, output: shown.text, status: failed ? "error" : "done" }],
      shell: { ...card.shell, ...how, ...next, omitted: shown.omitted || undefined, bytes: r.buf.total, endedAt: this.core.now() },
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

  /** A changed card: to every device, to the session's overlay and to notices.json (smaller). */
  private put(s: Session, card: Msg) {
    if (s.transcript?.get(card.id)) s.apply({ type: "msg", msg: card });
    const i = s.overlay.findIndex((n) => n.msg.id === card.id);
    if (i >= 0) s.overlay[i] = { ...s.overlay[i]!, msg: card };
    const saved = this.saved.get(card.id);
    const tool = card.parts[0];
    const small = saved !== undefined && tool?.type === "tool" ? { ...card, parts: [{ ...tool, output: saved }] } : card;
    this.core.notices.update(s.id, small);
    if (card.shell?.state !== "queued" || card.shell.queuedId) this.core.notices.flush();
  }

  /** The session's overlay keeps up with the transcript's copy of a running card (a store reread lays it over). */
  private syncOverlay(s: Session, id: string) {
    const m = s.transcript?.get(id);
    const i = s.overlay.findIndex((n) => n.msg.id === id);
    if (m && i >= 0) s.overlay[i] = { ...s.overlay[i]!, msg: m };
  }
}

/** A card whose command a restart cut off. */
function cutOff(m: Msg, now: number): Msg {
  const tool = m.parts[0];
  return {
    ...m,
    parts: tool?.type === "tool" ? [{ ...tool, status: "error" as const }] : m.parts,
    shell: { ...m.shell!, state: "notSent", stopped: true, why: RESTART_WHY, endedAt: now },
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
