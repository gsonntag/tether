// A live Claude Code session through the Agent SDK (SPEC §6): one query() with streaming input
// per session, so the process stays up between turns. What it says goes through ClaudeStream into
// the session's sink; permission prompts go to the broker through the sink.

import { query, type CanUseTool, type PermissionMode, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import type { Attachment } from "../../../../shared/attachments";
import { tetherOrigin } from "../../../../shared/fromTether";
import type { Msg, Part, ToolPart } from "../../../../shared/transcript";
import { nativeImages } from "../../core/attachments";
import { existsSync } from "node:fs";
import type { Driver, Sink, StartOpts } from "../../core/adapter";
import { CLAUDE_BIN } from "./bin";
import { canonicalCommand } from "./content";
import { claudeAsk, claudeResult } from "./requests";
import { ClaudeStream } from "./stream";

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

/** The runner's environment for Claude, minus Tether's own secrets. */
function claudeEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("TETHER_")) env[k] = v;
  // Turn status from Claude Code itself: idle only once background subagents are done too.
  env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS = "1";
  return env;
}

/** How long Claude Code may take to start before it counts as failed. */
const START_TIMEOUT_MS = 60_000;

export class ClaudeDriver implements Driver {
  private q!: Query;
  private input = new InputQueue();
  private stream: ClaudeStream;
  private closed = false;
  private stderr: string[] = [];
  onExit?: (error?: string) => void;

  private constructor(
    readonly nativeId: string,
    private projectPath: string,
    private sink: Sink,
  ) {
    this.stream = new ClaudeStream(sink, { nativeId });
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
        settingSources: ["user", "project", "local"],
        systemPrompt: { type: "preset", preset: "claude_code" },
        canUseTool,
        env: claudeEnv(),
        pathToClaudeCodeExecutable: CLAUDE_BIN,
        stderr: (data: string) => {
          this.stderr.push(data);
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
      throw new Error(this.why(e?.message ?? String(e)));
    }
    void this.pump();
  }

  /** A failure's message, with what Claude Code printed when it says more. */
  private why(message: string): string {
    const err = this.stderr.join("").trim().split("\n").filter(Boolean).slice(-3).join(" ").slice(0, 500);
    return err && !message.includes(err) ? `${message} (${err})` : message;
  }

  private async pump() {
    let error: string | undefined;
    try {
      for await (const m of this.q) {
        try {
          this.stream.handle(m);
        } catch (e: any) {
          // Tether's bug, not Claude's: stop this process cleanly and say so.
          console.error(`claude ${this.nativeId}: couldn't handle a ${(m as any)?.type}${(m as any)?.subtype ? `/${(m as any).subtype}` : ""} message:`, e);
          error = `Tether couldn't follow Claude Code's output (${e?.message ?? e}), so it closed the session. Send again to resume it.`;
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
    this.onExit?.(error);
  }

  async send(text: string, attachments: Attachment[] = []) {
    if (this.closed) throw new Error("Claude Code isn't running.");
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
    await this.q.interrupt();
  }

  async setModel(model: string) {
    await this.q.setModel(model === "default" ? undefined : model);
  }

  async setEffort(effort: string) {
    await this.q.applyFlagSettings({ effortLevel: effort as any });
  }

  async setPermissionMode(mode: string) {
    await this.q.setPermissionMode(mode as PermissionMode);
  }

  async stopSubagent(nativeId: string) {
    const task = this.stream.taskOf(nativeId);
    if (task) await this.q.stopTask(task);
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
  }
}
