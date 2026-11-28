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

import { randomUUID } from "node:crypto";
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
import { billingOf, BYPASS } from "./models";
import { fetchQuota, findLanguageServerPort, keptPlan, registerLanguageServer, unregisterLanguageServer } from "./quota";
import { acpArgv, agyHome, noteCommands, noteOpened, reader, seenContext, seenSettings, seenTitles, settingsOf, stampOf, storeStamp } from "./store";
import { childrenOf, matchCalls } from "./subagents";
import { rateLimitHit } from "../../rateLimit";
import { agyUsageDir, recordAgyUsage } from "./usage";

/** How long Antigravity may take to load a conversation before the start counts as failed. */
const START_TIMEOUT_MS = 90_000;
export const timing = {
  /** A turn the agent runs without a prompt ends after this long with nothing new. */
  quietMs: 3000,
  /** How often running subagents are looked at. */
  childPollMs: 1000,
  /** A subagent that reported back is done once its store has been quiet this long. */
  childDoneMs: 5000,
  /** A subagent with nothing new and nothing asked in this long counts as ended. */
  childStalledMs: 10 * 60_000,
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
  /** the session that made the call: this one, or one of its subagents */
  from: string;
  toolId: string;
  prompt: string;
  role?: string;
  type?: string;
  at: number;
}

interface RunningChild {
  /** the session that started it (this one, or a subagent of it) */
  parent: string;
  sink: Sink;
  /** its updates, from its load in this process: numbered as a replay numbers it */
  t: AcpTranscript;
  /** loaded here: its updates and requests come to this process (else its store is polled) */
  loaded: boolean;
  changedAt: number;
  reported: boolean;
  asks: Set<AbortController>;
  /** fallback (not loaded): its store as last read */
  rev: string;
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
  private csrfToken!: string;
  private lsPort?: number;
  /** Bypass permissions (Tether's mode): every request is approved here, Antigravity runs in accept-edits */
  private bypass = false;
  /** Tether's MCP server name, when this session has it: its tools run without asking */
  private toolServer?: string;
  /** open permission requests, aborted when the turn ends */
  private asks = new Set<AbortController>();
  private settings: { model?: string; effort?: string; permissionMode?: string } = {};
  /** thinking levels offered for the currently selected model (empty when the model takes no effort) */
  private offeredEfforts?: string[];
  private commandList: { name: string; description?: string }[] = [];
  /** the plan file this turn wrote for review (plan mode) */
  private plan?: { path: string; toolId: string; content?: string };
  private calls: SubagentCall[] = [];
  /** what this session was loaded with; its subagents get the same (their Tether tools speak for it) */
  private mcpServers: unknown[] = [];
  private children = new Map<string, RunningChild>();
  private poll?: ReturnType<typeof setInterval>;
  onExit?: (error?: string) => void;

