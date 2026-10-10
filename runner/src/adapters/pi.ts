// pi (`pi --mode rpc`): one child process per live session, JSONL over stdin/stdout.
// Protocol: pi docs rpc.md, rpc-commands.md, json.md, rpc-extension-ui.md.

import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ModelRef, Msg, Part, SessionSummary } from "../../../web/src/shared/protocol";
import { findTool } from "../../../web/src/shared/reducer";
import { fileURLToPath } from "node:url";
import { piStats } from "../context";
import { LiveSession, newId } from "../session";
import { sessionContext } from "../context/inject";

const PI_GUARD_EXT = fileURLToPath(new URL("../../hooks/pi-guard.ts", import.meta.url));
import type { Adapter, CreateOpts, Sink, StoredProject } from "./types";

const PI_BIN = process.env.PI_BIN ?? "pi";
const SESSION_DIR = process.env.PI_CODING_AGENT_SESSION_DIR ?? join(homedir(), ".pi", "agent", "sessions");

// ---------------- session files ----------------

interface PiFile {
  path: string;
  id: string;
  cwd: string;
  createdAt: number;
  mtime: number;
  size: number;
  title?: string;
}

const headerCache = new Map<string, PiFile>();
const titleCache = new Map<string, { mtime: number; title: string }>();

async function scanFiles(): Promise<PiFile[]> {
  const out: PiFile[] = [];
  let dirs: string[] = [];
  try {
    dirs = await readdir(SESSION_DIR);
  } catch {
    return out;
  }
  await Promise.all(
    dirs.map(async (d) => {
      let files: string[] = [];
      try {
        files = (await readdir(join(SESSION_DIR, d))).filter((f) => f.endsWith(".jsonl"));
      } catch {
        return;
      }
      for (const f of files) {
        const path = join(SESSION_DIR, d, f);
        try {
          const st = await stat(path);
          let h = headerCache.get(path);
          if (!h) {
            const fh = await open(path, "r");
            const buf = Buffer.alloc(4096);
            const { bytesRead } = await fh.read(buf, 0, 4096, 0);
            await fh.close();
            const line = buf.subarray(0, bytesRead).toString("utf8").split("\n")[0]!;
            const head = JSON.parse(line);
            if (head.type !== "session") continue;
            h = { path, id: head.id, cwd: head.cwd, createdAt: Date.parse(head.timestamp), mtime: 0, size: 0 };
            headerCache.set(path, h);
          }
          h.mtime = st.mtimeMs;
          h.size = st.size;
          out.push(h);
        } catch {
          /* unreadable or partial file */
        }
      }
    }),
  );
  return out;
}

/** Session name (last session_info) or the first user message. */
async function titleOf(f: PiFile): Promise<string> {
  const c = titleCache.get(f.path);
  if (c && c.mtime === f.mtime) return c.title;
  let title = "";
  let name = "";
  try {
    const text = await Bun.file(f.path).text();
    for (const line of text.split("\n")) {
      if (line.includes('"type":"session_info"')) {
        try {
          name = JSON.parse(line).name ?? name;
        } catch {}
      } else if (!title && line.includes('"role":"user"')) {
        try {
          const m = JSON.parse(line).message;
          title = textOf(m.content);
        } catch {}
      }
    }
  } catch {}
  const t = (name || title || "Untitled").replace(/\s+/g, " ").slice(0, 120);
  titleCache.set(f.path, { mtime: f.mtime, title: t });
  return t;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((b) => b?.type === "text").map((b) => b.text).join("\n");
  return "";
}

// ---------------- message conversion ----------------

function convertAssistant(m: any, id: string): Msg {
  const parts: Part[] = (m.content ?? []).map((b: any): Part => {
    if (b.type === "text") return { type: "text", text: b.text ?? "" };
    if (b.type === "thinking") return { type: "thinking", text: b.redacted ? "(redacted)" : (b.thinking ?? "") };
    if (b.type === "toolCall") return { type: "tool", id: b.id, name: b.name, input: b.arguments, status: "running" };
    return { type: "text", text: "" };
  });
  const error = m.stopReason === "error" ? (m.errorMessage ?? "error") : m.stopReason === "aborted" ? "aborted" : undefined;
  return { id, role: "assistant", parts, ts: m.timestamp ?? Date.now(), model: m.provider ? `${m.provider}/${m.model}` : m.model, error };
}

