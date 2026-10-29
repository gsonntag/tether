// The Agent SDK's message stream as transcript events (SPEC §5, §6a). Pure apart from the sinks it
// reports to, so recorded streams replay through it in tests (fixtures/*.jsonl).
//
//  - stream_event frames build the main thread's assistant message as it streams; the `assistant`
//    frame after each content block is the final version of that block (one block per frame).
//  - Frames with parent_tool_use_id are a subagent's: they go to that subagent's own sink (a child
//    session), whole messages at a time (subagents don't stream partials).
//  - task_* frames open and close subagents; background_tasks_changed says what still runs.
//  - session_state_changed is the turn's status (CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1): it goes
//    idle only after background subagents finish, unlike `result`.
//
// Message ids match history.ts: assistant messages are their API message id, user ones their uuid.

import type { Msg } from "../../../../shared/transcript";
import type { Sink } from "../../core/adapter";
import { assistantPart, blockText, mergePart, notice, toolResults, userMessage } from "./content";

/** What the stream needs from the driver around it. */
export interface StreamHost {
  /** the session's native id (subagents are `<this>/<agent id>`) */
  nativeId: string;
}

interface Thread {
  sink: Sink;
  /** API message id -> how many final blocks have arrived for it */
  finals: Map<string, number>;
  /** tool call id -> the message holding it */
  tools: Map<string, string>;
}

/** Task types that are subagents (others are background shells, monitors, workflows). */
const AGENT_TASKS = new Set(["local_agent", "remote_agent"]);

export class ClaudeStream {
  private main: Thread;
  /** subagent threads, by task id (= agent id) */
  private agents = new Map<string, Thread>();
  /** subagent task id by the tool call that started it */
  private agentByTool = new Map<string, string>();
  /** running background tasks (subagents, shells, …) */
  readonly running = new Set<string>();
  /** the message streaming on the main thread */
  private current?: string;
  /** session_state_changed frames arrive: they, not `result`, end turns */
  private stateEvents = false;
  /** the last API error seen in this turn (an assistant frame's `error`) */
  private lastError?: string;

  constructor(
    sink: Sink,
    private host: StreamHost,
  ) {
    this.main = { sink, finals: new Map(), tools: new Map() };
  }

  handle(m: any) {
    if (!m || typeof m !== "object") return;
    const parent: string | null = m.parent_tool_use_id ?? null;
    if (parent && (m.type === "assistant" || m.type === "user")) return this.subagentFrame(m, parent);
    switch (m.type) {
      case "stream_event":
        if (!parent) this.streamEvent(m.event);
        return;
      case "assistant":
        return this.assistant(this.main, m);
      case "user":
        return this.user(this.main, m);
      case "system":
        return this.system(m);
      case "result":
        return this.result(m);
    }
  }

  // ---------------- main thread ----------------

  private streamEvent(e: any) {
    const sink = this.main.sink;
    switch (e?.type) {
      case "message_start": {
        const id: string = e.message?.id;
        if (!id) return;
        this.current = id;
        this.main.finals.set(id, 0);
        const had = sink.message(id);
        sink.event({ type: "msg", msg: { id, role: "assistant", parts: had?.parts ?? [], ts: had?.ts ?? Date.now(), streaming: true, ...(e.message.model ? { model: e.message.model } : {}) } });
        return;
      }
      case "content_block_start": {
        const msg = this.current ? sink.message(this.current) : undefined;
        if (!msg) return;
        const parts = [...msg.parts];
        const p = assistantPart(e.content_block);
        parts[e.index] = p.type === "tool" ? { ...p, input: {} } : p;
        if (p.type === "tool") this.main.tools.set(p.id, msg.id);
        sink.event({ type: "msg", msg: { ...msg, parts: fill(parts) } });
        return;
      }
      case "content_block_delta": {
        if (!this.current) return;
        const d = e.delta;
        if (d?.type === "text_delta" && d.text) sink.event({ type: "delta", msgId: this.current, part: e.index, text: d.text });
        else if (d?.type === "thinking_delta" && d.thinking) sink.event({ type: "delta", msgId: this.current, part: e.index, text: d.thinking });
        return;
      }
      case "message_stop": {
        const msg = this.current ? sink.message(this.current) : undefined;
        if (msg?.streaming) sink.event({ type: "msg", msg: { ...msg, streaming: false } });
        return;
      }
    }
  }

