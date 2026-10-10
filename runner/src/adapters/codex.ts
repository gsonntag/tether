// OpenAI Codex CLI through `codex app-server`: the JSON-RPC API (newline-delimited over stdio)
// behind Codex's IDE extension. One app-server process per live session. Threads live in Codex's
// own store, so conversations started in a terminal show up too, with their history.
//
// Guard: in ask/auto Codex runs with approvalPolicy "untrusted" (it asks before anything outside
// its own list of safe read-only commands, and before every patch) inside its workspace-write
// sandbox when that works on this machine; each request goes to the guard. approvalsReviewer is
// forced to "user" (the client), so Codex's own auto-reviewer from config.toml doesn't answer
// first. Codex's "decline" carries no reason, so the guard's reason is steered into the turn.
// In full: no approvals, no sandbox.

import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ActivityItem, ModelRef, Msg, Part, SessionSummary } from "../../../web/src/shared/protocol";
import { CodexActivity } from "./codexActivity";
import { findTool } from "../../../web/src/shared/reducer";
import { codexRollout, codexTokenUsage } from "../contextWindow";
import type { Classified } from "../fallback";
import { LiveSession, newId } from "../session";
import { sessionContext } from "../context/inject";
import type { Adapter, CreateOpts, Sink, StoredProject } from "./types";

const CODEX_BIN = process.env.CODEX_BIN ?? "codex";
/** Thread sources listed as sessions (Codex's default is interactive ones only, which leaves out ours). */
const SOURCES = ["cli", "vscode", "exec", "appServer"];
const OUTPUT_MAX = 50_000;
/** Prefix of the notes the guard steers into a turn; they're not the user's words. */
const GUARD_NOTE = "[Tether guard]";

type ToolPart = Extract<Part, { type: "tool" }>;

let sandboxProbe: Promise<boolean> | undefined;
/**
 * Whether Codex's command sandbox works on this machine. It doesn't everywhere (bubblewrap can't
 * set up its network namespace under some AppArmor/container setups), and then every sandboxed
 * command fails and asks to rerun unsandboxed. Without it the guard is the only gate.
 */
function sandboxWorks(): Promise<boolean> {
  if (process.platform !== "linux" && process.platform !== "darwin") return Promise.resolve(false);
  return (sandboxProbe ??= (async () => {
    try {
      const p = Bun.spawn([CODEX_BIN, "sandbox", "true"], { cwd: homedir(), stdout: "ignore", stderr: "ignore" });
      const timer = setTimeout(() => p.kill(), 20_000);
      const code = await p.exited;
      clearTimeout(timer);
      return code === 0;
    } catch {
      return false;
    }
  })());
}