function resultText(content: any): string {
  if (!Array.isArray(content)) return typeof content === "string" ? content : "";
  return content.map((b: any) => (b.type === "text" ? b.text : b.type === "image" ? "[image]" : "")).join("\n");
}

/** Converts one pi AgentMessage into transcript changes. Returns a new message, or applies a tool result. */
function convertMessage(m: any, messages: Msg[], id: string): Msg | undefined {
  switch (m.role) {
    case "user": {
      const parts: Part[] =
        typeof m.content === "string"
          ? [{ type: "text", text: m.content }]
          : (m.content ?? []).map((b: any): Part => (b.type === "image" ? { type: "image", mimeType: b.mimeType, data: b.data } : { type: "text", text: b.text ?? "" }));
      return { id, role: "user", parts, ts: m.timestamp ?? Date.now() };
    }
    case "assistant":
      return convertAssistant(m, id);
    case "toolResult": {
      const hit = findTool(messages, m.toolCallId);
      if (hit) {
        hit.part.status = m.isError ? "error" : "done";
        hit.part.output = resultText(m.content);
      }
      return undefined;
    }
    case "bashExecution":
      return {
        id,
        role: "user",
        ts: m.timestamp ?? Date.now(),
        parts: [{ type: "tool", id: id + "b", name: "bash", input: { command: m.command }, status: m.exitCode === 0 ? "done" : "error", output: m.output }],
      };
    case "compactionSummary":
      return { id, role: "notice", level: "info", ts: m.timestamp ?? Date.now(), parts: [{ type: "text", text: `Context compacted.\n\n${m.summary}` }] };
    case "branchSummary":
      return { id, role: "notice", level: "info", ts: m.timestamp ?? Date.now(), parts: [{ type: "text", text: `Branch summary:\n\n${m.summary}` }] };
    case "custom":
      if (!m.display) return undefined;
      return { id, role: "notice", level: "info", ts: m.timestamp ?? Date.now(), parts: [{ type: "text", text: textOf(m.content) }] };
    default:
      return undefined; // system and unknown roles
  }
}

function convertAll(list: any[]): Msg[] {
  const out: Msg[] = [];
  list.forEach((m, i) => {
    const msg = convertMessage(m, out, `h${i}`);
    if (msg) out.push(msg);
  });
  // Tool calls without a result in history were interrupted.
  for (const m of out) for (const p of m.parts) if (p.type === "tool" && p.status === "running") p.status = "error";
  return out;
}

// ---------------- RPC client ----------------

class PiRpc {
  private proc: ReturnType<typeof Bun.spawn>;
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private n = 0;
  onRecord?: (r: any) => void;
  onExit?: (code: number | null, stderr: string) => void;
  private stderr = "";

  constructor(cwd: string, args: string[], env: Record<string, string> = {}) {
    this.proc = Bun.spawn([PI_BIN, "--mode", "rpc", ...args], {
      cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...env },
    });
    this.readStdout();
    this.readStderr();
    this.proc.exited.then((code) => {
      for (const p of this.pending.values()) p.reject(new Error(`pi exited (${code}): ${this.stderr.slice(-500)}`));
      this.pending.clear();
      this.onExit?.(code, this.stderr);
    });
  }

  // Strict LF framing: Node's readline would also split on U+2028/2029 (pi rpc.md).
  private async readStdout() {
    const reader = (this.proc.stdout as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        let line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (!line) continue;
        let rec: any;
        try {
          rec = JSON.parse(line);
        } catch {
          continue;
        }
        if (rec.type === "response" && rec.id && this.pending.has(rec.id)) {
          const p = this.pending.get(rec.id)!;
          this.pending.delete(rec.id);
          rec.success ? p.resolve(rec.data) : p.reject(new Error(rec.error ?? `${rec.command} failed`));
        } else {
          this.onRecord?.(rec);
        }
      }
    }
  }

  private async readStderr() {
    const reader = (this.proc.stderr as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      this.stderr = (this.stderr + dec.decode(value)).slice(-8000);
    }
  }

  write(rec: object) {
    const sink = this.proc.stdin as import("bun").FileSink;
    sink.write(JSON.stringify(rec) + "\n");
    sink.flush();
  }

  call<T = any>(type: string, args: object = {}): Promise<T> {
    const id = `r${++this.n}`;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ id, type, ...args });
    });
  }

  close() {
    try {
      (this.proc.stdin as import("bun").FileSink).end();
    } catch {}
    setTimeout(() => this.proc.kill(), 5_000);
  }
}

