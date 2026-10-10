// Google Antigravity CLI (`agy`). It has no ACP or server mode; this drives its headless stream-json
// mode: one process per session, user turns as `{"event":"user","message":{"content":…}}` lines on
// stdin, NDJSON events out (wire formats and the event translation are in ./agy.ts).
//
// Approvals: headless agy can't ask, so it runs with --dangerously-skip-permissions and a
// PreToolUse hook (runner/hooks/agy-guard.ts) sends every call to the Tether guard. The hook is
// passed per process: `--add-dir` of a runner-owned folder whose .agents/hooks.json names it, so
// nothing is written into ~/.gemini and agy runs started outside Tether are untouched.
//
// agy has no session list API, so the runner records the conversations it starts; their history
// comes from agy's transcript file (thinking, tool calls and results included).

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelRef, Msg, SessionSummary } from "../../../web/src/shared/protocol";
import { findPlan } from "../../../web/src/shared/reducer";
import { CONFIG_DIR, config, saveConfigSoon } from "../config";
import { agyUsage, knownWindow } from "../contextWindow";
import { kindOf } from "../guard";
import { attachmentsDir } from "../attachments";
import { LiveSession, newId } from "../session";
import { sessionContext, withPreamble } from "../context/inject";
import { AGY_MODES, AgyStream, APPROVING_MODES, cleanArgs, DEFAULT_EFFORT, effortOf, hookConfig, HookWatch, parseModels, planArtifact, planId, sessionMode, spawnArgs, transcriptPath, transcriptToMessages } from "./agy";
import type { Adapter, CreateOpts, Sink, StoredProject } from "./types";

const AGY_BIN = process.env.AGY_BIN ?? "agy";
const MODES = [...AGY_MODES];
/** agy's terminal sandbox (`--sandbox`). Off by default: where its sandbox server can't start, every command fails once and the agent retries it with BypassSandbox. */
const SANDBOX = process.env.AGY_SANDBOX === "1";

interface AgyRecord {
  /** Tether's stable id for the session */
  id: string;
  /** agy's conversation id, known once the process started */
  convId?: string;
  cwd: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  model?: string;
  effort?: string;
  mode?: string;
  /** User messages recorded by Tether, for search before agy wrote a transcript. */
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

// ---------------- the guard hook, passed per process ----------------

const HOOK_SCRIPT = fileURLToPath(new URL("../../hooks/agy-guard.ts", import.meta.url));
/** Runner-owned folder agy is pointed at with --add-dir; it only holds the hook config. */
export const HOOK_DIR = join(CONFIG_DIR, "antigravity-hook");
/** Unguessable, so a hook in the project's own .agents/hooks.json can't override this one by name. */
const HOOK_NAME = `tether-guard-${randomBytes(8).toString("hex")}`;

/** Writes a read-only file in a read-only folder: agy has the hook folder in its workspace. */
function writeLocked(path: string, text: string) {
  const dir = dirname(path);
  try {
    if (readFileSync(path, "utf8") === text) return;
  } catch {}
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o755);
  try {
    chmodSync(path, 0o644);
  } catch {}
  writeFileSync(path, text);
  chmodSync(path, 0o444);
  chmodSync(dir, 0o555);
}

/** Writes the hook folder before each process starts (idempotent; repairs it if it was changed). */
export function ensureHookDir(): string {
  writeLocked(join(HOOK_DIR, ".agents", "hooks.json"), JSON.stringify(hookConfig(HOOK_NAME, process.execPath, HOOK_SCRIPT), null, 2) + "\n");
  // agy lists it as a second workspace folder; tell the agent it isn't the project.
  writeLocked(
    join(HOOK_DIR, "AGENTS.md"),
    "This folder only holds Tether's tool-approval hook. It is not the user's project: don't read, change or run commands in it. Work in the other workspace folder.\n",
  );
  return HOOK_DIR;
}

/** The hook ships with the runner; there is nothing to install. */
export function agyHookInstalled(): boolean {
  return existsSync(HOOK_SCRIPT);
}

