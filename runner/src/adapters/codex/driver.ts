// A live Codex thread through the shared app-server daemon (SPEC §6): one connection per thread,
// subscribed to it (thread/start or thread/resume). The thread lives in the daemon, not in this
// process: Codex's own TUI can join it at the same time (`codex resume`, terminal "shared"), and it
// outlives a runner restart. What the daemon says goes through CodexStream into the session's sink;
// approvals and questions go to the broker through the sink, and close as resolved elsewhere when
// another client (the TUI) answers first (serverRequest/resolved).

import { existsSync } from "node:fs";
import { FROM_TETHER } from "../../../../shared/fromTether";
import { RESOLVED_ELSEWHERE, type Driver, type Sink, type StartOpts } from "../../core/adapter";
import { connect } from "./daemon";
import { dropCache, PLACEHOLDER_NAME } from "./discovery";
import { codexMode, modeOf, sandboxPolicy, type CodexModel } from "./modes";
import { ASKS, codexAnswer, codexAsk, DECLINE_ELICITATION } from "./requests";
import type { CodexRpc } from "./rpc";
import { CodexStream } from "./stream";

const input = (text: string) => [{ type: "text", text, text_elements: [] }];

/** What Codex says when a thread has nothing on disk yet (no turn, no name). */
const NO_ROLLOUT = /no rollout found/i;

/** The thread settings to start or resume with (a missing field: the thread's or Codex's own). */
function settings(opts: StartOpts) {
  const out: Record<string, unknown> = { approvalsReviewer: "user" };
  if (opts.model && opts.model !== "default") out.model = opts.model;
  if (opts.permissionMode) {
    const m = codexMode(opts.permissionMode);
    out.approvalPolicy = m.approvalPolicy;
    out.sandbox = m.sandbox;
  }
  return out;
}

/** Threads Tether created (newId) that no driver has taken yet. */
const pending = new Map<string, { rpc: CodexRpc; started: any; timer: ReturnType<typeof setTimeout> }>();

/** Creates a thread in the daemon for a new session; its driver picks it up (CodexDriver.open). */
export async function createThread(projectPath: string, opts: StartOpts): Promise<string> {
  if (!existsSync(projectPath)) throw new Error(`There's no folder ${projectPath} on this runner.`);
  const rpc = await connect();
  try {
    const started = await rpc.call("thread/start", { cwd: projectPath, ...settings(opts) });
    const id: string = started.thread.id;
    // Nobody took it (the session failed to open): let it go.
    const timer = setTimeout(() => {
      pending.delete(id);
      rpc.close();
    }, 60_000);
    pending.set(id, { rpc, started, timer });
    dropCache();
    return id;
  } catch (e) {
    rpc.close();
    throw e;
  }
}

export class CodexDriver implements Driver {
  readonly stream: CodexStream;
  private closed = false;
  /** open requests by the daemon's request id: aborted when another client answers */
  private asks = new Map<string, AbortController>();
  private defaultModel?: string;
  /** the thread has something on disk (a turn, or a name), so another client can join it */
  private materialized: boolean;
  onExit?: (error?: string) => void;

  private constructor(
    readonly nativeId: string,
    private projectPath: string,
    private rpc: CodexRpc,
    private sink: Sink,
    materialized: boolean,
  ) {
    this.materialized = materialized;
    this.stream = new CodexStream(sink, projectPath, nativeId);
    this.stream.onSettings = (s) => this.settingsChanged(s);
    rpc.onNotify((m, p) => this.notify(m, p));
    rpc.onRequest = (m, p, id) => this.request(m, p, id);
    rpc.onClose((reason) => {
      if (this.closed) return;
      this.closed = true;
      this.abortAll();
      this.onExit?.(`The connection to the Codex daemon closed (${reason}). Send again to reconnect.`);
    });
  }

  /** A new thread (made by createThread) or an existing one, joined. */
  static async open(nativeId: string, projectPath: string, opts: StartOpts, sink: Sink, resume: boolean): Promise<CodexDriver> {
    if (!existsSync(projectPath)) throw new Error(`The session's folder ${projectPath} doesn't exist any more.`);
    const p = pending.get(nativeId);
    if (p) {
      pending.delete(nativeId);
      clearTimeout(p.timer);
      const d = new CodexDriver(nativeId, projectPath, p.rpc, sink, false);
      await d.started(p.started, opts);
      return d;
    }
    if (!resume) throw new Error("This new Codex session is gone (the daemon may have restarted). Start a new one.");
    const rpc = await connect();
    const d = new CodexDriver(nativeId, projectPath, rpc, sink, true);
    try {
      const r = await rpc.call("thread/resume", { threadId: nativeId, ...settings(opts), excludeTurns: true }).catch((e: any) => {
        if (NO_ROLLOUT.test(String(e?.message))) throw new Error("This Codex session never got a message, so there's nothing to reopen. Start a new one.");
        throw e;
      });
      await d.started(r, opts);
      // Mid-turn (Codex's TUI, or a turn that went on while the runner was away): carry on from it.
      if (r.thread?.status?.type === "active") {
        const t: any = await rpc.call("thread/turns/list", { threadId: nativeId, limit: 1, sortDirection: "desc", itemsView: "full" }).catch(() => undefined);
        const turn = t?.data?.[0];
        if (turn && turn.status === "inProgress") d.stream.seedTurn(turn);
      }
    } catch (e) {
      d.closed = true;
      rpc.close();
      throw e;
    }
    return d;
  }

