// A live Claude Code session through the Agent SDK (SPEC §6): one query() with streaming input
// per session, so the process stays up between turns. What it says goes through ClaudeStream into
// the session's sink; permission prompts go to the broker through the sink.

import { query, type CanUseTool, type PermissionMode, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import type { Attachment } from "../../../../shared/attachments";
import { tetherOrigin } from "../../../../shared/fromTether";
import { UNKNOWN_BILLING, type ContextUse, type Msg, type Part, type ToolPart } from "../../../../shared/transcript";
import { redact, type CredentialSnapshot } from "../../credentials";
import { nativeImages } from "../../core/attachments";
import { existsSync } from "node:fs";
import type { Driver, Sink, StartOpts } from "../../core/adapter";
import { CLAUDE_BIN } from "./bin";
import { canonicalCommand } from "./content";
import { keepBilling } from "./context";
import { claudeAuthSettings, claudeEnv, claudeKeyLease, confirmClaudeBilling } from "./credentials";
import { claudeAsk, claudeResult } from "./requests";
import { ClaudeStream } from "./stream";
import { ClaudeCostCounter } from "./cost";

/** User messages for the SDK, pushed as they're sent; the iterator waits between them. */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private wake?: () => void;
  private ended = false;
  push(m: SDKUserMessage) {
    this.items.push(m);
    this.wake?.();
  }
  end() {
    this.ended = true;
    this.wake?.();
  }
  async *[Symbol.asyncIterator]() {
    for (;;) {
      while (this.items.length) yield this.items.shift()!;
      if (this.ended) return;
      await new Promise<void>((r) => (this.wake = r));
      this.wake = undefined;
    }
  }
}

/** How long Claude Code may take to start before it counts as failed. */
const START_TIMEOUT_MS = 60_000;

export class ClaudeDriver implements Driver {
  private q!: Query;
  private input = new InputQueue();
  private stream: ClaudeStream;
  private closed = false;
  private stderr: string[] = [];
  private credential?: CredentialSnapshot;
  private failedError?: string;
  private interrupting = false;
  private lease?: ReturnType<typeof claudeKeyLease>;
  private costs?: ClaudeCostCounter;
  private costSessionId?: string;
  onExit?: (error?: string) => void;

  private constructor(
    readonly nativeId: string,
    private projectPath: string,
    private sink: Sink,
  ) {
    this.stream = new ClaudeStream(sink, { nativeId, contextNow: () => this.contextNow(), failed: () => this.failed(), interrupted: () => this.interrupting });
  }

  /** Starts Claude Code on a new session (`resume`: false) or an existing one. Rejects if it can't start. */
  static async open(nativeId: string, projectPath: string, opts: StartOpts, sink: Sink, resume: boolean): Promise<ClaudeDriver> {
    // The SDK would blame the binary for a missing working folder.
    if (!existsSync(projectPath)) throw new Error(`The session's folder ${projectPath} doesn't exist any more.`);
    const d = new ClaudeDriver(nativeId, projectPath, sink);
    await d.start(opts, resume);
    return d;
  }

