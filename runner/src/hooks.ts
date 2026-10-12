// Your hooks, run once by Tether for every harness (docs/harness-platform.md, Phase 4). Same shape
// and contract as Claude Code's command hooks:
//
//   PreToolUse        before a tool call, in the guard path (LiveSession.checkTool): exit 2 or
//                     `permissionDecision: "deny"` (or `decision: "block"`) denies it with a reason
//                     the agent sees; `permissionDecision: "allow"` skips the judge and the person
//                     (the guard's own deny rules still apply).
//   PostToolUse       after a tool result the adapter saw: exit 2 / `decision: "block"` / additional
//                     context go to the agent as feedback.
//   Stop              when a turn ends: exit 2 / `decision: "block"` sends the reason back as the next
//                     prompt (the agent goes on); `stop_hook_active` is true in a turn a Stop hook started.
//   UserPromptSubmit  before your message goes out: exit 2 / `decision: "block"` holds it back (the
//                     reason shows inline); plain stdout or additional context goes along with it.
//
// Each command gets the event's JSON on stdin (Claude's field names), runs in the project with
// CLAUDE_PROJECT_DIR set, and is killed after its timeout (600 s unless set). Tool names are
// normalized to Claude Code's (Bash, Read, Edit, Write, Glob, Grep, LS, WebFetch, WebSearch,
// TodoWrite, Task, mcp__server__tool) so Claude-style matchers work on every harness; the
// harness's own name is in `tether.tool_name`.
//
// Claude Code sessions run them through the SDK's hook callbacks (adapters/claude.ts), minus the
// ones Claude already runs from its own settings files (claudeNativeKeys). Codex sessions skip the
// ones Codex already runs from its own trusted hook config.
//
// Stored in the runner's config dir (hooks.json); "Find hooks" and the master context's Import read
// ~/.claude/settings.json (never written).

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { HookEventName, HookFindResult, HookView } from "../../web/src/shared/protocol";
import { commandOf } from "./guard";
import { Mutex } from "./context/git";
import { configDir, home, tilde } from "./context/paths";
import { writeAtomic } from "./context/store";

export const HOOK_EVENTS: HookEventName[] = ["PreToolUse", "PostToolUse", "Stop", "UserPromptSubmit"];
/** Events whose matcher is a tool name (the others ignore it, as in Claude Code). */
const TOOL_EVENTS = new Set<HookEventName>(["PreToolUse", "PostToolUse"]);
/** Claude Code's default command hook timeout, in seconds. */
export const DEFAULT_TIMEOUT_S = 600;

export interface HookCommand {
  type: "command";
  command: string;
  /** seconds */
  timeout?: number;
}

export interface StoredHook {
  id: string;
  event: HookEventName;
  matcher: string;
  hooks: HookCommand[];
  enabled: boolean;
  /** "you", or "claude:~/.claude/settings.json" */
  sources: string[];
  addedAt: number;
}

interface HooksData {
  hooks: StoredHook[];
  /** identities you deleted: Find doesn't bring them back (pasting one does) */
  dismissed: string[];
}

export const hooksFile = () => join(configDir(), "hooks.json");
const claudeSettings = () => join(home(), ".claude", "settings.json");

// ---------------- store ----------------

let cache: { mtime: number; data: HooksData } | undefined;

export function loadHooks(): HooksData {
  let mtime = -1;
  try {
    mtime = statSync(hooksFile()).mtimeMs;
  } catch {}
  if (cache && cache.mtime === mtime && mtime >= 0) return cache.data;
  let data: HooksData = { hooks: [], dismissed: [] };
  try {
    const v = JSON.parse(readFileSync(hooksFile(), "utf8"));
    if (v && Array.isArray(v.hooks)) data = { hooks: v.hooks.filter((h: any) => HOOK_EVENTS.includes(h?.event) && Array.isArray(h.hooks)), dismissed: Array.isArray(v.dismissed) ? v.dismissed : [] };
  } catch {}
  cache = mtime >= 0 ? { mtime, data } : undefined;
  return data;
}

const lock = new Mutex();

