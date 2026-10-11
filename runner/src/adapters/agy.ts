// Antigravity (`agy` 1.3) wire formats, kept apart from the session so they can be tested against
// captured output (agy.test.ts). Three sources describe a conversation:
//  - the stream-json events of `agy -p "" --input-format stream-json --output-format stream-json`:
//    `init`, `step_update` (text deltas, tool start/end, per-request usage) and `result`;
//  - the PreToolUse hook payload (runner/hooks/agy-guard.ts): a tool call's full arguments, which
//    the stream abbreviates (an edit's step only names its file);
//  - the conversation's transcript, ~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/
//    transcript_full.jsonl: everything, including thinking and full tool results. It is written as
//    steps finish, so live sessions tail it for what the stream leaves out, and resumed sessions
//    replay it as their history.

import { homedir } from "node:os";
import { join } from "node:path";
import type { ModelRef, Msg, Part, SessionEvent } from "../../../web/src/shared/protocol";
import { userParts } from "../../../web/src/shared/bash";

// ---------------- models and effort ----------------

/** `agy models` prints `<id>\t<label>` lines (and a "Fetching…" line first). */
export function parseModels(text: string): ModelRef[] {
  const out: ModelRef[] = [];
  for (const line of text.split("\n")) {
    const [id, label] = line.split("\t").map((s) => s.trim());
    if (id && label && /^[a-z0-9][\w.-]*$/i.test(id)) out.push({ id, label });
  }
  return out;
}

const LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"];
const LEVEL_RE = new RegExp(`-(${LEVELS.join("|")})$`);

/**
 * agy lists one model id per effort ("gemini-3.8-flash-low", "-medium", "-high"); `--model <base>
 * --effort <level>` is the same choice, and combining a full id with `--effort` is an error. So a
 * model's effort levels are its siblings, and changing effort switches to the sibling. Models with
 * a single variant (claude-*, gpt-oss-*) have none: agy rejects `--effort` for them.
 */
export function effortOf(model: string | undefined, models: ModelRef[]): { base: string; level: string; levels: string[] } | undefined {
  const m = model?.match(LEVEL_RE);
  if (!model || !m) return undefined;
  const base = model.slice(0, -m[0].length);
  const levels = models
    .map((x) => x.id)
    .filter((id) => id.startsWith(base + "-") && LEVEL_RE.test(id) && id.slice(0, id.lastIndexOf("-")) === base)
    .map((id) => id.slice(base.length + 1))
    .sort((a, b) => LEVELS.indexOf(a) - LEVELS.indexOf(b));
  return levels.length > 1 ? { base, level: m[1]!, levels } : undefined;
}

/**
 * Session modes Tether offers. agy's own approving modes (`--mode accept-edits`, the old
 * `bypassPermissions` session mode) would decide tool calls without the guard, so they are refused:
 * anything but "plan" is "default".
 */
export const AGY_MODES = ["default", "plan"] as const;
export const APPROVING_MODES = ["bypassPermissions", "acceptEdits", "accept-edits", "auto"];
export function sessionMode(mode: string | undefined): (typeof AGY_MODES)[number] {
  return mode === "plan" ? "plan" : "default";
}

/** Effort levels offered for agy's default model (Gemini Flash), passed as a bare `--effort`. */
export const DEFAULT_EFFORT = ["low", "medium", "high"];

export interface SpawnOpts {
  convId?: string;
  model?: string;
  /** only with the default model (see effortOf) */
  effort?: string;
  plan?: boolean;
  /** directory whose .agents/hooks.json holds the guard hook */
  hookDir?: string;
  sandbox?: boolean;
  /** folders outside the project the agent may need to read (attachments) */
  readDirs?: string[];
}

/**
 * `-p` takes the prompt as its value, so it gets an empty one: with `--input-format stream-json` the
 * turns come from stdin. Approvals are skipped because headless agy can't ask (it would deny
 * anything not pre-approved in settings.json); the guard hook decides every call instead.
 */
