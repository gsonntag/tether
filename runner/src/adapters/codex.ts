// OpenAI Codex CLI through `codex app-server`: the JSON-RPC API (newline-delimited over stdio)
// behind Codex's IDE extension. One app-server process per live session. Threads live in Codex's
// own store, so conversations started in a terminal show up too, with their history.
//
// Guard: in ask/auto Codex runs with approvalPolicy "untrusted" (it asks before anything outside
// its own list of safe read-only commands, and before every patch) inside its workspace-write
// sandbox when that works on this machine; each request goes to the guard. approvalsReviewer is
// forced to "user" (the client), so Codex's own auto-reviewer from config.toml doesn't answer
// first. Codex's "decline" carries no reason, so the guard's reason is steered into the turn.
// MCP tool calls are approved through an MCP elicitation (see onElicitation); they go to the guard too.
// In full: no approvals, no sandbox.

import { resolve } from "node:path";
import { codexOnChatGpt, type ActivityItem, type ModelRef, type Msg, type Part, type SessionGoal, type SessionSummary } from "../../../web/src/shared/protocol";
import { userParts } from "../../../web/src/shared/bash";
import { displayText } from "../../../web/src/shared/skill";
import { CodexActivity } from "./codexActivity";
import { sessionSkills } from "../skillcmd";
import { findTool } from "../../../web/src/shared/reducer";
import { codexRollout, codexTokenUsage } from "../contextWindow";
import type { Classified } from "../fallback";
import { codexFault } from "../faults";
import { CODEX_STATUS } from "../goal";
import { LiveSession, newId, tetherOnly } from "../session";
import { sessionLaunch } from "../connectors/launch";
import { nativeImagePaths } from "../attachments";
import type { Adapter, CreateOpts, Sink, StoredProject } from "./types";
import { codexPick, lastLineTime } from "./lastActivity";
import { formContent, formRequest } from "./elicitation";
import { userHome } from "../home";
import { codexNativeKeys, hooksFor } from "../hooks";
import { agentEnv } from "../secrets";

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
      const p = Bun.spawn([CODEX_BIN, "sandbox", "true"], { cwd: userHome(), stdout: "ignore", stderr: "ignore" });
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

/**
 * A failed turn's error as fallback sees it. Codex reports usageLimitExceeded for the ChatGPT
 * plan's limit but also for a provider's quota or billing errors (insufficient_quota): it's a
 * definite limit only for a model on the ChatGPT login. A model routed to another provider
 * ("openrouter/…") gets a plain quota hint, so the error offers "Continue on …" and never switches.
 */
export function classifyCodexError(e: any, model: string | undefined, quotaReset: () => number | undefined): { status?: number; hint?: Classified } {
  const info = e?.codexErrorInfo;
  if (info === "usageLimitExceeded") return { hint: codexOnChatGpt(model) ? { kind: "quota", resetAt: quotaReset(), definite: true } : { kind: "quota" } };
  if (info === "serverOverloaded" || info === "rateLimitExceeded") return { hint: { kind: "rate_limit" } };
  const status = info && typeof info === "object" ? (Object.values(info)[0] as any)?.httpStatusCode : undefined;
  return { status: status ?? undefined };
}

export class CodexProcess {
  proc: ReturnType<typeof Bun.spawn>;
  stderr = "";
  exited: Promise<number>;
  private nextId = 0;
  private waits = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>();
  onNotify?: (method: string, params: any) => void;
  /** Server-to-client requests (approvals, questions). Returning undefined answers "unsupported". */
  onRequest?: (method: string, params: any) => Promise<unknown>;