  private constructor(
    readonly nativeId: string,
    private projectPath: string,
    private sink: Sink,
    private usageDir: string,
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
      config: (options) => this.noteConfig(options),
    });
  }

  static async open(nativeId: string, projectPath: string, opts: StartOpts, sink: Sink, usageDir = agyUsageDir): Promise<AgyDriver> {
    if (!existsSync(projectPath)) throw new Error(`The session's folder ${projectPath} doesn't exist any more.`);
    const d = new AgyDriver(nativeId, projectPath, sink, usageDir);
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
    this.mcpServers = mcpServers;
    const append = this.readOnly ? READ_ONLY_PROMPT : server?.instructions?.();
    const csrfToken = process.env.ANTIGRAVITY_CSRF_TOKEN || randomUUID();
    this.csrfToken = csrfToken;
    this.client = new AcpClient({
      argv: acpArgv(),
      cwd: this.projectPath,
      env: { ANTIGRAVITY_CSRF_TOKEN: csrfToken },
      name: "Antigravity",
      onUpdate: (sid, u) => (sid === this.nativeId ? this.update(u) : this.childUpdate(sid, u)),
      onRequest: (method, params) => this.request(method, params),
      onExit: (error) => this.exited(error),
    });
    registerLanguageServer(this.client.pid, this.csrfToken);
    try {
      await this.client.initialize();
      // Its history comes as updates, already in the transcript: they only number what follows.
      const r: any = await this.client.call("session/load", { sessionId: this.nativeId, cwd: this.projectPath, mcpServers, ...(append ? { _meta: { antigravity: { systemPrompt: { append } } } } : {}) }, START_TIMEOUT_MS);
      noteOpened(r);
      this.t.drain();
      this.recordOfferedEfforts(r?.configOptions);
      this.note(settingsOf(r?.configOptions, typeof r?.modes?.currentModeId === "string" ? r.modes.currentModeId : undefined));
      // The session's settings as Tether shows them: they go to Antigravity before the first prompt.
      // A side chat is always in Antigravity's default mode, which asks before anything that changes something.
      const mode = this.readOnly ? "default" : opts.permissionMode;
      if (opts.model && opts.model !== "default" && opts.model !== this.settings.model) await this.setModel(opts.model);
      if (opts.effort && opts.effort !== this.settings.effort && (this.offeredEfforts === undefined || this.offeredEfforts.length > 0)) await this.setEffort(opts.effort);
      if (mode && mode !== this.settings.permissionMode) await this.setPermissionMode(mode);
    } catch (e: any) {
      this.closed = true;
      unregisterLanguageServer(this.client.pid);
      await this.client.close();
      throw new Error(this.client.why(`Antigravity didn't start: ${e?.message ?? e}`));
    }
    this.live = true;
    reader.forget();
    const context = seenContext.get(this.nativeId);
    this.sink.state({ ...this.settings, billing: billingOf(), ...(context ? { context } : {}) });
    void this.pollQuota();
  }

  private async pollQuota() {
    const cached = keptPlan();
    if (cached) this.sink.plan?.(cached);
    try {
      this.lsPort ??= await findLanguageServerPort(this.client.pid, undefined, 2000);
      if (this.lsPort) {
        const plan = await fetchQuota(this.lsPort, this.csrfToken);
        if (plan) this.sink.plan?.(plan);
      }
    } catch {}
  }

  private recordOfferedEfforts(options: any[] | undefined) {
    if (!Array.isArray(options)) return;
    const tl = options.find((c) => c?.id === "thought_level" || c?.category === "thought_level");
    this.offeredEfforts = Array.isArray(tl?.options)
      ? tl.options.map((o: any) => (typeof o?.value === "string" ? o.value : "")).filter(Boolean)
      : [];
  }

  /**
   * Model and effort from a settings snapshot. Not the mode: a snapshot can arrive after a mode
   * change and carry the old one (checked on 1.5.13), so the mode comes only from
   * `current_mode_update` and from what Tether sets.
   */
  private noteConfig(options: any[] | undefined) {
    this.recordOfferedEfforts(options);
    const { permissionMode: _, ...rest } = settingsOf(options);
    const clearEffort = Array.isArray(options) && this.offeredEfforts?.length === 0 && this.settings.effort !== undefined;
    this.note(rest, clearEffort);
  }

  /** Settings as Antigravity reports them: what the session shows. */
  private note(s: { model?: string; effort?: string; permissionMode?: string }, clearEffort = false) {
    // Under Bypass permissions Antigravity reports accept-edits; any other mode it reports ends the bypass.
    if (s.permissionMode !== undefined && this.bypass) {
      if (s.permissionMode === "accept-edits" || s.permissionMode === BYPASS) s = { ...s, permissionMode: BYPASS };
      else this.bypass = false;
    }
    const patch: Partial<{ model?: string; effort?: string; permissionMode?: string }> = {};
    for (const k of Object.keys(s) as (keyof typeof s)[]) {
      if (s[k] !== undefined && s[k] !== this.settings[k]) patch[k] = s[k];
    }
    if (clearEffort && s.effort === undefined && this.settings.effort !== undefined) patch.effort = undefined;
    if (!Object.keys(patch).length) return;
    this.settings = { ...this.settings, ...patch };
    if (patch.effort === undefined && "effort" in patch) delete this.settings.effort;
    seenSettings.set(this.nativeId, this.settings);
    if (this.live) this.sink.state(patch);
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
    // A subagent's request (it comes here once its conversation is loaded): it asks in its own session.
    const child = typeof params?.sessionId === "string" && params.sessionId !== this.nativeId ? this.children.get(params.sessionId) : undefined;
    const sink = child?.sink ?? this.sink;
    const asks = child?.asks ?? this.asks;
    const options: { optionId: string; name?: string; kind?: string }[] = Array.isArray(params?.options) ? params.options : [];
    const call = params?.toolCall ?? {};
    const tool = acpTool({ sessionUpdate: "tool_call", ...call });
    const approval = options.length > 0 && options.every((o) => ALLOW.has(o.kind ?? "") || REJECT.has(o.kind ?? ""));
    const pick = (kinds: Set<string>) => options.find((o) => o.kind && kinds.has(o.kind) && o.kind.endsWith("_once")) ?? options.find((o) => o.kind && kinds.has(o.kind));
    const answer = (o?: { optionId: string }) => (o ? { outcome: { outcome: "selected", optionId: o.optionId } } : { outcome: { outcome: "cancelled" } });
    if (approval) {
      // A side chat changes nothing: refused here as well as by the core, without asking anyone.
      if (this.readOnly) return answer(pick(REJECT));
      // Bypass permissions: approved without asking anyone, the subagents' requests too.
      if (this.bypass) return answer(pick(ALLOW));
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
    asks.add(abort);
    if (child) child.changedAt = Date.now();
    let d: Decision;
    try {
      d = await sink.request(ask, abort.signal);
    } finally {
      asks.delete(abort);
      if (child) child.changedAt = Date.now();
    }
    if (abort.signal.aborted) return answer(undefined);
    let chosen: { optionId: string } | undefined;
    if (approval) chosen = d.allow ? pick(ALLOW) : pick(REJECT);
    else if (d.allow) chosen = options.find((o) => (o.name ?? o.optionId) === d.answers?.[0]) ?? options.find((o) => o.optionId === d.answers?.[0]);
    // A plain Deny stops the turn (the subagent, for its own), as declining in Antigravity's own UI does.
    if (!d.allow && d.interrupt) setTimeout(() => void (child ? this.stopSubagent(params.sessionId) : this.interrupt()), 0);
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
    this.t.prompt(shown, tether?.origin);
    this.stopping = false;
    this.plan = undefined;
    this.flush();
    this.sink.state({ status: "running", error: undefined });
    const prompt = [{ type: "text", text }, ...images.map((i) => ({ type: "image", mimeType: i.mimeType, data: i.data }))];
    const usageTurn = { session: this.nativeId, project: this.projectPath, model: this.settings.model, plan: billingOf().kind === "plan" };
    this.turn = this.client
      .call("session/prompt", { sessionId: this.nativeId, prompt }, 0)
      .then(
        async (r: any) => {
          const stopped = r?.stopReason === "cancelled" || this.stopping;
          try {
            await recordAgyUsage(this.usageDir, usageTurn, r?.usage);
          } catch (e) {
            console.warn("Could not record Antigravity turn usage:", e);
          }
          this.ended(stopped ? undefined : stopError(r?.stopReason), stopped);
        },
        (e: unknown) => this.ended(this.stopping ? undefined : `Antigravity: ${(e as Error)?.message ?? e}`, this.stopping, e),
      );
  }

  private ended(error: string | undefined, stopped: boolean, cause?: unknown) {
    this.turn = undefined;
    this.abortAsks();
    // A process that exited ended its turn already (exited).
    if (this.closed) return;
    this.t.end(error, stopped);
    this.flush();
    if (error && !stopped) {
      const code = (cause as { data?: { code?: string } } | undefined)?.data?.code;
      if (code === "QUOTA_EXCEEDED" || code === "USAGE_LIMIT_EXCEEDED" ||
        /^Antigravity: (?:quota exceeded|usage limit exceeded)(?:[.!]|$)/i.test(error)) this.sink.limitReached?.({});
      else {
        const hit = rateLimitHit(cause);
        if (hit) this.sink.rateLimited?.(hit);
      }
    }
    this.sink.state({ status: "idle", ...(error ? {} : { error: undefined }) });
    if (!error && !stopped) this.offerPlan();
    void this.pollQuota();
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

  /** A subagent started; a file the agent wrote for review (in plan mode, the plan). */
  private noteCall(u: AcpUpdate, from = this.nativeId) {
    const raw = (u.rawInput ?? u.args) as Record<string, any> | undefined;
    const name = typeof u.name === "string" ? u.name : undefined;
    if (name === "invoke_subagent" && u.sessionUpdate === "tool_call" && raw && typeof raw.Prompt === "string") this.subagentCalled(from, String(u.toolCallId), raw);
    if (from !== this.nativeId) return;
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

  private subagentCalled(from: string, toolId: string, raw: Record<string, any>) {
    if (this.calls.some((c) => c.toolId === toolId)) return;
    this.calls.push({ from, toolId, prompt: raw.Prompt, ...(typeof raw.Role === "string" ? { role: raw.Role } : {}), ...(typeof raw.TypeName === "string" ? { type: raw.TypeName } : {}), at: Date.now() });
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
    for (const from of new Set(this.calls.map((c) => c.from))) {
      const calls = this.calls.filter((c) => c.from === from);
      const since = Math.min(...calls.map((c) => c.at)) - 5000;
      const fresh = childrenOf(from, since).filter((c) => !this.children.has(c.nativeId));
      for (const [child, call] of matchCalls(fresh, calls)) {
        this.calls = this.calls.filter((c) => c !== call);
        this.startChild(child, call);
      }
    }
    this.calls = this.calls.filter((c) => now - c.at < timing.childFindMs);
    for (const [id, c] of this.children) {
      if (!c.loaded) this.pollChild(id, c, now);
      // Over once it reported back and went quiet; or stalled a long while with nothing asked.
      const quiet = now - c.changedAt;
      if (c.asks.size) continue;
      if ((c.reported && quiet > timing.childDoneMs) || quiet > timing.childStalledMs) this.endChild(id, c);
    }
    if (!this.calls.length && !this.children.size) {
      clearInterval(this.poll);
      this.poll = undefined;
    }
  }

  /**
   * A subagent found: its session opens, and its conversation is loaded into this process, the one
   * running it. Only then does Antigravity send its updates and its permission requests here
   * (checked on 1.5.13: a request it was already waiting on arrives with the load, and approving it
   * lets it go on). If the load fails, its store is polled instead, and its requests can't be answered.
   */
  private startChild(child: string, call: SubagentCall) {
    const parentSink = call.from === this.nativeId ? this.sink : this.children.get(call.from)?.sink;
    if (!parentSink) return;
    if (call.from === this.nativeId) this.t.link(call.toolId, `antigravity:${child}`);
    else this.children.get(call.from)?.t.link(call.toolId, `antigravity:${child}`);
    const sink = parentSink.subagent({ nativeId: child, parentToolId: call.toolId, title: call.role || "Subagent", ...(call.type ? { agentType: call.type } : {}), prompt: call.prompt });
    const c: RunningChild = { parent: call.from, sink, t: new AcpTranscript("m", { stamp: stampOf(child, () => Date.now()) }), loaded: false, changedAt: Date.now(), reported: false, asks: new Set(), rev: "", shown: new Map() };
    this.children.set(child, c);
    void this.client
      .call("session/load", { sessionId: child, cwd: this.projectPath, mcpServers: this.mcpServers }, START_TIMEOUT_MS)
      .then(() => {
        if (this.children.get(child) !== c) return;
        // What it did before the load came as a replay: all of it into its transcript, then live.
        c.loaded = true;
        c.t.drain();
        for (const m of c.t.msgs) sink.event({ type: "msg", msg: structuredClone(m) });
      })
      .catch((e) => console.error(`antigravity ${this.nativeId}: couldn't load subagent ${child}: ${e?.message ?? e}`));
  }

  /** A loaded subagent's update. */
  private childUpdate(id: string, u: AcpUpdate) {
    const c = this.children.get(id);
    if (!c) return;
    c.t.update(u);
    c.changedAt = Date.now();
    if (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") {
      this.noteCall(u, id);
      const raw = (u.rawInput ?? u.args) as Record<string, unknown> | undefined;
      if (u.name === "send_message" && raw?.Recipient === c.parent) c.reported = true;
    }
    if (!c.loaded) return; // its replay: shown whole once the load answers
    for (const e of c.t.drain()) c.sink.event(e);
  }

  /** Fallback for a subagent that couldn't be loaded: its store, replayed when it changes. */
  private pollChild(id: string, c: RunningChild, now: number) {
    const rev = storeStamp(id)?.rev ?? "";
    if (rev === c.rev || c.reading) return;
    c.rev = rev;
    c.changedAt = now;
    c.reading = true;
    void reader
      .replay(id, this.projectPath)
      .then(({ msgs }) => {
        if (c.loaded || this.children.get(id) !== c) return;
        for (const m of msgs) {
          const json = JSON.stringify(m);
          if (c.shown.get(m.id) === json) continue;
          c.shown.set(m.id, json);
          c.sink.event({ type: "msg", msg: m });
          if (m.parts.some((p) => p.type === "tool" && p.name === "send_message" && (p.input as any)?.raw?.Recipient === c.parent)) c.reported = true;
        }
      })
      .catch(() => {})
      .finally(() => (c.reading = false));
  }

  private endChild(id: string, c: RunningChild) {
    if (this.children.get(id) !== c) return;
    this.children.delete(id);
    for (const a of c.asks) a.abort();
    c.asks.clear();
    if (c.loaded) {
      c.t.end();
      for (const e of c.t.drain()) c.sink.event(e);
    }
    c.sink.ended?.();
    // Its own subagents end with it.
    for (const [k, x] of this.children) if (x.parent === id) this.endChild(k, x);
  }

  /** Stops one subagent (capabilities.subagents.stop): `session/cancel` on its loaded conversation (checked on 1.5.13: a command it runs is killed). */
  async stopSubagent(nativeId: string) {
    const c = this.children.get(nativeId);
    if (!c) return;
    for (const a of c.asks) a.abort();
    if (c.loaded) {
      this.client.notify("session/cancel", { sessionId: nativeId });
      c.t.end(undefined, true);
      for (const e of c.t.drain()) c.sink.event(e);
    }
    this.endChild(nativeId, c);
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
    this.noteConfig(r?.configOptions);
  }

  async setEffort(effort: string) {
    const r: any = await this.client.call("session/set_config_option", { sessionId: this.nativeId, configId: "thought_level", value: effort });
    this.noteConfig(r?.configOptions);
  }

  async setPermissionMode(mode: string) {
    if (this.readOnly && mode !== "default") throw new Error("A side chat stays read-only.");
    const was = this.bypass;
    this.bypass = mode === BYPASS;
    try {
      await this.client.call("session/set_mode", { sessionId: this.nativeId, modeId: this.bypass ? "accept-edits" : mode });
    } catch (e) {
      this.bypass = was;
      throw e;
    }
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
    for (const [id, c] of [...this.children]) this.endChild(id, c);
  }

  private exited(error?: string) {
    const was = !this.closed;
    this.closed = true;
    unregisterLanguageServer(this.client.pid);
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
    unregisterLanguageServer(this.client.pid);
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
