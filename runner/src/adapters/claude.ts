// Claude Code via the Claude Agent SDK (same engine and login as the `claude` CLI).
// One streaming-input query() per live session: user messages are pushed into an async queue,
// so the session stays open between turns and later prompts can be queued while it runs.

import {
  getSessionMessages,
  listSessions,
  query,
  renameSession,
  resolveSettings,
  type CanUseTool,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ActivityItem, ContextUsage, ModelRef, Msg, Part, SessionSummary } from "../../../web/src/shared/protocol";
import { tail } from "./activity";
import { ClaudeActivity } from "./claudeActivity";
import { userParts } from "../../../web/src/shared/bash";
import { displayText } from "../../../web/src/shared/skill";
import { findPlan, findTool } from "../../../web/src/shared/reducer";
import { anthropicUsage, claudeContextUsage, claudeHistoryContext, claudeWindow } from "../contextWindow";
import { LiveSession, newId } from "../session";
import { rememberClaudeBuiltins } from "../skillcmd";
import { sessionContext } from "../context/inject";
import { LimitStatus, toMs } from "../limitStatus";
import type { Adapter, CreateOpts, Sink, StoredProject } from "./types";

const CLAUDE_BIN = process.env.CLAUDE_BIN ?? Bun.which("claude") ?? undefined;
/** The modes Tether offers: only those that keep asking the guard (acceptEdits, auto, bypass… don't). */
export const PERMISSION_MODES = ["default", "plan"];

/** Claude permission modes that still ask canUseTool (so the guard) before acting. */
export function keepsGuard(mode: string | undefined): mode is "default" | "plan" {
  return mode === "default" || mode === "plan";
}
const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];
const FALLBACK_MODELS: ModelRef[] = [
  { id: "default", label: "Default" },
  { id: "opus", label: "Opus" },
  { id: "sonnet", label: "Sonnet" },
  { id: "haiku", label: "Haiku" },
];

// ---------------- conversion ----------------

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content.map((b: any) => (b.type === "text" ? b.text : b.type === "image" ? "[image]" : "")).filter(Boolean).join("\n");
  return "";
}

/** Flags Claude Code stores on transcript entries (the SDK's history API drops them). */
interface EntryFlags {
  isMeta?: boolean;
  isCompactSummary?: boolean;
  origin?: { kind?: string; name?: string; body?: string; server?: string; from?: string };
}

const tag = (text: string, name: string) => text.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.trim();

function notice(id: string, ts: number, source: Msg["source"], title: string, body?: string, collapsed = true): Msg {
  return { id, role: "notice", level: "info", source, title, collapsed: collapsed && !!body, parts: body ? [{ type: "text", text: body }] : [], ts };
}

/**
 * Turns Claude Code injects as "user" messages but the person didn't type: subagent reports,
 * background-task notifications, compaction summaries, slash-command bodies, caveats and system
 * reminders. Returns the message to show (often a notice), null to hide it, or undefined when it
 * is an ordinary prompt.
 */
function injected(text: string, flags: EntryFlags, id: string, ts: number): Msg | null | undefined {
  const o = flags.origin;
  const peerTag = text.match(/<agent-message[^>]*>([\s\S]*?)(?:<\/agent-message>|$)/);
  if (o?.kind === "peer" || (peerTag && /^\s*(Another Claude session sent a message:\s*)?<agent-message/.test(text))) {
    // The report itself; drop the harness's "this is model output" preamble.
    const raw = o?.body ?? peerTag?.[1] ?? text;
    const body = raw.replace(/^\[Subagent hand-back\][\s\S]*?The report follows:\s*/, "").replace(/^\s{2}/gm, "").trim();
    const sub = /^\[Subagent hand-back\]/.test(raw);
    return notice(id, ts, "agent", `${sub ? "Report from subagent" : "Message from another session"}${o?.name ? ` · ${o.name}` : ""}`, body);
  }
  if (o?.kind === "task-notification" || text.trimStart().startsWith("<task-notification>")) {
    const summary = tag(text, "summary") ?? "Background task update";
    const status = tag(text, "status");
    const result = tag(text, "result");
    const usage = tag(text, "usage");
    const ms = usage && Number(tag(usage, "duration_ms"));
    const toks = usage && Number(tag(usage, "subagent_tokens") ?? tag(usage, "total_tokens"));
    const meta = [status, ms ? `${Math.round(ms / 60000) || "<1"} min` : "", toks ? `${Math.round(toks / 1000)}k tokens` : ""].filter(Boolean).join(" · ");
    const showResult = result && !/delivered to you as a message/i.test(result) ? result : undefined;
    return notice(id, ts, "task", `${summary}${meta ? ` (${meta})` : ""}`, showResult);
  }
  if (o?.kind === "channel") return notice(id, ts, "channel", `Message from ${o.server ?? "a channel"}`, text, false);
  if (flags.isCompactSummary) return notice(id, ts, "compaction", "Conversation compacted: summary of the earlier part", text);
  const t = text.trimStart();
  if (t.startsWith("<system-reminder>") || t.startsWith("<local-command-caveat>") || t.startsWith("[Request interrupted")) return null;
  if (t.startsWith("<local-command-stdout>")) {
    const out = tag(t, "local-command-stdout");
    return out ? notice(id, ts, "command", "Command output", out, false) : null;
  }
  if (flags.isMeta) return notice(id, ts, "command", "Expanded command instructions", text);
  return undefined;
}