const inside = (p: string, dir: string) => p === dir || p.startsWith(dir.replace(/\/$/, "") + "/");
const pathArg = (a: any): string | undefined => {
  const p = a?.TargetFile ?? a?.AbsolutePath ?? a?.DirectoryPath ?? a?.SearchPath ?? a?.path;
  return typeof p === "string" ? p : undefined;
};

// ---------------- models ----------------

let modelCache: ModelRef[] | undefined;
let modelLoad: Promise<ModelRef[]> | undefined;

function loadModels(): Promise<ModelRef[]> {
  if (modelCache) return Promise.resolve(modelCache);
  return (modelLoad ??= (async () => {
    try {
      if (!Bun.which(AGY_BIN)) return [];
      const p = Bun.spawn([AGY_BIN, "models"], { stdout: "pipe", stderr: "ignore", stdin: "ignore", timeout: 30_000 });
      const list = parseModels(await new Response(p.stdout).text());
      if (list.length) modelCache = list;
      return list;
    } catch {
      return [];
    } finally {
      modelLoad = undefined;
    }
  })());
}

// ---------------- session ----------------

class AgySession extends LiveSession {
  private proc?: ReturnType<typeof Bun.spawn>;
  /** the previous process, until it has exited (agy keeps the conversation open until then) */
  private exiting?: Promise<unknown>;
  /** settings are launch flags: the process restarts before the next turn */
  private stale = false;
  /** undefined: agy's default model */
  private model?: string;
  /** only with the default model; other models carry their effort in their id */
  private effort?: string;
  private mode: string;
  private convId?: string;
  /** shared memory, sent ahead of the first message of a new conversation */
  private preamble?: string;
  private stream: AgyStream;
  private models: ModelRef[] = [];
  /** what the hook told us: the default model's real name, the conversation's artifact folder */
  private resolvedModel?: string;
  private artifactDir?: string;
  private transcriptFile?: string;
  private tailOffset = 0;
  private tailTimer?: ReturnType<typeof setInterval>;
  /** plan mode: a plan was written this turn and nothing may change until the person reviews it */
  private planReview?: string;
  private reviewing?: Promise<{ allow: boolean; reason?: string }>;
  /** this turn started with agy's `/plan` command: plan mode for one turn */
  private planTurn = false;
  /** proof that the current process runs the guard hook (see HookWatch) */
  private watch = new HookWatch();
  /** verdicts by `conversation:step`: a second hook (an old global install) asks again for the same call */
  private verdicts = new Map<string, Promise<{ allow: boolean; reason?: string; always?: boolean; overwrite?: Record<string, unknown> }>>();

  constructor(init: { nativeId: string; projectPath: string; title?: string; createdAt?: number; updatedAt?: number }, sink: Sink, opts: CreateOpts = {}) {
    super("antigravity", init, sink);
    const r = records().find((x) => x.id === init.nativeId);
    this.convId = r?.convId;
    const model = opts.model ?? r?.model;
    this.model = model && model !== "default" ? model : undefined;
    this.effort = this.model ? undefined : r?.effort;
    this.mode = sessionMode(opts.permissionMode ?? r?.mode);
    this.stream = new AgyStream({
      emit: (e) => this.emit(e),
      messages: () => this.t.messages,
      model: () => this.t.state.model,
      usage: (u) => this.setContext(this.context(u)),
    });
  }

  /** A request's usage for the context meter. agy's default model is a Gemini one (its window is guessed from that). */
  private context(u: any) {
    const model = this.model ?? this.resolvedModel;
    const c = agyUsage(u, model);
    return c && !model ? { ...c, max: knownWindow("gemini"), maxEstimated: true } : c;
  }

  addUserMessage(text: string, id?: string) {
    super.addUserMessage(text, id);
    const record = records().find((r) => r.id === this.nativeId);
    if (!record) return;
    record.userMessages = [...(record.userMessages ?? []), { text, ts: Date.now() }].slice(-500);
    saveConfigSoon();
  }