export function spawnArgs(o: SpawnOpts): string[] {
  const args = ["-p", "", "--input-format", "stream-json", "--output-format", "stream-json"];
  if (o.convId) args.push("--conversation", o.convId);
  if (o.model) args.push("--model", o.model);
  else if (o.effort) args.push("--effort", o.effort);
  if (o.plan) args.push("--mode", "plan");
  if (o.hookDir) args.push("--dangerously-skip-permissions", "--add-dir", o.hookDir);
  // Attached files live outside the project; the guard denies writes there.
  for (const d of o.readDirs ?? []) args.push("--add-dir", d);
  if (o.sandbox) args.push("--sandbox");
  return args;
}

// ---------------- the guard hook ----------------

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The hooks.json that puts the guard in front of every tool call. `name` should be unguessable: a
 * same-named hook in the project's own `.agents/hooks.json` would override this one. The PreToolUse
 * command fails closed on top of agy's own handling (which denies on a crash, a timeout or bad
 * JSON, but runs the tool when a hook prints nothing): no output is a deny. PreInvocation tells the
 * runner the hook is loaded (see HookWatch). The timeout is long because "ask" waits for a person.
 */
export function hookConfig(name: string, runtime: string, script: string) {
  const run = `${shq(runtime)} ${shq(script)}`;
  const deny = shq(JSON.stringify({ decision: "deny", reason: "Tether's guard hook failed; blocked to be safe." }));
  return {
    [name]: {
      PreToolUse: [{ matcher: "", hooks: [{ type: "command", command: `o=$(${run}) && [ -n "$o" ] && printf '%s\\n' "$o" || printf '%s\\n' ${deny}`, timeout: 86_400 }] }],
      PreInvocation: [{ type: "command", command: run, timeout: 60 }],
    },
  };
}

/**
 * Proof that agy is running the guard hook. With --dangerously-skip-permissions nothing else stops
 * a tool call, and agy quietly runs without a hook it doesn't load (a missing or invalid hooks.json,
 * a project hook overriding it by name). So for each process: before the model answers, the hook
 * must have pinged (PreInvocation), and every tool step that ran must have been seen by the guard.
 * `event` returns why the process is unguarded; the session then kills it.
 */
export class HookWatch {
  private invoked = new Set<string>();
  private checked = new Set<string>();

  /** the PreInvocation ping */
  invocation(conversationId: unknown) {
    this.invoked.add(String(conversationId ?? ""));
  }

  /** the guard got this tool call (called before deciding it) */
  checkedCall(conversationId: unknown, step: number) {
    this.checked.add(`${conversationId ?? ""}:${step}`);
  }

  event(raw: any): string | undefined {
    if ((raw?.event ?? raw?.type) !== "step_update") return undefined;
    const e = raw.step_update ?? raw;
    const conv = String(e.conversation_id ?? "");
    const modelOutput = e.step_type === "agent_response" || e.step_type === "tool";
    if (modelOutput && !this.invoked.has(conv) && !this.invoked.has("")) return "the model answered, but the guard hook never ran before the request";
    if (e.step_type !== "tool" || (e.state !== "DONE" && e.state !== "ERROR")) return undefined;
    if (this.checked.has(`${conv}:${Number(e.step_index)}`) || this.checked.has(`:${Number(e.step_index)}`)) return undefined;
    // A failing hook is a denial: the call didn't run.
    const err = String(e.tool_info?.error?.message ?? "");
    if (e.state === "ERROR" && /\bhook\b/i.test(err)) return undefined;
    return `${e.tool_name ?? "a tool"} ran without the guard seeing it`;
  }
}

// ---------------- tool calls ----------------

/** Per-call chatter agy adds to every tool's arguments; left out so cards and retries compare equal. */
const VOLATILE = new Set(["toolAction", "toolSummary", "WaitMsBeforeAsync"]);

export function cleanArgs(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== "object") return {};
  return Object.fromEntries(Object.entries(args as Record<string, unknown>).filter(([k]) => !VOLATILE.has(k)));
}

/** A plan artifact: written for the person to review (`ArtifactMetadata.RequestFeedback`). */
export function planArtifact(tool: string, args: any): string | undefined {
  if (tool !== "write_to_file" || !args?.ArtifactMetadata?.RequestFeedback) return undefined;
  return typeof args.CodeContent === "string" ? args.CodeContent : undefined;
}

const MAX_OUTPUT = 30_000;

