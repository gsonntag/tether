// An ACP session's `session/update`s as Tether's transcript (SPEC §5). One builder serves both a
// replay (`session/load` sends the whole conversation as updates) and a live turn, so a message
// gets the same id either way: `${prefix}${n}`, n counting messages from the start. A user prompt
// is one message, and everything the agent does until the next prompt (its text, thinking and tool
// calls) is one assistant message.
//
// The harness keeps no times with its updates: `stamp` dates each message the first time it's seen.

import { peerAction } from "../../../../shared/peers";
import type { Msg, Part, ToolKind, ToolPart, ToolStatus } from "../../../../shared/transcript";
import type { TranscriptEvent } from "../../core/adapter";
import type { AcpUpdate } from "./client";

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

/** ACP's tool kinds as Tether's. A file written whole (`edit` with no old text) is a write. */
const KINDS: Record<string, ToolKind> = { read: "read", edit: "edit", delete: "edit", move: "edit", search: "search", execute: "shell", fetch: "fetch", task: "task" };

function statusOf(s: unknown): ToolStatus | undefined {
  if (s === "completed") return "done";
  if (s === "failed") return "error";
  if (s === "pending" || s === "in_progress") return "running";
  return undefined;
}

/** The text in a content block (or a list of them): ACP's `{ type: "text", text }`, also nested as `{ type: "content", content }`. */
export function contentText(c: any): string {
  if (!c) return "";
  if (Array.isArray(c)) return c.map(contentText).filter(Boolean).join("\n");
  if (c.type === "content") return contentText(c.content);
  if (c.type === "text") return typeof c.text === "string" ? c.text : "";
  if (c.type === "resource_link") return str(c.uri) ?? "";
  if (c.type === "resource") return str(c.resource?.text) ?? "";
  return "";
}

/** A call's diffs (`content` of type `diff`), as the edit card's `edits`. */
function diffsOf(content: any): { old_string: string; new_string: string; path?: string }[] {
  if (!Array.isArray(content)) return [];
  return content.filter((c) => c?.type === "diff").map((c) => ({ old_string: typeof c.oldText === "string" ? c.oldText : "", new_string: typeof c.newText === "string" ? c.newText : "", ...(str(c.path) ? { path: c.path } : {}) }));
}

/**
 * A tool call (`tool_call`, or a `tool_call_update` with what changed) as a part: its kind from
 * ACP's own, the command and path the card shows, and its input as the harness gave it with the
 * fields the cards read (`command`, `edits`, `content`) added.
 */
export function acpTool(u: AcpUpdate, before?: ToolPart): ToolPart {
  const name = str(u.name) ?? before?.name ?? str(u.title) ?? "tool";
  const raw = (u.rawInput ?? u.args ?? (before?.input as any)?.raw ?? {}) as Record<string, any>;
  const diffs = diffsOf(u.content);
  const created = diffs.length > 0 && diffs.every((d) => !d.old_string);
  const acpKind = str(u.kind) ?? (before ? undefined : "other");
  // Tether's own tools (`mcp_<server>_tether_send`, …) draw as peer cards.
  let kind: ToolKind = peerAction(name.toLowerCase())
    ? "peer"
    : ["invoke_subagent", "task", "agent"].includes(name.toLowerCase())
    ? "task"
    : acpKind
    ? (KINDS[acpKind] ?? "other")
    : (before?.kind ?? "other");
  if (kind === "edit" && (created || (!diffs.length && typeof (raw.Content ?? raw.content) === "string" && !raw.Target && !raw.old_string))) kind = "write";
  const command = kind === "shell" ? (str(raw.CommandLine) ?? str(raw.command) ?? str(raw.cmd) ?? before?.command ?? str(u.title)) : undefined;
  const path = str(u.locations?.[0]?.path) ?? str(raw.Path) ?? str(raw.path) ?? str(raw.file_path) ?? before?.path;
  const prev = (before?.input ?? {}) as Record<string, any>;
  const input: Record<string, any> = { ...prev, raw };
  if (command) input.command = command;
  if (str(raw.toolSummary)) input.description = raw.toolSummary;
  if (diffs.length) input.edits = diffs;
  else if (kind === "edit" && (typeof raw.Target === "string" || typeof raw.Replacement === "string") && !prev.edits) input.edits = [{ old_string: raw.Target ?? "", new_string: raw.Replacement ?? "" }];
  if (kind === "write") {
    const content = diffs.length ? diffs[0]!.new_string : (raw.Content ?? raw.content);
    if (typeof content === "string") input.content = content;
  }
  if (kind === "task") {
    const prompt = str(raw.Prompt) ?? str(raw.prompt);
    const role = str(raw.Role) ?? str(raw.role);
    const typeName = str(raw.TypeName) ?? str(raw.typeName) ?? str(raw.subagent_type);
    const who = role ?? typeName;
    const head = prompt ? prompt.split("\n")[0]!.trim() : undefined;
    const desc = str(raw.toolSummary) ?? str(raw.description) ?? [who, head].filter(Boolean).join(" · ");
    if (desc) input.description = desc;
    if (prompt) input.prompt = prompt;
    if (typeName ?? role) input.subagent_type = typeName ?? role;
  }
  let out = rawOutput(u);
  const status = statusOf(u.status) ?? before?.status ?? "running";
  // A call that failed with nothing to show (denied, cancelled, or stopped in the background): say so.
  if (status === "error" && out === undefined && !before?.output) out = "No output: Antigravity didn't say why it failed.";
  return {
    type: "tool",
    id: String(u.toolCallId ?? before?.id),
    name,
    kind,
    input,
    status,
    ...(command ? { command } : {}),
    ...((kind === "read" || kind === "edit" || kind === "write") && path ? { path } : {}),
    ...(out !== undefined ? { output: out } : before?.output !== undefined ? { output: before.output } : {}),
  };
}