  /** `env`: a session's process gets your secrets (secrets.ts agentEnv); background calls run with the runner's own */
  constructor(cwd: string, env: Record<string, string | undefined> = process.env, args: string[] = []) {
    const proc = Bun.spawn([CODEX_BIN, "app-server", ...args], { cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe", env });
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
  const p = new CodexProcess(userHome());
  try {
    await p.init();
    return await fn(p);
  } finally {
    p.kill();
  }
}

/** Stored-history reads (opening, search) run at most this many helper processes at once. */
const HISTORY_HELPERS = 2;
let historyRunning = 0;
const historyQueue: (() => void)[] = [];

/** withProcess for reading a thread, a few at a time. */
export async function withHistoryProcess<T>(fn: (p: CodexProcess) => Promise<T>, run: typeof withProcess = withProcess): Promise<T> {
  // A finished read hands its slot straight to the next one waiting.
  if (historyRunning >= HISTORY_HELPERS) await new Promise<void>((r) => historyQueue.push(r));
  else historyRunning++;
  try {
    return await run(fn);
  } finally {
    const next = historyQueue.shift();
    if (next) next();
    else historyRunning--;
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
  const content: any[] = item.content ?? [];
  const skills = new Set(content.filter((c) => c.type === "skill").map((c) => c.name));
  // A skill Tether passed to Codex natively reads as typed: `$name args` → `/name args`.
  const typed = (t: string) => t.replace(/^\$([\w.:-]+)/, (m, n) => (skills.has(n) ? `/${n}` : m));
  // Images Tether attached are listed in the text already (they show as the attachment's chip).
  const listed = content.some((c) => c.type === "text" && String(c.text).includes("Attached files ("));
  return content
    .map((c) => (c.type === "text" ? typed(c.text) : (c.type === "image" || c.type === "localImage") && !listed ? "[image]" : ""))
    .filter(Boolean)
    .join("\n");
}

/**
 * `/name args` for a skill Codex has (at the start of the text, or of a message joined into it):
 * Codex's own mention (`$name`) plus the skill item that loads it.
 */
export function codexInput(text: string, skills: Map<string, string>): any[] {
  const items: any[] = [];
  const out = text.replace(/(^|\n\n)\/([\w.:-]+)(?=\s|$)/g, (m, lead: string, name: string) => {
    const path = skills.get(name);
    if (!path) return m;
    if (!items.some((i) => i.name === name)) items.push({ type: "skill", name, path });
    return `${lead}$${name}`;
  });
  return [{ type: "text", text: out, text_elements: [] }, ...items, ...imageItems(text)];
}

/** The images a message lists as attachments, as Codex's own image input (it reads the files). */
export function imageItems(text: string): any[] {
  return nativeImagePaths(text).map((a) => ({ type: "localImage", path: a.path }));
}

/**
 * A resumed thread's turns as a transcript. A message takes its item's own start time when known
 * (`times`, see itemTimes), else its turn's start (Codex keeps those in seconds); a turn without
 * one takes the time of the one before it. `marks` gets each message's turn id (fork points).
 */
export function historyMsgs(turns: any[], cwd: string, model?: string, times?: Map<string, number>, marks?: Map<string, string>): Msg[] {
  const out: Msg[] = [];
  let last = 0;
  for (const turn of turns) {
    const from = out.length;
    let a: Msg | undefined;
    const turnTs = (last = (turn.startedAt ?? 0) * 1000 || (turn.completedAt ?? 0) * 1000 || last);
    const at = (item: any) => times?.get(item.id) || turnTs;
    for (const item of turn.items ?? []) {
      if (item.type === "userMessage") {
        const text = userText(item);
        if (text && !text.startsWith(GUARD_NOTE)) out.push({ id: `u-${item.id}`, role: "user", parts: userParts(text, `u-${item.id}`), ts: at(item) });
        a = undefined;
        continue;
      }
      if (item.type === "contextCompaction") {
        out.push({ id: `n-${item.id}`, role: "notice", parts: [{ type: "text", text: "Context compacted." }], ts: at(item), source: "compaction" });
        continue;
      }
      const part = itemPart(item, cwd);
      if (!part || ((part.type === "text" || part.type === "thinking" || part.type === "plan") && !part.text)) continue;
      if (part.type === "tool" && part.status === "running") part.status = "error";
      if (!a) out.push((a = { id: `a-${item.id}`, role: "assistant", parts: [], ts: at(item), model }));
      a.parts.push(part);
    }
    if (a && turn.status === "failed") a.error = turn.error?.message ?? "error";
    if (marks && turn.id) for (const m of out.slice(from)) marks.set(m.id, turn.id);
  }
  return out;
}

/**
 * Item start times for turns where the turn's own start isn't enough: ones with a message steered in
 * after it began. Codex records them per item (`thread/items/list`); best effort, a few calls at most.
 */
const ITEM_TIMES_BUDGET_MS = 4_000;

export async function itemTimes(p: Pick<CodexProcess, "call">, threadId: string, turns: any[]): Promise<Map<string, number>> {
  const times = new Map<string, number>();
  const steered = turns.filter((t) => (t.items ?? []).filter((i: any) => i.type === "userMessage").length > 1).slice(-20);
  // The history waits on this: a few seconds at most, whatever Codex does.
  const deadline = Date.now() + ITEM_TIMES_BUDGET_MS;
  for (const turn of steered) {
    let cursor: string | null = null;
    try {
      for (let page = 0; page < 10; page++) {
        const left = deadline - Date.now();
        if (left <= 0) return times;
        const r: any = await p.call("thread/items/list", { threadId, turnId: turn.id, cursor, limit: 100 }, left);
        for (const e of r?.data ?? []) if (e?.item?.id && e.startedAtMs) times.set(e.item.id, e.startedAtMs);
        if (!(cursor = r?.nextCursor)) break;
      }
    } catch {
      // An older Codex without the method, or one too slow: the turns' starts stand for the rest.
      return times;
    }
  }
  return times;
}

// ---------------- live session ----------------

/**
 * The extra sandbox permissions a command approval asks for (experimental `additionalPermissions`:
 * network, file-system entries/read/write roots), or undefined when it asks for none.
 */
export function additionalPermissions(p: any): Record<string, unknown> | undefined {
  const a = p?.additionalPermissions;
  if (!a || typeof a !== "object") return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(a)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "object" && !Array.isArray(v) && Object.values(v).every((x) => x === null || x === undefined || (Array.isArray(x) && !x.length))) continue;
    out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Codex collaboration modes, offered as the session's modes: "plan" plans before it acts. */
export const CODEX_MODES = ["default", "plan"];

/**
 * The guard's name for the MCP tool an approval elicitation is about (`mcp__server__tool`, as on
 * the tool card). Codex's message reads `Allow <the X MCP server> to run tool "<name>"?`; the
 * name in `_meta` wins when there is one.
 */
export function mcpApprovalTool(p: any): string {
  const name = p?._meta?.tool_name ?? /run tool "(.+)"\?\s*$/.exec(p?.message ?? "")?.[1] ?? p?._meta?.tool_title ?? "tool";
  return `mcp__${p?.serverName ?? "mcp"}__${name}`;
}

/** `_meta.persist` lists the remember options Codex offers (a string or an array). */
const offers = (persist: unknown, v: string) => persist === v || (Array.isArray(persist) && persist.includes(v));

/**
 * The app-server's (experimental) CollaborationMode for turn/start and thread/settings/update.
 * developer_instructions null: Codex's built-in instructions for that mode.
 */
export function collaborationMode(mode: string, model: string, effort?: string) {
  return { mode: mode === "plan" ? "plan" : "default", settings: { model, reasoning_effort: effort ?? null, developer_instructions: null } };
}

export class CodexSession extends LiveSession {
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
    init: { nativeId: string; projectPath: string; title?: string; createdAt?: number; updatedAt?: number },
    sink: Sink,
    private opts: CreateOpts & { resume?: boolean; fork?: { threadId: string; lastTurnId: string } } = {},
  ) {
    super("codex", init, sink);
    this.model = opts.model && opts.model !== "default" ? opts.model : undefined;
    if (opts.permissionMode && CODEX_MODES.includes(opts.permissionMode)) this.collab = opts.permissionMode;
  }

  private sandboxed = false;

  private policy() {
    // A review session (/review): Codex's read-only sandbox where it works, and it asks before anything else.
    if (this.isReviewSession)
      return { approvalPolicy: "untrusted", sandboxPolicy: this.sandboxed ? { type: "readOnly", networkAccess: false } : { type: "dangerFullAccess" } };
    // Full access asks nothing, unless your PreToolUse hooks need to see the calls (checkTool then allows them).
    if (this.guardMode === "full" && !hooksFor("PreToolUse", { skip: this.hookSkip }).length) return { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } };
    if (this.guardMode === "full") return { approvalPolicy: "untrusted", sandboxPolicy: { type: "dangerFullAccess" } };
    return {
      approvalPolicy: "untrusted",
      sandboxPolicy: this.sandboxed
        ? { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }
        : { type: "dangerFullAccess" },
    };
  }

  async start() {
    // The session's credential: its env over your secrets, its args ("-c" overrides) after app-server.
    const cred = await this.credentialLaunch();
    this.p = new CodexProcess(this.projectPath, agentEnv(cred.env), cred.args);
    this.p.onNotify = (m, params) => this.onNotify(m, params);
    this.p.onRequest = (m, params) => this.onRequest(m, params);
    this.p.exited.then((code) => {
      if (this.closed) return;
      this.notice(`codex exited (code ${code}). ${this.p.stderr.trim().split("\n").slice(-3).join("\n")}`, "error");
      this.setState({ status: "idle" });
      this.close();
    });
    [this.sandboxed] = await Promise.all([sandboxWorks(), this.p.init()]);
    // Hooks Codex runs itself (its own trusted hook config) aren't run again by Tether.
    this.hookSkip = await this.p
      .call("hooks/list", { cwds: [this.projectPath] }, 10_000)
      .then(codexNativeKeys)
      .catch(() => undefined);
    const { approvalPolicy, sandboxPolicy } = this.policy();
    // Its connector: shared memory as developer instructions, the tether-context MCP server and the MCP registry's servers.
    const launch = await sessionLaunch("codex", {
      projectPath: this.projectPath,
      session: { id: this.opts.resume ? this.id : undefined, key: this.guardEnv.TETHER_GUARD_KEY, review: this.isReviewSession },
      resume: this.opts.resume || !!this.opts.fork,
    });
    const params = {
      cwd: this.projectPath,
      approvalPolicy,
      approvalsReviewer: "user",
      sandbox: sandboxPolicy.type === "dangerFullAccess" ? "danger-full-access" : sandboxPolicy.type === "readOnly" ? "read-only" : "workspace-write",
      ...(this.model ? { model: this.model } : {}),
      ...launch.options,
    };
    let r: any;
    if (this.opts.resume) {
      r = await this.p.call("thread/resume", { threadId: this.nativeId, ...params }).catch((e: any) => {
        // Codex writes a thread only with its first turn, and gives a new one its own id.
        if (/no rollout found/i.test(String(e?.message ?? e))) throw new Error("This Codex session never got a message, so Codex has nothing to reopen. Start a new session instead.");
        throw e;
      });
      const turns = r.thread.turns ?? [];
      this.emit({ type: "reset", messages: historyMsgs(turns, this.projectPath, r.model, await itemTimes(this.p, this.nativeId, turns), this.forkMarks) });
    } else if (this.opts.fork) {
      // Codex's own fork: a new thread with the turns up to and including lastTurnId.
      r = await this.p.call("thread/fork", { threadId: this.opts.fork.threadId, lastTurnId: this.opts.fork.lastTurnId, ...params });
      this.nativeId = r.thread.id;
      const turns = r.thread.turns ?? [];
      this.emit({ type: "reset", messages: historyMsgs(turns, this.projectPath, r.model, undefined, this.forkMarks) });
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
    this.mcpAuthNotice(launch.mcpAuth);
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
    if (this.turnId) this.forkMarks.set(msg.id, this.turnId);
    return msg;
  }

  /**
   * The messages since the last one placed in a turn belong to this one (fork points): the user
   * message that started it, steers into it, its replies.
   */
  private markTurn(turnId: string) {
    for (let i = this.t.messages.length - 1; i >= 0; i--) {
      const m = this.t.messages[i]!;
      if (this.forkMarks.has(m.id)) break;
      if (!tetherOnly(m)) this.forkMarks.set(m.id, turnId);
    }
  }

  /**
   * thread/fork keeps whole turns, through a finished one: a fork point only where a turn ends (the
   * next message Codex has starts another turn) and not in the turn running now.
   */
  forkPoint(n: number) {
    const point = this.lastMark(n);
    if (!point || point === this.turnId) return undefined;
    const after = this.t.messages.slice(n).find((m) => !tetherOnly(m));
    if (after && this.forkMarks.get(after.id) === point) return undefined;
    if (after && !this.forkMarks.has(after.id)) return undefined;
    return point;
  }

  /** thread/compact/start; it takes no instructions, so a focus means Tether's restart on a brief. */
  protected async nativeCompact(focus?: string) {
    if (focus) return false;
    this.finishMsg();
    this.setState({ status: "running" });
    await this.p.call("thread/compact/start", { threadId: this.nativeId });
    // It runs as a turn (turn/started … turn/completed); if none shows up, don't stay "running".
    // Only until that turn starts: a later turn (still waiting on turn/start) is never cut short.
    clearTimeout(this.compactTimer);
    this.compactTimer = setTimeout(() => !this.closed && !this.turnId && this.t.state.status === "running" && this.setState({ status: "idle" }), CodexSession.COMPACT_FALLBACK_MS);
    return true;
  }

  static COMPACT_FALLBACK_MS = 15_000;
  /** a compaction's way back to idle when its turn never shows up */
  private compactTimer?: ReturnType<typeof setTimeout>;

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
        clearTimeout(this.compactTimer);
        this.turnId = p.turn.id;
        this.markTurn(p.turn.id);
        if (this.t.state.status !== "running") this.setState({ status: "running" });
        this.interruptForFault();
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
      case "turn/completed": {
        if (p.turn?.id) this.markTurn(p.turn.id);
        // A simulated limit (faults.ts): the turn ends with Codex's own notifications for it instead.
        const fault = this.takeFault();
        this.faultStop = false;
        if (fault) for (const [m, x] of codexFault(fault, this.nativeId, p.turn)) this.onNotify(m, x);
        else this.onTurnCompleted(p.turn);
        break;
      }
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
      case "thread/goal/updated":
        // Codex's own goal (mirrorGoal): what it decided, or our own change coming back.
        if (p.goal && this.mirrored !== undefined && p.goal.objective === this.mirrored) this.nativeGoalChanged(p.goal.status, p.goal.tokensUsed);
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
    // On a credential (an Azure key…) a usageLimitExceeded isn't the ChatGPT plan's limit.
    if (this.t.state.credential) return classifyCodexError(e, "credential/model", () => undefined);
    return classifyCodexError(e, this.model ?? this.t.state.model, () => this.quotaReset());
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
        // With experimentalApi a command can ask for more sandbox room (network, extra write roots),
        // granted by accepting it: that is a permission request, not a plain command, so no
        // read-only-command rule may wave it through.
        const extra = additionalPermissions(p);
        const v = extra
          ? await this.checkTool("request_permissions", { ...input, reason: p.reason, permissions: extra, cwd: p.cwd }, p.itemId)
          : await this.checkTool("bash", input, p.itemId);
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
        return this.onElicitation(p);
      default:
        return undefined;
    }
  }

  /**
   * An MCP server (or Codex on its behalf) wants something from the user. Codex asks before an MCP
   * tool call as an elicitation tagged `_meta.codex_approval_kind: "mcp_tool_call"` with an empty
   * form; that goes to the guard like any other approval, and "always" is passed back as Codex's
   * session-scoped `persist` when it offers one. Forms become a question card, a URL a confirm.
   */
  private async onElicitation(p: any): Promise<{ action: "accept" | "decline" | "cancel"; content: unknown; _meta: unknown }> {
    const meta = p._meta && typeof p._meta === "object" ? p._meta : {};
    if (meta.codex_approval_kind === "mcp_tool_call") {
      const tool = mcpApprovalTool(p);
      const v = await this.checkTool(tool, meta.tool_params ?? {});
      if (!v.allow) {
        this.explainDenial(`call to ${tool}`, v.reason);
        return { action: "decline", content: null, _meta: null };
      }
      const persist = v.always && offers(meta.persist, "session") ? { persist: "session" } : null;
      return { action: "accept", content: null, _meta: persist };
    }
    const server = p.serverName ?? "An MCP server";
    if (p.mode === "url") {
      const r = await this.askUi({ id: newId("q"), kind: "confirm", title: `${server} wants you to open a link`, message: `${p.message ?? ""}\n\n${p.url}`.trim(), userOnly: true });
      return { action: r.cancelled ? "cancel" : r.confirmed ? "accept" : "decline", content: null, _meta: null };
    }
    const req = formRequest(p.message || `${server} needs your input`, p.requestedSchema);
    if (!req) {
      // Nothing to fill in: a plain yes/no.
      const r = await this.askUi({ id: newId("q"), kind: "confirm", title: `${server} asks`, message: p.message, userOnly: true });
      return { action: r.cancelled ? "cancel" : r.confirmed ? "accept" : "decline", content: r.confirmed ? {} : null, _meta: null };
    }
    const r = await this.askUi(req);
    if (r.cancelled) return { action: "cancel", content: null, _meta: null };
    return { action: "accept", content: formContent(p.requestedSchema, r), _meta: null };
  }

  /** Codex's "decline" tells the model nothing; pass the guard's reason along. */
  private explainDenial(what: string, reason?: string) {
    const turnId = this.turnId;
    if (!turnId) return;
    const text = `${GUARD_NOTE} Your ${what} was blocked: ${reason ?? "not allowed"}. Don't retry it as is; find another way or explain what you need.`;
    this.p.call("turn/steer", { threadId: this.nativeId, input: [{ type: "text", text, text_elements: [] }], expectedTurnId: turnId }).catch(() => {});
  }

  // ---- turns ----

  /** a simulated limit wants the turn interrupted as soon as it has an id */
  private faultStop = false;

  protected faultInterrupt() {
    this.faultStop = true;
    this.interruptForFault();
  }

  private interruptForFault() {
    if (!this.faultStop || !this.turnId) return;
    this.faultStop = false;
    this.p.call("turn/interrupt", { threadId: this.nativeId, turnId: this.turnId }).catch(() => {});
  }

  /** `skills`: a `/name` paragraph for a skill Codex has goes as a skill item (not for briefs). */
  private async startTurn(text: string, skills = true) {
    clearTimeout(this.compactTimer);
    this.finishMsg();
    this.setState({ status: "running" });
    try {
      const r: any = await this.p.call("turn/start", {
        threadId: this.nativeId,
        input: skills ? codexInput(text, this.skillPaths) : [{ type: "text", text, text_elements: [] }, ...imageItems(text)],
        approvalsReviewer: "user",
        ...this.policy(),
        ...(this.model ? { model: this.model } : {}),
        ...(this.effort ? { effort: this.effort } : {}),
        ...this.collabParam(),
      });
      this.turnId ??= r.turn?.id;
      if (r.turn?.id) this.markTurn(r.turn.id);
      this.interruptForFault();
    } catch (e: any) {
      if (await this.handleTurnError(e?.message)) return;
      this.notice(e?.message || "Could not start the turn.", "error");
      this.setState({ status: "idle" });
    }
  }

  protected async steer(text: string) {
    if (!this.turnId) return false;
    try {
      await this.p.call("turn/steer", { threadId: this.nativeId, input: codexInput(text, this.skillPaths), expectedTurnId: this.turnId });
      return true;
    } catch {
      return false; // the turn just ended, or it's a review/compaction, which can't be steered
    }
  }

  protected async send(text: string) {
    if (await this.preferBest(text)) return;
    this.addUserMessage(text);
    this.autoTitle(text);
    await this.startTurn(text);
  }

  /** name → SKILL.md of the skills Codex found for this project (from the last skills/list). */
  private skillPaths = new Map<string, string>();

  /** codexInput turns a `/name` paragraph anywhere in the message into a skill item. */
  protected nativeAnywhere = true;

  /** Without a path from skills/list there's no skill item to send: expanded instead. */
  protected nativeSkillText(name: string, args: string) {
    return this.skillPaths.has(name) ? super.nativeSkillText(name, args) : undefined;
  }

  /** Codex runs a skill from a `skill` input item (see codexInput); skills/list says which it has. */
  protected async nativeSkills() {
    const r: any = await this.p.call("skills/list", { cwds: [this.projectPath] });
    const skills = (r?.data ?? []).flatMap((e: any) => e.skills ?? []).filter((s: any) => s.enabled !== false);
    this.skillPaths = new Map(skills.map((s: any) => [s.name, s.path]));
    return skills.map((s: any) => ({ name: s.name, description: s.description, path: s.path }));
  }

  async continueTurn(text = "Continue where you left off.") {
    this.addUserMessage(text.length > 300 ? text.slice(0, 300) + "…" : text);
    await this.startTurn(text, false);
  }

  /** the objective Codex's thread goal was last given; undefined: not mirrored (yet) */
  private mirrored?: string;

  /**
   * Codex thread goals (app-server thread/goal/*, the `goals` feature): Tether's goal mirrored in,
   * so Codex's own goal tools and continuation work on it, and its status comes back through
   * thread/goal/updated (nativeGoalChanged). Tether's copy stays the source of truth. A Codex
   * without the API (or with goals off) leaves the loop to Tether alone.
   */
  protected async mirrorGoal(g: SessionGoal | null) {
    if (!this.p || this.closed) return;
    const threadId = this.nativeId;
    try {
      if (!g) {
        this.mirrored = undefined;
        this.nativeGoal = false;
        await this.p.call("thread/goal/clear", { threadId, origin: "user" });
        return;
      }
      // One goal per thread: a new objective replaces the old one (after a restart, ask Codex what it has).
      const cur = this.mirrored ?? ((await this.p.call("thread/goal/get", { threadId })) as any)?.goal?.objective;
      if (cur !== undefined && cur !== g.objective) await this.p.call("thread/goal/clear", { threadId, origin: "user" });
      this.mirrored = g.objective;
      await this.p.call("thread/goal/set", { threadId, origin: "user", objective: g.objective, status: CODEX_STATUS[g.status], tokenBudget: g.budget?.tokens ?? null });
      this.nativeGoal = true;
      const now = this.t.state.goal;
      if (now && now.objective === g.objective && !now.native) this.setState({ goal: { ...now, native: true } });
    } catch (e) {
      this.mirrored = undefined;
      this.nativeGoal = false;
      throw e;
    }
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

  /** Plan mode: its `plan` item goes up for Tether's review when the turn ends (the app-server has no review step). */
  protected planning() {
    return this.collab === "plan";
  }

  /** Approved: Default mode from the next turn, as the Codex TUI's "Yes, implement this plan" does. */
  protected async leavePlanMode() {
    if (this.collab === "plan") await this.setPermissionMode("default");
  }

  async rename(title: string) {
    await this.p.call("thread/name/set", { threadId: this.nativeId, name: title }).catch(() => {});
    this.setTitle(title);
  }

  async listCommands() {
    return [];
  }

  protected shutdown() {
    clearTimeout(this.compactTimer);
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

/**
 * A thread's title. Its preview is the first message as Codex got it: a skill Tether passed
 * natively starts `$name`, which reads as typed (`/name`) when `skills` (this project's) has it.
 */
const titleOf = (t: any, skills?: Set<string>) => {
  const preview = (t.preview ?? "").replace(/^\$([\w.:-]+)/, (m: string, n: string) => (skills?.has(n) ? `/${n}` : m));
  return t.name || displayText(preview).replace(/\s+/g, " ").slice(0, 120) || "Untitled";
};
const skillNames = (projectPath: string) => new Set(sessionSkills("codex", projectPath).map((s) => s.name));

/**
 * When a thread's last message was written: the last item in its rollout. Its `updatedAt` also
 * moves when a client resumes it or changes its settings; `recencyAt` (its last turn's start) is the
 * fallback.
 */
async function lastMessageAt(t: any): Promise<number> {
  const fromRollout = typeof t.path === "string" ? await lastLineTime(t.path, codexPick) : undefined;
  return fromRollout ?? (t.recencyAt ?? t.updatedAt) * 1000;
}

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
    const list = (await threads()).filter((t) => t.cwd === projectPath);
    const skills = list.some((t) => !t.name && t.preview?.startsWith("$")) ? skillNames(projectPath) : undefined;
    return Promise.all(
      list.map(async (t) => ({
        id: `codex:${t.id}`,
        harness: "codex" as const,
        nativeId: t.id,
        projectPath,
        title: titleOf(t, skills),
        createdAt: t.createdAt * 1000,
        updatedAt: await lastMessageAt(t),
        live: false,
        status: "idle" as const,
      })),
    );
  },

  async readHistory(nativeId: string, projectPath: string): Promise<Msg[]> {
    if (!Bun.which(CODEX_BIN)) return [];
    return withHistoryProcess(async (p) => {
      const r: any = await p.call("thread/read", { threadId: nativeId, includeTurns: true });
      const thread = r.thread ?? r;
      return historyMsgs(thread.turns ?? [], projectPath, thread.model, await itemTimes(p, nativeId, thread.turns ?? []));
    });
  },

  // A short-lived app-server answers thread/read; the thread itself isn't resumed.
  async storedHistory(nativeId: string, projectPath: string) {
    if (!Bun.which(CODEX_BIN)) return undefined;
    return withHistoryProcess(async (p) => {
      const r: any = await p.call("thread/read", { threadId: nativeId, includeTurns: true });
      const thread = r.thread ?? r;
      const turns = thread.turns ?? [];
      const messages = historyMsgs(turns, projectPath, thread.model, await itemTimes(p, nativeId, turns));
      const model: string | undefined = thread.model ?? [...messages].reverse().find((m) => m.model)?.model;
      // Codex reports token usage only as turns run; the last count is in the rollout.
      const context =
        typeof thread.path === "string"
          ? await Bun.file(thread.path)
              .slice(-4_000_000)
              .text()
              .then((text) => codexRollout(text, model))
              .catch(() => undefined)
          : undefined;
      return { messages, context, model };
    });
  },

  modes: CODEX_MODES,

  create(projectPath, opts, sink) {
    listCache = undefined;
    return new CodexSession({ nativeId: "pending-" + newId(""), projectPath }, sink, opts);
  },

  async fork(from, opts, sink) {
    listCache = undefined;
    return new CodexSession({ nativeId: "pending-" + newId(""), projectPath: from.projectPath }, sink, { ...opts, fork: { threadId: from.nativeId, lastTurnId: from.point } });
  },

  async resume(nativeId, projectPath, sink) {
    const t = (await threads()).find((x) => x.id === nativeId);
    return new CodexSession(
      { nativeId, projectPath: t?.cwd ?? projectPath, title: t ? titleOf(t, skillNames(t.cwd)) : undefined, createdAt: t ? t.createdAt * 1000 : undefined, updatedAt: t && (await lastMessageAt(t)) },
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