/** Codex runs shell commands as `/bin/bash -lc '<script>'`; the guard and the card want the script. */
export function unwrapShell(cmd: string): string {
  const m = cmd.match(/^(?:\S*\/)?(?:ba|z)?sh\s+-l?c\s+(?:'((?:[^']|'\\'')*)'|"((?:[^"\\]|\\.)*)")$/s);
  if (!m) return cmd;
  return m[1] !== undefined ? m[1].replace(/'\\''/g, "'") : m[2]!.replace(/\\(["\\$`])/g, "$1");
}

// ---------------- connection ----------------

export class CodexProcess {
  proc: ReturnType<typeof Bun.spawn>;
  stderr = "";
  exited: Promise<number>;
  private nextId = 0;
  private waits = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>();
  onNotify?: (method: string, params: any) => void;
  /** Server-to-client requests (approvals, questions). Returning undefined answers "unsupported". */
  onRequest?: (method: string, params: any) => Promise<unknown>;

  constructor(cwd: string) {
    const proc = Bun.spawn([CODEX_BIN, "app-server"], { cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe", env: process.env });
    this.proc = proc;
    (async () => {
      const dec = new TextDecoder();
      let buf = "";
      for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
        buf += dec.decode(chunk, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          let m: any;
          try {
            m = JSON.parse(line);
          } catch {
            continue;
          }
          this.handle(m);
        }
      }
    })();
    (async () => {
      const dec = new TextDecoder();
      for await (const c of proc.stderr as ReadableStream<Uint8Array>) this.stderr = (this.stderr + dec.decode(c)).slice(-8000);
    })();
    this.exited = proc.exited;
    this.exited.then((code) => {
      for (const w of this.waits.values()) w.rej(new Error(`codex app-server exited (code ${code})`));
      this.waits.clear();
    });
  }

  private handle(m: any) {
    if (m.id !== undefined && m.method) {
      const reply = (body: object) => this.write({ id: m.id, ...body });
      Promise.resolve(this.onRequest?.(m.method, m.params))
        .then((result) => (result === undefined ? reply({ error: { code: -32601, message: `Tether does not support ${m.method}` } }) : reply({ result })))
        .catch((e) => reply({ error: { code: -32000, message: String(e?.message ?? e) } }));
    } else if (m.id !== undefined) {
      const w = this.waits.get(m.id);
      if (!w) return;
      this.waits.delete(m.id);
      if (m.error) w.rej(new Error(m.error.message ?? JSON.stringify(m.error)));
      else w.res(m.result);
    } else if (m.method) this.onNotify?.(m.method, m.params ?? {});
  }

  write(obj: object) {
    const sink = this.proc.stdin as import("bun").FileSink;
    sink.write(JSON.stringify(obj) + "\n");
    sink.flush();
  }

  call<T = any>(method: string, params: unknown, timeoutMs = 60_000): Promise<T> {
    const id = ++this.nextId;
    return new Promise<T>((res, rej) => {
      const timer = setTimeout(() => {
        this.waits.delete(id);
        rej(new Error(`codex ${method} timed out. ${this.stderr.trim().split("\n").slice(-2).join(" ")}`));
      }, timeoutMs);
      this.waits.set(id, {
        res: (v) => (clearTimeout(timer), res(v)),
        rej: (e) => (clearTimeout(timer), rej(e)),
      });
      this.write({ id, method, params });
    });
  }

  /** experimentalApi: collaboration (plan) mode is still an experimental app-server field. */
  async init() {
    await this.call("initialize", { clientInfo: { name: "tether", title: "Tether", version: "0.1.0" }, capabilities: { experimentalApi: true, requestAttestation: false } }, 30_000);
    this.write({ method: "initialized" });
  }

  kill() {
    try {
      (this.proc.stdin as import("bun").FileSink).end();
    } catch {}
    setTimeout(() => this.proc.kill(), 3_000);
  }
}

/** A short-lived app-server for catalog calls (thread list, models). */
async function withProcess<T>(fn: (p: CodexProcess) => Promise<T>): Promise<T> {
  const p = new CodexProcess(homedir());
  try {
    await p.init();
    return await fn(p);
  } finally {
    p.kill();
  }
}

interface CodexModel {
  id: string;
  displayName: string;
  hidden: boolean;
  isDefault: boolean;
  supportedReasoningEfforts: { reasoningEffort: string }[];
}

async function fetchModels(p: CodexProcess): Promise<CodexModel[]> {
  const out: CodexModel[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 10; i++) {
    const r: any = await p.call("model/list", { cursor }, 30_000);
    out.push(...r.data);
    if (!(cursor = r.nextCursor)) break;
  }
  return out.filter((m) => !m.hidden);
}

// ---------------- item translation ----------------

/** Unified diff -> old/new text pairs per hunk, which the UI renders as a diff. */
export function diffPairs(diff: string, kind: string): { oldText: string; newText: string }[] {
  const lines = diff.split("\n");
  if (!lines.some((l) => l.startsWith("@@"))) return kind === "delete" ? [{ oldText: diff, newText: "" }] : [{ oldText: "", newText: diff }];
  const hunks: { o: string[]; n: string[] }[] = [];
  let cur: { o: string[]; n: string[] } | undefined;
  for (const l of lines) {
    if (l.startsWith("@@")) hunks.push((cur = { o: [], n: [] }));
    else if (!cur || l.startsWith("\\")) continue; // file headers, "\ No newline at end of file"
    else if (l[0] === " ") cur.o.push(l.slice(1)), cur.n.push(l.slice(1));
    else if (l[0] === "-") cur.o.push(l.slice(1));
    else if (l[0] === "+") cur.n.push(l.slice(1));
  }
  return hunks.map((h) => ({ oldText: h.o.join("\n"), newText: h.n.join("\n") }));
}

/**
 * Tool input for a patch: `path` is the file the guard should judge (the first one outside the
 * project, if any), `edits` the diff the UI shows. Also the input the guard sees, so "Approve &
 * retry" matches the card.
 */
function patchInput(changes: { path: string; kind: { type: string }; diff: string }[], cwd: string) {
  const paths = changes.map((c) => resolve(cwd, c.path));
  const outside = paths.find((p) => p !== cwd && !p.startsWith(cwd.replace(/\/$/, "") + "/"));
  return {
    path: outside ?? paths[0] ?? cwd,
    ...(changes.length > 1 ? { files: paths } : {}),
    edits: changes.flatMap((c) => diffPairs(c.diff ?? "", c.kind?.type ?? "update")),
  };
}

const toolStatus = (s: string | undefined): ToolPart["status"] => (s === "completed" ? "done" : s === "failed" || s === "declined" ? "error" : "running");

function mcpText(r: any): string | undefined {
  if (!r) return undefined;
  const text = (r.content ?? []).map((c: any) => (c?.type === "text" ? c.text : JSON.stringify(c))).join("\n");
  return text || (r.structuredContent ? JSON.stringify(r.structuredContent, null, 2) : undefined);
}

/** A Codex thread item as a transcript part (undefined: not shown). */
function itemPart(item: any, cwd: string): Part | undefined {
  switch (item.type) {
    case "agentMessage":
      return { type: "text", text: item.text ?? "" };
    case "plan": // plan mode's proposed plan
      return { type: "plan", id: item.id, text: item.text ?? "" };
    case "reasoning": {
      const text = (item.summary?.length ? item.summary : (item.content ?? [])).join("\n\n");
      return { type: "thinking", text };
    }
    case "commandExecution": {
      const failed = item.status === "completed" && item.exitCode != null && item.exitCode !== 0;
      return { type: "tool", id: item.id, name: "bash", input: { command: unwrapShell(item.command ?? "") }, status: failed ? "error" : toolStatus(item.status), output: item.aggregatedOutput ?? undefined };
    }
    case "fileChange":
      return { type: "tool", id: item.id, name: "apply_patch", input: patchInput(item.changes ?? [], cwd), status: toolStatus(item.status) };
    case "mcpToolCall":
      return { type: "tool", id: item.id, name: `mcp__${item.server}__${item.tool}`, input: item.arguments ?? {}, status: toolStatus(item.status), output: item.error?.message ?? mcpText(item.result) };
    case "dynamicToolCall":
      return {
        type: "tool",
        id: item.id,
        name: item.tool,
        input: item.arguments ?? {},
        status: toolStatus(item.status),
        output: (item.contentItems ?? []).map((c: any) => c.text ?? "[image]").join("\n") || undefined,
      };
    case "collabAgentToolCall":
      return { type: "tool", id: item.id, name: "Agent", input: { description: item.tool, prompt: item.prompt ?? "" }, status: toolStatus(item.status) };
    case "webSearch":
      return { type: "tool", id: item.id, name: "web_search", input: { query: item.query }, status: "done" };
    case "imageView":
      return { type: "tool", id: item.id, name: "view_image", input: { path: item.path }, status: "done" };
    default:
      return undefined;
  }
}

function userText(item: any): string {
  return (item.content ?? []).map((c: any) => (c.type === "text" ? c.text : c.type === "image" || c.type === "localImage" ? "[image]" : "")).join("\n");
}

/** A resumed thread's turns as a transcript. */
function historyMsgs(turns: any[], cwd: string, model?: string): Msg[] {
  const out: Msg[] = [];
  for (const turn of turns) {
    let a: Msg | undefined;
    const ts = (turn.startedAt ?? 0) * 1000 || Date.now();
    for (const item of turn.items ?? []) {
      if (item.type === "userMessage") {
        const text = userText(item);
        if (text && !text.startsWith(GUARD_NOTE)) out.push({ id: `u-${item.id}`, role: "user", parts: [{ type: "text", text }], ts });
        a = undefined;
        continue;
      }
      if (item.type === "contextCompaction") {
        out.push({ id: `n-${item.id}`, role: "notice", parts: [{ type: "text", text: "Context compacted." }], ts, source: "compaction" });
        continue;
      }
      const part = itemPart(item, cwd);
      if (!part || ((part.type === "text" || part.type === "thinking" || part.type === "plan") && !part.text)) continue;
      if (part.type === "tool" && part.status === "running") part.status = "error";
      if (!a) out.push((a = { id: `a-${item.id}`, role: "assistant", parts: [], ts, model }));
      a.parts.push(part);
    }
    if (a && turn.status === "failed") a.error = turn.error?.message ?? "error";
  }
  return out;
}

// ---------------- live session ----------------

/** Codex collaboration modes, offered as the session's modes: "plan" plans before it acts. */
export const CODEX_MODES = ["default", "plan"];

/**
 * The app-server's (experimental) CollaborationMode for turn/start and thread/settings/update.
 * developer_instructions null: Codex's built-in instructions for that mode.
 */
export function collaborationMode(mode: string, model: string, effort?: string) {
  return { mode: mode === "plan" ? "plan" : "default", settings: { model, reasoning_effort: effort ?? null, developer_instructions: null } };
}

class CodexSession extends LiveSession {
  private p!: CodexProcess;
  private turnId?: string;
  private msgId?: string;
  private model?: string;
  private effort?: string;
  private models: CodexModel[] = [];
  /** item id -> its part (for streaming deltas into it) */
  private parts = new Map<string, { msgId: string; idx: number; delta?: "summary" | "content" }>();
  /** fileChange items: approval requests only carry the item id */
  private patches = new Map<string, any>();
  private rateLimits?: any;
  private retrying = false;
  /** collaboration mode picked in Tether; undefined until set (Codex keeps the thread's own) */
  private collab?: string;
  /** subagent threads, background terminals, sleeps (codexActivity.ts) */
  private act = new CodexActivity();

  constructor(
    init: { nativeId: string; projectPath: string; title?: string; createdAt?: number },
    sink: Sink,
    private opts: CreateOpts & { resume?: boolean } = {},
  ) {
    super("codex", init, sink);
    this.model = opts.model && opts.model !== "default" ? opts.model : undefined;
    if (opts.permissionMode && CODEX_MODES.includes(opts.permissionMode)) this.collab = opts.permissionMode;
  }

  private sandboxed = false;

  private policy() {
    if (this.guardMode === "full") return { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } };
    return {
      approvalPolicy: "untrusted",
      sandboxPolicy: this.sandboxed
        ? { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }
        : { type: "dangerFullAccess" },
    };
  }

  async start() {
    this.p = new CodexProcess(this.projectPath);
    this.p.onNotify = (m, params) => this.onNotify(m, params);
    this.p.onRequest = (m, params) => this.onRequest(m, params);
    this.p.exited.then((code) => {
      if (this.closed) return;
      this.notice(`codex exited (code ${code}). ${this.p.stderr.trim().split("\n").slice(-3).join("\n")}`, "error");
      this.setState({ status: "idle" });
      this.close();
    });
    [this.sandboxed] = await Promise.all([sandboxWorks(), this.p.init()]);
    const { approvalPolicy, sandboxPolicy } = this.policy();
    // Master context: shared memory as developer instructions, and the tether-context MCP server.
    const ctx = await sessionContext(this.projectPath, { id: this.opts.resume ? this.id : undefined, key: this.guardEnv.TETHER_GUARD_KEY });
    const params = {
      cwd: this.projectPath,
      approvalPolicy,
      approvalsReviewer: "user",
      sandbox: sandboxPolicy.type === "dangerFullAccess" ? "danger-full-access" : "workspace-write",
      ...(this.model ? { model: this.model } : {}),
      ...(ctx
        ? {
            developerInstructions: ctx.prompt,
            config: { "mcp_servers.tether-context": { command: ctx.mcp.command, args: ctx.mcp.args, env: ctx.mcp.env, default_tools_approval_mode: "approve" } },
          }
        : {}),
    };
    let r: any;
    if (this.opts.resume) {
      r = await this.p.call("thread/resume", { threadId: this.nativeId, ...params });
      this.emit({ type: "reset", messages: historyMsgs(r.thread.turns ?? [], this.projectPath, r.model) });
    } else {
      r = await this.p.call("thread/start", params);
      this.nativeId = r.thread.id;
    }
    if (r.thread.name) this.setTitle(r.thread.name);
    this.model = r.model;
    this.effort = r.reasoningEffort ?? undefined;
    this.models = await fetchModels(this.p).catch(() => []);
    modelCache = this.models;
    modelCacheAt = Date.now();
    this.collab ??= r.collaborationMode?.mode === "plan" ? "plan" : undefined;
    this.setState({ status: "idle", model: r.model, thinking: this.effort, thinkingLevels: this.levels(), activity: [], modes: CODEX_MODES, permissionMode: this.collab ?? "default" });
    // Codex reports token usage only as turns run; a resumed thread's last count is in its rollout.
    if (this.opts.resume && r.thread.path && !this.t.state.context)
      await Bun.file(r.thread.path)
        .slice(-4_000_000)
        .text()
        .then((text) => this.setContext(codexRollout(text, r.model)))
        .catch(() => {});
  }

  private levels(): string[] {
    const m = this.models.find((x) => x.id === this.model);
    return (m?.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort);
  }

  // ---- transcript ----

  private ensureMsg(): Msg {
    const cur = this.msgId && this.t.messages.find((m) => m.id === this.msgId);
    if (cur) return cur;
    const msg: Msg = { id: newId("a"), role: "assistant", parts: [], ts: Date.now(), model: this.t.state.model, streaming: true };
    this.msgId = msg.id;
    this.emit({ type: "msg", msg });
    return msg;
  }

  private addPart(itemId: string, part: Part) {
    const m = this.ensureMsg();
    this.parts.set(itemId, { msgId: m.id, idx: m.parts.length });
    this.emit({ type: "msg", msg: { ...m, parts: [...m.parts, part] } });
  }

  private replacePart(itemId: string, part: Part) {
    const at = this.parts.get(itemId);
    const m = at && this.t.messages.find((x) => x.id === at.msgId);
    if (!at || !m) return this.addPart(itemId, part);
    const parts = [...m.parts];
    const old = parts[at.idx];
    // Keep the guard's verdict, or its "checking…" while the judge decides.
    parts[at.idx] = old?.type === "tool" && part.type === "tool" && (old.guard || old.judging) ? { ...part, guard: old.guard, judging: part.status === "running" ? old.judging : undefined } : part;
    this.emit({ type: "msg", msg: { ...m, parts } });
  }

  private textDelta(itemId: string, kind: "text" | "thinking", text: string, source?: "summary" | "content") {
    if (!text) return;
    let at = this.parts.get(itemId);
    if (!at) {
      this.addPart(itemId, { type: kind, text: "" });
      at = this.parts.get(itemId)!;
    }
    // Reasoning can stream both a summary and raw content; show whichever comes first.
    if (source) {
      at.delta ??= source;
      if (at.delta !== source) return;
    }
    this.emit({ type: "delta", msgId: at.msgId, part: at.idx, kind, text });
  }

  private finishMsg(error?: string) {
    const m = this.msgId && this.t.messages.find((x) => x.id === this.msgId);
    if (m) this.emit({ type: "msg", msg: { ...m, streaming: false, ...(error ? { error } : {}) } });
    this.msgId = undefined;
    this.parts.clear();
  }

  private setRetrying(text?: string) {
    const statuses = { ...this.t.state.statuses };
    if (text) statuses.codex = text;
    else delete statuses.codex;
    this.retrying = !!text;
    this.setState({ statuses });
  }

  private onNotify(method: string, p: any) {
    this.upsertActivity(...this.act.onNotify(method, p, this.nativeId));
    if (p.threadId && p.threadId !== this.nativeId) return; // subagent threads: their activity item shows them
    switch (method) {
      case "turn/started":
        this.turnId = p.turn.id;
        if (this.t.state.status !== "running") this.setState({ status: "running" });
        break;
      case "item/started": {
        const item = p.item;
        if (item.type === "fileChange") this.patches.set(item.id, item);
        // Reasoning gets its part from its first delta: many reasoning items stay empty.
        if (item.type === "userMessage" || item.type === "contextCompaction" || item.type === "reasoning") break;
        const part = itemPart(item, this.projectPath);
        if (part) this.addPart(item.id, part);
        break;
      }
      case "item/agentMessage/delta":
      case "item/plan/delta":
        this.textDelta(p.itemId, "text", p.delta);
        break;
      case "item/reasoning/summaryTextDelta":
        this.textDelta(p.itemId, "thinking", p.delta, "summary");
        break;
      case "item/reasoning/summaryPartAdded":
        if (p.summaryIndex > 0) this.textDelta(p.itemId, "thinking", "\n\n", "summary");
        break;
      case "item/reasoning/textDelta":
        this.textDelta(p.itemId, "thinking", p.delta, "content");
        break;
      case "item/commandExecution/outputDelta":
      case "item/fileChange/outputDelta": {
        const hit = findTool(this.t.messages, p.itemId);
        if (hit) this.emit({ type: "tool", msgId: hit.msg.id, toolId: p.itemId, patch: { output: ((hit.part.output ?? "") + p.delta).slice(-OUTPUT_MAX) } });
        break;
      }
      case "item/completed": {
        const item = p.item;
        if (item.type === "userMessage") break;
        if (item.type === "contextCompaction") {
          this.emit({ type: "msg", msg: { id: newId("n"), role: "notice", parts: [{ type: "text", text: "Context compacted." }], ts: Date.now(), source: "compaction" } });
          this.contextCompacted();
          break;
        }
        this.patches.delete(item.id);
        const part = itemPart(item, this.projectPath);
        if (!part) break;
        if ((part.type === "text" || part.type === "thinking" || part.type === "plan") && !part.text && !this.parts.has(item.id)) break;
        this.replacePart(item.id, part);
        break;
      }
      case "turn/plan/updated": {
        const todos = (p.plan ?? []).map((s: any) => ({ content: s.step, status: s.status === "inProgress" ? "in_progress" : s.status }));
        const m = this.ensureMsg();
        const idx = m.parts.findIndex((x) => x.type === "tool" && x.name === "TodoWrite");
        const part: Part = { type: "tool", id: idx >= 0 ? (m.parts[idx] as ToolPart).id : newId("plan"), name: "TodoWrite", input: { todos }, status: "done" };
        const parts = [...m.parts];
        if (idx >= 0) parts[idx] = part;
        else parts.push(part);
        this.emit({ type: "msg", msg: { ...m, parts } });
        break;
      }
      case "turn/completed":
        this.onTurnCompleted(p.turn);
        break;
      case "error":
        if (p.willRetry) this.setRetrying(`retrying: ${p.error?.message ?? "error"}`);
        break;
      case "thread/tokenUsage/updated": {
        this.setContext(codexTokenUsage(p.tokenUsage, this.model ?? this.t.state.model));
        break;
      }
      case "account/rateLimits/updated":
        this.rateLimits = p.rateLimits;
        break;
      case "thread/name/updated":
        if (p.threadName) this.setTitle(p.threadName);
        break;
      case "model/rerouted":
        this.notice(`Codex moved this turn from ${p.fromModel} to ${p.toModel}.`);
        break;
      case "warning":
      case "guardianWarning":
        this.emit({ type: "toast", level: "warning", text: p.message });
        break;
    }
  }

  /** usageLimitExceeded: the latest exhausted window's reset, from Codex's rate-limit updates. */
  private quotaReset(): number | undefined {
    const rl = this.rateLimits;
    const resets = [rl?.primary, rl?.secondary].filter((w) => w && w.usedPercent >= 100 && w.resetsAt).map((w) => w.resetsAt * 1000);
    return resets.length ? Math.max(...resets) : undefined;
  }

  private classifyError(e: any): { status?: number; hint?: Classified } {
    const info = e?.codexErrorInfo;
    if (info === "usageLimitExceeded") return { hint: { kind: "quota", resetAt: this.quotaReset() } };
    if (info === "serverOverloaded") return { hint: { kind: "rate_limit" } };
    const status = info && typeof info === "object" ? (Object.values(info)[0] as any)?.httpStatusCode : undefined;
    return { status: status ?? undefined };
  }

  private async onTurnCompleted(turn: any) {
    this.turnId = undefined;
    if (this.retrying) this.setRetrying();
    if (turn.status === "failed") {
      const e = turn.error;
      const text = [e?.message, e?.additionalDetails].filter(Boolean).join(": ");
      const { status, hint } = this.classifyError(e);
      this.finishMsg();
      if (await this.handleTurnError(text, status, hint)) return;
      this.notice(text || "The turn failed.", "error");
    } else {
      this.finishMsg(turn.status === "interrupted" ? "aborted" : undefined);
      if (turn.status === "completed") this.turnSucceeded();
    }
    if (await this.drainPending()) return;
    this.setState({ status: "idle" });
  }

  private async onRequest(method: string, p: any): Promise<unknown> {
    switch (method) {
      case "item/commandExecution/requestApproval": {
        const input = { command: unwrapShell(p.command ?? "") };
        const v = await this.checkTool("bash", input, p.itemId);
        if (!v.allow) this.explainDenial(`\`${input.command}\``, v.reason);
        return { decision: v.allow ? (v.always ? "acceptForSession" : "accept") : "decline" };
      }
      case "item/fileChange/requestApproval": {
        const item = this.patches.get(p.itemId);
        const input = item ? patchInput(item.changes ?? [], this.projectPath) : { path: p.grantRoot ?? this.projectPath, reason: p.reason };
        const v = await this.checkTool("apply_patch", input, p.itemId);
        if (!v.allow) this.explainDenial(`patch to ${input.path}`, v.reason);
        return { decision: v.allow ? (v.always ? "acceptForSession" : "accept") : "decline" };
      }
      case "item/permissions/requestApproval": {
        const v = await this.checkTool("request_permissions", { reason: p.reason, permissions: p.permissions, cwd: p.cwd }, p.itemId);
        const granted: any = {};
        if (v.allow && p.permissions?.network) granted.network = p.permissions.network;
        if (v.allow && p.permissions?.fileSystem) granted.fileSystem = p.permissions.fileSystem;
        if (!v.allow) this.explainDenial("permission request", v.reason);
        return { permissions: granted, scope: v.always ? "session" : "turn" };
      }
      case "item/tool/requestUserInput": {
        const qs: any[] = p.questions ?? [];
        const r = await this.askUi({
          id: newId("q"),
          kind: "question",
          title: "Codex has a question",
          questions: qs.map((q) => ({ question: q.question, header: q.header, options: (q.options ?? []).map((o: any) => ({ label: o.label, description: o.description })) })),
        });
        const answers: Record<string, { answers: string[] }> = {};
        if (!r.cancelled) for (const q of qs) if (r.answers?.[q.question] !== undefined) answers[q.id] = { answers: [r.answers[q.question]!] };
        return { answers };
      }
      case "mcpServer/elicitation/request":
        return { action: "decline", content: null, _meta: null };
      default:
        return undefined;
    }
  }

  /** Codex's "decline" tells the model nothing; pass the guard's reason along. */
  private explainDenial(what: string, reason?: string) {
    const turnId = this.turnId;
    if (!turnId) return;
    const text = `${GUARD_NOTE} Your ${what} was blocked: ${reason ?? "not allowed"}. Don't retry it as is; find another way or explain what you need.`;
    this.p.call("turn/steer", { threadId: this.nativeId, input: [{ type: "text", text, text_elements: [] }], expectedTurnId: turnId }).catch(() => {});
  }

  // ---- turns ----

  private async startTurn(text: string) {
    this.finishMsg();
    this.setState({ status: "running" });
    try {
      const r: any = await this.p.call("turn/start", {
        threadId: this.nativeId,
        input: [{ type: "text", text, text_elements: [] }],
        approvalsReviewer: "user",
        ...this.policy(),
        ...(this.model ? { model: this.model } : {}),
        ...(this.effort ? { effort: this.effort } : {}),
        ...this.collabParam(),
      });
      this.turnId ??= r.turn?.id;
    } catch (e: any) {
      if (await this.handleTurnError(e?.message)) return;
      this.notice(e?.message || "Could not start the turn.", "error");
      this.setState({ status: "idle" });
    }
  }

  protected async steer(text: string) {
    if (!this.turnId) return false;
    try {
      await this.p.call("turn/steer", { threadId: this.nativeId, input: [{ type: "text", text, text_elements: [] }], expectedTurnId: this.turnId });
      return true;
    } catch {
      return false; // the turn just ended, or it's a review/compaction, which can't be steered
    }
  }

  protected async send(text: string) {
    if (await this.preferBest(text)) return;
    this.addUserMessage(text);
    if (this.title === "New session") this.setTitle(text.replace(/\s+/g, " ").slice(0, 120));
    await this.startTurn(text);
  }

  async continueTurn(text = "Continue where you left off.") {
    this.addUserMessage(text.length > 300 ? text.slice(0, 300) + "…" : text);
    await this.startTurn(text);
  }

  async abort() {
    if (this.cancelWait()) return;
    this.cancelAllUi();
    if (this.turnId) await this.p.call("turn/interrupt", { threadId: this.nativeId, turnId: this.turnId });
  }

  /** A subagent is a thread of its own: interrupt its running turn. */
  protected async stopActivityItem(item: ActivityItem) {
    const turnId = this.act.turns.get(item.id);
    if (item.kind !== "subagent" || !turnId) throw new Error("Codex isn't running a turn for this agent right now.");
    await this.p.call("turn/interrupt", { threadId: item.id, turnId });
  }

  /** Model and effort ride along on the next turn/start (Codex keeps them for later turns). */
  async applyModel(model: string) {
    this.model = model === "default" ? this.models.find((m) => m.isDefault)?.id : model;
    const levels = this.levels();
    if (this.effort && levels.length && !levels.includes(this.effort)) this.effort = undefined;
    this.setState({ model: this.model ?? model, thinking: this.effort, thinkingLevels: levels });
  }

  async setThinking(level: string) {
    this.effort = level;
    this.setState({ thinking: level });
  }

  private collabParam() {
    const model = this.model ?? this.t.state.model;
    return this.collab && model && model !== "default" ? { collaborationMode: collaborationMode(this.collab, model, this.effort) } : {};
  }

  /**
   * Plan mode on or off (Codex's collaboration mode; approvals stay with the guard). It applies
   * from the next turn: set on the thread now, and sent again with every turn/start.
   */
  async setPermissionMode(mode: string) {
    if (!CODEX_MODES.includes(mode)) throw new Error(`Codex modes are ${CODEX_MODES.join(" and ")}; the guard setting decides approvals.`);
    this.collab = mode;
    const p = this.collabParam();
    if (p.collaborationMode) await this.p.call("thread/settings/update", { threadId: this.nativeId, ...p }).catch(() => {});
    this.setState({ permissionMode: mode });
  }

  async rename(title: string) {
    await this.p.call("thread/name/set", { threadId: this.nativeId, name: title }).catch(() => {});
    this.setTitle(title);
  }

  async listCommands() {
    return [];
  }

  protected shutdown() {
    this.p?.kill();
  }
}

