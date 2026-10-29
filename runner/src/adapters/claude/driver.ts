// A live Claude Code session through the Agent SDK (SPEC §6): one query() with streaming input
// per session, so the process stays up between turns. What it says goes through ClaudeStream into
// the session's sink; permission prompts go to the broker through the sink.

import { query, type CanUseTool, type PermissionMode, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { Driver, Sink, StartOpts } from "../../core/adapter";
import { CLAUDE_BIN } from "./bin";
import { readHistory } from "./history";
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
    this.stream = new ClaudeStream(sink, { nativeId, reload: () => void this.reload() });
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
    const canUseTool: CanUseTool = async (tool, input, { signal }) => {
      const question = tool === "AskUserQuestion";
      const d = await this.sink.request(
        question ? { kind: "question", tool, input, question: String((input as any)?.questions?.[0]?.question ?? "Claude has a question") } : { kind: "approval", tool, input },
        signal,
      );
      return d.allow ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: d.reason };
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
      for await (const m of this.q) this.stream.handle(m);
    } catch (e: any) {
      error = this.why(`Claude Code stopped: ${e?.message ?? e}`);
    }
    if (this.closed) return;
    this.closed = true;
    this.onExit?.(error);
  }

  private async reload() {
    try {
      const messages = await readHistory(this.nativeId, this.projectPath);
      this.sink.event({ type: "reset", messages, hasOlder: false });
    } catch {}
  }

  async send(text: string) {
    if (this.closed) throw new Error("Claude Code isn't running.");
    const uuid = randomUUID();
    // In the transcript under the uuid Claude Code stores it with, so stored and live ids agree.
    this.sink.event({ type: "msg", msg: { id: uuid, role: "user", ts: Date.now(), parts: [{ type: "text", text }] } });
    this.sink.state({ status: "running", error: undefined });
    this.input.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, uuid, origin: { kind: "human" } } as SDKUserMessage);
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
