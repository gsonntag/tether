// Live mode (SPEC §4): driving a session through its harness's programmatic interface. A session
// goes live when you send it something (or create it), and back to stored after 5 idle minutes
// (never while its subagents or background tasks still run) or when its process ends.
//
// Each live session's driver reports through a Sink made here: transcript events go into the
// session's transcript and out with the next seq, status changes become turnStarted/turnEnded,
// permission requests go to the request desk (core/requests.ts), and subagents become child
// sessions (SPEC §6a).

import { randomUUID } from "node:crypto";
import { sessionId as makeId } from "../../../shared/ids";
import type { HarnessId, LiveState, ModelList, Msg, RequestAnswer } from "../../../shared/transcript";
import type { Driver, Sink, StartOpts, SubagentStart } from "./adapter";
import type { RequestBroker } from "./broker";
import { RequestDesk } from "./requests";
import { Session } from "./session";
import type { SessionCore } from "./sessions";
import { Transcript } from "./transcript";

/** Idle this long, a live session's process closes. */
export const IDLE_CLOSE_MS = 5 * 60_000;

const notice = (text: string, level: Msg["level"] = "info"): Msg => ({ id: `n-${randomUUID()}`, role: "notice", level, ts: Date.now(), parts: [{ type: "text", text }] });

export class LiveControl {
  private readonly idleMs: number;
  readonly desk: RequestDesk;
  /** shutting down: drivers close, but their open requests stay saved for the next start */
  private stopping = false;

  constructor(
    private core: SessionCore,
    broker: RequestBroker,
    opts: { idleMs?: number } = {},
  ) {
    this.idleMs = opts.idleMs ?? IDLE_CLOSE_MS;
    this.desk = new RequestDesk(core, broker, { send: (id, text) => this.send(id, text), setPermissionMode: (id, mode) => this.setPermissionMode(id, mode) });
  }

  // ---------------- ops ----------------

  async newSession(args: { harness: HarnessId; projectPath: string } & StartOpts): Promise<{ sessionId: string }> {
    const a = this.core.adapter(args.harness);
    const folder = this.core.folder(args.projectPath);
    const s = this.core.create(args.harness, a.newId(), folder, { model: args.model, effort: args.effort, permissionMode: args.permissionMode });
    this.core.touch(s);
    // Started now, so a problem (not signed in, …) shows before anything is typed. A failure is
    // already in the session's state; the session still opens.
    await this.ensureDriver(s).catch(() => {});
    return { sessionId: s.id };
  }

  async send(id: string, text: string) {
    if (!text?.trim()) throw new Error("Type a message first.");
    const s = await this.core.open(id);
    if (s.summary.parentSessionId) throw new Error("Subagents can't take messages yet. Message the main session instead.");
    // Checked and claimed with no await in between, so two sends can't both start a turn.
    if (s.state.status !== "idle" || s.sending) throw new Error("Claude is still working. Stop it first, or wait for it to finish.");
    const me = {};
    s.sending = me;
    // Running from now: starting Claude can take seconds, and Stop works meanwhile (cancelSend).
    this.status(s, "running");
    try {
      await this.core.load(s);
      const d = await this.ensureDriver(s);
      // Stopped before the message went out (interrupt already set idle and freed the session).
      if (s.cancelSend === me) return;
      this.core.touch(s, { updatedAt: this.core.now() });
      await d.send(text);
      s.fresh = false;
    } catch (e) {
      if (s.sending === me) this.status(s, "idle");
      throw e;
    } finally {
      if (s.sending === me) s.sending = undefined;
      if (s.cancelSend === me) s.cancelSend = undefined;
    }
  }

  /** A status change made by the core itself (not the driver), with the same consequences. */
  private status(s: Session, status: LiveState["status"]) {
    const before = s.state.status;
    if (s.setState({ status })) this.statusChanged(s, before);
  }

  async interrupt(id: string) {
    const s = await this.core.open(id);
    const parentId = s.summary.parentSessionId;
    if (parentId) {
      // A subagent: stop just it (SPEC §6a). Its parent's process runs it.
      this.desk.cancel((r) => r.sessionId === id);
      const parent = this.core.sessions.get(parentId);
      if (!s.childRunning || !parent?.driver?.stopSubagent) return;
      await parent.driver.stopSubagent(s.summary.nativeId);
      return;
    }
    // Whatever it asked is moot now (the harness stops waiting too).
    this.desk.stop(id);
    // Stopped while Claude is still starting: the message never goes out.
    if (s.sending && !s.driver) {
      // Free at once: a send right after this goes ahead (on the same start).
      s.cancelSend = s.sending;
      s.sending = undefined;
      return this.status(s, "idle");
    }
    await s.driver?.interrupt();
  }

  async setModel(id: string, model: string) {
    await this.setting(id, { model }, (d) => d.setModel(model));
  }

  async setEffort(id: string, effort: string) {
    await this.setting(id, { effort }, (d) => d.setEffort?.(effort) ?? Promise.resolve());
  }

  async setPermissionMode(id: string, mode: string) {
    await this.setting(id, { permissionMode: mode }, (d) => d.setPermissionMode(mode));
  }

