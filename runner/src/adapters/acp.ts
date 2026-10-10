// Any agent that speaks ACP (Agent Client Protocol, agentclientprotocol.com) over stdio:
// opencode (`opencode acp`) and Kiro CLI (`kiro-cli acp`) today; Gemini CLI, Codex adapters and
// others plug in with one more spec. We advertise no fs/terminal client capabilities, so the agent
// uses its own tools on the runner's disk.

import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import { homedir } from "node:os";
import type { HarnessId, ModelRef, Msg, Part, SessionSummary } from "../../../web/src/shared/protocol";
import { findTool } from "../../../web/src/shared/reducer";
import { acpUsage } from "../context";
import { LiveSession, newId } from "../session";
import type { Adapter, CreateOpts, Sink, StoredProject } from "./types";

const SEARCH_SINK: Sink = { emit() {}, summary() {}, async handoff() {} };

export interface AcpSpec {
  id: HarnessId;
  bin: string;
  args: string[];
  env?: Record<string, string>;
}

// ---------------- connection ----------------

class AcpProcess {
  proc: ReturnType<typeof Bun.spawn>;
  conn: ClientSideConnection;
  stderr = "";
  exited: Promise<number>;
  caps: any = {};
  handlers = new Map<string, (n: SessionNotification) => void>();
  permission?: (r: RequestPermissionRequest) => Promise<RequestPermissionResponse>;

  constructor(spec: AcpSpec, cwd: string) {
    const proc = Bun.spawn([spec.bin, ...spec.args], {
      cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...spec.env },
    });
    this.proc = proc;
    const sink = proc.stdin as import("bun").FileSink;
    const output = new WritableStream<Uint8Array>({
      write(chunk) {
        sink.write(chunk);
        sink.flush();
      },
      close() {
        sink.end();
      },
    });
    const client: Client = {
      sessionUpdate: (n) => this.handlers.get(n.sessionId)?.(n),
      requestPermission: (r) => (this.permission ? this.permission(r) : { outcome: { outcome: "cancelled" } }),
    };
    this.conn = new ClientSideConnection(() => client, ndJsonStream(output, proc.stdout as ReadableStream<Uint8Array>));
    (async () => {
      const dec = new TextDecoder();
      for await (const c of proc.stderr as ReadableStream<Uint8Array>) this.stderr = (this.stderr + dec.decode(c)).slice(-8000);
    })();
    this.exited = proc.exited;
  }

  async init() {
    const r = await withTimeout(
      this.conn.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "tether", version: "0.1.0" },
      }),
      30_000,
      () => `agent did not answer initialize: ${this.stderr.slice(-400)}`,
    );
    this.caps = r.agentCapabilities ?? {};
    return r;
  }

  kill() {
    try {
      (this.proc.stdin as import("bun").FileSink).end();
    } catch {}
    setTimeout(() => this.proc.kill(), 3_000);
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, msg: () => string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(msg())), ms))]);
}

function errText(e: any): string {
  return [e?.message, e?.data?.message ?? (typeof e?.data === "string" ? e.data : e?.data ? JSON.stringify(e.data) : "")].filter(Boolean).join(": ");
}

function contentText(c: any): string {
  if (!c) return "";
  if (c.type === "text") return c.text;
  if (c.type === "resource") return c.resource?.text ?? "";
  if (c.type === "resource_link") return c.uri;
  if (c.type === "image") return "[image]";
  return "";
}

/** The model / thinking option among ACP config options (by category, else by id). */
function configOption(opts: any[] | undefined, kind: "model" | "thought"): any {
  const re = kind === "model" ? /^model$/i : /effort|thought|reason|think/i;
  return (opts ?? []).find((o) => o.type === "select" && (o.category === (kind === "model" ? "model" : "thought_level") || re.test(o.id)));
}

function selectValues(o: any): { value: string; name: string }[] {
  const out: { value: string; name: string }[] = [];
  for (const x of o?.options ?? []) {
    if (Array.isArray(x.options)) out.push(...x.options);
    else out.push(x);
  }
  return out;
}

