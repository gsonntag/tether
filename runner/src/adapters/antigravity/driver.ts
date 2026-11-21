// A live Antigravity session (SPEC §6): its own `agy acp` process, the conversation loaded into it
// (`session/load`), each message a `session/prompt`. What it streams goes through AcpTranscript
// into the sink, numbered as a replay numbers it; permission prompts go to the broker.
//
// No steering: a prompt sent during a turn ends that turn's wait and runs after it (checked on
// 1.5.13), so Tether queues messages for after the turn instead (capabilities.canSteer false).
//
// Antigravity also works without a prompt: when a subagent reports back, the main agent runs a turn
// of its own, its updates arriving with no prompt and no end. That shows as working, and ends after
// a few quiet seconds. Subagents (§6a) live in conversations of their own (subagents.ts); this
// process runs them, so it stays up while they do.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Attachment } from "../../../../shared/attachments";
import { tetherOrigin } from "../../../../shared/fromTether";
import type { Msg, Part, RequestQuestion, ToolPart } from "../../../../shared/transcript";
import { nativeImages } from "../../core/attachments";
import type { Decision, Driver, RequestAsk, Sink, StartOpts } from "../../core/adapter";
import { movedDir } from "../../core/moved";
import { AcpClient, type AcpUpdate } from "../acp/client";
import { acpTool, AcpTranscript } from "../acp/transcript";
import { ToolServerSlot } from "../toolServer";
import { billingOf } from "./models";
import { acpArgv, agyHome, noteCommands, noteOpened, reader, seenContext, seenSettings, seenTitles, settingsOf, stampOf, storeStamp } from "./store";
import { childrenOf, matchCalls } from "./subagents";

/** How long Antigravity may take to load a conversation before the start counts as failed. */
const START_TIMEOUT_MS = 90_000;
export const timing = {
  /** A turn the agent runs without a prompt ends after this long with nothing new. */
  quietMs: 3000,
  /** How often running subagents are looked at. */
  childPollMs: 1000,
  /** A subagent that reported back is done once its store has been quiet this long. */
  childDoneMs: 20_000,
  /** A subagent whose store hasn't changed in this long is stalled (an approval it asked can't reach Tether). */
  childStalledMs: 3 * 60_000,
  /** A subagent call whose conversation hasn't appeared in this long is let go. */
  childFindMs: 60_000,
};

const ALLOW = new Set(["allow_once", "allow_always"]);
const REJECT = new Set(["reject_once", "reject_always"]);

/** Tether's MCP server for Antigravity sessions (peers, SPEC §9a). */
export const agyTools = new ToolServerSlot();

/** What a side chat is told (SPEC §16a). */
export const READ_ONLY_PROMPT =
  "This is a read-only side chat. Answer from what you can read: don't change any file, run no commands, start no subagents, schedule nothing, and use no tool that writes, sends or runs anything. Every request for permission is refused.";