// ---------------- adapter ----------------

let modelCache: CodexModel[] | undefined;
let modelCacheAt = 0;
const MODEL_CACHE_MS = 5 * 60_000;
let listCache: { at: number; threads: any[] } | undefined;

async function threads(): Promise<any[]> {
  if (listCache && Date.now() - listCache.at < 20_000) return listCache.threads;
  const all: any[] = [];
  try {
    await withProcess(async (p) => {
      let cursor: string | null = null;
      for (let i = 0; i < 20; i++) {
        const r: any = await p.call("thread/list", { cursor, limit: 100, sortKey: "updated_at", sourceKinds: SOURCES, useStateDbOnly: true }, 30_000);
        all.push(...r.data);
        if (!(cursor = r.nextCursor)) break;
      }
    });
  } catch {}
  listCache = { at: Date.now(), threads: all };
  return all;
}

const titleOf = (t: any) => t.name || (t.preview ?? "").replace(/\s+/g, " ").slice(0, 120) || "Untitled";

export const codexAdapter: Adapter = {
  id: "codex",

  async available() {
    return !!Bun.which(CODEX_BIN);
  },

  async listProjects(): Promise<StoredProject[]> {
    if (!Bun.which(CODEX_BIN)) return [];
    const by = new Map<string, StoredProject>();
    for (const t of await threads()) {
      const p = by.get(t.cwd) ?? { path: t.cwd, updatedAt: 0, count: 0 };
      p.count++;
      p.updatedAt = Math.max(p.updatedAt, t.updatedAt * 1000);
      by.set(t.cwd, p);
    }
    return [...by.values()];
  },

  async listSessions(projectPath: string): Promise<SessionSummary[]> {
    if (!Bun.which(CODEX_BIN)) return [];
    return (await threads())
      .filter((t) => t.cwd === projectPath)
      .map((t) => ({
        id: `codex:${t.id}`,
        harness: "codex" as const,
        nativeId: t.id,
        projectPath,
        title: titleOf(t),
        createdAt: t.createdAt * 1000,
        updatedAt: t.updatedAt * 1000,
        live: false,
        status: "idle" as const,
      }));
  },

  async readHistory(nativeId: string, projectPath: string): Promise<Msg[]> {
    if (!Bun.which(CODEX_BIN)) return [];
    return withProcess(async (p) => {
      const r: any = await p.call("thread/read", { threadId: nativeId, includeTurns: true });
      const thread = r.thread ?? r;
      return historyMsgs(thread.turns ?? [], projectPath, thread.model);
    });
  },

  create(projectPath, opts, sink) {
    listCache = undefined;
    return new CodexSession({ nativeId: "pending-" + newId(""), projectPath }, sink, opts);
  },

  async resume(nativeId, projectPath, sink) {
    const t = (await threads()).find((x) => x.id === nativeId);
    return new CodexSession(
      { nativeId, projectPath: t?.cwd ?? projectPath, title: t ? titleOf(t) : undefined, createdAt: t ? t.createdAt * 1000 : undefined },
      sink,
      { resume: true },
    );
  },

  async listModels(live) {
    if ((!modelCache || Date.now() - modelCacheAt > MODEL_CACHE_MS) && Bun.which(CODEX_BIN)) {
      modelCache = await withProcess(fetchModels).catch(() => []);
      modelCacheAt = Date.now();
    }
    const models = modelCache ?? [];
    const cur = live?.t.state.model;
    const m = models.find((x) => x.id === cur) ?? models.find((x) => x.isDefault);
    return {
      models: [{ id: "default" }, ...models.map((x): ModelRef => ({ id: x.id, label: x.displayName }))],
      thinkingLevels: (m?.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort),
      permissionModes: CODEX_MODES,
    };
  },
};