function mutate<T>(fn: (d: HooksData) => T): Promise<T> {
  return lock.run(async () => {
    const d = structuredClone(loadHooks());
    const r = fn(d);
    // Commands run with your rights: owner-only like the rest of the runner's config.
    writeAtomic(hooksFile(), JSON.stringify(d, null, 2) + "\n", 0o600);
    cache = undefined;
    return r;
  });
}

/** For tests: forget the cached file. */
export function resetHooksCache() {
  cache = undefined;
}

const newId = () => `hook_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** One command of one event and matcher: the unit duplicates are found by. */
export const commandKey = (event: string, matcher: string | undefined, command: string) => JSON.stringify([event, TOOL_EVENTS.has(event as HookEventName) ? normMatcher(matcher) : "", command.trim()]);
const identity = (h: Pick<StoredHook, "event" | "matcher" | "hooks">) => JSON.stringify([h.event, normMatcher(h.matcher), h.hooks.map((c) => c.command.trim()).sort()]);
const normMatcher = (m: string | undefined) => (!m || m === "*" ? "" : m.trim());

// ---------------- parsing (Claude Code's settings shape) ----------------

type Entry = Pick<StoredHook, "event" | "matcher" | "hooks">;

function commands(list: unknown, warnings: string[], where: string): HookCommand[] {
  const out: HookCommand[] = [];
  for (const c of Array.isArray(list) ? list : []) {
    if (!c || typeof c !== "object") continue;
    const type = (c as any).type ?? "command";
    if (type !== "command") {
      warnings.push(`${where}: "${type}" hooks aren't supported, only commands.`);
      continue;
    }
    const command = (c as any).command;
    if (typeof command !== "string" || !command.trim()) continue;
    const timeout = Number((c as any).timeout);
    out.push({ type: "command", command, ...(timeout > 0 ? { timeout } : {}) });
  }
  return out;
}

/** `{"PreToolUse": [{matcher, hooks}], …}` into entries; other events are skipped with a warning. */
function fromEventMap(map: Record<string, unknown>, warnings: string[], where: string): Entry[] {
  const out: Entry[] = [];
  for (const [event, groups] of Object.entries(map)) {
    if (!HOOK_EVENTS.includes(event as HookEventName)) {
      warnings.push(`${where}: ${event} hooks aren't run by Tether (only ${HOOK_EVENTS.join(", ")}).`);
      continue;
    }
    for (const g of Array.isArray(groups) ? groups : []) {
      if (!g || typeof g !== "object") continue;
      const hooks = commands((g as any).hooks, warnings, where);
      if (hooks.length) out.push({ event: event as HookEventName, matcher: normMatcher((g as any).matcher), hooks });
    }
  }
  return out;
}

/**
 * Pasted JSON: Claude settings (`{"hooks": {...}}`), its hooks map (`{"PreToolUse": [...]}`), or one
 * entry (`{"event", "matcher", "hooks"}`, or `"command"` instead of `"hooks"`).
 */
export function parseHooks(text: string): { entries: Entry[]; warnings: string[] } {
  let v: any;
  try {
    v = JSON.parse(text);
  } catch (e: any) {
    throw new Error(`That isn't valid JSON: ${e?.message ?? e}`);
  }
  const warnings: string[] = [];
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("Paste a JSON object.");
  let entries: Entry[];
  if (typeof v.event === "string") {
    if (!HOOK_EVENTS.includes(v.event)) throw new Error(`"event" must be one of ${HOOK_EVENTS.join(", ")}.`);
    const hooks = typeof v.command === "string" ? commands([{ type: "command", command: v.command, timeout: v.timeout }], warnings, "hook") : commands(v.hooks, warnings, "hook");
    entries = hooks.length ? [{ event: v.event, matcher: typeof v.matcher === "string" ? normMatcher(v.matcher) : "", hooks }] : [];
  } else entries = fromEventMap(v.hooks && typeof v.hooks === "object" && !Array.isArray(v.hooks) ? v.hooks : v, warnings, "hooks");
  for (const e of entries)
    if (e.matcher && TOOL_EVENTS.has(e.event))
      try {
        new RegExp(e.matcher);
      } catch {
        throw new Error(`The matcher ${e.matcher} isn't a valid pattern.`);
      }
  if (!entries.length) throw new Error(warnings[0] ?? "No command hooks in that JSON.");
  return { entries, warnings };
}