// ---------------- live session ----------------

class PiSession extends LiveSession {
  private rpc!: PiRpc;
  private sessionFile?: string;
  private streamingId?: string;

  constructor(
    init: { nativeId: string; projectPath: string; title?: string; createdAt?: number; sessionFile?: string },
    sink: Sink,
    private opts: CreateOpts = {},
  ) {
    super("pi", init, sink);
    this.sessionFile = init.sessionFile;
  }

  async start() {
    const args: string[] = [];
    if (this.sessionFile) args.push("--session", this.sessionFile);
    if (this.opts.model) args.push("--model", this.opts.model);
    // Every tool call goes through the Tether guard (pi has no permission system of its own).
    args.push("-e", PI_GUARD_EXT);
    // Master context: shared memory in the system prompt (its MCP server is registered in pi's global mcp.json by the export).
    const ctx = await sessionContext(this.projectPath, { key: this.guardEnv.TETHER_GUARD_KEY });
    if (ctx) args.push("--append-system-prompt", ctx.prompt);
    this.rpc = new PiRpc(this.projectPath, args, this.guardEnv);
    this.rpc.onRecord = (r) => this.onRecord(r);
    this.rpc.onExit = (code, stderr) => {
      if (!this.closed) {
        this.notice(`pi exited (code ${code}). ${stderr.trim().split("\n").slice(-3).join("\n")}`, "error");
        this.setState({ status: "idle" });
        this.close();
      }
    };
    const st = await this.rpc.call("get_state");
    this.nativeId = st.sessionId;
    this.sessionFile = st.sessionFile;
    if (st.sessionName) this.setTitle(st.sessionName);
    const msgs = await this.rpc.call("get_messages");
    this.emit({ type: "reset", messages: convertAll(msgs.messages ?? []) });
    this.setState({
      status: st.isStreaming ? "running" : "idle",
      model: st.model ? `${st.model.provider}/${st.model.id}` : undefined,
      thinking: st.thinkingLevel,
    });
    this.refreshContext();
  }

  /** pi's own context estimate (the one its footer shows); its tokens are null right after compaction. */
  private refreshContext() {
    this.rpc
      .call("get_session_stats")
      .then((stats) => {
        const c = piStats(stats, this.t.state.model);
        this.setContext(c);
        if (c && c.used === undefined) this.contextCompacted();
      })
      .catch(() => {});
  }

  private onRecord(r: any) {
    switch (r.type) {
      case "agent_start":
        this.setState({ status: "running" });
        break;
      case "agent_settled":
        this.onSettled();
        break;
      case "message_start":
        if (r.message?.role === "assistant") {
          this.streamingId = newId("a");
          const msg = convertAssistant(r.message, this.streamingId);
          msg.streaming = true;
          this.emit({ type: "msg", msg });
        }
        break;
      case "message_update":
        this.onUpdate(r.assistantMessageEvent);
        break;
      case "message_end": {
        const m = r.message;
        if (m?.role === "assistant") {
          const id = this.streamingId ?? newId("a");
          this.streamingId = undefined;
          const msg = convertAssistant(m, id);
          // keep live tool state (results may already be streaming in)
          const prev = this.t.messages.find((x) => x.id === id);
          if (prev)
            msg.parts = msg.parts.map((p) => {
              if (p.type !== "tool") return p;
              const old = prev.parts.find((q) => q.type === "tool" && q.id === p.id);
              return old && old.type === "tool" ? { ...p, status: old.status, output: old.output } : p;
            });
          this.emit({ type: "msg", msg });
          if (!msg.error) this.turnSucceeded();
          this.refreshContext();
        } else if (m?.role === "toolResult") {
          const hit = findTool(this.t.messages, m.toolCallId);
          if (hit)
            this.emit({
              type: "tool",
              msgId: hit.msg.id,
              toolId: m.toolCallId,
              patch: { status: m.isError ? "error" : "done", output: resultText(m.content) },
            });
        } else if (m) {
          const msg = convertMessage(m, this.t.messages, newId("m"));
          if (msg) this.emit({ type: "msg", msg });
        }
        break;
      }
      case "tool_execution_update": {
        const hit = findTool(this.t.messages, r.toolCallId);
        const text = resultText(r.partialResult?.content);
        if (hit && text) this.emit({ type: "tool", msgId: hit.msg.id, toolId: r.toolCallId, patch: { output: text } });
        break;
      }
      case "queue_update":
        this.setState({ queued: [...(r.steering ?? []), ...(r.followUp ?? [])] });
        break;
      case "thinking_level_changed":
        this.setState({ thinking: r.level });
        break;
      case "session_info_changed":
        if (r.name) this.setTitle(r.name);
        break;
      case "compaction_start":
        this.emit({ type: "toast", level: "info", text: "Compacting context…" });
        break;
      case "compaction_end":
        this.rpc.call("get_messages").then((d) => this.emit({ type: "reset", messages: convertAll(d.messages ?? []) }));
        this.refreshContext();
        break;
      case "auto_retry_start":
        this.setState({ status: "waiting", waitingReason: `Retrying (${r.attempt}/${r.maxAttempts}): ${r.errorMessage ?? ""}`, waitingUntil: Date.now() + (r.delayMs ?? 0) });
        break;
      case "auto_retry_end":
        this.setState({ status: "running", waitingReason: undefined, waitingUntil: undefined });
        break;
      case "extension_ui_request":
        this.onExtensionUi(r);
        break;
      case "extension_error":
        this.emit({ type: "toast", level: "error", text: `Extension error: ${r.error}` });
        break;
    }
  }