/**
 * Antigravity's header on a command's output: when it started and ended, and a clean exit
 * ("Created At: …\nCompleted At: …\nCommand exited with code 0.\n\n"). An unclean exit's line stays.
 */
const HEADER = /^(?:(?:Created|Completed) At: [^\n]*\n)+(?:Command exited with code 0\.\n)?\n*/;
const tidy = (o: string) => o.replace(HEADER, "");

/** What a call printed: its `rawOutput` (a command's output, an error), else its text content. */
function rawOutput(u: AcpUpdate): string | undefined {
  const r = u.rawOutput;
  if (typeof r === "string") return tidy(r);
  if (r && typeof r === "object") {
    const o = str(r.output) ?? str(r.error) ?? str(r.message);
    if (o) return tidy(o);
  }
  const t = Array.isArray(u.content) ? contentText(u.content.filter((c: any) => c?.type !== "diff")) : "";
  return t ? tidy(t) : undefined;
}

export interface BuilderHooks {
  /** the date of message n, the first time it's seen (kept, so a later replay gives the same) */
  stamp(n: number): number;
  title?(title: string): void;
  context?(c: { used: number; total: number }): void;
  commands?(list: { name: string; description?: string }[]): void;
  mode?(mode: string): void;
  config?(options: any[]): void;
}

export class AcpTranscript {
  readonly msgs: Msg[] = [];
  /** the assistant message of the turn now (undefined after a prompt) */
  private turn?: Msg;
  /**
   * The reply of the turn that ended last, while no prompt has followed it: what the agent says next
   * without a prompt (after a subagent's report) joins it, as a replay groups it.
   */
  private last?: Msg;
  /** a prompt's text, while user chunks arrive */
  private user?: Msg;
  private tools = new Map<string, { msg: Msg; part: number }>();
  /** events for live use; a replay ignores them */
  events: TranscriptEvent[] = [];

  constructor(
    private prefix: string,
    private hooks: BuilderHooks,
  ) {}

  private newMsg(role: "user" | "assistant"): Msg {
    const n = this.msgs.length;
    const m: Msg = { id: `${this.prefix}${n}`, role, parts: [], ts: this.hooks.stamp(n) };
    this.msgs.push(m);
    return m;
  }

  private emit(m: Msg) {
    this.events.push({ type: "msg", msg: structuredClone(m) });
  }

  /** A prompt Tether sent (live): its message, as a replay would show it. */
  prompt(parts: Part[], origin?: Msg["origin"]): Msg {
    this.turn = undefined;
    this.user = undefined;
    this.last = undefined;
    const m = this.newMsg("user");
    m.parts = parts;
    // Set before it's emitted: modules read who wrote it from the event (a peer's message isn't the person's).
    if (origin) m.origin = origin;
    this.emit(m);
    return m;
  }

  /** The agent's message of this turn, made if needed. */
  private agent(): Msg {
    if (!this.turn && this.last && !this.user) {
      this.turn = this.last;
      this.turn.streaming = true;
      this.emit(this.turn);
    }
    if (!this.turn) {
      this.user = undefined;
      this.turn = this.newMsg("assistant");
      this.turn.streaming = true;
      this.emit(this.turn);
    }
    this.last = undefined;
    return this.turn;
  }

  /** A turn the agent runs without a prompt has begun, or will begin with its next update. */
  get idle() {
    return !this.turn;
  }


  private text(type: "text" | "thinking", text: string) {
    if (!text) return;
    const m = this.agent();
    const last = m.parts.at(-1);
    if (last?.type === type) {
      last.text += text;
      this.events.push({ type: "delta", msgId: m.id, part: m.parts.length - 1, text });
    } else {
      m.parts.push({ type, text });
      this.emit(m);
    }
  }

