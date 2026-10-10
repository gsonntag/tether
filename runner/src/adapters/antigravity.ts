// Google Antigravity CLI (`agy`). It has no ACP or server mode; this uses its documented headless
// stream-json mode (antigravity.google/docs/cli/headless): one persistent process per session,
// user turns as `{"event":"user","message":{"content":...}}` lines on stdin, NDJSON events out
// (`init`, `step_update`, `result`). Headless agy can't ask for permission interactively: tools
// that need approval are soft-denied unless pre-approved in its settings or the session runs in
// bypassPermissions (--dangerously-skip-permissions). It also has no session list API, so the
// runner records the conversations it starts.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelRef, Msg, SessionSummary } from "../../../web/src/shared/protocol";
import { findTool } from "../../../web/src/shared/reducer";
import { config, saveConfigSoon } from "../config";
import { agyUsage } from "../contextWindow";
import { LiveSession, newId } from "../session";
import { sessionContext, withPreamble } from "../context/inject";
import type { Adapter, CreateOpts, Sink, StoredProject } from "./types";

const AGY_BIN = process.env.AGY_BIN ?? "agy";
const MODES = ["default", "bypassPermissions"];
const EFFORT = ["low", "medium", "high"];

interface AgyRecord {
  /** Tether's stable id for the session */
  id: string;
  /** agy's conversation id, known after the first turn */
  convId?: string;
  cwd: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** User messages recorded by Tether; Antigravity itself doesn't expose transcript history. */
  userMessages?: { text: string; ts: number }[];
}

function records(): AgyRecord[] {
  const c = config() as any;
  return (c.antigravity ??= []);
}

function remember(r: AgyRecord) {
  const list = records();
  const i = list.findIndex((x) => x.id === r.id);
  if (i >= 0) list[i] = { ...list[i]!, ...r };
  else list.push(r);
  saveConfigSoon();
}

class AgySession extends LiveSession {
  private proc?: ReturnType<typeof Bun.spawn>;
  private model?: string;
  private effort?: string;
  private mode: string;
  private msgId?: string;
  private stepPart = new Map<number, number>(); // step_index -> part index
  private convId?: string;
  /** shared memory, sent ahead of the first message of a new conversation */
  private preamble?: string;

  constructor(init: { nativeId: string; projectPath: string; title?: string; createdAt?: number }, sink: Sink, opts: CreateOpts & { resume?: boolean } = {}) {
    super("antigravity", init, sink);
    this.convId = records().find((r) => r.id === init.nativeId)?.convId;
    this.model = opts.model && opts.model !== "default" ? opts.model : undefined;
    this.mode = opts.permissionMode === "bypassPermissions" ? "bypassPermissions" : "default";
  }

  addUserMessage(text: string, id?: string) {
    super.addUserMessage(text, id);
    const record = records().find((r) => r.id === this.nativeId);
    if (!record) return;
    record.userMessages = [...(record.userMessages ?? []), { text, ts: Date.now() }].slice(-500);
    saveConfigSoon();
  }

