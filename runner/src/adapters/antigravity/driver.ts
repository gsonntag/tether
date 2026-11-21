// A live Antigravity session (SPEC §6): its own `agy acp` process, the conversation loaded into it
// (`session/load`), each message a `session/prompt`. What it streams goes through AcpTranscript
// into the sink, numbered as a replay numbers it; permission prompts go to the broker.
//
// No steering: a prompt sent during a turn ends that turn's wait and runs after it (checked on
// 1.5.13), so Tether queues messages for after the turn instead (capabilities.canSteer false).

import { existsSync } from "node:fs";
import type { Attachment } from "../../../../shared/attachments";
import { tetherOrigin } from "../../../../shared/fromTether";
import type { Part, RequestQuestion } from "../../../../shared/transcript";
import { nativeImages } from "../../core/attachments";
import type { Decision, Driver, RequestAsk, Sink, StartOpts } from "../../core/adapter";
import { AcpClient, type AcpUpdate } from "../acp/client";
import { acpTool, AcpTranscript } from "../acp/transcript";
import { billingOf } from "./models";
import { acpArgv, noteCommands, noteOpened, reader, seenContext, seenSettings, seenTitles, settingsOf, stampOf } from "./store";

/** How long Antigravity may take to load a conversation before the start counts as failed. */
const START_TIMEOUT_MS = 90_000;

const ALLOW = new Set(["allow_once", "allow_always"]);
const REJECT = new Set(["reject_once", "reject_always"]);

export class AgyDriver implements Driver {
  private client!: AcpClient;
  private t: AcpTranscript;
  private live = false;
  private closed = false;
  private turn?: Promise<void>;
  private stopping = false;
  /** open permission requests, aborted when the turn ends */
  private asks = new Set<AbortController>();
  private settings: { model?: string; effort?: string; permissionMode?: string } = {};
  private commandList: { name: string; description?: string }[] = [];
  onExit?: (error?: string) => void;

  private constructor(
    readonly nativeId: string,
    private projectPath: string,
    private sink: Sink,
  ) {
    this.t = new AcpTranscript("m", {
      stamp: stampOf(nativeId, () => Date.now()),
      context: (c) => {
        seenContext.set(nativeId, c);
        if (this.live) sink.state({ context: c });
      },
      commands: (list) => {
        this.commandList = list;
        noteCommands(list);
      },
      title: (title) => {
        seenTitles.set(nativeId, title);
        reader.forget();
      },
      mode: (mode) => this.note({ permissionMode: mode }),
      config: (options) => this.note(settingsOf(options)),
    });
  }

  static async open(nativeId: string, projectPath: string, opts: StartOpts, sink: Sink): Promise<AgyDriver> {
    if (!existsSync(projectPath)) throw new Error(`The session's folder ${projectPath} doesn't exist any more.`);
    const d = new AgyDriver(nativeId, projectPath, sink);
    await d.start(opts);
    return d;
  }

  private async start(opts: StartOpts) {
    this.client = new AcpClient({
      argv: acpArgv(),
      cwd: this.projectPath,
      name: "Antigravity",
      onUpdate: (sid, u) => sid === this.nativeId && this.update(u),
      onRequest: (method, params) => this.request(method, params),
      onExit: (error) => this.exited(error),
    });
    try {
      await this.client.initialize();
      // Its history comes as updates, already in the transcript: they only number what follows.
      const r: any = await this.client.call("session/load", { sessionId: this.nativeId, cwd: this.projectPath, mcpServers: [] }, START_TIMEOUT_MS);
      noteOpened(r);
      this.t.drain();
      this.note(settingsOf(r?.configOptions, typeof r?.modes?.currentModeId === "string" ? r.modes.currentModeId : undefined));
      // The session's settings as Tether shows them: they go to Antigravity before the first prompt.
      if (opts.model && opts.model !== "default" && opts.model !== this.settings.model) await this.setModel(opts.model);
      if (opts.effort && opts.effort !== this.settings.effort) await this.setEffort(opts.effort);
      if (opts.permissionMode && opts.permissionMode !== this.settings.permissionMode) await this.setPermissionMode(opts.permissionMode);
    } catch (e: any) {
      this.closed = true;
      await this.client.close();
      throw new Error(this.client.why(`Antigravity didn't start: ${e?.message ?? e}`));
    }
    this.live = true;
    reader.forget();
    const context = seenContext.get(this.nativeId);
    this.sink.state({ ...this.settings, billing: billingOf(), ...(context ? { context } : {}) });
  }

  /** Settings as Antigravity reports them: what the session shows. */
  private note(s: { model?: string; effort?: string; permissionMode?: string }) {
    const changed = (Object.keys(s) as (keyof typeof s)[]).filter((k) => s[k] !== undefined && s[k] !== this.settings[k]);
    if (!changed.length) return;
    this.settings = { ...this.settings, ...s };
    seenSettings.set(this.nativeId, this.settings);
    if (this.live) this.sink.state(Object.fromEntries(changed.map((k) => [k, s[k]])));
  }

  private update(u: AcpUpdate) {
    this.t.update(u);
    this.flush();
  }

  private flush() {
    if (!this.live) return;
    for (const e of this.t.drain()) this.sink.event(e);
  }

  // ---------- requests ----------