/** Strips Claude Code's wrapper tags from a user prompt; undefined = not shown. */
function cleanUserText(text: string): string | undefined {
  if (text.startsWith("<local-command-caveat>") || text.startsWith("<local-command-stdout>")) return undefined;
  const cmd = text.match(/<command-name>([^<]*)<\/command-name>/);
  if (cmd) {
    const args = text.match(/<command-args>([^<]*)<\/command-args>/)?.[1]?.trim();
    return `${cmd[1]}${args ? " " + args : ""}`;
  }
  if (text.startsWith("<system-reminder>") || text.startsWith("[Request interrupted")) return undefined;
  return text;
}

function assistantParts(content: any[]): Part[] {
  return content.map((b): Part => {
    if (b.type === "text") return { type: "text", text: b.text };
    if (b.type === "thinking") return { type: "thinking", text: b.thinking ?? "" };
    if (b.type === "redacted_thinking") return { type: "thinking", text: "(redacted)" };
    if (b.type === "tool_use" && b.name === "ExitPlanMode") return { type: "plan", id: b.id, text: typeof b.input?.plan === "string" ? b.input.plan : "" };
    if (b.type === "tool_use" || b.type === "server_tool_use" || b.type === "mcp_tool_use")
      return { type: "tool", id: b.id, name: b.name, input: b.input, status: "running" };
    return { type: "text", text: "" };
  });
}

/** Applies tool_result blocks of a user message; returns the visible user message, if any. */
function applyUser(content: unknown, messages: Msg[], id: string, ts: number, flags: EntryFlags = {}): Msg | undefined {
  const whole = typeof content === "string" ? content : Array.isArray(content) ? content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n") : "";
  if (whole) {
    const inj = injected(whole, flags, id, ts);
    if (inj === null) return undefined;
    if (inj) return inj;
  }
  if (typeof content === "string") {
    const text = cleanUserText(content);
    return text === undefined ? undefined : { id, role: "user", parts: userParts(text, id), ts };
  }
  const parts: Part[] = [];
  for (const b of (content as any[]) ?? []) {
    if (b.type === "tool_result") {
      const hit = findTool(messages, b.tool_use_id);
      if (hit) {
        hit.part.status = b.is_error ? "error" : "done";
        hit.part.output = blockText(b.content);
      }
      const plan = !hit && findPlan(messages, b.tool_use_id);
      if (plan) {
        // Declined: the result is the person's feedback. Approved: it repeats the plan as approved.
        const result = blockText(b.content);
        plan.part.outcome = b.is_error ? "feedback" : "approved";
        const approved = result.split("## Approved Plan:\n")[1];
        if (approved) plan.part.text = approved.trim();
        if (b.is_error && result.trim()) parts.push(...userParts(result, `${id}:${parts.length}`));
      }
    } else if (b.type === "text") {
      const text = cleanUserText(b.text);
      if (text !== undefined) parts.push(...userParts(text, `${id}:${parts.length}`));
    } else if (b.type === "image" && b.source?.type === "base64") {
      parts.push({ type: "image", mimeType: b.source.media_type, data: b.source.data });
    }
  }
  return parts.length ? { id, role: "user", parts, ts } : undefined;
}