  private async start(opts: StartOpts, resume: boolean) {
    this.credential = opts.credential;
    this.lease = claudeKeyLease(opts.credential);
    const canUseTool: CanUseTool = async (tool, input, o) => {
      // A subagent's request goes to its own session (it shows in the parent's too).
      const sink = (o.agentID && this.stream.sinkOfAgent(o.agentID)) || this.sink;
      const ask = claudeAsk(tool, input, o);
      return claudeResult(ask, input, await sink.request(ask, o.signal));
    };
    this.q = query({
      prompt: this.input,
      options: {
        cwd: this.projectPath,
        ...(resume ? { resume: this.nativeId } : { sessionId: this.nativeId }),
        ...(opts.model && opts.model !== "default" ? { model: opts.model } : {}),
        ...(opts.effort ? { effort: opts.effort as any } : {}),
        ...(opts.permissionMode ? { permissionMode: opts.permissionMode as PermissionMode } : {}),
        // Lets the person pick Bypass permissions later in the session; it isn't on by itself.
        allowDangerouslySkipPermissions: true,
        includePartialMessages: true,
        forwardSubagentText: true,
        // Each subagent has its own Stop, so Stop on the main turn leaves background ones running.
        perTaskStopAffordance: true,
        settingSources: ["user", "project", "local"],
        settings: claudeAuthSettings(this.lease.helper),
        systemPrompt: { type: "preset", preset: "claude_code" },
        canUseTool,
        env: claudeEnv(opts.credential),
        pathToClaudeCodeExecutable: CLAUDE_BIN,
        stderr: (data: string) => {
          this.stderr.push(redact(data));
          if (this.stderr.length > 50) this.stderr.shift();
        },
      },
    });
    // Starting fails here (no binary, a bad resume id, …) rather than on the first message.
    try {
      await Promise.race([this.q.initializationResult(), Bun.sleep(START_TIMEOUT_MS).then(() => Promise.reject(new Error("Claude Code didn't start within a minute.")))]);
    } catch (e: any) {
      this.closed = true;
      this.input.end();
      try {
        this.q.close();
      } catch {}
      this.lease?.close();
      throw new Error(this.why(e?.message ?? String(e)));
    }
    try {
      await this.noteBilling();
    } catch (e) {
      await this.close();
      this.sink.state({ billing: UNKNOWN_BILLING });
      throw e;
    }
    if (this.credential?.source === "anthropic") {
      let baseline: number | undefined = resume ? undefined : 0;
      if (resume) {
        // Pinned, unstable read-only API. A missing/changed reply leaves the amount unknown.
        const readUsage = this.q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
        const usage = await Promise.race([
          Promise.resolve().then(() => typeof readUsage === "function" ? readUsage.call(this.q, { skipBehaviors: true }) : undefined).catch(() => undefined),
          Bun.sleep(5000).then(() => undefined),
        ]);
        const total = usage?.session?.total_cost_usd;
        if (typeof total === "number" && Number.isFinite(total) && total >= 0) baseline = total;
      }
      this.costs = new ClaudeCostCounter(baseline);
      this.costSessionId = this.nativeId;
    }
    void this.pump();
    void this.reportEffort();
  }

  /** The effort that really goes out: Claude Code drops it on a model without effort (Haiku 4.5), and says so only here. */
  private async reportEffort() {
    // Not in the SDK's types yet (0.3.312), and it may go: then the session shows what was sent.
    const q = this.q as unknown as { getSettings?(): Promise<{ applied?: { effort?: string | null } }> };
    const applied = (await q.getSettings?.().catch(() => undefined))?.applied;
    if (applied && "effort" in applied && !this.closed) this.sink.state({ effort: applied.effort ?? undefined });
  }

  /** What this start draws from: only Claude Code can say, and only now. */
  private async noteBilling() {
    const account = await this.q.accountInfo().catch(() => undefined);
    const billing = confirmClaudeBilling(account, this.credential);
    keepBilling(this.nativeId, billing);
    this.sink.state({ billing });
  }

  private async contextNow(): Promise<ContextUse | undefined> {
    const u = await this.q.getContextUsage({ detail: "summary" });
    const total = u.rawMaxTokens || u.maxTokens;
    return u.totalTokens > 0 && total >= u.totalTokens ? { used: u.totalTokens, total } : undefined;
  }

  /** A failure's message, with what Claude Code printed when it says more. */
  private why(message: string): string {
    if (this.credential?.source === "anthropic") return "Anthropic API key failed. The session stopped. Check Credentials.";
    const err = this.stderr.join("").trim().split("\n").filter(Boolean).slice(-3).join(" ").slice(0, 500);
    return redact(err && !message.includes(err) ? `${message} (${err})` : message);
  }

  private failed(): string | undefined {
    if (this.credential?.source !== "anthropic") return undefined;
    if (this.failedError) return this.failedError;
    const error = "Anthropic API key failed. The session stopped. Check Credentials.";
    this.failedError = error;
    this.sink.state({ status: "idle", error });
    void this.close().finally(() => this.onExit?.(error));
    return error;
  }

  private async pump() {
    let error: string | undefined;
    try {
      for await (const m of this.q) {
        try {
          if (this.costs) {
            if (m.type === "conversation_reset") this.costs.reset();
            if ((m.type === "result" || (m.type === "system" && m.subtype === "init")) && m.session_id && m.session_id !== this.costSessionId) {
              this.costs.reset();
              this.costSessionId = m.session_id;
            }
            if (m.type === "result") this.sink.cost?.(this.costs.report(m.total_cost_usd, m.subtype === "error_during_execution"));
          }
          this.stream.handle(m);
        } catch (e: any) {
          // Tether's bug, not Claude's: stop this process cleanly and say so.
          console.error(`claude ${this.nativeId}: couldn't handle output`);
          error = "Tether couldn't follow Claude Code's output, so it closed the session. Send again to resume it.";
          this.closed = true;
          this.input.end();
          try {
            this.q.close();
          } catch {}
          break;
        }
      }
    } catch (e: any) {
      if (!error) error = this.why(`Claude Code stopped: ${e?.message ?? e}`);
    }
    if (this.closed && !error) return;
    this.closed = true;
    this.lease?.close();
    this.onExit?.(error);
  }