/** The hooks in a Claude Code settings file (empty when it has none or can't be read). */
export function claudeSettingsHooks(path: string): { entries: Entry[]; warnings: string[] } {
  let v: any;
  try {
    v = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { entries: [], warnings: [] };
  }
  const warnings: string[] = [];
  if (!v?.hooks || typeof v.hooks !== "object") return { entries: [], warnings };
  return { entries: fromEventMap(v.hooks, warnings, tilde(path)), warnings };
}

/**
 * The hook commands Claude Code runs itself in this project, from the settings files Tether's
 * Claude sessions load (user, project, local): Tether doesn't run those again there.
 */
export function claudeNativeKeys(projectPath: string): Set<string> {
  const keys = new Set<string>();
  if (process.env.TETHER_HOOKS_CLAUDE_NATIVE === "0") return keys;
  for (const f of [claudeSettings(), join(projectPath, ".claude", "settings.json"), join(projectPath, ".claude", "settings.local.json")])
    for (const e of claudeSettingsHooks(f).entries) for (const c of e.hooks) keys.add(commandKey(e.event, e.matcher, c.command));
  return keys;
}

// ---------------- operations (the web app's) ----------------

function view(h: StoredHook, native: Set<string>): HookView {
  return {
    id: h.id,
    event: h.event,
    matcher: h.matcher,
    hooks: h.hooks,
    enabled: h.enabled,
    sources: h.sources,
    ...(h.hooks.every((c) => native.has(commandKey(h.event, h.matcher, c.command))) ? { claudeNative: true } : {}),
  };
}

export function listHooks(): HookView[] {
  // Your user settings only: per-project ones depend on the session's directory.
  const native = new Set<string>();
  for (const e of claudeSettingsHooks(claudeSettings()).entries) for (const c of e.hooks) native.add(commandKey(e.event, e.matcher, c.command));
  return loadHooks().hooks.map((h) => view(h, native));
}

function merge(d: HooksData, entries: Entry[], source: string, byHand: boolean): number {
  let added = 0;
  const dismissed = new Set(d.dismissed);
  for (const e of entries) {
    const id = identity(e);
    const cur = d.hooks.find((h) => identity(h) === id);
    if (cur) {
      if (!cur.sources.includes(source)) cur.sources.push(source);
      continue;
    }
    if (!byHand && dismissed.has(id)) continue;
    if (byHand) d.dismissed = d.dismissed.filter((x) => x !== id);
    d.hooks.push({ id: newId(), event: e.event, matcher: e.matcher, hooks: e.hooks, enabled: true, sources: [source], addedAt: Date.now() });
    added++;
  }
  return added;
}

export async function addHooks(text: string): Promise<HookView[]> {
  const { entries } = parseHooks(text);
  await mutate((d) => merge(d, entries, "you", true));
  return listHooks();
}

export async function setHook(id: string, change: { enabled?: boolean; remove?: boolean; json?: string }): Promise<HookView[]> {
  const edited = change.json !== undefined ? parseHooks(change.json).entries : undefined;
  if (edited && edited.length !== 1) throw new Error("Edit one hook at a time: one event, one matcher.");
  await mutate((d) => {
    const h = d.hooks.find((x) => x.id === id);
    if (!h) throw new Error("No such hook.");
    if (change.remove) {
      d.hooks = d.hooks.filter((x) => x.id !== id);
      if (h.sources.some((s) => s !== "you")) d.dismissed = [...new Set([...d.dismissed, identity(h)])];
      return;
    }
    if (change.enabled !== undefined) h.enabled = change.enabled;
    if (edited) {
      const e = edited[0]!;
      h.event = e.event;
      h.matcher = e.matcher;
      h.hooks = e.hooks;
      if (!h.sources.includes("you")) h.sources.push("you");
    }
  });
  return listHooks();
}

/** "Find hooks" and the master context's Import: ~/.claude/settings.json's hooks, read only. */
export async function importHooks(): Promise<HookFindResult> {
  const { entries, warnings } = claudeSettingsHooks(claudeSettings());
  const added = entries.length ? await mutate((d) => merge(d, entries, `claude:${tilde(claudeSettings())}`, false)) : 0;
  return { hooks: listHooks(), added, warnings };
}

// ---------------- tool names ----------------