  private effortState() {
    const fam = effortOf(this.model, this.models);
    if (fam) return { thinkingLevels: fam.levels, thinking: fam.level };
    if (!this.model) return { thinkingLevels: DEFAULT_EFFORT, thinking: this.effort };
    return { thinkingLevels: [], thinking: undefined };
  }

  async start() {
    this.models = await loadModels();
    if (!records().some((r) => r.id === this.nativeId)) this.save();
    if (this.convId) {
      const file = transcriptPath(this.convId);
      try {
        const bytes = await Bun.file(file).bytes();
        const entries = new TextDecoder()
          .decode(bytes)
          .split("\n")
          .flatMap((l) => {
            try {
              return l ? [JSON.parse(l)] : [];
            } catch {
              return [];
            }
          });
        const h = transcriptToMessages(entries, this.model);
        this.emit({ type: "reset", messages: h.messages });
        if (h.usage) this.setContext(this.context(h.usage));
        this.tailOffset = bytes.length;
      } catch {
        this.notice("Antigravity's transcript for this conversation wasn't found, so earlier turns aren't shown. The agent still remembers them.");
      }
    }
    this.setState({ status: "idle", model: this.model ?? "default", modes: MODES, permissionMode: this.mode, ...this.effortState() });
    // Master context: shared memory goes ahead of the first message of a new conversation.
    if (!this.convId) this.preamble = (await sessionContext(this.projectPath))?.prompt;
  }