  async send(text: string, attachments: Attachment[] = []) {
    if (this.closed) throw new Error("Claude Code isn't running.");
    this.interrupting = false;
    this.sink.state({ status: "running", error: undefined });
    this.push(text, attachments);
  }

  /**
   * Into the running turn (SPEC §9): with streaming input, Claude Code takes a message that arrives
   * mid-turn at its next step (it stores it as a queued command), or starts a turn with it if the
   * turn ended meanwhile.
   */
  async steer(text: string, attachments: Attachment[] = []) {
    if (this.closed) throw new Error("Claude Code isn't running.");
    this.push(text, attachments);
  }

  /** A message to Claude Code, shown in the transcript under the uuid it stores it with. */
  private push(text: string, attachments: Attachment[]) {
    this.stream.mainStarts();
    const uuid = randomUUID();
    const images = nativeImages(attachments);
    // Tether's own message (an answer passed on after a restart) shows as Tether's, as stored ones do.
    const tether = tetherOrigin(text);
    const parts: Part[] = [{ type: "text", text: tether?.text ?? canonicalCommand(text) }, ...images.map((i) => ({ type: "image" as const, mimeType: i.mimeType, data: i.data }))];
    const shown: Msg = { id: uuid, role: "user", ts: Date.now(), ...(tether ? { origin: tether.origin } : {}), parts };
    this.sink.event({ type: "msg", msg: shown });
    const content = images.length ? [{ type: "text", text }, ...images.map((i) => ({ type: "image", source: { type: "base64", media_type: i.mimeType, data: i.data } }))] : text;
    this.input.push({ type: "user", message: { role: "user", content }, parent_tool_use_id: null, uuid, origin: { kind: "human" } } as SDKUserMessage);
  }

  /** Asking the main agent to pass a message on to a subagent (SPEC §6a, steer "via-parent"). */
  relayMessage(nativeId: string, text: string) {
    const agent = this.stream.taskOf(nativeId) ?? nativeId;
    return `Please pass this message from the user to your running subagent ${agent} right now: call the SendMessage tool with to: "${agent}" and the message below exactly as written, then carry on with what you were doing. Don't answer it yourself.\n\n${text}`;
  }

  /** The main agent's SendMessage call to that subagent, carrying the message. */
  relayedBy(nativeId: string, tool: ToolPart, text?: string) {
    const agent = this.stream.taskOf(nativeId);
    const input = (tool.input ?? {}) as { to?: unknown; message?: unknown };
    if (tool.name !== "SendMessage" || !agent || typeof input.to !== "string") return false;
    if (input.to !== agent && this.stream.nameOfAgent(agent) !== input.to) return false;
    // The main agent may message it on its own too: this one carries (the start of) your text.
    const norm = (x: string) => x.replace(/\s+/g, " ").trim().slice(0, 60);
    return !text || (typeof input.message === "string" && norm(input.message).includes(norm(text)));
  }

  async interrupt() {
    // With the main agent free only background work is left, which an interrupt spares.
    const left = this.stream.onlyBackground() ? [...this.stream.background] : [];
    this.interrupting = true;
    await this.q.interrupt();
    await Promise.all(left.map((id) => this.q.stopTask(id).catch(() => {})));
  }

  async setModel(model: string) {
    await this.q.setModel(model === "default" ? undefined : model);
    void this.reportEffort();
  }

  async setEffort(effort: string) {
    await this.q.applyFlagSettings({ effortLevel: effort as any });
    void this.reportEffort();
  }

  async setPermissionMode(mode: string) {
    await this.q.setPermissionMode(mode as PermissionMode);
  }

  async stopSubagent(nativeId: string) {
    const task = this.stream.taskOf(nativeId);
    if (task) await this.q.stopTask(task);
  }

  /** Ctrl+B in the terminal, for one subagent: its call returns, and the main agent goes on. */
  async backgroundSubagent(toolId: string) {
    await this.q.backgroundTasks(toolId);
  }

  onlyBackground() {
    return this.stream.onlyBackground();
  }

  busy() {
    return this.stream.running.size > 0;
  }

  /** The live list of models, from this process. */
  models() {
    return this.q.supportedModels();
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.input.end();
    try {
      this.q.close();
    } catch {}
    this.lease?.close();
  }
}