  private async request(method: string, params: any): Promise<unknown> {
    if (method !== "session/request_permission") throw Object.assign(new Error("Not supported."), { code: -32601 });
    const options: { optionId: string; name?: string; kind?: string }[] = Array.isArray(params?.options) ? params.options : [];
    const call = params?.toolCall ?? {};
    const tool = acpTool({ sessionUpdate: "tool_call", ...call });
    const approval = options.length > 0 && options.every((o) => ALLOW.has(o.kind ?? "") || REJECT.has(o.kind ?? ""));
    const title = typeof call.title === "string" ? call.title : undefined;
    const ask: RequestAsk = approval
      ? { kind: "approval", tool: tool.name, input: call.rawInput ?? call.args ?? {}, toolKind: tool.kind, toolId: tool.id, noReason: true, ...(tool.command ? { command: tool.command } : {}), ...(tool.path ? { path: tool.path } : {}), ...(title ? { title } : {}) }
      : questionAsk(title ?? "Antigravity asks", options, tool.id);
    const abort = new AbortController();
    this.asks.add(abort);
    let d: Decision;
    try {
      d = await this.sink.request(ask, abort.signal);
    } finally {
      this.asks.delete(abort);
    }
    if (abort.signal.aborted) return { outcome: { outcome: "cancelled" } };
    const pick = (kinds: Set<string>) => options.find((o) => o.kind && kinds.has(o.kind) && o.kind.endsWith("_once")) ?? options.find((o) => o.kind && kinds.has(o.kind));
    let chosen: { optionId: string } | undefined;
    if (approval) chosen = d.allow ? pick(ALLOW) : pick(REJECT);
    else if (d.allow) chosen = options.find((o) => (o.name ?? o.optionId) === d.answers?.[0]) ?? options.find((o) => o.optionId === d.answers?.[0]);
    // A plain Deny stops the turn, as declining in Antigravity's own UI does.
    if (!d.allow && d.interrupt) setTimeout(() => void this.interrupt(), 0);
    return chosen ? { outcome: { outcome: "selected", optionId: chosen.optionId } } : { outcome: { outcome: "cancelled" } };
  }

  private abortAsks() {
    for (const a of this.asks) a.abort();
    this.asks.clear();
  }

  // ---------- turns ----------

  async send(text: string, attachments: Attachment[] = []) {
    if (this.closed || !this.client.alive) throw new Error("Antigravity isn't running.");
    if (this.turn) throw new Error("Antigravity is still working on the last message.");
    const images = nativeImages(attachments);
    const tether = tetherOrigin(text);
    const shown: Part[] = [{ type: "text", text: tether?.text ?? text }, ...images.map((i) => ({ type: "image" as const, mimeType: i.mimeType, data: i.data }))];
    const msg = this.t.prompt(shown);
    if (tether) msg.origin = tether.origin;
    this.stopping = false;
    this.flush();
    this.sink.state({ status: "running", error: undefined });
    const prompt = [{ type: "text", text }, ...images.map((i) => ({ type: "image", mimeType: i.mimeType, data: i.data }))];
    this.turn = this.client
      .call("session/prompt", { sessionId: this.nativeId, prompt }, 0)
      .then(
        (r: any) => this.ended(r?.stopReason === "cancelled" || this.stopping ? undefined : stopError(r?.stopReason), r?.stopReason === "cancelled"),
        (e: any) => this.ended(this.stopping ? undefined : `Antigravity: ${e?.message ?? e}`, this.stopping),
      )
      .finally(() => (this.turn = undefined));
  }

  private ended(error: string | undefined, stopped: boolean) {
    this.abortAsks();
    // A process that exited ended its turn already (exited).
    if (this.closed) return;
    this.t.end(error, stopped);
    this.flush();
    this.sink.state({ status: "idle", ...(error ? {} : { error: undefined }) });
  }

  async interrupt() {
    if (!this.turn) return;
    this.stopping = true;
    this.abortAsks();
    this.client.notify("session/cancel", { sessionId: this.nativeId });
  }

  async setModel(model: string) {
    if (model === "default") return;
    const r: any = await this.client.call("session/set_config_option", { sessionId: this.nativeId, configId: "model", value: model });
    this.note(settingsOf(r?.configOptions));
  }

  async setEffort(effort: string) {
    const r: any = await this.client.call("session/set_config_option", { sessionId: this.nativeId, configId: "thought_level", value: effort });
    this.note(settingsOf(r?.configOptions));
  }

  async setPermissionMode(mode: string) {
    await this.client.call("session/set_mode", { sessionId: this.nativeId, modeId: mode });
    this.note({ permissionMode: mode });
  }

  commands() {
    return this.commandList;
  }

  turnRunning() {
    return !!this.turn;
  }

  busy() {
    return !!this.turn;
  }

  private exited(error?: string) {
    const was = !this.closed;
    this.closed = true;
    this.abortAsks();
    if (this.turn) this.t.end(error ?? "Antigravity stopped.", true);
    this.flush();
    if (was) this.onExit?.(error ?? "Antigravity stopped.");
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.abortAsks();
    await this.client.call("session/close", { sessionId: this.nativeId }, 5000).catch(() => {});
    await this.client.close();
  }
}

/** Why a turn stopped short, in words; undefined for a normal end. */
function stopError(reason: unknown): string | undefined {
  if (reason === "max_tokens") return "Antigravity stopped: the reply reached its length limit.";
  if (reason === "max_turn_requests") return "Antigravity stopped: the turn reached its step limit.";
  if (reason === "refusal") return "Antigravity refused to continue.";
  return undefined;
}

/** A request whose options aren't allow and deny: a question with them as its answers. */
function questionAsk(question: string, options: { optionId: string; name?: string }[], toolId?: string): RequestAsk {
  const labels = options.map((o) => o.name ?? o.optionId);
  const q: RequestQuestion = { question, options: labels.map((label) => ({ label })) };
  return { kind: "question", question, options: labels, questions: [q], noReason: true, ...(toolId ? { toolId } : {}) };
}