const CLAUDE_TOOLS = new Set(["Bash", "BashOutput", "KillShell", "Read", "Edit", "MultiEdit", "Write", "Glob", "Grep", "LS", "WebFetch", "WebSearch", "TodoWrite", "Task", "Agent", "NotebookEdit", "NotebookRead", "ExitPlanMode", "Skill"]);

const NAMES: [RegExp, string][] = [
  [/^(bash|shell|exec|execute|run_command|run_terminal_cmd|local_shell|exec_command)$/i, "Bash"],
  [/^(read|view_file|read_file|view_file_outline|view_code_item)$/i, "Read"],
  [/^(edit|replace_file_content|multi_replace_file_content|str_replace_based_edit_tool|apply_patch|sed_file|patch)$/i, "Edit"],
  [/^(multiedit|multi_edit)$/i, "MultiEdit"],
  [/^(write|write_to_file|create_file)$/i, "Write"],
  [/^(glob|find|find_by_name)$/i, "Glob"],
  [/^(grep|grep_search|search)$/i, "Grep"],
  [/^(ls|list|list_dir)$/i, "LS"],
  [/^(webfetch|web_fetch|fetch|read_url_content)$/i, "WebFetch"],
  [/^(websearch|web_search|search_web)$/i, "WebSearch"],
  [/^(todowrite|todo_write|update_plan)$/i, "TodoWrite"],
  [/^(task|agent)$/i, "Task"],
  [/^(notebookedit|notebook_edit)$/i, "NotebookEdit"],
];

/** Claude's input field names, next to the harness's own (they're kept). */
function claudeInput(name: string, input: any): any {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input ?? {};
  const out = { ...input };
  if (name === "Bash") {
    const c = commandOf(input);
    if (c !== undefined) out.command = c;
  }
  if (["Read", "Edit", "MultiEdit", "Write", "NotebookEdit"].includes(name) && out.file_path === undefined) {
    const p = input.filePath ?? input.filepath ?? input.path ?? input.AbsolutePath ?? input.TargetFile ?? input.notebook_path;
    if (typeof p === "string") out.file_path = p;
  }
  if (name === "Write" && out.content === undefined && typeof input.CodeContent === "string") out.content = input.CodeContent;
  if (name === "WebFetch" && out.url === undefined && typeof input.Url === "string") out.url = input.Url;
  if (name === "Grep" && out.pattern === undefined && typeof input.Query === "string") out.pattern = input.Query;
  if (name === "WebSearch" && out.query === undefined && typeof input.Query === "string") out.query = input.Query;
  return out;
}

/**
 * A harness's tool call as a Claude Code hook sees it. `servers`: MCP server names, so
 * `server_tool` / `server.tool` (opencode, pi-mcp-adapter) become `mcp__server__tool`.
 */
export function hookTool(tool: string, input: unknown, servers: string[] = []): { name: string; input: any } {
  if (/^mcp__/.test(tool) || CLAUDE_TOOLS.has(tool)) return { name: tool, input: claudeInput(tool, input) };
  const inp: any = input;
  // pi-mcp-adapter's single `mcp` tool: {server, tool, args}
  if (tool === "mcp" && inp && typeof inp === "object" && typeof inp.tool === "string") {
    const server = typeof inp.server === "string" ? inp.server : inp.tool.split(/[_.]/)[0];
    const name = typeof inp.server === "string" ? inp.tool : inp.tool.slice(server.length + 1);
    return { name: `mcp__${server}__${name}`, input: inp.args ?? inp.arguments ?? {} };
  }
  for (const s of [...servers, "tether-context", "tether_context"].sort((a, b) => b.length - a.length))
    if (tool.startsWith(s) && /^[_.]/.test(tool.slice(s.length)) && tool.length > s.length + 1) return { name: `mcp__${s === "tether_context" ? "tether-context" : s}__${tool.slice(s.length + 1)}`, input: inp ?? {} };
  for (const [re, name] of NAMES) if (re.test(tool)) return { name, input: claudeInput(name, input) };
  return { name: tool, input: inp ?? {} };
}

// ---------------- matching ----------------