  /** A final content block (main thread or a subagent's): merged at the next index of its message. */
  private assistant(t: Thread, m: any) {
    const msg = m.message;
    if (!Array.isArray(msg?.content)) return;
    const id: string = msg.id ?? m.uuid;
    if (m.error) this.lastError = blockText(msg.content) || String(m.error);
    const have = t.sink.message(id);
    const parts = [...(have?.parts ?? [])];
    let n = t.finals.get(id) ?? 0;
    for (const b of msg.content) {
      const p = assistantPart(b);
      parts[n] = mergePart(parts[n], p);
      if (p.type === "tool") t.tools.set(p.id, id);
      n++;
    }
    t.finals.set(id, n);
    const base: Msg = have ?? { id, role: "assistant", parts: [], ts: Date.now() };
    const model = msg.model && !String(msg.model).startsWith("<") ? msg.model : base.model;
    t.sink.event({ type: "msg", msg: { ...base, parts: fill(parts), ...(model ? { model } : {}), ...(m.error ? { error: this.lastError } : {}) } });
  }

  /** Tool results, and turns Claude Code injects (interrupts, task notifications). */
  private user(t: Thread, m: any) {
    if (m.isReplay) return;
    const content = m.message?.content;
    for (const r of toolResults(content)) {
      const msgId = t.tools.get(r.toolId);
      if (msgId) t.sink.event({ type: "tool", msgId, toolId: r.toolId, patch: { status: r.status, output: r.output } });
    }
    // Our own prompts are added when sent; anything else with text is something Claude Code says.
    if (!m.uuid || toolResults(content).length) return;
    const u = userMessage(content, m.uuid, Date.now(), { isMeta: m.isSynthetic, origin: m.origin });
    if (u && u.role === "notice") t.sink.event({ type: "msg", msg: u });
  }

  private system(m: any) {
    const sink = this.main.sink;
    switch (m.subtype) {
      case "init":
        if (m.session_id) sink.nativeId?.(m.session_id);
        sink.state({ ...(m.model ? { modelResolved: m.model } : {}), ...(m.permissionMode ? { permissionMode: m.permissionMode } : {}) });
        return;
      case "status":
        if (m.permissionMode) sink.state({ permissionMode: m.permissionMode });
        return;
      case "session_state_changed":
        this.stateEvents = true;
        sink.state({ status: m.state === "running" ? "running" : m.state === "requires_action" ? "waiting" : "idle" });
        return;
      case "compact_boundary":
        // Claude continues from a summary; the conversation so far stays on screen, as in the
        // store (history.ts reads across compactions), with the same notice at the spot.
        sink.event({ type: "msg", msg: notice(m.uuid ?? `n-compact-${Date.now()}`, Date.now(), "Context compacted.") });
        return;
      case "task_started":
        if (AGENT_TASKS.has(m.task_type) || m.subagent_type) this.agentStarted(m);
        if (m.task_id) this.running.add(m.task_id);
        return;
      case "task_updated":
        if (["completed", "failed", "killed"].includes(m.patch?.status)) this.taskEnded(m.task_id, m.patch.status === "killed" ? "stopped" : m.patch.status, m.patch.error);
        return;
      case "task_notification":
        this.taskEnded(m.task_id, m.status);
        return;
      case "background_tasks_changed":
        // The level signal: whatever isn't listed has ended, even if its edge was missed.
        if (Array.isArray(m.tasks)) {
          const now = new Set<string>(m.tasks.map((x: any) => x?.task_id).filter(Boolean));
          for (const id of [...this.running]) if (!now.has(id)) this.taskEnded(id, "completed");
          for (const id of now) this.running.add(id);
        }
        return;
    }
  }