  update(u: AcpUpdate) {
    switch (u.sessionUpdate) {
      case "user_message_chunk": {
        const c = u.content;
        if (!this.user) {
          this.turn = undefined;
          this.last = undefined;
          this.user = this.newMsg("user");
        }
        const m = this.user;
        if (c?.type === "image" && typeof c.data === "string") m.parts.push({ type: "image", mimeType: str(c.mimeType) ?? "image/png", data: c.data });
        else {
          const t = contentText(c);
          const last = m.parts.at(-1);
          if (last?.type === "text") last.text += t;
          else if (t) m.parts.push({ type: "text", text: t });
        }
        this.emit(m);
        return;
      }
      case "agent_message_chunk":
        return this.text("text", contentText(u.content));
      case "agent_thought_chunk":
        return this.text("thinking", contentText(u.content));
      case "tool_call":
      case "tool_call_update": {
        const id = String(u.toolCallId ?? "");
        if (!id) return;
        const at = this.tools.get(id);
        if (at) {
          const before = at.msg.parts[at.part] as ToolPart;
          const next = { ...acpTool(u, before), ...(before.childSessionId ? { childSessionId: before.childSessionId } : {}) };
          at.msg.parts[at.part] = next;
          const { type: _t, id: _i, ...patch } = next;
          this.events.push({ type: "tool", msgId: at.msg.id, toolId: id, patch });
          return;
        }
        const m = this.agent();
        m.parts.push(acpTool(u));
        this.tools.set(id, { msg: m, part: m.parts.length - 1 });
        this.emit(m);
        return;
      }
      case "plan": {
        // The agent's task list, as a todo card that it keeps up to date.
        const todos = (Array.isArray(u.entries) ? u.entries : []).map((e: any) => ({ content: String(e?.content ?? ""), status: e?.status === "completed" ? "completed" : e?.status === "in_progress" ? "in_progress" : "pending" }));
        const m = this.agent();
        const id = `plan-${m.id}`;
        const at = this.tools.get(id);
        const part: ToolPart = { type: "tool", id, name: "plan", kind: "todo", input: { todos }, status: "done" };
        if (at) {
          at.msg.parts[at.part] = part;
          this.events.push({ type: "tool", msgId: at.msg.id, toolId: id, patch: { input: { todos } } });
        } else {
          m.parts.push(part);
          this.tools.set(id, { msg: m, part: m.parts.length - 1 });
          this.emit(m);
        }
        return;
      }
      case "usage_update":
        if (typeof u.used === "number" && typeof u.size === "number" && u.size > 0 && u.used > 0) this.hooks.context?.({ used: u.used, total: u.size });
        return;
      case "session_info_update":
        if (str(u.title)) this.hooks.title?.(u.title);
        return;
      case "available_commands_update":
        if (Array.isArray(u.availableCommands)) this.hooks.commands?.(u.availableCommands.filter((c: any) => str(c?.name)).map((c: any) => ({ name: c.name, ...(str(c.description) ? { description: c.description } : {}) })));
        return;
      case "current_mode_update":
        if (str(u.currentModeId)) this.hooks.mode?.(u.currentModeId);
        return;
      case "config_option_update":
        if (Array.isArray(u.configOptions)) this.hooks.config?.(u.configOptions);
        return;
    }
  }

  /** The turn ended: its message stops streaming, running calls settle, and `error` goes on it. */
  end(error?: string, stopped = false) {
    const m = this.turn ?? (error ? this.agent() : undefined);
    this.turn = undefined;
    this.user = undefined;
    if (!m) return;
    m.streaming = false;
    for (let i = 0; i < m.parts.length; i++) {
      const p = m.parts[i]!;
      if (p.type === "tool" && p.status === "running") m.parts[i] = { ...p, status: stopped || error ? "error" : "done" };
    }
    if (error) m.error = error;
    this.emit(m);
    this.last = m;
  }

  /** A call that started a subagent: its card links to the subagent's session (SPEC §6a), in later updates too. */
  link(toolId: string, childSessionId: string) {
    const at = this.tools.get(toolId);
    if (!at) return;
    const p = at.msg.parts[at.part] as ToolPart;
    at.msg.parts[at.part] = { ...p, childSessionId };
  }

  /** Takes the events gathered since the last call. */
  drain(): TranscriptEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  /** A replay's messages, done: nothing in them streams or runs any more. */
  settled(): Msg[] {
    return this.msgs.map((m) => {
      if (!m.streaming && !m.parts.some((p) => p.type === "tool" && p.status === "running")) return m;
      return { ...m, streaming: false, parts: m.parts.map((p) => (p.type === "tool" && p.status === "running" ? { ...p, status: "error" as const } : p)) };
    });
  }
}