  /** A person answers a request (SPEC §7); the first answer wins. */
  async answerRequest(_sessionId: string, requestId: string, a: RequestAnswer) {
    this.desk.answer(requestId, a);
  }

  async listModels(harness: HarnessId, sessionId?: string): Promise<ModelList> {
    const s = sessionId ? this.core.sessions.get(sessionId) : undefined;
    return this.core.adapter(s?.summary.harness ?? harness).listModels(s?.driver);
  }

  /** Closes every live session (runner shutdown): their harnesses flush their stores. */
  async closeAll() {
    // What's open now is asked again after the restart: it stays saved.
    this.stopping = true;
    this.desk.broker.freeze();
    await Promise.all([...this.core.sessions.values()].filter((s) => s.driver).map((s) => this.close(s)));
  }

  // ---------------- lifecycle ----------------

  private async setting(id: string, patch: StartOpts, apply: (d: Driver) => Promise<void>) {
    const s = await this.core.open(id);
    if (s.summary.parentSessionId) throw new Error("A subagent runs with its parent's settings.");
    this.core.o.prefs.set(id, { projectPath: s.summary.projectPath, ...patch });
    s.setState(patch);
    // Starting with the old settings right now: applied as soon as it's up.
    const d = s.driver ?? (s.starting ? await s.starting.catch(() => undefined) : undefined);
    if (d) await apply(d);
  }

  /** The session's driver, starting or resuming the harness when it isn't live. */
  private ensureDriver(s: Session): Promise<Driver> {
    if (s.driver) return Promise.resolve(s.driver);
    s.starting ??= this.startDriver(s).finally(() => (s.starting = undefined));
    return s.starting;
  }

  private async startDriver(s: Session): Promise<Driver> {
    const a = this.core.adapter(s.summary.harness);
    const opts: StartOpts = { model: s.state.model, effort: s.state.effort, permissionMode: s.state.permissionMode };
    // Live from here: its own events, not the store, update the transcript.
    s.unwatch?.();
    s.unwatch = undefined;
    const sink = this.sink(s);
    let d: Driver;
    try {
      d = s.fresh ? await a.start(s.summary.projectPath, s.summary.nativeId, opts, sink) : await a.resume(s.summary.nativeId, s.summary.projectPath, opts, sink);
    } catch (e: any) {
      const error = e?.message ?? String(e);
      s.apply({ type: "msg", msg: notice(`Couldn't start ${s.summary.harness === "claude" ? "Claude Code" : s.summary.harness}: ${error}`, "error") });
      // Not live after all: stored, tailing its store if someone watches it, and evictable.
      s.setState({ error, mode: "stored", status: "idle" });
      this.core.touch(s);
      this.core.tail(s);
      this.core.scheduleEvict(s);
      throw e;
    }
    s.driver = d;
    d.onExit = (error) => {
      if (s.driver !== d) return;
      if (error) s.apply({ type: "msg", msg: notice(error, "error") });
      this.toStored(s, error);
    };
    this.setMode(s, "live", { error: undefined });
    this.scheduleIdle(s);
    return d;
  }

  private async close(s: Session) {
    const d = s.driver;
    if (!d) return;
    try {
      await d.close();
    } catch {}
    if (s.driver === d) this.toStored(s);
  }

  private toStored(s: Session, error?: string) {
    s.driver = undefined;
    // Calls still running died with the process: failed, not spinning (as the store reads, notices.ts settleStopped).
    for (const m of s.transcript?.messages ?? [])
      for (const p of m.parts) if (p.type === "tool" && p.status === "running") s.apply({ type: "tool", msgId: m.id, toolId: p.id, patch: { status: "error" } });
    // Nobody waits on its requests any more (restored ones stay until answered or stopped).
    if (!this.stopping) this.desk.cancel((_r, chain, restored) => !restored && chain.at(-1) === s.id);
    clearTimeout(s.idleTimer);
    // Its subagents ran in its process: they're done too.
    for (const c of this.core.sessions.values()) if (c.summary.parentSessionId === s.id && c.childRunning) this.childEnded(c);
    this.setMode(s, "stored", { status: "idle", ...(error ? { error } : {}) });
    if (s.fresh) {
      // Never got a message: nothing of it is in any store.
      this.core.book.remove([s.id]);
      this.core.sessions.delete(s.id);
      return;
    }
    this.core.tail(s);
    this.core.scheduleEvict(s);
  }

  private setMode(s: Session, mode: LiveState["mode"], extra: Partial<LiveState> = {}) {
    const from = s.state.mode;
    s.setState({ mode, ...extra });
    this.core.touch(s);
    if (from !== mode) this.core.o.bus.emit("modeChanged", { sessionId: s.id, from, to: mode });
  }

  private scheduleIdle(s: Session) {
    clearTimeout(s.idleTimer);
    s.idleTimer = setTimeout(() => {
      if (!s.driver) return;
      // Not while a turn, a subagent or a background task runs: look again later.
      if (s.state.status !== "idle" || s.driver.busy()) return this.scheduleIdle(s);
      void this.close(s);
    }, this.idleMs);
    s.idleTimer.unref?.();
  }