  /** After start or resume: effort, the live settings, the default model. */
  private async started(r: any, opts: StartOpts) {
    if (opts.effort && opts.effort !== r.reasoningEffort) await this.rpc.call("thread/settings/update", { threadId: this.nativeId, effort: opts.effort }).catch(() => {});
    const mode = modeOf(r.approvalPolicy, r.sandbox);
    this.sink.state({
      ...(r.model ? { modelResolved: r.model } : {}),
      ...(opts.model ? {} : r.model ? { model: r.model } : {}),
      ...(opts.effort ? {} : r.reasoningEffort ? { effort: r.reasoningEffort } : {}),
      ...(opts.permissionMode || !mode ? {} : { permissionMode: mode }),
    });
  }

  // ---------------- what the daemon says ----------------

  private notify(method: string, p: any) {
    if (method === "serverRequest/resolved") return this.resolved(String(p.requestId));
    if (method === "thread/closed" && p.threadId === this.nativeId && !this.closed) {
      this.closed = true;
      this.abortAll();
      this.rpc.close();
      return this.onExit?.();
    }
    this.stream.handle(method, p);
  }

  /** Settings changed on the thread (here, or /model and /approvals in Codex's TUI). */
  private settingsChanged(s: any) {
    const mode = modeOf(s.approvalPolicy, s.sandboxPolicy);
    this.sink.state({
      ...(s.model ? { modelResolved: s.model } : {}),
      ...(s.effort ? { effort: s.effort } : {}),
      ...(mode ? { permissionMode: mode } : {}),
    });
  }

  /** The daemon asks (an approval, a question): the broker decides. */
  private request(method: string, p: any, id: number | string): Promise<unknown> | undefined {
    if (!ASKS.has(method)) return undefined;
    const thread = p.threadId ?? this.nativeId;
    const sink = thread === this.nativeId ? this.sink : this.stream.child(thread)?.sink;
    if (!sink) return undefined;
    const ask = codexAsk(method, p, this.projectPath, p.itemId ? this.stream.patch(thread, p.itemId) : undefined);
    if (!ask) return Promise.resolve(DECLINE_ELICITATION);
    const ac = new AbortController();
    const key = String(id);
    this.asks.set(key, ac);
    return sink.request(ask, ac.signal).then(async (d) => {
      this.asks.delete(key);
      // Answered elsewhere (the TUI) or stopped: the daemon isn't waiting for this answer.
      if (ac.signal.aborted) return undefined;
      // Codex's "decline" tells the model nothing: a reason goes into the turn as a steer.
      if (!d.allow && !d.interrupt && d.reason) void this.steerTurn(thread, `${FROM_TETHER}${d.reason}`).catch(() => {});
      return codexAnswer(method, p, d);
    });
  }

  private resolved(requestId: string) {
    const ac = this.asks.get(requestId);
    if (!ac) return;
    this.asks.delete(requestId);
    ac.abort(RESOLVED_ELSEWHERE);
  }

  private abortAll() {
    for (const ac of this.asks.values()) ac.abort();
    this.asks.clear();
  }

  // ---------------- driving ----------------

  async send(text: string) {
    if (this.closed) throw new Error("This Codex session isn't connected.");
    this.sink.state({ status: "running", error: undefined });
    try {
      await this.rpc.call("turn/start", { threadId: this.nativeId, input: input(text) });
      this.materialized = true;
    } catch (e: any) {
      this.sink.state({ status: "idle" });
      throw new Error(`Codex didn't start the turn: ${e?.message ?? e}`);
    }
  }

  async steer(text: string) {
    await this.steerTurn(this.nativeId, text);
  }

  private async steerTurn(threadId: string, text: string) {
    const turnId = threadId === this.nativeId ? this.stream.main.turnId : this.stream.child(threadId)?.turnId;
    if (!turnId) throw new Error("Nothing is running to steer. Send it as a new message instead.");
    await this.rpc.call("turn/steer", { threadId, input: input(text), expectedTurnId: turnId });
  }

  async interrupt() {
    const turnId = this.stream.main.turnId;
    if (turnId) await this.rpc.call("turn/interrupt", { threadId: this.nativeId, turnId });
    else this.sink.state({ status: "idle" });
  }

  async setModel(model: string) {
    let id = model;
    if (model === "default") {
      this.defaultModel ??= ((await this.rpc.call("model/list", {}).catch(() => ({ data: [] }))).data as CodexModel[]).find((m) => m.isDefault)?.id;
      if (!this.defaultModel) return;
      id = this.defaultModel;
    }
    await this.rpc.call("thread/settings/update", { threadId: this.nativeId, model: id });
  }

  async setEffort(effort: string) {
    await this.rpc.call("thread/settings/update", { threadId: this.nativeId, effort });
  }

  async setPermissionMode(mode: string) {
    const m = codexMode(mode);
    await this.rpc.call("thread/settings/update", { threadId: this.nativeId, approvalPolicy: m.approvalPolicy, sandboxPolicy: sandboxPolicy(m.sandbox), approvalsReviewer: "user" });
  }

  async stopSubagent(nativeId: string) {
    const turnId = this.stream.child(nativeId)?.turnId;
    if (turnId) await this.rpc.call("turn/interrupt", { threadId: nativeId, turnId });
  }

  async steerSubagent(nativeId: string, text: string) {
    await this.steerTurn(nativeId, text);
  }

  /**
   * Before Codex's TUI joins: a thread with nothing on disk can't be resumed by another client, so
   * a new one gets a name (a placeholder titles ignore) to have its rollout written.
   */
  async beforeTerminal() {
    if (this.materialized) return;
    await this.rpc.call("thread/name/set", { threadId: this.nativeId, name: PLACEHOLDER_NAME });
    this.materialized = true;
  }

  busy() {
    return this.stream.runningChildren().length > 0;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.abortAll();
    await this.rpc.call("thread/unsubscribe", { threadId: this.nativeId }, 5_000).catch(() => {});
    this.rpc.close();
  }
}