/** Antigravity's saved Always-allow rules (its settings.json): with any, a side chat can't be kept read-only. */
export function savedAllowRules(file = join(agyHome(), "settings.json")): string[] {
  try {
    const s = JSON.parse(readFileSync(file, "utf8"));
    const allow = s?.permissions?.allow;
    return Array.isArray(allow) ? allow.filter((x: unknown) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

interface SubagentCall {
  toolId: string;
  prompt: string;
  role?: string;
  type?: string;
  at: number;
}

interface RunningChild {
  sink: Sink;
  rev: string;
  changedAt: number;
  reported: boolean;
  shown: Map<string, string>;
  reading?: boolean;
}

export class AgyDriver implements Driver {
  private client!: AcpClient;
  private t: AcpTranscript;
  private live = false;
  private closed = false;
  private turn?: Promise<void>;
  /** a turn the agent runs without a prompt (after a subagent's report) */
  private unprompted?: ReturnType<typeof setTimeout>;
  private stopping = false;
  private readOnly = false;
  /** Tether's MCP server name, when this session has it: its tools run without asking */
  private toolServer?: string;
  /** open permission requests, aborted when the turn ends */
  private asks = new Set<AbortController>();
  private settings: { model?: string; effort?: string; permissionMode?: string } = {};
  private commandList: { name: string; description?: string }[] = [];
  /** the plan file this turn wrote for review (plan mode) */
  private plan?: { path: string; toolId: string; content?: string };
  private calls: SubagentCall[] = [];
  private children = new Map<string, RunningChild>();
  private poll?: ReturnType<typeof setInterval>;
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
    this.readOnly = !!opts.readOnly;
    if (this.readOnly) {
      const rules = savedAllowRules();
      if (rules.length) throw new Error(`Antigravity has saved Always-allow rules (${rules.slice(0, 3).join(", ")}${rules.length > 3 ? ", …" : ""}), so a side chat can't be kept read-only. Remove them from ~/.gemini/antigravity-cli/settings.json to use side chats.`);
    }
    // Tether's tools (peers), not in a side chat; the instructions go with them.
    const server = this.readOnly ? undefined : agyTools.for(this.projectPath);
    const env = server ? Object.entries(server.env(`antigravity:${this.nativeId}`)).map(([name, value]) => ({ name, value })) : [];
    const mcpServers = server ? [{ name: server.name, command: server.command, args: server.args, env }] : [];
    this.toolServer = server?.name;
    const append = this.readOnly ? READ_ONLY_PROMPT : server?.instructions?.();
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
      const r: any = await this.client.call("session/load", { sessionId: this.nativeId, cwd: this.projectPath, mcpServers, ...(append ? { _meta: { antigravity: { systemPrompt: { append } } } } : {}) }, START_TIMEOUT_MS);
      noteOpened(r);
      this.t.drain();
      this.note(settingsOf(r?.configOptions, typeof r?.modes?.currentModeId === "string" ? r.modes.currentModeId : undefined));
      // The session's settings as Tether shows them: they go to Antigravity before the first prompt.
      // A side chat is always in Antigravity's default mode, which asks before anything that changes something.
      const mode = this.readOnly ? "default" : opts.permissionMode;
      if (opts.model && opts.model !== "default" && opts.model !== this.settings.model) await this.setModel(opts.model);
      if (opts.effort && opts.effort !== this.settings.effort) await this.setEffort(opts.effort);
      if (mode && mode !== this.settings.permissionMode) await this.setPermissionMode(mode);
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
    // The agent at work with no prompt of ours: a turn of its own (a subagent reported back). Only
    // something new starts one; a late update to a call of the turn that ended only keeps one going.
    const starts = ["agent_message_chunk", "agent_thought_chunk", "tool_call"].includes(u.sessionUpdate);
    const goesOn = starts || u.sessionUpdate === "tool_call_update" || u.sessionUpdate === "plan";
    if (!this.turn && this.live && (starts || (goesOn && this.unprompted))) this.unpromptedUpdate();
    this.t.update(u);
    if (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") this.noteCall(u);
    this.flush();
  }

  private flush() {
    if (!this.live) return;
    for (const e of this.t.drain()) this.sink.event(e);
  }

  // ---------- turns the agent runs by itself ----------

  private unpromptedUpdate() {
    if (!this.unprompted) this.sink.state({ status: "running", error: undefined });
    clearTimeout(this.unprompted);
    this.unprompted = setTimeout(() => this.unpromptedQuiet(), timing.quietMs);
  }

  private unpromptedQuiet() {
    // Still waiting on a person, or on a call: not over.
    if (this.asks.size || this.t.msgs.at(-1)?.parts.some((p) => p.type === "tool" && p.status === "running")) {
      this.unprompted = setTimeout(() => this.unpromptedQuiet(), timing.quietMs);
      return;
    }
    this.unprompted = undefined;
    if (this.closed) return;
    this.t.end();
    this.flush();
    this.sink.state({ status: "idle" });
  }

  // ---------- requests ----------

  private async request(method: string, params: any): Promise<unknown> {
    if (method !== "session/request_permission") throw Object.assign(new Error("Not supported."), { code: -32601 });
    const options: { optionId: string; name?: string; kind?: string }[] = Array.isArray(params?.options) ? params.options : [];
    const call = params?.toolCall ?? {};
    const tool = acpTool({ sessionUpdate: "tool_call", ...call });
    const approval = options.length > 0 && options.every((o) => ALLOW.has(o.kind ?? "") || REJECT.has(o.kind ?? ""));
    const pick = (kinds: Set<string>) => options.find((o) => o.kind && kinds.has(o.kind) && o.kind.endsWith("_once")) ?? options.find((o) => o.kind && kinds.has(o.kind));
    const answer = (o?: { optionId: string }) => (o ? { outcome: { outcome: "selected", optionId: o.optionId } } : { outcome: { outcome: "cancelled" } });
    if (approval) {
      // A side chat changes nothing: refused here as well as by the core, without asking anyone.
      if (this.readOnly) return answer(pick(REJECT));
      // Tether's own tools run without asking, as on the other harnesses.
      if (this.toolServer && tool.name.startsWith(`mcp_${this.toolServer}_`)) return answer(pick(ALLOW));
      // A moved session reads the history it was moved with (SPEC §15) without asking.
      if (tool.kind === "read" && tool.path && inside(tool.path, movedDir(`antigravity:${this.nativeId}`))) return answer(pick(ALLOW));
    }
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
    if (abort.signal.aborted) return answer(undefined);
    let chosen: { optionId: string } | undefined;
    if (approval) chosen = d.allow ? pick(ALLOW) : pick(REJECT);
    else if (d.allow) chosen = options.find((o) => (o.name ?? o.optionId) === d.answers?.[0]) ?? options.find((o) => o.optionId === d.answers?.[0]);
    // A plain Deny stops the turn, as declining in Antigravity's own UI does.
    if (!d.allow && d.interrupt) setTimeout(() => void this.interrupt(), 0);
    return answer(chosen);
  }

  private abortAsks() {
    for (const a of this.asks) a.abort();
    this.asks.clear();
  }

  // ---------- turns ----------

  async send(text: string, attachments: Attachment[] = []) {
    if (this.closed || !this.client.alive) throw new Error("Antigravity isn't running.");
    if (this.turn || this.unprompted) throw new Error("Antigravity is still working on the last message.");
    const images = nativeImages(attachments);
    const tether = tetherOrigin(text);
    const shown: Part[] = [{ type: "text", text: tether?.text ?? text }, ...images.map((i) => ({ type: "image" as const, mimeType: i.mimeType, data: i.data }))];
    const msg = this.t.prompt(shown);
    if (tether) msg.origin = tether.origin;
    this.stopping = false;
    this.plan = undefined;
    this.flush();
    this.sink.state({ status: "running", error: undefined });
    const prompt = [{ type: "text", text }, ...images.map((i) => ({ type: "image", mimeType: i.mimeType, data: i.data }))];
    this.turn = this.client
      .call("session/prompt", { sessionId: this.nativeId, prompt }, 0)
      .then(
        (r: any) => this.ended(r?.stopReason === "cancelled" || this.stopping ? undefined : stopError(r?.stopReason), r?.stopReason === "cancelled" || this.stopping),
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
    if (!error && !stopped) this.offerPlan();
  }

  async interrupt() {
    if (this.unprompted) {
      clearTimeout(this.unprompted);
      this.unprompted = undefined;
      this.abortAsks();
      this.client.notify("session/cancel", { sessionId: this.nativeId });
      this.t.end(undefined, true);
      this.flush();
      this.sink.state({ status: "idle" });
      return;
    }
    if (!this.turn) return;
    this.stopping = true;
    this.abortAsks();
    this.client.notify("session/cancel", { sessionId: this.nativeId });
  }

  // ---------- plan review (SPEC §7) ----------

  /** A file the agent wrote for review: in plan mode, the plan. */
  private noteCall(u: AcpUpdate) {
    const raw = (u.rawInput ?? u.args) as Record<string, any> | undefined;
    const name = typeof u.name === "string" ? u.name : undefined;
    if (name === "invoke_subagent" && u.sessionUpdate === "tool_call" && raw && typeof raw.Prompt === "string") this.subagentCalled(String(u.toolCallId), raw);
    if (!raw?.ArtifactMetadata?.RequestFeedback || typeof (raw.Path ?? raw.path) !== "string") return;
    this.plan = { path: raw.Path ?? raw.path, toolId: String(u.toolCallId), ...(typeof raw.Content === "string" ? { content: raw.Content } : {}) };
  }

  /**
   * A plan mode turn that ended on a plan for review: it goes up as a request Tether answers
   * (planFollowUp), as Codex's does. Approving leaves plan mode and says to go ahead.
   */
  private offerPlan() {
    const plan = this.plan;
    this.plan = undefined;
    if (!plan || this.settings.permissionMode !== "plan" || this.readOnly) return;
    let text = plan.content;
    try {
      text = readFileSync(plan.path, "utf8");
    } catch {}
    if (!text?.trim()) return;
    void this.sink.request({ kind: "approval", tool: "plan", input: { path: plan.path }, toolId: plan.toolId, title: "Antigravity's plan is ready", plan: text, approveMode: "default", planFollowUp: true }).catch(() => {});
  }

  // ---------- subagents (SPEC §6a) ----------

  private subagentCalled(toolId: string, raw: Record<string, any>) {
    if (this.calls.some((c) => c.toolId === toolId)) return;
    this.calls.push({ toolId, prompt: raw.Prompt, ...(typeof raw.Role === "string" ? { role: raw.Role } : {}), ...(typeof raw.TypeName === "string" ? { type: raw.TypeName } : {}), at: Date.now() });
    this.watchChildren();
  }

  private watchChildren() {
    if (this.poll || this.closed) return;
    this.poll = setInterval(() => void this.childTick(), timing.childPollMs);
    this.poll.unref?.();
  }

  private async childTick() {
    const now = Date.now();
    // Subagents still to be found: their conversations appear a moment after the call.
    if (this.calls.length) {
      const since = Math.min(...this.calls.map((c) => c.at)) - 5000;
      const fresh = childrenOf(this.nativeId, since).filter((c) => !this.children.has(c.nativeId));
      for (const [child, call] of matchCalls(fresh, this.calls)) {
        this.calls = this.calls.filter((c) => c !== call);
        this.t.link(call.toolId, `antigravity:${child}`);
        const sink = this.sink.subagent({ nativeId: child, parentToolId: call.toolId, title: call.role || "Subagent", ...(call.type ? { agentType: call.type } : {}), prompt: call.prompt });
        this.children.set(child, { sink, rev: "", changedAt: now, reported: false, shown: new Map() });
      }
      this.calls = this.calls.filter((c) => now - c.at < timing.childFindMs);
    }
    for (const [id, c] of this.children) {
      const rev = storeStamp(id)?.rev ?? "";
      if (rev !== c.rev && !c.reading) {
        c.rev = rev;
        c.changedAt = now;
        c.reading = true;
        void this.readChild(id, c).finally(() => (c.reading = false));
      }
      const quiet = now - c.changedAt;
      if ((c.reported && quiet > timing.childDoneMs) || quiet > timing.childStalledMs) {
        this.children.delete(id);
        c.sink.ended?.();
      }
    }
    if (!this.calls.length && !this.children.size) {
      clearInterval(this.poll);
      this.poll = undefined;
    }
  }

  /** A subagent's conversation as it is now, into its own transcript. */
  private async readChild(id: string, c: RunningChild) {
    const { msgs } = await reader.replay(id, this.projectPath).catch(() => ({ msgs: [] as Msg[] }));
    for (const m of msgs) {
      const json = JSON.stringify(m);
      if (c.shown.get(m.id) === json) continue;
      c.shown.set(m.id, json);
      c.sink.event({ type: "msg", msg: m });
      if (m.parts.some((p) => p.type === "tool" && p.name === "send_message" && (p.input as any)?.raw?.Recipient === this.nativeId)) c.reported = true;
    }
  }

  /** Asking the main agent to pass a message on to a subagent (subagents.steer "via-parent"). */
  relayMessage(nativeId: string, text: string) {
    return `Please pass this message from the user to your running subagent ${nativeId} right now: call the send_message tool with Recipient "${nativeId}" and the message below exactly as written, then carry on with what you were doing. Don't answer it yourself.\n\n${text}`;
  }

  /** The main agent's send_message call to that subagent, carrying the message. */
  relayedBy(nativeId: string, tool: ToolPart, text?: string) {
    const raw = ((tool.input as any)?.raw ?? {}) as { Recipient?: unknown; Message?: unknown };
    if (tool.name !== "send_message" || raw.Recipient !== nativeId) return false;
    const norm = (x: string) => x.replace(/\s+/g, " ").trim().slice(0, 60);
    return !text || (typeof raw.Message === "string" && norm(raw.Message).includes(norm(text)));
  }

  // ---------- settings ----------

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
    if (this.readOnly && mode !== "default") throw new Error("A side chat stays read-only.");
    await this.client.call("session/set_mode", { sessionId: this.nativeId, modeId: mode });
    this.note({ permissionMode: mode });
  }

  commands() {
    return this.commandList;
  }

  turnRunning() {
    return !!this.turn || !!this.unprompted;
  }

  /** Working, or running subagents (they live in this process, and end with it). */
  busy() {
    return !!this.turn || !!this.unprompted || this.children.size > 0 || this.calls.length > 0;
  }

  private stopChildren() {
    clearInterval(this.poll);
    this.poll = undefined;
    this.calls = [];
    for (const c of this.children.values()) c.sink.ended?.();
    this.children.clear();
  }

  private exited(error?: string) {
    const was = !this.closed;
    this.closed = true;
    clearTimeout(this.unprompted);
    this.abortAsks();
    this.stopChildren();
    if (this.turn || this.unprompted) this.t.end(error ?? "Antigravity stopped.", true);
    this.unprompted = undefined;
    this.flush();
    if (was) this.onExit?.(error ?? "Antigravity stopped.");
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.unprompted);
    this.unprompted = undefined;
    this.abortAsks();
    this.stopChildren();
    await this.client.call("session/close", { sessionId: this.nativeId }, 5000).catch(() => {});
    await this.client.close();
  }
}

const inside = (path: string, dir: string) => path === dir || path.startsWith(dir.endsWith("/") ? dir : `${dir}/`);

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