  private spawn() {
    const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json"];
    if (this.convId) args.push("--conversation", this.convId);
    if (this.model) args.push("--model", this.model);
    if (this.effort) args.push("--effort", this.effort);
    // Guard: "full" skips approvals; "auto" fences commands in agy's sandbox (project read-write,
    // no network, secrets hidden) and lets the guard decide each call through the PreToolUse
    // hook; "ask"/"edits" send each call to a person through the same hook.
    const guard = this.guardMode;
    if (guard === "full" || this.mode === "bypassPermissions") args.push("--dangerously-skip-permissions");
    if (guard === "auto") args.push("--sandbox");
    const proc = Bun.spawn([AGY_BIN, ...args], {
      cwd: this.projectPath,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...this.guardEnv },
    });
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
          try {
            this.onEvent(JSON.parse(line));
          } catch {}
        }
      }
    })();
    let stderr = "";
    (async () => {
      const dec = new TextDecoder();
      for await (const c of proc.stderr as ReadableStream<Uint8Array>) stderr = (stderr + dec.decode(c)).slice(-4000);
    })();
    proc.exited.then((code) => {
      if (this.proc !== proc || this.closed) return;
      this.proc = undefined;
      if (this.t.state.status === "running") {
        this.notice(`agy exited (code ${code}). ${stderr.trim().split("\n").slice(-3).join("\n")}`, "error");
        this.setState({ status: "idle" });
      }
    });
  }

  protected onGuardChanged = () => this.restart();

  async start() {
    if (!agyHookInstalled()) this.notice("The Tether guard hook isn't installed for Antigravity, so the guard can't approve its tool calls: in headless mode anything that needs approval is skipped. Install it in Settings → Guard.", "warning");
    this.setState({
      status: "idle",
      model: this.model ?? "default",
      modes: MODES,
      permissionMode: this.mode,
      thinkingLevels: EFFORT,
    });
    if (!records().some((r) => r.id === this.nativeId)) this.save();
    // Master context: shared memory goes ahead of the first message of a new conversation.
    if (!this.convId) this.preamble = (await sessionContext(this.projectPath))?.prompt;
    if (this.convId) this.notice("Antigravity has no history API: earlier turns of this conversation are not shown, but the agent remembers them.");
  }

  private onEvent(raw: any) {
    // Payloads are nested under their event name: {"event":"step_update","step_update":{...}}.
    const kind = raw.event ?? raw.type;
    const e = (kind && raw[kind] && typeof raw[kind] === "object" ? { ...raw, ...raw[kind] } : raw) as any;
    switch (kind) {
      case "init":
        if (e.model) this.setState({ model: e.model });
        break;
      case "step_update": {
        if (e.conversation_id && !this.convId) this.adopt(e.conversation_id);
        if (e.step_type === "user_input" || e.step_type === "checkpoint") break;
        const msg = this.ensureMsg();
        const idx = this.stepPart.get(e.step_index);
        if (e.usage) this.setContext(agyUsage(e.usage, this.t.state.model));
        if (e.step_type === "agent_response") {
          if (idx === undefined) {
            this.stepPart.set(e.step_index, msg.parts.length);
            this.emit({ type: "msg", msg: { ...msg, parts: [...msg.parts, { type: "text", text: e.text_delta ?? "" }] } });
          } else if (e.text_delta) this.emit({ type: "delta", msgId: msg.id, part: idx, kind: "text", text: e.text_delta });
        } else if (e.step_type === "tool") {
          const toolId = `agy-${e.step_index}`;
          const info = e.tool_info ?? {};
          if (idx === undefined) {
            this.stepPart.set(e.step_index, msg.parts.length);
            this.emit({
              type: "msg",
              msg: { ...msg, parts: [...msg.parts, { type: "tool", id: toolId, name: e.tool_name ?? "tool", input: info.parameters ?? info.input ?? {}, status: "running" }] },
            });
          }
          if (e.state === "DONE") {
            const hit = findTool(this.t.messages, toolId);
            if (hit)
              this.emit({
                type: "tool",
                msgId: hit.msg.id,
                toolId,
                patch: {
                  status: info.error ? "error" : "done",
                  output: info.error?.message ?? (typeof info.output === "string" ? info.output : info.output ? JSON.stringify(info.output, null, 2) : undefined),
                  ...(info.parameters ? { input: info.parameters } : {}),
                },
              });
          }
        }
        break;
      }
      case "result":
        this.onResult(e);
        break;
    }
  }

  private ensureMsg() {
    const cur = this.msgId && this.t.messages.find((m) => m.id === this.msgId);
    if (cur) return cur;
    const msg = { id: newId("a"), role: "assistant" as const, parts: [], ts: Date.now(), model: this.t.state.model, streaming: true };
    this.msgId = msg.id;
    this.stepPart.clear();
    this.emit({ type: "msg", msg });
    return msg;
  }

  private adopt(convId: string) {
    this.convId = convId;
    this.save();
  }

  private save() {
    remember({ id: this.nativeId, convId: this.convId, cwd: this.projectPath, title: this.title, createdAt: this.createdAt, updatedAt: Date.now() });
  }

  private async onResult(e: any) {
    if (e.conversation_id && !this.convId) this.adopt(e.conversation_id);
    const m = this.msgId && this.t.messages.find((x) => x.id === this.msgId);
    if (m) this.emit({ type: "msg", msg: { ...m, streaming: false, error: e.status === "ERROR" ? (e.error ?? "error") : undefined } });
    this.msgId = undefined;
    this.save();
    if (e.status === "ERROR" && (await this.handleTurnError(String(e.error ?? "")))) return;
    if (e.status !== "ERROR") this.turnSucceeded();
    if (await this.drainPending()) return;
    this.setState({ status: "idle" });
  }

  private write(text: string, show: boolean) {
    if (show) this.addUserMessage(text);
    if (!this.proc) this.spawn();
    const sink = this.proc!.stdin as import("bun").FileSink;
    const content = withPreamble(this.preamble, text);
    this.preamble = undefined;
    sink.write(JSON.stringify({ event: "user", message: { content } }) + "\n");
    sink.flush();
    this.setState({ status: "running" });
  }

  // Headless agy has no steering: steers wait for the end of the turn like queued messages.
  protected async send(text: string) {
    if (await this.preferBest(text)) return;
    this.autoTitle(text);
    this.write(text, true);
  }

  async continueTurn(text = "Continue where you left off.") {
    this.write(text, false);
  }

  /** Settings are process flags: restart the process (the conversation id keeps the context). */
  private restart() {
    const p = this.proc;
    this.proc = undefined;
    p?.kill();
  }

  async abort() {
    if (this.cancelWait()) return;
    this.restart();
    this.setState({ status: "idle" });
  }

  async applyModel(model: string) {
    this.model = model === "default" ? undefined : model;
    this.restart();
    this.setState({ model });
  }

  async setThinking(level: string) {
    this.effort = level;
    this.restart();
    this.setState({ thinking: level });
  }

  async setPermissionMode(mode: string) {
    this.mode = mode;
    this.restart();
    this.setState({ permissionMode: mode });
  }

  async rename(title: string) {
    this.setTitle(title);
    this.save();
  }

  async listCommands() {
    return [];
  }

  /** Headless agy has no way to run a skill by name: every skill is expanded into the message. */
  protected async nativeSkills() {
    return [];
  }

  protected shutdown() {
    this.proc?.kill();
  }
}