  private onUpdate(e: any) {
    const id = this.streamingId;
    if (!id || !e) return;
    const msg = this.t.messages.find((m) => m.id === id);
    if (!msg) return;
    switch (e.type) {
      case "text_delta":
        this.emit({ type: "delta", msgId: id, part: e.contentIndex, kind: "text", text: e.delta });
        break;
      case "thinking_delta":
        this.emit({ type: "delta", msgId: id, part: e.contentIndex, kind: "thinking", text: e.delta });
        break;
      case "toolcall_start": {
        const parts = [...msg.parts];
        parts[e.contentIndex] = { type: "tool", id: e.id, name: e.toolName, input: {}, status: "running" };
        this.emit({ type: "msg", msg: { ...msg, parts } });
        break;
      }
      case "toolcall_end": {
        const parts = [...msg.parts];
        const tc = e.toolCall;
        parts[e.contentIndex] = { type: "tool", id: tc.id, name: tc.name, input: tc.arguments, status: "running" };
        this.emit({ type: "msg", msg: { ...msg, parts } });
        break;
      }
    }
  }

  private async onSettled() {
    const last = [...this.t.messages].reverse().find((m) => m.role === "assistant");
    if (last?.error && last.error !== "aborted") {
      if (await this.handleTurnError(last.error)) return;
    }
    if (await this.drainPending()) return;
    this.setState({ status: "idle" });
  }