const KIND_NAMES: Record<string, string> = {
  execute: "bash",
  edit: "edit",
  read: "read",
  search: "search",
  fetch: "fetch",
  delete: "delete",
  move: "move",
  think: "think",
};

// ---------------- live session ----------------

class AcpSession extends LiveSession {
  private p!: AcpProcess;
  private configOptions: any[] = [];
  private modeIds: string[] = [];
  private commands: { name: string; description?: string }[] = [];
  private curMsg?: { id: string; role: "user" | "assistant"; messageId?: string | null };
  private loadingHistory = false;

  constructor(
    private spec: AcpSpec,
    init: { nativeId: string; projectPath: string; title?: string; createdAt?: number },
    sink: Sink,
    private opts: CreateOpts & { resume?: boolean } = {},
  ) {
    super(spec.id, init, sink);
  }

  async start() {
    this.p = new AcpProcess(this.spec, this.projectPath);
    this.p.exited.then((code) => {
      if (!this.closed) {
        this.notice(`${this.spec.id} exited (code ${code}). ${this.p.stderr.trim().split("\n").slice(-3).join("\n")}`, "error");
        this.setState({ status: "idle" });
        this.close();
      }
    });
    this.p.permission = (r) => this.onPermission(r);
    await this.p.init();
    let res: any;
    if (this.opts.resume) {
      this.p.handlers.set(this.nativeId, (n) => this.onUpdate(n));
      this.loadingHistory = true;
      this.emit({ type: "reset", messages: [] });
      res = await this.p.conn.loadSession({ sessionId: this.nativeId, cwd: this.projectPath, mcpServers: [] });
      this.loadingHistory = false;
      this.finishStreaming();
      for (const m of this.t.messages) for (const part of m.parts) if (part.type === "tool" && part.status === "running") part.status = "error";
    } else {
      res = await this.p.conn.newSession({ cwd: this.projectPath, mcpServers: [] });
      this.nativeId = res.sessionId;
      this.p.handlers.set(this.nativeId, (n) => this.onUpdate(n));
    }
    this.applyConfig(res?.configOptions);
    if (res?.modes) {
      this.modeIds = res.modes.availableModes.map((m: any) => m.id);
      this.setState({ modes: this.modeIds, permissionMode: res.modes.currentModeId });
    }
    this.setState({ status: "idle" });
    if (this.opts.model) await this.applyModel(this.opts.model).catch((e) => this.notice(`Could not set model: ${e.message}`, "warning"));
    if (this.opts.permissionMode && this.modeIds.includes(this.opts.permissionMode)) await this.setPermissionMode(this.opts.permissionMode);
  }

  private applyConfig(opts: any[] | null | undefined) {
    if (!opts) return;
    this.configOptions = opts;
    const model = configOption(opts, "model");
    const thought = configOption(opts, "thought");
    this.setState({
      model: model?.currentValue,
      thinking: thought?.currentValue,
      thinkingLevels: thought ? selectValues(thought).map((v) => v.value) : undefined,
    });
  }

  // ---- transcript building from session/update ----

  private current(role: "user" | "assistant", messageId?: string | null): Msg {
    const cur = this.curMsg;
    const last = cur && this.t.messages.find((m) => m.id === cur.id);
    if (last && cur!.role === role && (!messageId || !cur!.messageId || cur!.messageId === messageId)) return last;
    this.finishStreaming();
    const msg: Msg = { id: newId(role[0]!), role, parts: [], ts: Date.now(), streaming: role === "assistant" && !this.loadingHistory, model: role === "assistant" ? this.t.state.model : undefined };
    this.curMsg = { id: msg.id, role, messageId };
    this.emit({ type: "msg", msg });
    return msg;
  }

  private finishStreaming() {
    const cur = this.curMsg;
    const m = cur && this.t.messages.find((x) => x.id === cur.id);
    if (m?.streaming) this.emit({ type: "msg", msg: { ...m, streaming: false } });
  }