/** A tool result in the transcript starts with "Created At: …\nCompleted At: …". */
export function toolResultText(content: unknown): string {
  let s = typeof content === "string" ? content : "";
  s = s.replace(/^Created At: [^\n]*\n(Completed At: [^\n]*\n)?\n?/, "").replace(/\r\n/g, "\n");
  return s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + "\n…(truncated)" : s.trimEnd();
}

/** The person's words in a transcript USER_INPUT: agy wraps them in tags and metadata (and `--mode plan` adds "/plan "). */
export function cleanUserText(content: unknown): string {
  let s = typeof content === "string" ? content : "";
  const req = s.match(/<USER_REQUEST>\n?([\s\S]*?)\n?<\/USER_REQUEST>/);
  if (req) s = req[1]!;
  return s
    .replace(/<tether-memory>[\s\S]*?<\/tether-memory>\s*/g, "")
    .replace(/^\/plan /, "")
    .trim();
}

export function transcriptPath(convId: string): string {
  return join(homedir(), ".gemini", "antigravity-cli", "brain", convId, ".system_generated", "logs", "transcript_full.jsonl");
}

export const toolId = (step: number) => `agy-${step}`;
export const planId = (step: number) => `plan-agy-${step}`;

// ---------------- history (transcript replay) ----------------

/** A resumed conversation from its transcript lines, and the size of its last model request. */
export function transcriptToMessages(entries: any[], model?: string): { messages: Msg[]; usage?: any } {
  const messages: Msg[] = [];
  let usage: any;
  let cur: Msg | undefined;
  const tools = new Map<number, Extract<Part, { type: "tool" }>>();
  // A step without a time takes the one before it.
  let last = 0;
  const ts = (e: any) => (last = Date.parse(e.created_at) || last);
  for (const e of entries) {
    const step = Number(e.step_index);
    switch (e.type) {
      case "USER_INPUT": {
        cur = undefined;
        const text = cleanUserText(e.content);
        // Attached files become their chips; the rest stays as typed.
        const parts: Part[] = text.includes("Attached files (") ? userParts(text, `agy-u${step}`) : [{ type: "text", text }];
        if (text && e.source !== "SYSTEM") messages.push({ id: `agy-u${step}`, role: "user", parts, ts: ts(e) });
        break;
      }
      case "PLANNER_RESPONSE": {
        if (!cur) {
          cur = { id: `agy-a${step}`, role: "assistant", parts: [], ts: ts(e), ...(model ? { model } : {}) };
          messages.push(cur);
        }
        if (e.thinking) cur.parts.push({ type: "thinking", text: String(e.thinking).trim() });
        if (e.content) cur.parts.push({ type: "text", text: String(e.content) });
        (e.tool_calls ?? []).forEach((c: any, k: number) => {
          const s = step + 1 + k;
          const part: Extract<Part, { type: "tool" }> = { type: "tool", id: toolId(s), name: c.name ?? "tool", input: cleanArgs(c.args), status: "error", output: "No result: denied or interrupted." };
          tools.set(s, part);
          cur!.parts.push(part);
          const plan = planArtifact(c.name, c.args);
          if (plan) cur!.parts.push({ type: "plan", id: planId(s), text: plan });
        });
        if (e.input_tokens !== undefined) usage = { input_tokens: e.input_tokens, cache_read_tokens: e.cache_read_tokens };
        break;
      }
      case "GENERIC": {
        const part = tools.get(step);
        if (part) {
          part.status = e.status === "ERROR" ? "error" : "done";
          part.output = e.status === "ERROR" && e.error ? String(e.error) : toolResultText(e.content);
        }
        break;
      }
      default:
        if (e.status === "ERROR" && e.error && e.type !== "GENERIC")
          messages.push({ id: `agy-n${step}`, role: "notice", parts: [{ type: "text", text: String(e.error) }], ts: ts(e), level: "error" });
    }
  }
  return { messages, usage };
}

// ---------------- live stream ----------------

export interface AgyHost {
  emit(e: SessionEvent): void;
  messages(): Msg[];
  model(): string | undefined;
  /** a model request's usage (context meter) */
  usage(u: any): void;
}