/** The session's JSONL under ~/.claude/projects (the SDK encodes the cwd by replacing non-alphanumerics). */
function transcriptFile(sessionId: string, dir: string): string | undefined {
  const base = join(homedir(), ".claude", "projects");
  const direct = join(base, dir.replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`);
  if (existsSync(direct)) return direct;
  try {
    for (const d of readdirSync(base)) {
      const f = join(base, d, `${sessionId}.jsonl`);
      if (existsSync(f)) return f;
    }
  } catch {}
  return undefined;
}

async function entryFlags(sessionId: string, dir: string): Promise<Map<string, EntryFlags>> {
  const out = new Map<string, EntryFlags>();
  const f = transcriptFile(sessionId, dir);
  if (!f) return out;
  for (const line of (await Bun.file(f).text()).split("\n")) {
    if (!line.includes('"type":"user"') || !(line.includes('"isMeta"') || line.includes('"origin"') || line.includes('"isCompactSummary"'))) continue;
    try {
      const e = JSON.parse(line);
      if (e.uuid) out.set(e.uuid, { isMeta: e.isMeta, isCompactSummary: e.isCompactSummary, origin: e.origin });
    } catch {}
  }
  return out;
}

/** `onContext`: the context as of the last stored reply (a resumed process reports nothing until prompted). */
export async function loadHistory(sessionId: string, dir: string, onContext?: (c: ContextUsage | undefined) => void): Promise<Msg[]> {
  const [list, flags] = await Promise.all([getSessionMessages(sessionId, { dir, includeSystemMessages: true }), entryFlags(sessionId, dir)]);
  onContext?.(claudeHistoryContext(list));
  const out: Msg[] = [];
  const byApiId = new Map<string, Msg>();
  for (const m of list) {
    if (m.parent_tool_use_id) continue; // subagent internals
    const msg: any = m.message;
    if (m.type === "assistant" && msg?.content) {
      // Claude Code writes one entry per content block, sharing the API message id.
      const apiId = msg.id ?? m.uuid;
      const prev = byApiId.get(apiId);
      const parts = assistantParts(msg.content);
      if (prev) prev.parts.push(...parts);
      else {
        const nm: Msg = { id: m.uuid, role: "assistant", parts, ts: 0, model: msg.model };
        byApiId.set(apiId, nm);
        out.push(nm);
      }
    } else if (m.type === "user" && msg) {
      const u = applyUser(msg.content, out, m.uuid, 0, flags.get(m.uuid));
      if (u) out.push(u);
    } else if (m.type === "system" && msg?.subtype === "compact_boundary") {
      out.push({ id: m.uuid, role: "notice", level: "info", parts: [{ type: "text", text: "Context compacted." }], ts: 0 });
    }
  }
  for (const m of out) for (const p of m.parts) if (p.type === "tool" && p.status === "running") p.status = "error";
  return out;
}

// ---------------- input queue ----------------

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

// ---------------- live session ----------------

class ClaudeSession extends LiveSession {
  private q?: Query;
  private input = new InputQueue();
  private resumeId?: string;
  /** API message id -> transcript message id, for streaming + final blocks */
  private current?: { apiId: string; msgId: string; finalCount: number };
  private rejected?: { resetAt?: number };
  private limits = new LimitStatus();
  private limitTimer?: ReturnType<typeof setTimeout>;
  private lastError?: { text?: string; status?: number | null; kind?: string };
  /** subagents, shells, monitors, cron jobs, wakeups (claudeActivity.ts) */
  private act = new ClaudeActivity();
  private pollTimer?: ReturnType<typeof setInterval>;

  constructor(
    init: { nativeId: string; projectPath: string; title?: string; createdAt?: number; updatedAt?: number },
    sink: Sink,
    private opts: CreateOpts & { resume?: boolean } = {},
  ) {
    super("claude-code", init, sink);
    if (opts.resume) this.resumeId = init.nativeId;
  }

  async start() {
    if (this.resumeId) {
      this.emit({ type: "reset", messages: await loadHistory(this.resumeId, this.projectPath, (c) => this.setContext(c)) });
    }
    // Your own settings (user, project, local) decide model, effort and permission mode unless
    // this session explicitly chose something else.
    const eff: any = await resolveSettings({ cwd: this.projectPath, settingSources: ["user", "project", "local"] })
      .then((r) => r.effective)
      .catch(() => ({}));
    const model = this.opts.model && this.opts.model !== "default" ? this.opts.model : undefined;
    // The guard decides approvals, so Claude's own approving modes (acceptEdits, auto, bypass…) from
    // settings must not apply: they'd answer before canUseTool is ever asked. Plan mode is safe to keep.
    // The same goes for a mode carried over by a handoff (the previous session's mode, or another
    // harness's like opencode's "build").
    const settingsMode = eff.permissions?.defaultMode === "plan" ? "plan" : "default";
    const permissionMode = keepsGuard(this.opts.permissionMode) ? this.opts.permissionMode : settingsMode;
    const canUseTool: CanUseTool = (toolName, input, { signal, suggestions, toolUseID }) => this.permission(toolName, input, signal, suggestions, toolUseID);
    // Master context: shared memory in the system prompt, and the tether-context MCP server.
    const ctx = await sessionContext(this.projectPath, { id: this.id, key: this.guardEnv.TETHER_GUARD_KEY });
    this.q = query({
      prompt: this.input,
      options: {
        cwd: this.projectPath,
        ...(this.resumeId ? { resume: this.resumeId } : { sessionId: this.nativeId }),
        ...(model ? { model } : {}),
        permissionMode: permissionMode as any,
        includePartialMessages: true,
        // A one-line "what it's doing" for running subagents, every ~30 s (forks reuse their cache).
        agentProgressSummaries: true,
        settingSources: ["user", "project", "local"],
        systemPrompt: { type: "preset", preset: "claude_code", ...(ctx ? { append: ctx.prompt } : {}) },
        ...(ctx ? { mcpServers: { "tether-context": { type: "stdio" as const, ...ctx.mcp } } } : {}),
        canUseTool,
        pathToClaudeCodeExecutable: CLAUDE_BIN,
        stderr: (d) => process.env.DEBUG && process.stderr.write(d),
      },
    });
    this.setState({
      status: "idle",
      model: model ?? eff.model ?? "default",
      permissionMode,
      thinking: eff.effortLevel,
      modes: PERMISSION_MODES,
      // A new process has no tasks yet; they arrive as it starts them.
      activity: [],
    });
    this.pump();
    this.refreshContext();
  }

  /** Claude Code's own /context estimate: the window, and (resumed) how full it was. */
  private refreshContext() {
    this.q
      ?.getContextUsage({ detail: "summary" })
      .then((r) => this.setContext(claudeContextUsage(r)))
      .catch(() => {});
  }

  private async pump() {
    try {
      for await (const m of this.q!) this.onMessage(m);
    } catch (e: any) {
      if (!this.closed) this.notice(`Claude Code stopped: ${e?.message ?? e}`, "error");
    }
    if (!this.closed) {
      this.setState({ status: "idle" });
      this.close();
    }
  }

  private onMessage(m: SDKMessage) {
    this.upsertActivity(...this.act.onMessage(m));
    this.pollOutputs();
    // Subagent internals feed its activity item (steps, latest action); the Agent tool card shows the result.
    if ((m as any).parent_tool_use_id) return;
    switch (m.type) {
      case "system":
        this.onSystem(m as any);
        break;
      case "stream_event":
        this.onStream((m as any).event);
        break;
      case "assistant": {
        const msg: any = m.message;
        if ((m as any).error) this.lastError = { kind: (m as any).error, text: blockText(msg?.content) };
        this.onAssistant(msg);
        break;
      }
      case "user": {
        // Our own prompts are added when sent; besides tool results, show only turns Claude Code
        // injects itself (subagent reports, task notifications, channel messages).
        const content: any = (m as any).message?.content;
        const um = m as any;
        if (!um.isReplay && (um.origin && um.origin.kind !== "human" || um.isSynthetic)) {
          const msg = applyUser(content, this.t.messages, um.uuid ?? newId("i"), Date.now(), { origin: um.origin, isMeta: um.isMeta ?? um.isSynthetic });
          if (msg) this.emit({ type: "msg", msg });
        }
        if (Array.isArray(content))
          for (const b of content) {
            if (b.type !== "tool_result") continue;
            const hit = findTool(this.t.messages, b.tool_use_id);
            if (hit)
              this.emit({ type: "tool", msgId: hit.msg.id, toolId: b.tool_use_id, patch: { status: b.is_error ? "error" : "done", output: blockText(b.content) } });
          }
        break;
      }
      case "result":
        this.onResult(m as any);
        break;
      case "rate_limit_event": {
        const info = (m as any).rate_limit_info;
        if (info?.status === "rejected") {
          const r = info.resetsAt;
          this.rejected = { resetAt: r ? toMs(r) : undefined };
        } else if (this.limits.update(info)) this.showLimit();
        break;
      }
    }
  }

  /**
   * While background shells or monitors run, read the end of their output every few seconds (the
   * same tail the CLI's /tasks view shows), and once more when they end. Wakeups due fire too.
   */
  private pollOutputs() {
    const busy = this.act.readable().length > 0 || this.act.list().some((a) => a.id.startsWith("wakeup:") && a.status === "waiting");
    if (busy && !this.pollTimer) this.pollTimer = setInterval(() => this.readOutputs(), 3_000);
    if (!busy && this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
      this.readOutputs();
    }
  }

  private finalRead = new Set<string>();
  /** a pass is reading (another one asked for meanwhile runs right after it) */
  private reading?: { again: boolean };
  private async readOutputs() {
    this.upsertActivity(...this.act.tick());
    const q: any = this.q;
    if (!q?.getTaskOutput || this.closed) return;
    // One pass at a time: a slow getTaskOutput mustn't stack up passes every 3 s.
    if (this.reading) return void (this.reading.again = true);
    this.reading = { again: false };
    try {
      do {
        this.reading.again = false;
        await this.readOutputsOnce(q);
      } while (this.reading.again && !this.closed);
    } finally {
      this.reading = undefined;
    }
    this.pollOutputs();
  }

  private async readOutputsOnce(q: any) {
    // Running ones, and each one that ended once more for its last lines.
    const ended = this.act.list().filter((a) => (a.kind === "shell" || a.kind === "monitor") && a.stoppable && a.endedAt && !this.finalRead.has(a.id));
    for (const a of [...this.act.readable(), ...ended]) {
      if (a.endedAt) this.finalRead.add(a.id);
      try {
        const r = await q.getTaskOutput(a.id);
        const output = tail(r?.output ?? "");
        if (output && output !== this.act.get(a.id)?.output) {
          this.act.patch(a.id, { output });
          this.upsertActivity(...this.act.take());
        }
      } catch {}
    }
  }

  protected async stopActivityItem(item: ActivityItem) {
    if (!this.q) throw new Error("Claude Code isn't running.");
    await this.q.stopTask(item.id);
  }

  private onSystem(m: any) {
    switch (m.subtype) {
      case "init":
        if (m.session_id) this.nativeId = m.session_id;
        this.setState({ model: m.model, permissionMode: m.permissionMode });
        break;
      case "session_state_changed":
        if (m.state === "running") this.setState({ status: "running" });
        break;
      case "status":
        if (m.permissionMode) this.setState({ permissionMode: m.permissionMode });
        if (m.status === "compacting") this.emit({ type: "toast", level: "info", text: "Compacting context…" });
        break;
      case "compact_boundary":
        this.contextCompacted(m.compact_metadata?.post_tokens);
        loadHistory(this.nativeId, this.projectPath)
          .then((messages) => this.emit({ type: "reset", messages }))
          .catch(() => {});
        break;
      case "api_retry":
        this.lastError = { kind: m.error, status: m.error_status };
        this.setState({
          status: "waiting",
          waitingReason: `API retry ${m.attempt}/${m.max_retries} (${m.error_status ?? m.error})`,
          waitingUntil: Date.now() + (m.retry_delay_ms ?? 0),
        });
        break;
      case "notification":
        if (m.message ?? m.text) this.emit({ type: "toast", level: "info", text: m.message ?? m.text });
        break;
    }
  }

  private onStream(e: any) {
    switch (e?.type) {
      case "message_start": {
        const msgId = newId("a");
        this.current = { apiId: e.message.id, msgId, finalCount: 0 };
        this.emit({ type: "msg", msg: { id: msgId, role: "assistant", parts: [], ts: Date.now(), model: e.message.model, streaming: true } });
        // Each request's usage is what the model read: the context as of this step.
        this.setContext(anthropicUsage(e.message.usage, e.message.model));
        if (this.t.state.status !== "running") this.setState({ status: "running", waitingReason: undefined, waitingUntil: undefined });
        break;
      }
      case "content_block_start": {
        const cur = this.current;
        const msg = cur && this.t.messages.find((x) => x.id === cur.msgId);
        if (!msg) break;
        const parts = [...msg.parts];
        parts[e.index] = assistantParts([e.content_block])[0]!;
        if (parts[e.index]!.type === "tool") (parts[e.index] as any).input = {};
        this.emit({ type: "msg", msg: { ...msg, parts } });
        break;
      }
      case "content_block_delta": {
        const cur = this.current;
        if (!cur) break;
        if (e.delta.type === "text_delta") this.emit({ type: "delta", msgId: cur.msgId, part: e.index, kind: "text", text: e.delta.text });
        else if (e.delta.type === "thinking_delta") this.emit({ type: "delta", msgId: cur.msgId, part: e.index, kind: "thinking", text: e.delta.thinking });
        break;
      }
    }
  }

  private onAssistant(msg: any) {
    if (!msg?.content) return;
    let cur = this.current;
    if (!cur || cur.apiId !== msg.id) {
      // No partial stream for this message (e.g. an error reply): start a fresh one.
      cur = this.current = { apiId: msg.id ?? newId("api"), msgId: newId("a"), finalCount: 0 };
      this.emit({ type: "msg", msg: { id: cur.msgId, role: "assistant", parts: [], ts: Date.now(), model: msg.model } });
    }
    const existing = this.t.messages.find((x) => x.id === cur!.msgId)!;
    const parts = [...existing.parts];
    for (const p of assistantParts(msg.content)) {
      const i = cur.finalCount++;
      const old = parts[i];
      parts[i] =
        p.type === "tool" && old?.type === "tool" && old.id === p.id
          ? { ...old, ...p, status: old.status, output: old.output }
          : p.type === "plan" && old?.type === "plan" && old.id === p.id
            ? { ...p, outcome: old.outcome }
            : p;
    }
    this.emit({ type: "msg", msg: { ...existing, parts, model: msg.model ?? existing.model, streaming: msg.stop_reason == null } });
  }

  private async onResult(r: any) {
    if (this.current) {
      const msg = this.t.messages.find((x) => x.id === this.current!.msgId);
      if (msg?.streaming) this.emit({ type: "msg", msg: { ...msg, streaming: false } });
      this.current = undefined;
    }
    this.setState({ cost: r.total_cost_usd });
    const model = this.t.state.context?.model;
    const window = claudeWindow(r.modelUsage, model);
    if (window) this.setContext({ max: window, model });
    const isErr = r.is_error || (r.subtype && r.subtype !== "success");
    if (isErr) {
      const text = [r.result, this.lastError?.text, this.lastError?.kind].filter(Boolean).join(" ");
      const hint =
        this.rejected || this.lastError?.kind === "billing_error"
          ? { kind: "quota" as const, resetAt: this.rejected?.resetAt }
          : this.lastError?.kind === "rate_limit" || this.lastError?.kind === "overloaded"
            ? { kind: "rate_limit" as const }
            : undefined;
      this.rejected = undefined;
      this.lastError = undefined;
      if (r.subtype !== "error_during_execution" || hint) {
        if (await this.handleTurnError(text, r.api_error_status, hint)) return;
      }
      if (text && r.subtype !== "error_during_execution") this.notice(text, "error");
    } else {
      this.turnSucceeded();
    }
    this.lastError = undefined;
    if (await this.drainPending()) return;
    this.setState({ status: "idle", waitingReason: undefined, waitingUntil: undefined });
  }

  private async permission(
    toolName: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
    suggestions?: any[],
    toolUseID?: string,
  ): Promise<PermissionResult> {
    if (toolName === "AskUserQuestion" && Array.isArray((input as any).questions)) {
      const id = newId("q");
      signal.addEventListener("abort", () => this.uiRespond({ id, cancelled: true }));
      // Unattended (auto/full guard): don't stall forever on a question nobody is there to answer.
      const timeout = this.guardMode === "ask" || this.guardMode === "edits" ? undefined : 15 * 60_000;
      const res = await this.askUi({ id, kind: "question", title: "Claude has a question", questions: (input as any).questions }, timeout);
      if (res.cancelled || !res.answers)
        return { behavior: "deny", message: "Nobody answered. Make the most reasonable choice yourself, say which one you made, and continue." };
      return { behavior: "allow", updatedInput: { ...input, answers: res.answers } };
    }
    if (toolName === "ExitPlanMode") return this.reviewPlan(input, signal, toolUseID);
    const v = await this.checkTool(toolName, input, toolUseID);
    if (!v.allow) return { behavior: "deny", message: v.reason || "Blocked by the Tether guard." };
    return { behavior: "allow", updatedInput: input, ...(v.always && suggestions?.length ? { updatedPermissions: suggestions } : {}) };
  }

  /**
   * Plan mode: Claude waits on ExitPlanMode until the person approves the plan or sends feedback,
   * whatever the guard mode (they chose plan mode to review it). Feedback denies the call with the
   * comments as the message, so Claude stays in plan mode and revises.
   */
  private async reviewPlan(input: Record<string, unknown>, signal: AbortSignal, toolUseID?: string): Promise<PermissionResult> {
    const planId = toolUseID ?? newId("plan");
    // Claude Code fills `plan` from its plan file; the streamed tool input can be an older draft.
    const text = typeof input.plan === "string" ? input.plan : "";
    if (findPlan(this.t.messages, planId)) {
      if (text) this.setPlan(planId, { text });
    } else {
      this.emit({ type: "msg", msg: { id: newId("a"), role: "assistant", parts: [{ type: "plan", id: planId, text }], ts: Date.now(), model: this.t.state.model } });
    }
    const id = newId("plan-review");
    signal.addEventListener("abort", () => this.uiRespond({ id, cancelled: true }));
    const res = await this.askUi({ id, kind: "plan", title: "Claude's plan is ready for review", planId });
    if (res.cancelled) return { behavior: "deny", message: "The plan review was cancelled." };
    if (res.allow) {
      this.setPlan(planId, { outcome: "approved" });
      return { behavior: "allow", updatedInput: input };
    }
    const feedback = res.value?.trim() || "Please revise the plan.";
    this.setPlan(planId, { outcome: "feedback" });
    this.addUserMessage(feedback);
    return { behavior: "deny", message: feedback };
  }

  private setPlan(planId: string, patch: { text?: string; outcome?: "approved" | "feedback" }) {
    const hit = findPlan(this.t.messages, planId);
    if (hit) this.emit({ type: "msg", msg: { ...hit.msg, parts: hit.msg.parts.map((p) => (p === hit.part ? { ...hit.part, ...patch } : p)) } });
  }

  protected async send(text: string) {
    if (await this.preferBest(text)) return;
    this.autoTitle(text);
    this.addUserMessage(text);
    this.input.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null } as SDKUserMessage);
    this.setState({ status: "running" });
  }

  /** Priority "next": Claude Code folds it in at its next step. */
  protected async steer(text: string) {
    this.input.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, priority: "next" } as SDKUserMessage);
    return true;
  }

  async abort() {
    if (this.cancelWait()) return;
    this.cancelAllUi();
    await this.q?.interrupt();
  }

  async applyModel(model: string) {
    await this.q?.setModel(model === "default" ? undefined : model);
    this.setState({ model });
    this.refreshContext();
  }

  async setThinking(level: string) {
    await this.q?.applyFlagSettings({ effortLevel: level as any });
    this.setState({ thinking: level });
  }

  async setPermissionMode(mode: string) {
    if (!keepsGuard(mode)) throw new Error(`Claude Code runs in ${PERMISSION_MODES.join(" or ")} mode here; the guard setting decides approvals.`);
    await this.q?.setPermissionMode(mode as any);
    this.setState({ permissionMode: mode });
  }

  // The guard decides approvals; a mode from Claude's settings (acceptEdits, …) would skip it.
  // Plan mode approves nothing on its own (see start()), so a guard change keeps it.
  protected onGuardChanged = () => {
    if (!keepsGuard(this.t.state.permissionMode)) this.setPermissionMode("default").catch(() => {});
  };

  async rename(title: string) {
    await renameSession(this.nativeId, title, { dir: this.projectPath });
    this.setTitle(title);
  }

  async listCommands() {
    const cmds = (await this.q?.supportedCommands()) ?? [];
    return cmds.map((c) => ({ name: c.name, description: c.description }));
  }

  /**
   * Claude Code runs its skills as `/name` (they're in its command list). A built-in command with
   * the same name would run instead, so those names don't count.
   */
  protected async nativeSkills() {
    if (!this.q) return undefined;
    const cmds = await this.q.supportedCommands();
    const builtin = new Set(cmds.filter((c) => c.builtin).map((c) => c.name));
    rememberClaudeBuiltins(builtin); // for when a session can't answer in time (skillcmd decide())
    return cmds.filter((c) => !c.builtin && !builtin.has(c.name)).map((c) => ({ name: c.name, description: c.description }));
  }

  async models(): Promise<ModelRef[]> {
    const ms = (await this.q?.supportedModels()) ?? [];
    return ms.length ? ms.map((m) => ({ id: m.value, label: m.displayName })) : FALLBACK_MODELS;
  }

  async continueTurn(text = "Continue where you left off.") {
    this.input.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null } as SDKUserMessage);
    this.setState({ status: "running" });
  }

  /** statuses.limit from the rate-limit windows; re-checked when the earliest window resets. */
  private showLimit() {
    clearTimeout(this.limitTimer);
    this.limits.expire();
    const text = this.limits.text();
    if (text !== this.t.state.statuses?.limit) {
      const { limit: _, ...rest } = this.t.state.statuses ?? {};
      this.setState({ statuses: text ? { ...rest, limit: text } : rest });
    }
    const next = this.limits.nextReset();
    if (next !== undefined && !this.closed) this.limitTimer = setTimeout(() => this.showLimit(), Math.min(Math.max(next - Date.now(), 0) + 1000, 2 ** 31 - 1));
  }

  protected shutdown() {
    clearTimeout(this.limitTimer);
    clearInterval(this.pollTimer);
    this.input.end();
    try {
      this.q?.close();
    } catch {}
  }
}

// ---------------- adapter ----------------

let modelCache: ModelRef[] | undefined;

export const claudeAdapter: Adapter = {
  id: "claude-code",

  async available() {
    return true; // the SDK ships its own CLI when `claude` is not installed
  },

  async listProjects(): Promise<StoredProject[]> {
    const by = new Map<string, StoredProject>();
    for (const s of await listSessions()) {
      if (!s.cwd) continue;
      const p = by.get(s.cwd) ?? { path: s.cwd, updatedAt: 0, count: 0 };
      p.count++;
      p.updatedAt = Math.max(p.updatedAt, s.lastModified);
      by.set(s.cwd, p);
    }
    return [...by.values()];
  },

  async listSessions(projectPath: string): Promise<SessionSummary[]> {
    const list = await listSessions({ dir: projectPath, includeWorktrees: false });
    return list
      .filter((s) => !s.cwd || s.cwd === projectPath)
      .map((s) => ({
        id: `claude-code:${s.sessionId}`,
        harness: "claude-code" as const,
        nativeId: s.sessionId,
        projectPath,
        title: (s.customTitle || s.summary || displayText(cleanUserText(s.firstPrompt ?? "") ?? "") || "Untitled").replace(/\s+/g, " ").slice(0, 120),
        createdAt: s.createdAt ?? s.lastModified,
        updatedAt: s.lastModified,
        live: false,
        status: "idle" as const,
      }));
  },

  async readHistory(nativeId: string, projectPath: string): Promise<Msg[]> {
    return loadHistory(nativeId, projectPath);
  },

  create(projectPath, opts, sink) {
    return new ClaudeSession({ nativeId: randomUUID(), projectPath }, sink, opts);
  },

  async resume(nativeId, projectPath, sink) {
    const s = (await listSessions({ dir: projectPath, includeWorktrees: false })).find((x) => x.sessionId === nativeId);
    return new ClaudeSession(
      { nativeId, projectPath, title: s ? s.customTitle || s.summary || s.firstPrompt : undefined, createdAt: s?.createdAt, updatedAt: s?.lastModified },
      sink,
      { resume: true },
    );
  },

  async listModels(live) {
    if (live instanceof ClaudeSession) modelCache = await live.models();
    return { models: modelCache ?? FALLBACK_MODELS, thinkingLevels: EFFORT_LEVELS, permissionModes: PERMISSION_MODES };
  },
};