  private appendText(role: "user" | "assistant", kind: "text" | "thinking", text: string, messageId?: string | null) {
    if (!text) return;
    const m = this.current(role, messageId);
    const lastIdx = m.parts.length - 1;
    const last = m.parts[lastIdx];
    if (last && last.type === kind) this.emit({ type: "delta", msgId: m.id, part: lastIdx, kind, text });
    else this.emit({ type: "msg", msg: { ...m, parts: [...m.parts, { type: kind, text }] } });
  }

  private toolPatch(u: any): Partial<Extract<Part, { type: "tool" }>> {
    const patch: any = {};
    if (u.status) patch.status = u.status === "completed" ? "done" : u.status === "failed" ? "error" : "running";
    const content: any[] = u.content ?? [];
    const diffs = content.filter((c) => c.type === "diff");
    if (diffs.length) patch.input = { path: diffs[0].path, edits: diffs.map((d) => ({ oldText: d.oldText ?? "", newText: d.newText ?? "" })) };
    const text = content.filter((c) => c.type === "content").map((c) => contentText(c.content)).join("\n");
    if (text) patch.output = text;
    else if (u.rawOutput !== undefined && u.status && u.status !== "in_progress" && u.status !== "pending")
      patch.output = typeof u.rawOutput === "string" ? u.rawOutput : (u.rawOutput?.output ?? JSON.stringify(u.rawOutput, null, 2));
    if (u.rawInput !== undefined && !diffs.length) patch.input = u.rawInput;
    if (u.name) patch.name = u.name;
    return patch;
  }

  private onUpdate(n: SessionNotification) {
    const u: any = n.update;
    switch (u.sessionUpdate) {
      case "user_message_chunk":
        // Our own prompts are added when sent; only history replay needs these.
        if (this.loadingHistory) this.appendText("user", "text", contentText(u.content), u.messageId);
        break;
      case "agent_message_chunk":
        this.appendText("assistant", "text", contentText(u.content), u.messageId);
        break;
      case "agent_thought_chunk":
        this.appendText("assistant", "thinking", contentText(u.content), u.messageId);
        break;
      case "tool_call": {
        const m = this.current("assistant");
        const tool: Part = {
          type: "tool",
          id: u.toolCallId,
          name: u.name || KIND_NAMES[u.kind] || u.title || "tool",
          input: u.rawInput ?? { description: u.title },
          status: "running",
          ...this.toolPatch(u),
        } as Part;
        if (tool.type === "tool" && !u.status) tool.status = "running";
        this.emit({ type: "msg", msg: { ...m, parts: [...m.parts, tool] } });
        break;
      }
      case "tool_call_update": {
        const hit = findTool(this.t.messages, u.toolCallId);
        if (hit) this.emit({ type: "tool", msgId: hit.msg.id, toolId: u.toolCallId, patch: this.toolPatch(u) });
        break;
      }
      case "plan": {
        const todos = (u.entries ?? []).map((e: any) => ({ content: e.content, status: e.status }));
        const m = this.current("assistant");
        const idx = m.parts.findIndex((p) => p.type === "tool" && p.name === "TodoWrite");
        const part: Part = { type: "tool", id: idx >= 0 ? (m.parts[idx] as any).id : newId("plan"), name: "TodoWrite", input: { todos }, status: "done" };
        const parts = [...m.parts];
        if (idx >= 0) parts[idx] = part;
        else parts.push(part);
        this.emit({ type: "msg", msg: { ...m, parts } });
        break;
      }
      case "current_mode_update":
        this.setState({ permissionMode: u.currentModeId });
        break;
      case "config_option_update":
        this.applyConfig(u.configOptions);
        break;
      case "session_info_update":
        if (u.title) this.setTitle(u.title);
        break;
      case "usage_update":
        this.setContext(acpUsage(u, this.t.state.model));
        if (u.cost?.amount != null) this.setState({ cost: u.cost.amount });
        break;
      case "available_commands_update":
        this.commands = (u.availableCommands ?? []).map((c: any) => ({ name: c.name, description: c.description }));
        break;
      case "notice":
        if (!this.loadingHistory) this.emit({ type: "toast", level: u.severity === "error" ? "error" : u.severity === "warning" ? "warning" : "info", text: [u.title, u.description].filter(Boolean).join(": ") });
        break;
    }
  }