/** Claude Code's matcher: empty or `*` is every tool; `Edit|Write` a list of names; anything else a pattern. */
export function matches(matcher: string, name: string): boolean {
  const m = normMatcher(matcher);
  if (!m) return true;
  if (/^[\w|-]+$/.test(m)) return m.split("|").includes(name);
  try {
    return new RegExp(m).test(name);
  } catch {
    return m === name;
  }
}

export interface HookRun {
  event: HookEventName;
  matcher: string;
  command: string;
  timeout: number;
  key: string;
}

/** The enabled commands for an event (and tool name), minus `skip` (commandKey) ones. */
export function hooksFor(event: HookEventName, opts: { tool?: string; skip?: Set<string> } = {}): HookRun[] {
  const out: HookRun[] = [];
  const seen = new Set<string>();
  for (const h of loadHooks().hooks) {
    if (!h.enabled || h.event !== event) continue;
    if (TOOL_EVENTS.has(event) && opts.tool !== undefined && !matches(h.matcher, opts.tool)) continue;
    for (const c of h.hooks) {
      const key = commandKey(event, h.matcher, c.command);
      // The same command under the same matcher twice runs once (Claude dedupes identical commands too).
      if (opts.skip?.has(key) || seen.has(key)) continue;
      seen.add(key);
      out.push({ event, matcher: h.matcher, command: c.command, timeout: c.timeout ?? DEFAULT_TIMEOUT_S, key });
    }
  }
  return out;
}

/** Whether any enabled hook listens for this event (cheap: lets callers skip the work). */
export function hasHooks(event: HookEventName, skip?: Set<string>): boolean {
  return hooksFor(event, { skip }).length > 0;
}

// ---------------- running ----------------

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const SHELL = Bun.which("bash") ?? "sh";
const CAP = 100_000;

/** Never handed to your hook commands: the runner's relay credentials and guard keys. */
const PRIVATE_ENV = /^TETHER_(URL|TOKEN|GUARD_\w+)$/;

export async function runCommand(command: string, stdin: string, opts: { cwd: string; timeoutS: number; env?: Record<string, string>; signal?: AbortSignal }): Promise<CommandResult> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !PRIVATE_ENV.test(k)) env[k] = v;
  Object.assign(env, opts.env, { CLAUDE_PROJECT_DIR: opts.cwd });
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    // Its own process group, so a timeout ends whatever it started too.
    proc = Bun.spawn([SHELL, "-c", command], { cwd: opts.cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe", detached: true });
  } catch (e: any) {
    return { code: null, stdout: "", stderr: `couldn't start: ${e?.message ?? e}`, timedOut: false };
  }
  const kill = () => {
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      proc.kill("SIGKILL");
    }
  };
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, opts.timeoutS * 1000);
  const onAbort = () => kill();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const sink = proc.stdin as import("bun").FileSink;
    sink.write(stdin);
    await sink.end();
  } catch {} // a hook that doesn't read its input
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout as ReadableStream).text(), new Response(proc.stderr as ReadableStream).text(), proc.exited]);
  clearTimeout(timer);
  opts.signal?.removeEventListener("abort", onAbort);
  return { code: timedOut ? null : code, stdout: stdout.slice(0, CAP), stderr: stderr.slice(0, CAP), timedOut };
}

/** What a set of hooks for one event decided, in Claude Code's terms. */
export interface HookOutcome {
  /** PreToolUse: deny / allow / ask; PostToolUse, Stop, UserPromptSubmit: "block" */
  decision?: "deny" | "allow" | "ask" | "block";
  /** why: for the agent (deny, PostToolUse / Stop block) or for you (UserPromptSubmit block) */
  reason?: string;
  /** additional context for the agent */
  context: string[];
  /** `continue: false`: stop the agent, with this reason */
  stop?: string;
  /** systemMessage lines, and hooks that failed without blocking (non-2 exit, timeout): for you */
  messages: string[];
  /** how many commands ran */
  ran: number;
}

const PRECEDENCE = { deny: 3, block: 3, ask: 2, allow: 1 } as const;