  private onExtensionUi(r: any) {
    switch (r.method) {
      case "setStatus": {
        const text = r.statusText ? String(r.statusText).replace(/\u001b\[[0-9;]*m/g, "") : undefined;
        if (this.t.state.statuses[r.statusKey] === text) break;
        const statuses = { ...this.t.state.statuses };
        if (text) statuses[r.statusKey] = text;
        else delete statuses[r.statusKey];
        this.setState({ statuses });
        break;
      }
      case "notify":
        this.emit({ type: "toast", level: r.notifyType ?? "info", text: r.message });
        break;
      case "setTitle":
      case "setWidget":
      case "set_editor_text":
        break;
      case "select":
      case "confirm":
      case "input":
      case "editor":
        this.askUi(
          {
            id: r.id,
            kind: r.method === "editor" ? "input" : r.method,
            title: r.title,
            message: r.message ?? r.prefill,
            options: r.options,
            placeholder: r.placeholder,
          },
          r.timeout,
        ).then((res) => {
          const out: any = { type: "extension_ui_response", id: r.id };
          if (res.cancelled) out.cancelled = true;
          else if (r.method === "confirm") out.confirmed = !!res.confirmed;
          else out.value = res.value ?? "";
          this.rpc.write(out);
        });
        break;
    }
  }

  // pi shows user messages itself once they enter the conversation (message_end).
  protected echoesUserMessages = true;

  protected async send(text: string) {
    if (await this.preferBest(text)) return;
    if (this.title === "New session") this.setTitle(text.replace(/\s+/g, " ").slice(0, 120));
    await this.rpc.call("prompt", { message: text });
  }

  protected async steer(text: string) {
    try {
      await this.rpc.call("prompt", { message: text, streamingBehavior: "steer" });
      return true;
    } catch {
      return false;
    }
  }

  async abort() {
    if (this.cancelWait()) return;
    await this.rpc.call("abort");
  }

  async applyModel(model: string) {
    const i = model.indexOf("/");
    if (i < 0) throw new Error(`pi models are "provider/id", got "${model}"`);
    await this.rpc.call("set_model", { provider: model.slice(0, i), modelId: model.slice(i + 1) });
    this.setState({ model });
    this.refreshContext();
  }

  async setThinking(level: string) {
    await this.rpc.call("set_thinking_level", { level });
    this.setState({ thinking: level });
  }

  async setPermissionMode() {
    throw new Error("pi has no permission modes");
  }

  async rename(title: string) {
    await this.rpc.call("set_session_name", { name: title });
    this.setTitle(title);
  }

  async listCommands() {
    const d = await this.rpc.call("get_commands");
    return (d.commands ?? []).map((c: any) => ({ name: c.name, description: c.description }));
  }

  async models() {
    const [m, t] = await Promise.all([this.rpc.call("get_available_models"), this.rpc.call("get_available_thinking_levels")]);
    return {
      models: (m.models ?? []).map((x: any): ModelRef => ({ id: `${x.provider}/${x.id}`, label: x.name })),
      thinkingLevels: t.levels ?? [],
    };
  }

  async continueTurn(text = "Continue where you left off.") {
    await this.rpc.call("prompt", { message: text });
  }

  protected shutdown() {
    this.rpc?.close();
  }
}

// ---------------- adapter ----------------

let modelCache: { at: number; data: Awaited<ReturnType<PiSession["models"]>> } | undefined;

export const piAdapter: Adapter = {
  id: "pi",

  async available() {
    return !!Bun.which(PI_BIN);
  },

  async listProjects(): Promise<StoredProject[]> {
    const by = new Map<string, StoredProject>();
    for (const f of await scanFiles()) {
      const p = by.get(f.cwd) ?? { path: f.cwd, updatedAt: 0, count: 0 };
      p.count++;
      p.updatedAt = Math.max(p.updatedAt, f.mtime);
      by.set(f.cwd, p);
    }
    return [...by.values()];
  },

  async listSessions(projectPath: string): Promise<SessionSummary[]> {
    const files = (await scanFiles()).filter((f) => f.cwd === projectPath);
    return Promise.all(
      files.map(async (f) => ({
        id: `pi:${f.id}`,
        harness: "pi" as const,
        nativeId: f.id,
        projectPath: f.cwd,
        title: await titleOf(f),
        createdAt: f.createdAt,
        updatedAt: f.mtime,
        live: false,
        status: "idle" as const,
      })),
    );
  },

  async readHistory(nativeId: string, projectPath: string): Promise<Msg[]> {
    const f = (await scanFiles()).find((x) => x.id === nativeId && x.cwd === projectPath);
    if (!f) return [];
    const rows = (await Bun.file(f.path).text())
      .split("\n")
      .flatMap((line) => {
        try {
          const row = JSON.parse(line);
          return row.message ? [row.message] : [];
        } catch {
          return [];
        }
      });
    return convertAll(rows);
  },

  create(projectPath, opts, sink) {
    return new PiSession({ nativeId: "pending-" + newId(""), projectPath }, sink, opts);
  },

  async resume(nativeId, projectPath, sink) {
    const f = (await scanFiles()).find((x) => x.id === nativeId);
    if (!f) throw new Error(`pi session ${nativeId} not found`);
    return new PiSession({ nativeId, projectPath: f.cwd, title: await titleOf(f), createdAt: f.createdAt, sessionFile: f.path }, sink);
  },

  async listModels(live) {
    if (live instanceof PiSession) {
      const d = await live.models();
      modelCache = { at: Date.now(), data: d };
      return { ...d, permissionModes: [] };
    }
    if (!modelCache || Date.now() - modelCache.at > 10 * 60_000) {
      // A short-lived process just to read the model list.
      const rpc = new PiRpc(homedir(), ["--no-session"]);
      try {
        const [m, t] = await Promise.all([rpc.call("get_available_models"), rpc.call("get_available_thinking_levels")]);
        modelCache = {
          at: Date.now(),
          data: { models: (m.models ?? []).map((x: any) => ({ id: `${x.provider}/${x.id}`, label: x.name })), thinkingLevels: t.levels ?? [] },
        };
      } finally {
        rpc.close();
      }
    }
    return { ...modelCache.data, permissionModes: [] };
  },
};