  private async onPermission(r: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const tc: any = r.toolCall;
    const name = tc?.name || KIND_NAMES[tc?.kind] || tc?.title || "tool";
    const v = await this.checkTool(name, tc?.rawInput ?? {}, tc?.toolCallId);
    const want = v.allow ? (v.always ? ["allow_always", "allow_once"] : ["allow_once", "allow_always"]) : ["reject_once", "reject_always"];
    const opt = want.map((k) => r.options.find((o) => o.kind === k)).find(Boolean);
    return opt ? { outcome: { outcome: "selected", optionId: opt.optionId } } : { outcome: { outcome: "cancelled" } };
  }

  // ---- turns ----

  // ACP has no steering: steers wait for the end of the turn like queued messages.
  protected async send(text: string) {
    if (await this.preferBest(text)) return;
    this.addUserMessage(text);
    if (this.title === "New session") this.setTitle(text.replace(/\s+/g, " ").slice(0, 120));
    this.runTurn(text);
  }

  private async runTurn(text: string): Promise<void> {
    this.curMsg = undefined;
    this.setState({ status: "running" });
    try {
      const r = await this.p.conn.prompt({ sessionId: this.nativeId, prompt: [{ type: "text", text }] });
      this.finishStreaming();
      if (r.stopReason === "refusal") this.notice("The agent refused this request.", "warning");
      this.turnSucceeded();
    } catch (e: any) {
      this.finishStreaming();
      const msg = errText(e);
      if (await this.handleTurnError(msg)) return;
      this.notice(msg || "The turn failed.", "error");
    }
    if (await this.drainPending()) return;
    this.setState({ status: "idle" });
  }

  async continueTurn(text = "Continue where you left off.") {
    this.addUserMessage(text.length > 300 ? text.slice(0, 300) + "…" : text);
    this.runTurn(text);
  }

  async abort() {
    if (this.cancelWait()) return;
    this.cancelAllUi();
    await this.p.conn.cancel({ sessionId: this.nativeId });
  }

  async applyModel(model: string) {
    const opt = configOption(this.configOptions, "model");
    if (!opt) throw new Error(`${this.spec.id} does not offer model selection over ACP`);
    const r: any = await this.p.conn.setSessionConfigOption({ sessionId: this.nativeId, configId: opt.id, value: model } as any);
    this.applyConfig(r?.configOptions);
    this.setState({ model });
  }

  async setThinking(level: string) {
    const opt = configOption(this.configOptions, "thought");
    if (!opt) throw new Error("No thinking level option");
    const r: any = await this.p.conn.setSessionConfigOption({ sessionId: this.nativeId, configId: opt.id, value: level } as any);
    this.applyConfig(r?.configOptions);
  }

  async setPermissionMode(mode: string) {
    await this.p.conn.setSessionMode({ sessionId: this.nativeId, modeId: mode });
    this.setState({ permissionMode: mode });
  }

  async rename(title: string) {
    this.setTitle(title);
  }

  async listCommands() {
    return this.commands;
  }

  models(): { models: ModelRef[]; thinkingLevels: string[] } {
    const m = configOption(this.configOptions, "model");
    const t = configOption(this.configOptions, "thought");
    return {
      models: selectValues(m).map((v) => ({ id: v.value, label: v.name })),
      thinkingLevels: t ? selectValues(t).map((v) => v.value) : [],
    };
  }

  protected shutdown() {
    this.p?.kill();
  }
}

// ---------------- adapter ----------------