type Slot = { step: number; rank: number };
const RANK = { thinking: 0, text: 1, tool: 2, plan: 3 } as const;

/**
 * Turns agy's stream (plus hook arguments and transcript entries) into one assistant message per
 * turn. Parts are kept in step order: a step's thinking only arrives from the transcript after the
 * step is done, so it is inserted before that step's text and anything later.
 */
export class AgyStream {
  msgId?: string;
  /** per message: which step and kind each part belongs to */
  private slots = new Map<string, Slot[]>();
  /** which message a step went into */
  private stepMsg = new Map<number, string>();
  /** full tool arguments (hook or transcript), by tool step */
  private args = new Map<number, Record<string, unknown>>();
  /** agent_response steps whose DONE event was handled: their streamed text is complete */
  private doneSteps = new Set<number>();

  constructor(private host: AgyHost) {}

  private find(id: string | undefined) {
    return id ? this.host.messages().find((m) => m.id === id) : undefined;
  }

  private ensureMsg(): Msg {
    const cur = this.find(this.msgId);
    if (cur) return cur;
    const msg: Msg = { id: `agy-${crypto.randomUUID()}`, role: "assistant", parts: [], ts: Date.now(), model: this.host.model(), streaming: true };
    this.msgId = msg.id;
    this.slots.set(msg.id, []);
    this.host.emit({ type: "msg", msg });
    return msg;
  }

  private indexOf(msgId: string, step: number, kind: keyof typeof RANK) {
    return (this.slots.get(msgId) ?? []).findIndex((s) => s.rank === step * 4 + RANK[kind]);
  }

  /** Inserts a part in step order; returns its index. */
  private insert(msg: Msg, step: number, kind: keyof typeof RANK, part: Part): number {
    const slots = this.slots.get(msg.id) ?? [];
    const rank = step * 4 + RANK[kind];
    let i = slots.findIndex((s) => s.rank > rank);
    if (i < 0) i = slots.length;
    slots.splice(i, 0, { step, rank });
    this.slots.set(msg.id, slots);
    this.stepMsg.set(step, msg.id);
    const parts = [...msg.parts];
    parts.splice(i, 0, part);
    this.host.emit({ type: "msg", msg: { ...msg, parts } });
    return i;
  }

  private patchTool(step: number, patch: Partial<Extract<Part, { type: "tool" }>>) {
    const msg = this.find(this.stepMsg.get(step));
    if (msg?.parts.some((p) => p.type === "tool" && p.id === toolId(step))) this.host.emit({ type: "tool", msgId: msg.id, toolId: toolId(step), patch });
  }

  /** this turn had an error step / a model response */
  private turnErrored = false;
  private turnResponded = false;

  /**
   * A stream-json event. Returns the `result` payload when the turn ended, with `error` set when
   * this turn failed. agy's result is cumulative over the conversation: once a turn failed (a
   * usage limit, say), every later result says status ERROR with that old error, even across
   * processes. So a turn only failed if it had an error step or got no response at all.
   */
  event(raw: any): { result?: any; error?: string; conversationId?: string; model?: string } {
    const kind = raw?.event ?? raw?.type;
    const e = kind && raw[kind] && typeof raw[kind] === "object" ? { ...raw, ...raw[kind] } : raw;
    const conversationId = typeof e?.conversation_id === "string" && e.conversation_id ? e.conversation_id : undefined;
    if (kind === "init") return { conversationId, model: e.model };
    if (kind === "result") {
      const failed = e.status === "ERROR" && (this.turnErrored || !this.turnResponded);
      this.turnErrored = this.turnResponded = false;
      return { result: e, conversationId, ...(failed ? { error: String(e.error || "Antigravity reported an error.") } : {}) };
    }
    if (kind !== "step_update") return { conversationId };
    const step = Number(e.step_index);
    if (e.usage) this.host.usage(e.usage);
    if (e.step_type === "error_message") this.turnErrored = true;
    if (e.step_type === "agent_response" || e.step_type === "tool") this.turnResponded = true;
    if (e.step_type === "agent_response") {
      const msg = this.ensureMsg();
      this.stepMsg.set(step, msg.id);
      const i = this.indexOf(msg.id, step, "text");
      if (i < 0) {
        if (e.text_delta) this.insert(msg, step, "text", { type: "text", text: e.text_delta });
      } else if (e.text_delta) this.host.emit({ type: "delta", msgId: msg.id, part: i, kind: "text", text: e.text_delta });
      if (e.state === "DONE") this.doneSteps.add(step);
    } else if (e.step_type === "tool") {
      const info = e.tool_info ?? {};
      const msg = this.ensureMsg();
      if (!this.host.messages().some((m) => m.parts.some((p) => p.type === "tool" && p.id === toolId(step)))) {
        const input = this.args.get(step) ?? cleanArgs(info.parameters);
        this.insert(msg, step, "tool", { type: "tool", id: toolId(step), name: e.tool_name ?? info.name ?? "tool", input, status: "running" });
      }
      if (e.state === "DONE" || e.state === "ERROR") {
        const err = info.error?.message ?? (e.state === "ERROR" ? "Failed." : undefined);
        const out = typeof info.output === "string" ? info.output.replace(/\r\n/g, "\n").trimEnd() : undefined;
        this.patchTool(step, { status: err ? "error" : "done", ...(err ? { output: err } : out ? { output: out } : {}) });
      }
    }
    // user_input, system_message, checkpoint, error_message: nothing to show (errors come with the result)
    return { conversationId };
  }