  // ---------------- sinks ----------------

  /** Where a session's driver reports. */
  private sink(s: Session): Sink {
    const core = this.core;
    const bus = core.o.bus;
    return {
      event: (e) => {
        const out = s.apply(e);
        if (out?.type === "msg") bus.emit("message", { sessionId: s.id, msg: out.msg });
        if (out?.type === "tool") {
          const tool = s.transcript?.get(e.type === "tool" ? e.msgId : "")?.parts.find((p) => p.type === "tool" && p.id === (e as any).toolId);
          if (tool?.type === "tool") bus.emit("toolCall", { sessionId: s.id, msgId: (e as any).msgId, tool });
        }
      },
      message: (id) => s.transcript?.get(id),
      state: (patch) => {
        const before = s.state.status;
        const changed = s.setState(patch);
        if (!changed) return;
        if (changed.status && changed.status !== before) this.statusChanged(s, before);
        else if (changed.model || changed.modelResolved || changed.permissionMode) core.touch(s);
        // The harness changed its own mode (a plan approved): kept, so the next start uses it.
        if (changed.permissionMode && !s.summary.parentSessionId) core.o.prefs.set(s.id, { projectPath: s.summary.projectPath, permissionMode: changed.permissionMode });
      },
      request: (r, signal) => this.desk.ask(s, r, signal),
      nativeId: (id) => {
        if (id !== s.summary.nativeId) core.log(`${s.id}: the harness calls it ${id}`);
      },
      subagent: (start) => this.child(s, start),
      ended: () => {},
    };
  }

  private statusChanged(s: Session, before: LiveState["status"]) {
    const bus = this.core.o.bus;
    const now = s.state.status;
    // Kept in runner.json, so a turn cut off by a restart is reported when the session reopens.
    if (!s.summary.parentSessionId && (now === "idle") !== (before === "idle")) this.core.o.prefs.set(s.id, { projectPath: s.summary.projectPath, running: now === "idle" ? undefined : true });
    if (now === "running" && before !== "running") bus.emit("turnStarted", { sessionId: s.id });
    if (now === "idle") {
      bus.emit("turnEnded", { sessionId: s.id, error: s.state.error });
      this.scheduleIdle(s);
      void this.refreshTitle(s);
    }
    this.core.touch(s, { updatedAt: this.core.now() });
  }

  /** The harness names sessions itself (Claude writes a title after the first turn). */
  private async refreshTitle(s: Session) {
    if (s.summary.parentSessionId) return;
    const info = await this.core.adapter(s.summary.harness).sessionInfo(s.summary.nativeId, s.summary.projectPath).catch(() => undefined);
    if (info?.title && info.title !== s.summary.title) this.core.touch(s, { title: info.title });
  }

  /** A subagent started: it becomes a session of its own, live while it runs (SPEC §6a). */
  private child(parent: Session, start: SubagentStart): Sink {
    const id = makeId(parent.summary.harness, start.nativeId);
    let c = this.core.sessions.get(id);
    const now = this.core.now();
    if (!c) {
      c = new Session(
        {
          id,
          harness: parent.summary.harness,
          nativeId: start.nativeId,
          projectPath: parent.summary.projectPath,
          title: start.title || "Subagent",
          mode: "live",
          status: "running",
          updatedAt: now,
          parentSessionId: parent.id,
          parentToolId: start.parentToolId,
          ...(start.agentType ? { agentType: start.agentType } : {}),
        },
        { mode: "live", status: "running", requests: [], queue: [], model: parent.state.model, permissionMode: parent.state.permissionMode },
        parent.capabilities,
        this.core.out,
      );
      this.core.add(c);
    }
    const first: Msg[] = start.prompt ? [{ id: `${start.nativeId}:prompt`, role: "user", ts: now, parts: [{ type: "text", text: start.prompt }] }] : [];
    if (!c.transcript || c.transcript.length === 0) c.transcript = new Transcript(first);
    c.childRunning = true;
    c.setState({ mode: "live", status: "running" });
    this.core.touch(c, { updatedAt: now });
    // The parent's tool card links to it.
    const at = parent.transcript?.findTool(start.parentToolId);
    if (at) parent.apply({ type: "tool", msgId: at.msg.id, toolId: start.parentToolId, patch: { childSessionId: id } });
    const child = c;
    const sink = this.sink(child);
    return {
      ...sink,
      // A subagent's status follows its task, not turns.
      state: (patch) => {
        const { status: _, ...rest } = patch;
        if (Object.keys(rest).length) child.setState(rest);
      },
      ended: () => this.childEnded(child),
    };
  }

  private childEnded(c: Session) {
    if (!c.childRunning) return;
    c.childRunning = false;
    if (!this.stopping) this.desk.cancel((r, _chain, restored) => !restored && r.sessionId === c.id);
    c.setState({ mode: "stored", status: "idle" });
    this.core.touch(c, { updatedAt: this.core.now() });
    this.core.o.bus.emit("turnEnded", { sessionId: c.id });
    this.core.scheduleEvict(c);
  }
}