export function acpAdapter(spec: AcpSpec): Adapter {
  let listCache: { at: number; sessions: { sessionId: string; cwd: string; title?: string | null; updatedAt?: string | null }[] } | undefined;
  let modelCache: { models: ModelRef[]; thinkingLevels: string[]; modes: string[] } | undefined;

  /** One short-lived agent process to list sessions (and learn models). */
  async function catalog() {
    if (listCache && Date.now() - listCache.at < 20_000) return listCache.sessions;
    const p = new AcpProcess(spec, homedir());
    try {
      await p.init();
      const sessions: any[] = [];
      if (p.caps?.sessionCapabilities?.list) {
        let cursor: string | undefined;
        for (let i = 0; i < 20; i++) {
          const r = await withTimeout(p.conn.listSessions({ cursor } as any), 20_000, () => "session/list timed out");
          sessions.push(...r.sessions);
          if (!r.nextCursor) break;
          cursor = r.nextCursor;
        }
      }
      listCache = { at: Date.now(), sessions };
      return sessions;
    } catch {
      listCache = { at: Date.now(), sessions: [] };
      return [];
    } finally {
      p.kill();
    }
  }

  return {
    id: spec.id,

    async available() {
      return !!Bun.which(spec.bin);
    },

    async listProjects(): Promise<StoredProject[]> {
      if (!Bun.which(spec.bin)) return [];
      const by = new Map<string, StoredProject>();
      for (const s of await catalog()) {
        const p = by.get(s.cwd) ?? { path: s.cwd, updatedAt: 0, count: 0 };
        p.count++;
        p.updatedAt = Math.max(p.updatedAt, s.updatedAt ? Date.parse(s.updatedAt) : 0);
        by.set(s.cwd, p);
      }
      return [...by.values()];
    },

    async listSessions(projectPath: string): Promise<SessionSummary[]> {
      if (!Bun.which(spec.bin)) return [];
      return (await catalog())
        .filter((s) => s.cwd === projectPath)
        .map((s) => {
          const t = s.updatedAt ? Date.parse(s.updatedAt) : 0;
          return {
            id: `${spec.id}:${s.sessionId}`,
            harness: spec.id,
            nativeId: s.sessionId,
            projectPath,
            title: s.title || "Untitled",
            createdAt: t,
            updatedAt: t,
            live: false,
            status: "idle" as const,
          };
        });
    },

    async readHistory(nativeId: string, projectPath: string): Promise<Msg[]> {
      const session = new AcpSession(spec, { nativeId, projectPath }, SEARCH_SINK, { resume: true });
      try {
        await session.start();
        return session.t.messages;
      } finally {
        session.close();
      }
    },

    create(projectPath, opts, sink) {
      listCache = undefined;
      return new AcpSession(spec, { nativeId: "pending-" + newId(""), projectPath }, sink, opts);
    },

    async resume(nativeId, projectPath, sink) {
      const s = (await catalog()).find((x) => x.sessionId === nativeId);
      return new AcpSession(spec, { nativeId, projectPath, title: s?.title ?? undefined }, sink, { resume: true });
    },

    async listModels(live) {
      if (live instanceof AcpSession) {
        const m = live.models();
        modelCache = { ...m, modes: live.t.state.modes ?? [] };
      }
      if (!modelCache && Bun.which(spec.bin)) {
        // Learn the model list from a throwaway session in the home directory.
        const p = new AcpProcess(spec, homedir());
        try {
          await p.init();
          const r: any = await withTimeout(p.conn.newSession({ cwd: homedir(), mcpServers: [] }), 30_000, () => "session/new timed out");
          const m = configOption(r.configOptions, "model");
          const t = configOption(r.configOptions, "thought");
          modelCache = {
            models: selectValues(m).map((v) => ({ id: v.value, label: v.name })),
            thinkingLevels: t ? selectValues(t).map((v) => v.value) : [],
            modes: (r.modes?.availableModes ?? []).map((x: any) => x.id),
          };
        } catch {
          modelCache = { models: [], thinkingLevels: [], modes: [] };
        } finally {
          p.kill();
        }
      }
      return { models: modelCache?.models ?? [], thinkingLevels: modelCache?.thinkingLevels ?? [], permissionModes: modelCache?.modes ?? [] };
    },
  };
}

export const opencodeAdapter = acpAdapter({
  id: "opencode",
  bin: process.env.OPENCODE_BIN ?? "opencode",
  args: ["acp"],
});

// Kiro CLI V3 engine: model/effort through session config options, CLI-side auth.
export const kiroAdapter = acpAdapter({
  id: "kiro",
  bin: process.env.KIRO_BIN ?? "kiro-cli",
  args: (process.env.KIRO_ACP_ARGS ?? "acp --agent-engine=v3 --auth-method=cli").split(" "),
});