function interpret(event: HookEventName, run: HookRun, r: CommandResult, out: HookOutcome) {
  const label = run.command.length > 60 ? run.command.slice(0, 57) + "…" : run.command;
  const decide = (decision: NonNullable<HookOutcome["decision"]>, reason: string) => {
    if (!out.decision || PRECEDENCE[decision] > PRECEDENCE[out.decision]) {
      out.decision = decision;
      out.reason = reason;
    } else if (PRECEDENCE[decision] === PRECEDENCE[out.decision] && reason) out.reason = [out.reason, reason].filter(Boolean).join("\n");
  };
  if (r.timedOut) return void out.messages.push(`${event} hook timed out after ${run.timeout} s: ${label}`);
  if (r.code === 2) {
    const reason = r.stderr.trim() || `Blocked by the ${event} hook ${label}.`;
    return decide(event === "PreToolUse" ? "deny" : "block", reason);
  }
  if (r.code !== 0) return void out.messages.push(`${event} hook failed${r.code === null ? "" : ` (exit ${r.code})`}: ${label}${r.stderr.trim() ? `\n${r.stderr.trim().slice(0, 500)}` : ""}`);
  const text = r.stdout.trim();
  let j: any;
  if (text.startsWith("{"))
    try {
      j = JSON.parse(text);
    } catch {}
  if (!j || typeof j !== "object") {
    // Plain output: context for the agent on UserPromptSubmit (as in Claude Code); otherwise only shown in Claude's transcript view.
    if (event === "UserPromptSubmit" && text) out.context.push(text);
    return;
  }
  if (typeof j.systemMessage === "string" && j.systemMessage) out.messages.push(j.systemMessage);
  if (j.continue === false) out.stop = typeof j.stopReason === "string" && j.stopReason ? j.stopReason : `Stopped by the ${event} hook ${label}.`;
  const specific = j.hookSpecificOutput && typeof j.hookSpecificOutput === "object" ? j.hookSpecificOutput : {};
  if (typeof specific.additionalContext === "string" && specific.additionalContext) out.context.push(specific.additionalContext);
  const reason = typeof j.reason === "string" ? j.reason : "";
  if (event === "PreToolUse") {
    const pd = specific.permissionDecision;
    const pr = typeof specific.permissionDecisionReason === "string" ? specific.permissionDecisionReason : reason;
    if (pd === "deny" || j.decision === "block") decide("deny", pr || `Blocked by the PreToolUse hook ${label}.`);
    else if (pd === "ask") decide("ask", pr);
    else if (pd === "allow" || j.decision === "approve") decide("allow", pr || `Allowed by the PreToolUse hook ${label}.`);
  } else if (j.decision === "block") decide("block", reason || `Blocked by the ${event} hook ${label}.`);
}

/**
 * Runs the event's matching hooks (in parallel, like Claude Code) with `input` on stdin, and
 * combines their answers: a deny or block wins over ask, ask over allow.
 */
export async function runHooks(
  event: HookEventName,
  input: Record<string, unknown>,
  opts: { cwd: string; tool?: string; skip?: Set<string>; env?: Record<string, string>; signal?: AbortSignal; runs?: HookRun[] },
): Promise<HookOutcome> {
  const runs = opts.runs ?? hooksFor(event, { tool: opts.tool, skip: opts.skip });
  const out: HookOutcome = { context: [], messages: [], ran: runs.length };
  if (!runs.length) return out;
  const stdin = JSON.stringify({ ...input, cwd: opts.cwd, hook_event_name: event });
  const results = await Promise.all(runs.map((run) => runCommand(run.command, stdin, { cwd: opts.cwd, timeoutS: run.timeout, env: opts.env, signal: opts.signal })));
  runs.forEach((run, i) => interpret(event, run, results[i]!, out));
  return out;
}

/** Codex's own hooks (`hooks/list`) as commandKeys: the trusted, enabled command hooks it runs itself. */
export function codexNativeKeys(list: unknown): Set<string> {
  const keys = new Set<string>();
  const NAMES: Record<string, HookEventName> = { preToolUse: "PreToolUse", postToolUse: "PostToolUse", stop: "Stop", userPromptSubmit: "UserPromptSubmit" };
  for (const entry of (list as any)?.data ?? [])
    for (const h of entry?.hooks ?? []) {
      const event = NAMES[h?.eventName];
      if (!event || h.handlerType !== "command" || !h.enabled || typeof h.command !== "string") continue;
      if (h.trustStatus !== "trusted" && h.trustStatus !== "managed") continue;
      keys.add(commandKey(event, h.matcher ?? "", h.command));
    }
  return keys;
}