  private spawn() {
    mkdirSync(attachmentsDir(), { recursive: true, mode: 0o700 });
    const args = spawnArgs({ convId: this.convId, model: this.model, effort: this.effort, plan: this.mode === "plan", hookDir: ensureHookDir(), sandbox: SANDBOX, readDirs: [attachmentsDir()] });
    const proc = Bun.spawn([AGY_BIN, ...args], {
      cwd: this.projectPath,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...this.guardEnv },
    });
    this.proc = proc;
    this.stale = false;
    this.watch = new HookWatch();
    (async () => {
      const dec = new TextDecoder();
      let buf = "";
      for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
        buf += dec.decode(chunk, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line || this.proc !== proc) continue;
          let ev: any;
          try {
            ev = JSON.parse(line);
          } catch {
            continue;
          }
          void this.onEvent(proc, ev);
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
        this.stopTail();
        this.stream.finish(undefined, "agy exited before this call finished.");
        const why = stderr.trim().split("\n").filter((l) => !l.startsWith("AGY_ERROR")).slice(-3).join("\n");
        this.notice(`agy exited (code ${code}).${why ? ` ${why}` : ""}`, "error");
        this.setState({ status: "idle" });
      }
    });
  }

  private async onEvent(proc: ReturnType<typeof Bun.spawn>, raw: any) {
    const unguarded = this.watch.event(raw);
    if (unguarded) return this.unguarded(proc, unguarded);
    const r = this.stream.event(raw);
    if (r.conversationId && r.conversationId !== this.convId) this.adopt(r.conversationId);
    if (r.result && this.proc === proc) await this.onResult(r.error);
  }

  /** agy is running without the guard: kill it before it does anything else. */
  private unguarded(proc: ReturnType<typeof Bun.spawn>, why: string) {
    if (this.proc !== proc) return;
    this.proc = undefined;
    proc.kill("SIGKILL");
    this.stopTail();
    this.planReview = undefined;
    this.stream.finish("Stopped: Antigravity was running without Tether's guard.", "Stopped: Antigravity was running without Tether's guard.");
    this.notice(
      `Stopped Antigravity: ${why}. Its tool calls weren't being checked, so the session was stopped. Check the project for an .agents/hooks.json (or plugins) that changes hooks, then send a message to start it again.`,
      "error",
    );
    this.alert("blocked", "Antigravity ran without the guard", why);
    this.setState({ status: "idle" });
  }

  private adopt(convId: string) {
    this.convId = convId;
    this.transcriptFile = undefined;
    this.tailOffset = 0;
    this.save();
  }

  private save() {
    remember({
      id: this.nativeId,
      convId: this.convId,
      cwd: this.projectPath,
      title: this.title,
      createdAt: this.createdAt,
      updatedAt: Date.now(),
      model: this.model,
      effort: this.effort,
      mode: this.mode,
    });
  }

  // ---- transcript tail: thinking and full tool results, which the stream leaves out ----

  private async readTail() {
    const file = this.transcriptFile ?? (this.convId ? transcriptPath(this.convId) : undefined);
    if (!file) return;
    try {
      const f = Bun.file(file);
      const size = f.size;
      if (size <= this.tailOffset) return;
      const bytes = new Uint8Array(await f.slice(this.tailOffset, size).arrayBuffer());
      const end = bytes.lastIndexOf(10);
      if (end < 0) return;
      this.tailOffset += end + 1;
      for (const line of new TextDecoder().decode(bytes.subarray(0, end)).split("\n")) {
        if (!line) continue;
        try {
          this.stream.transcript(JSON.parse(line));
        } catch {}
      }
    } catch {}
  }

  private startTail() {
    clearInterval(this.tailTimer);
    this.tailTimer = setInterval(() => void this.readTail(), 700);
  }

  private stopTail() {
    clearInterval(this.tailTimer);
    this.tailTimer = undefined;
  }

  private async onResult(error: string | undefined) {
    this.stopTail();
    // The transcript line for the last step can trail the result event a little.
    await this.readTail();
    await Bun.sleep(150);
    await this.readTail();
    this.planReview = undefined;
    this.save();
    if (error) {
      const hadMsg = !!this.stream.msgId;
      if (await this.handleTurnError(error)) {
        this.stream.finish();
        return;
      }
      this.stream.finish(error);
      if (!hadMsg) this.notice(error, "error");
    } else {
      this.stream.finish();
      this.turnSucceeded();
    }
    if (await this.drainPending()) return;
    this.setState({ status: "idle" });
  }

  private async write(text: string, show: boolean) {
    if (show) this.addUserMessage(text);
    this.planReview = undefined;
    this.planTurn = /^\/plan(\s|$)/.test(text.trimStart());
    if (this.proc && this.stale) this.stopProcess(true);
    await this.exiting;
    if (!this.proc) this.spawn();
    const sink = this.proc!.stdin as import("bun").FileSink;
    const content = withPreamble(this.preamble, text);
    this.preamble = undefined;
    sink.write(JSON.stringify({ event: "user", message: { content } }) + "\n");
    sink.flush();
    this.setState({ status: "running" });
    this.startTail();
  }

  /**
   * Ends the process. Gracefully (idle, settings changed): closing stdin lets agy finish and save.
   * Otherwise SIGINT, which cancels the turn; agy reports it as an "interrupted" result, ignored here.
   */
  private stopProcess(graceful: boolean) {
    const p = this.proc;
    this.proc = undefined;
    if (!p) return;
    if (graceful) (p.stdin as import("bun").FileSink).end();
    else p.kill("SIGINT");
    const t1 = setTimeout(() => p.kill(graceful ? "SIGINT" : "SIGTERM"), graceful ? 5_000 : 3_000);
    const t2 = setTimeout(() => p.kill("SIGKILL"), 10_000);
    const done = p.exited.finally(() => {
      clearTimeout(t1);
      clearTimeout(t2);
      if (this.exiting === done) this.exiting = undefined;
    });
    this.exiting = done;
  }

  // Headless agy has no steering: steers wait for the end of the turn like queued messages.
  protected async send(text: string) {
    if (await this.preferBest(text)) return;
    this.autoTitle(text);
    await this.write(text, true);
  }

  async continueTurn(text = "Continue where you left off.") {
    await this.write(text, false);
  }

  async abort() {
    if (this.cancelWait()) return;
    this.cancelAllUi();
    this.planReview = undefined;
    this.stopTail();
    this.stopProcess(false);
    this.stream.finish(undefined, "Stopped.");
    this.setState({ status: "idle" });
  }

  /** Flags take effect with the next process: right away when idle, else after this turn. */
  private settingsChanged() {
    this.stale = true;
    if (this.proc && this.t.state.status === "idle") this.stopProcess(true);
    this.save();
  }

  async applyModel(model: string) {
    this.model = model === "default" ? undefined : model;
    if (this.model) this.effort = undefined;
    this.settingsChanged();
    this.setState({ model, ...this.effortState() });
  }

  async setThinking(level: string) {
    const fam = effortOf(this.model, this.models);
    if (fam) {
      if (fam.levels.includes(level)) await this.applyModel(`${fam.base}-${level}`);
      return;
    }
    if (this.model) {
      this.notice(`${this.model} has no effort levels in Antigravity.`, "warning");
      return;
    }
    this.effort = level;
    this.settingsChanged();
    this.setState({ thinking: level });
  }

  async setPermissionMode(mode: string) {
    // Approving modes (bypassPermissions, accept-edits) are refused: the guard decides every call.
    if (APPROVING_MODES.includes(mode)) {
      this.notice(`Antigravity's "${mode}" mode would approve tool calls without the guard; staying in ${this.mode} mode. Use the approvals menu (Full) instead.`, "warning");
      return;
    }
    this.mode = sessionMode(mode);
    this.settingsChanged();
    this.setState({ permissionMode: this.mode });
  }

  async rename(title: string) {
    this.setTitle(title);
    this.save();
  }

  /** agy expands slash commands in headless mode too; /plan is the one Tether knows about (plan review). */
  async listCommands() {
    return [{ name: "plan", description: "Plan first: Antigravity writes a plan for you to review before it changes anything" }];
  }

  // ---- guard: every call comes through the PreToolUse hook ----

  gateEvent(event: string, meta: Record<string, unknown>) {
    if (event === "invocation") this.watch.invocation(meta.conversationId);
  }

  async checkTool(tool: string, input: unknown, id?: string, meta?: Record<string, unknown>): Promise<{ allow: boolean; reason?: string; always?: boolean; overwrite?: Record<string, unknown> }> {
    let step = typeof meta?.step === "number" ? meta.step : id?.startsWith("agy-") ? Number(id.slice(4)) : undefined;
    const conv = typeof meta?.conversationId === "string" ? meta.conversationId : undefined;
    if (step !== undefined && Number.isFinite(step)) this.watch.checkedCall(conv, step);
    else step = undefined;
    const key = step !== undefined ? `${conv ?? ""}:${step}:${tool}` : undefined;
    const known = key ? this.verdicts.get(key) : undefined;
    if (known) return known;
    const v = this.decide(tool, input, id, meta, step, conv);
    if (key) {
      this.verdicts.set(key, v);
      if (this.verdicts.size > 200) this.verdicts.delete(this.verdicts.keys().next().value!);
    }
    return v;
  }

  private async decide(tool: string, input: unknown, id: string | undefined, meta: Record<string, unknown> | undefined, step: number | undefined, conv: string | undefined) {
    const args = cleanArgs(input);
    // A subagent's calls come through the same hook with its own conversation and step numbers:
    // they are guarded alike, but its steps, transcript and notes folder aren't this conversation's.
    if (conv && this.convId && conv !== this.convId) {
      step = undefined;
      id = `agy-sub-${conv.slice(0, 8)}-${meta?.step}`;
      meta = undefined;
    }
    if (typeof meta?.artifactDirectoryPath === "string") this.artifactDir = meta.artifactDirectoryPath;
    if (typeof meta?.modelName === "string") this.resolvedModel = meta.modelName;
    if (typeof meta?.transcriptPath === "string" && !this.transcriptFile) this.transcriptFile = meta.transcriptPath;
    const kind = kindOf(tool);
    // The hook folder is a workspace folder to agy: keep the agent out of it.
    let overwrite: Record<string, unknown> | undefined;
    if (typeof args.Cwd === "string" && inside(resolve(args.Cwd), HOOK_DIR)) {
      args.Cwd = this.projectPath;
      overwrite = { Cwd: this.projectPath };
    }
    if (step !== undefined && Number.isFinite(step)) this.stream.toolArgs(step, args);
    const path = pathArg(args);
    if (path && inside(resolve(this.projectPath, path), HOOK_DIR))
      return { allow: false, reason: `That folder only holds Tether's tool-approval hook. Work in the project, ${this.projectPath}.` };
    const plan = planArtifact(tool, input);
    if (plan && step !== undefined) this.stream.plan(step, plan);
    // agy's own notes for this conversation (plans, task lists, walkthroughs) live in its folder.
    if (kind === "edit" && path && this.artifactDir && inside(resolve(path), this.artifactDir)) {
      if (plan && step !== undefined && (this.mode === "plan" || this.planTurn)) this.planReview = planId(step);
      return { allow: true, reason: "Antigravity's notes for this conversation." };
    }
    // Plan mode: headless agy approves its own plan and goes on to implement it. The first call
    // that would change something waits for the person's review instead.
    if (this.planReview && kind !== "read") {
      const r = await (this.reviewing ??= this.reviewPlan(this.planReview).finally(() => (this.reviewing = undefined)));
      if (!r.allow) return r;
    }
    const v = await super.checkTool(tool, args, id);
    return v.allow && overwrite ? { ...v, overwrite } : v;
  }

  private async reviewPlan(plan: string): Promise<{ allow: boolean; reason?: string }> {
    const res = await this.askUi({ id: newId("plan-review"), kind: "plan", title: "Antigravity's plan is ready for review", planId: plan });
    if (res.cancelled) return { allow: false, reason: "The plan review was cancelled. Stop here and wait for the user." };
    if (res.allow) {
      this.setPlan(plan, { outcome: "approved" });
      this.planReview = undefined;
      return { allow: true };
    }
    const feedback = res.value?.trim() || "Please revise the plan.";
    this.setPlan(plan, { outcome: "feedback" });
    this.addUserMessage(feedback);
    return {
      allow: false,
      reason: `The user reviewed your plan and wants changes before anything is implemented:\n\n${feedback}\n\nUpdate the plan artifact to address this, then stop and wait for their review. Don't implement yet.`,
    };
  }

  private setPlan(id: string, patch: { outcome: "approved" | "feedback" }) {
    const hit = findPlan(this.t.messages, id);
    if (hit) this.emit({ type: "msg", msg: { ...hit.msg, parts: hit.msg.parts.map((p) => (p === hit.part ? { ...hit.part, ...patch } : p)) } });
  }

  /** Headless agy has no way to run a skill by name: every skill is expanded into the message. */
  protected async nativeSkills() {
    return [];
  }

  protected shutdown() {
    this.stopTail();
    this.stopProcess(this.t.state.status === "idle");
  }
}

// ---------------- adapter ----------------

function readTranscript(convId: string): any[] | undefined {
  try {
    return readFileSync(transcriptPath(convId), "utf8")
      .split("\n")
      .flatMap((l) => {
        try {
          return l ? [JSON.parse(l)] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return undefined;
  }
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
    const entries = record?.convId ? readTranscript(record.convId) : undefined;
    if (entries) return transcriptToMessages(entries, record?.model).messages;
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
    return new AgySession({ nativeId, projectPath: r?.cwd ?? projectPath, title: r?.title, createdAt: r?.createdAt, updatedAt: r?.updatedAt }, sink);
  },

  async listModels(live) {
    const models = await loadModels();
    const fam = live?.harness === "antigravity" ? live.t.state.thinkingLevels : undefined;
    return { models: [{ id: "default", label: "Default" }, ...models], thinkingLevels: fam ?? DEFAULT_EFFORT, permissionModes: MODES };
  },
};
