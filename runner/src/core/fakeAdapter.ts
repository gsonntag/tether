// A fake harness for core tests: stored sessions are in memory, and its driver replays a scripted
// stream of sink calls on each send, so sync, paging and subagent tests are deterministic.

import type { HarnessCapabilities, ModelList, Msg, ProjectInfo, SessionSummary } from "../../../shared/transcript";
import type { Adapter, Decision, Driver, Sink, StartOpts } from "./adapter";

/** One step of a scripted turn: called with the session's sink. */
export type Step = (sink: Sink, d: FakeDriver) => void | Promise<void>;

export const FAKE_CAPS: HarnessCapabilities = { canSteer: false, terminal: "handoff", subagents: { view: true, stop: true, steer: false } };

export class FakeDriver implements Driver {
  sent: string[] = [];
  closed = false;
  interrupted = 0;
  stopped: string[] = [];
  settings: Record<string, string> = {};
  isBusy = false;
  onExit?: (error?: string) => void;
  /** subagent sinks by native id */
  children = new Map<string, Sink>();
  lastDecision?: Decision;

  constructor(
    readonly nativeId: string,
    readonly sink: Sink,
    readonly opts: StartOpts,
    private script: (text: string) => Step[],
  ) {}

  async send(text: string) {
    this.sent.push(text);
    const id = `u${this.sent.length}`;
    this.sink.event({ type: "msg", msg: { id, role: "user", ts: 1, parts: [{ type: "text", text }] } });
    this.sink.state({ status: "running" });
    for (const step of this.script(text)) await step(this.sink, this);
  }
  async interrupt() {
    this.interrupted++;
    this.sink.state({ status: "idle" });
  }
  async setModel(m: string) {
    this.settings.model = m;
  }
  async setEffort(e: string) {
    this.settings.effort = e;
  }
  async setPermissionMode(m: string) {
    this.settings.permissionMode = m;
  }
  async stopSubagent(id: string) {
    this.stopped.push(id);
    this.children.get(id)?.ended?.();
  }
  busy() {
    return this.isBusy;
  }
  async close() {
    this.closed = true;
  }
}

// ---------- script steps ----------

export const say = (id: string, text: string): Step => (s) => s.event({ type: "msg", msg: { id, role: "assistant", ts: 2, parts: [{ type: "text", text }] } });
export const stream = (id: string, chunks: string[]): Step => (s) => {
  s.event({ type: "msg", msg: { id, role: "assistant", ts: 2, parts: [{ type: "text", text: "" }], streaming: true } });
  for (const c of chunks) s.event({ type: "delta", msgId: id, part: 0, text: c });
  s.event({ type: "msg", msg: { ...s.message(id)!, streaming: false } });
};
export const toolCall = (msgId: string, toolId: string, name = "Bash", input: unknown = { command: "ls" }): Step => (s) =>
  s.event({ type: "msg", msg: { id: msgId, role: "assistant", ts: 3, parts: [{ type: "tool", id: toolId, name, kind: name === "Agent" ? "task" : "shell", input, status: "running" }] } });
export const toolDone = (msgId: string, toolId: string, output: string): Step => (s) => s.event({ type: "tool", msgId, toolId, patch: { status: "done", output } });
export const idle: Step = (s) => s.state({ status: "idle" });
export const ask = (tool: string, input: unknown): Step => async (s, d) => {
  d.lastDecision = await s.request({ kind: "approval", tool, input });
};
export const subagent = (nativeId: string, parentToolId: string, steps: Step[] = []): Step => async (s, d) => {
  const c = s.subagent({ nativeId, parentToolId, title: "Count lines", agentType: "general-purpose", prompt: "Count the lines" });
  d.children.set(nativeId, c);
  for (const step of steps) await step(c, d);
};
export const subagentEnds = (nativeId: string): Step => (_s, d) => d.children.get(nativeId)?.ended?.();

// ---------- the adapter ----------

export class FakeAdapter implements Adapter {
  id = "claude" as const;
  capabilities = FAKE_CAPS;
  stored = new Map<string, { summary: SessionSummary; msgs: Msg[] }>();
  watchers = new Map<string, (msgs: Msg[]) => void>();
  drivers: FakeDriver[] = [];
  /** what each send does; default: a short reply, then idle */
  script: (text: string) => Step[] = (text) => [say(`a-${text}`, `echo ${text}`), idle];
  startError?: string;
  /** starts wait for this (a slow harness start) */
  startGate?: Promise<void>;
  private next = 0;

  addStored(nativeId: string, msgs: Msg[], over: Partial<SessionSummary> = {}) {
    const summary: SessionSummary = { id: `claude:${nativeId}`, harness: "claude", nativeId, projectPath: "/p", title: `Session ${nativeId}`, mode: "stored", status: "idle", updatedAt: Date.now(), ...over };
    this.stored.set(nativeId, { summary, msgs });
    return summary;
  }

  /** The store changed (someone used the session in a terminal). */
  write(nativeId: string, msgs: Msg[]) {
    this.stored.get(nativeId)!.msgs = msgs;
    this.watchers.get(nativeId)?.(msgs);
  }

  async available() {
    return true;
  }
  async listProjects(): Promise<ProjectInfo[]> {
    return [{ path: "/p", name: "p", harnesses: ["claude"], updatedAt: 1, sessions: this.stored.size }];
  }
  async listSessions(o: { projectPath?: string; since?: number } = {}) {
    return [...this.stored.values()].map((x) => x.summary).filter((s) => (!o.projectPath || s.projectPath === o.projectPath) && (!o.since || s.updatedAt >= o.since));
  }
  async sessionInfo(nativeId: string) {
    return this.stored.get(nativeId)?.summary;
  }
  async listSubagents(nativeId: string) {
    return [...this.stored.values()].map((x) => x.summary).filter((s) => s.parentSessionId === `claude:${nativeId}`);
  }
  async readHistory(nativeId: string) {
    return structuredClone(this.stored.get(nativeId)?.msgs ?? []);
  }
  watchHistory(nativeId: string, _p: string, onChange: (msgs: Msg[]) => void) {
    this.watchers.set(nativeId, onChange);
    return () => this.watchers.delete(nativeId);
  }
  async defaults() {
    return { model: "default" };
  }
  async start(_p: string, nativeId: string, opts: StartOpts, sink: Sink) {
    await this.startGate;
    return this.make(nativeId, opts, sink);
  }
  async resume(nativeId: string, _p: string, opts: StartOpts, sink: Sink) {
    await this.startGate;
    return this.make(nativeId, opts, sink);
  }
  private make(nativeId: string, opts: StartOpts, sink: Sink) {
    if (this.startError) throw new Error(this.startError);
    const d = new FakeDriver(nativeId, sink, opts, (t) => this.script(t));
    this.drivers.push(d);
    return d;
  }
  async listModels(): Promise<ModelList> {
    return { models: [{ id: "default", label: "Default" }], efforts: [], permissionModes: [] };
  }
  newId() {
    return `new-${++this.next}`;
  }
  terminalCommand() {
    return { argv: ["true"] };
  }
}