let modelCache: ModelRef[] | undefined;

// ---------------- guard hook installation ----------------

const HOOKS_FILE = join(homedir(), ".gemini", "config", "hooks.json");
const HOOK_SCRIPT = fileURLToPath(new URL("../../hooks/agy-guard.ts", import.meta.url));
const HOOK_NAME = "tether-guard";

export function agyHookInstalled(): boolean {
  try {
    return !!JSON.parse(readFileSync(HOOKS_FILE, "utf8"))[HOOK_NAME];
  } catch {
    return false;
  }
}

/** Adds the Tether PreToolUse hook to Antigravity's global hooks file (other hooks are kept). */
export function installAgyHook() {
  let hooks: any = {};
  try {
    hooks = JSON.parse(readFileSync(HOOKS_FILE, "utf8"));
  } catch {}
  hooks[HOOK_NAME] = {
    PreToolUse: [{ matcher: "", hooks: [{ type: "command", command: `${process.execPath} ${HOOK_SCRIPT}`, timeout: 900 }] }],
  };
  mkdirSync(dirname(HOOKS_FILE), { recursive: true });
  writeFileSync(HOOKS_FILE, JSON.stringify(hooks, null, 2));
}

export const antigravityAdapter: Adapter = {
  id: "antigravity",

  async available() {
    return !!Bun.which(AGY_BIN);
  },

  async listProjects(): Promise<StoredProject[]> {
    const by = new Map<string, StoredProject>();
    for (const r of records()) {
      const p = by.get(r.cwd) ?? { path: r.cwd, updatedAt: 0, count: 0 };
      p.count++;
      p.updatedAt = Math.max(p.updatedAt, r.updatedAt);
      by.set(r.cwd, p);
    }
    return [...by.values()];
  },

  async listSessions(projectPath: string): Promise<SessionSummary[]> {
    return records()
      .filter((r) => r.cwd === projectPath)
      .map((r) => ({
        id: `antigravity:${r.id}`,
        harness: "antigravity" as const,
        nativeId: r.id,
        projectPath,
        title: r.title,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        live: false,
        status: "idle" as const,
      }));
  },

  async readHistory(nativeId: string, _projectPath: string): Promise<Msg[]> {
    const record = records().find((r) => r.id === nativeId);
    return (record?.userMessages ?? []).map((message, i): Msg => ({
      id: `agy-search-${i}`,
      role: "user",
      parts: [{ type: "text", text: message.text }],
      ts: message.ts,
    }));
  },

  create(projectPath, opts, sink) {
    return new AgySession({ nativeId: crypto.randomUUID(), projectPath }, sink, opts);
  },

  async resume(nativeId, projectPath, sink) {
    const r = records().find((x) => x.id === nativeId);
    return new AgySession({ nativeId, projectPath: r?.cwd ?? projectPath, title: r?.title, createdAt: r?.createdAt }, sink, { resume: true });
  },

  async listModels() {
    if (!modelCache && Bun.which(AGY_BIN)) {
      try {
        const p = Bun.spawn([AGY_BIN, "models"], { stdout: "pipe", stderr: "ignore" });
        const out = await new Response(p.stdout).text();
        modelCache = out
          .split("\n")
          .map((l) => l.trim().split(/\s+/)[0] ?? "")
          .filter((x) => x && /^[a-z0-9][\w.-]*$/i.test(x))
          .map((id) => ({ id }));
      } catch {
        modelCache = [];
      }
    }
    return { models: [{ id: "default" }, ...(modelCache ?? [])], thinkingLevels: EFFORT, permissionModes: MODES };
  },
};