  private result(m: any) {
    const sink = this.main.sink;
    const msg = this.current ? sink.message(this.current) : undefined;
    if (msg?.streaming) sink.event({ type: "msg", msg: { ...msg, streaming: false } });
    this.current = undefined;
    const interrupted = m.subtype === "error_during_execution" || m.terminal_reason === "aborted_streaming" || m.terminal_reason === "aborted_tools";
    if ((m.is_error || (m.subtype && m.subtype !== "success")) && !interrupted) {
      const text = [typeof m.result === "string" ? m.result : "", this.lastError].filter(Boolean)[0] || (Array.isArray(m.errors) && m.errors.join(" ")) || "The turn failed.";
      // Claude's own error reply is already in the transcript: no second copy of it.
      if (!this.lastError || text !== this.lastError) sink.event({ type: "msg", msg: notice(`n-${m.uuid ?? Date.now()}`, Date.now(), text, "error") });
      if (/not logged in|\/login|invalid api key|authentication/i.test(text))
        sink.state({ error: "Claude Code isn't signed in on the runner machine. Run `claude` there and log in, then send again." });
    }
    this.lastError = undefined;
    // Without state events (an older CLI), the result ends the turn.
    if (!this.stateEvents) sink.state({ status: "idle" });
  }

  // ---------------- subagents ----------------

  private agentStarted(m: any) {
    const taskId: string = m.task_id;
    if (!taskId || this.agents.has(taskId)) return;
    const parentThread = (m.parent_task_id && this.agents.get(m.parent_task_id)) || this.main;
    const sink = parentThread.sink.subagent({
      nativeId: `${this.host.nativeId}/${taskId}`,
      parentToolId: m.tool_use_id ?? "",
      title: m.description || "Subagent",
      agentType: m.subagent_type,
      prompt: m.prompt,
    });
    this.agents.set(taskId, { sink, finals: new Map(), tools: new Map() });
    if (m.tool_use_id) this.agentByTool.set(m.tool_use_id, taskId);
  }

  private subagentFrame(m: any, parentTool: string) {
    const taskId: string | undefined = m.agent_id ?? this.agentByTool.get(parentTool);
    if (!taskId) return;
    // Frames can come before task_started (or without it, from an older CLI): open it from them.
    if (!this.agents.has(taskId)) this.agentStarted({ task_id: taskId, tool_use_id: parentTool, description: m.task_description, subagent_type: m.subagent_type });
    const t = this.agents.get(taskId)!;
    if (m.type === "assistant") this.assistant(t, m);
    else this.user(t, m);
  }

  private taskEnded(taskId: string | undefined, status?: string, error?: string) {
    if (!taskId) return;
    this.running.delete(taskId);
    const t = this.agents.get(taskId);
    if (!t) return;
    this.agents.delete(taskId);
    if (status === "failed") t.sink.event({ type: "msg", msg: notice(`n-${taskId}-end`, Date.now(), error ? `The subagent failed: ${error}` : "The subagent failed.", "error") });
    if (status === "stopped") t.sink.event({ type: "msg", msg: notice(`n-${taskId}-end`, Date.now(), "Stopped") });
    // Its card in the parent can still say running for a background agent: its result came early.
    t.sink.ended?.();
  }

  /** The task id of a subagent by its native id (`<session>/<task>`). */
  taskOf(nativeId: string): string | undefined {
    const i = nativeId.lastIndexOf("/");
    return i < 0 ? undefined : nativeId.slice(i + 1);
  }
}

/** Holes in a parts array (a block that started out of order) as empty text, so it serializes. */
function fill(parts: (Msg["parts"][number] | undefined)[]): Msg["parts"] {
  return Array.from(parts, (p) => p ?? { type: "text" as const, text: "" });
}