  /** A tool call's full arguments, from the PreToolUse hook (it runs before the step's event). */
  toolArgs(step: number, args: Record<string, unknown>) {
    this.args.set(step, args);
    this.patchTool(step, { input: args });
  }

  /** A plan artifact the agent is writing at this tool step (the hook sees it before the step event). */
  plan(step: number, text: string) {
    const msg = this.find(this.stepMsg.get(step)) ?? this.ensureMsg();
    this.stepMsg.set(step, msg.id);
    const id = planId(step);
    const at = msg.parts.findIndex((p) => p.type === "plan" && p.id === id);
    if (at >= 0) this.host.emit({ type: "msg", msg: { ...msg, parts: msg.parts.map((p, i) => (i === at ? { ...(p as any), text } : p)) } });
    else this.insert(msg, step, "plan", { type: "plan", id, text });
  }

  /** A transcript entry written while the session runs: thinking, full arguments, full results. */
  transcript(t: any) {
    const step = Number(t.step_index);
    if (t.type === "PLANNER_RESPONSE") {
      const msg = this.find(this.stepMsg.get(step));
      if (msg && t.thinking && this.indexOf(msg.id, step, "thinking") < 0) this.insert(msg, step, "thinking", { type: "thinking", text: String(t.thinking).trim() });
      // The transcript line can land before the stream's last deltas: only a finished step's text is compared.
      const cur = this.doneSteps.has(step) ? this.find(this.stepMsg.get(step)) : undefined;
      if (cur && typeof t.content === "string" && t.content) {
        const i = this.indexOf(cur.id, step, "text");
        if (i < 0) this.insert(cur, step, "text", { type: "text", text: t.content });
        else if ((cur.parts[i] as any)?.text !== t.content) this.host.emit({ type: "msg", msg: { ...cur, parts: cur.parts.map((p, j) => (j === i ? { type: "text", text: t.content } : p)) } });
      }
      (t.tool_calls ?? []).forEach((c: any, k: number) => {
        const s = step + 1 + k;
        if (!this.args.has(s)) this.toolArgs(s, cleanArgs(c.args));
      });
    } else if (t.type === "GENERIC") {
      this.patchTool(step, t.status === "ERROR" ? { status: "error", output: String(t.error ?? toolResultText(t.content)) } : { output: toolResultText(t.content) });
    }
  }

  /** The turn is over: the message stops streaming. `cut` (Stop, a crash): calls still running never finish. */
  finish(error?: string, cut?: string) {
    const m = this.find(this.msgId);
    if (m) {
      const parts = cut ? m.parts.map((p) => (p.type === "tool" && p.status === "running" ? { ...p, status: "error" as const, output: p.output || cut } : p)) : m.parts;
      this.host.emit({ type: "msg", msg: { ...m, parts, streaming: false, ...(error ? { error } : {}) } });
    }
    this.msgId = undefined;
    this.turnErrored = this.turnResponded = false;
  }
}
