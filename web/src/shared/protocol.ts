// Shared between runner, server and browser. The server only imports types from here (Foliation
// builds the backend from server/ alone, and Bun erases `import type`).
//
// Every harness (pi, Claude Code, later opencode/kiro/...) is translated by a runner adapter into
// this one transcript model, so the UI never knows which agent produced a message.

export type HarnessId = "claude-code" | "codex" | "pi" | "opencode" | "kiro" | "antigravity";

export const HARNESSES: { id: HarnessId; label: string; badge: string }[] = [
  { id: "claude-code", label: "Claude Code", badge: "CC" },
  { id: "codex", label: "Codex", badge: "cx" },
  { id: "pi", label: "pi", badge: "pi" },
  { id: "opencode", label: "opencode", badge: "oc" },
  { id: "kiro", label: "Kiro", badge: "kiro" },
  { id: "antigravity", label: "Antigravity", badge: "agy" },
];

// ---------- transcript ----------

export type ToolStatus = "running" | "done" | "error";

export type Part =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "image"; mimeType: string; data: string }
  | {
      type: "tool";
      id: string;
      name: string;
      input: unknown;
      status: ToolStatus;
      output?: string;
      /** Set when the tool ran inside a subagent (Claude Code Task tool). */
      parentToolId?: string;
      /** The guard's verdict on this call */
      guard?: GuardVerdict;
      /** The guard's judge model is deciding this call; cleared by the verdict or the call ending. */
      judging?: boolean;
    }
  | {
      /**
       * A plan the agent proposes (Claude Code ExitPlanMode, a Codex plan-mode plan) or, for
       * harnesses whose only plan is a checklist (ACP), that checklist as markdown.
       */
      type: "plan";
      id: string;
      text: string;
      checklist?: boolean;
      /** how the person answered it, when the harness asked for approval */
      outcome?: "approved" | "feedback";
    };

export type GuardMode = "ask" | "edits" | "auto" | "full";
/** Who approves tool calls, strictest first. "ask" also asks before edits inside the project. */
export const GUARD_MODES: { id: GuardMode; label: string }[] = [
  { id: "ask", label: "Ask permission" },
  { id: "edits", label: "Accept edits" },
  { id: "auto", label: "Auto" },
  { id: "full", label: "Dangerously skip" },
];

export interface GuardVerdict {
  decision: "allow" | "deny";
  by: "rule" | "judge" | "user" | "mode";
  reason?: string;
}

export interface Checkpoint {
  id: string;
  sha: string;
  ts: number;
  /** the prompt that followed this checkpoint */
  label: string;
  /** what the turn that started here changed: up to the next checkpoint, or the working tree at its end */
  stat?: DiffStat;
}

export interface DiffStat {
  files: number;
  additions: number;
  deletions: number;
}

export interface SessionFileDiff {
  path: string;
  status: "added" | "modified" | "deleted" | "typechanged" | "unknown";
  additions: number;
  deletions: number;
  /** unified diff hunks (from the first "@@"), empty when not shown */
  patch: string;
  /** the patch was cut short */
  truncated?: boolean;
  /** binary file: no patch */
  binary?: boolean;
  /** why the patch was left out (too large) */
  skipped?: string;
}

export interface SessionDiff {
  /** The first Tether checkpoint for this session, or HEAD/empty for older or new sessions. */
  base: "session" | "HEAD" | "empty";
  files: SessionFileDiff[];
  /** totals over every changed file, including any past the file cap */
  fileCount: number;
  additions: number;
  deletions: number;
  /** some files or patches were left out or cut short */
  truncated: boolean;
}

export type Role = "user" | "assistant" | "notice";

export interface Msg {
  id: string;
  role: Role;
  parts: Part[];
  ts: number;
  /** assistant: "provider/model" that produced it */
  model?: string;
  /** notice: severity */
  level?: "info" | "warning" | "error";
  /** notice: a heading; with `collapsed` the body is folded under it */
  title?: string;
  collapsed?: boolean;
  /** notice: what produced it (agent report, background task, compaction…) */
  source?: "agent" | "task" | "compaction" | "command" | "channel";
  /** assistant: ended in an error */
  error?: string;
  streaming?: boolean;
}

// ---------- live state ----------

export type RunStatus = "idle" | "running" | "waiting";

export interface ModelRef {
  /** "provider/id" for pi, model alias or id for Claude Code */
  id: string;
  label?: string;
}

/**
 * An ordered fallback chain. Entries are "harness:model" ("claude-code:opus",
 * "pi:openai-codex/gpt-6-luna"); a bare model means the session's own harness. Moving down the
 * chain within a harness switches the model; across harnesses it hands the conversation off to a
 * new linked session in the same directory.
 */
export interface ModelProfile {
  name: string;
  chain: string[];
}

export interface ChainEntry {
  harness: HarnessId;
  model: string;
}

export function parseEntry(entry: string, fallback: HarnessId): ChainEntry {
  for (const h of HARNESSES) if (entry.startsWith(h.id + ":")) return { harness: h.id, model: entry.slice(h.id.length + 1) };
  return { harness: fallback, model: entry };
}

export const formatEntry = (e: ChainEntry) => `${e.harness}:${e.model}`;

export interface UiRequest {
  id: string;
  kind: "confirm" | "select" | "input" | "permission" | "question" | "plan";
  title: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  /** permission: tool name and input */
  tool?: { name: string; input: unknown };
  /** question (AskUserQuestion): one or more questions */
  questions?: { question: string; header?: string; options: { label: string; description?: string }[]; multiSelect?: boolean }[];
  /** plan: the agent waits for approval of this plan part; deny (allow: false) with `value` as feedback */
  planId?: string;
}

export interface UiResponse {
  id: string;
  cancelled?: boolean;
  value?: string;
  confirmed?: boolean;
  /** permission */
  allow?: boolean;
  always?: boolean;
  /** question: question text -> answer label(s) */
  answers?: Record<string, string>;
}

export interface LiveState {
  status: RunStatus;
  /** shown while status=waiting (quota reset, backoff) */
  waitingReason?: string;
  waitingUntil?: number;
  model?: string;
  /** model profile the chain came from, if any */
  profile?: string;
  /** this session's fallback order (a copy of the profile, editable per session) */
  chain?: string[];
  /** go back to an earlier chain entry (even across harnesses) once it has reset */
  preferEarlier?: boolean;
  /** linked sessions: where this one came from / went to */
  handoffFrom?: { sessionId: string; reason: string };
  handoffTo?: { sessionId: string; reason: string };
  thinking?: string;
  permissionMode?: string;
  /** who approves tool calls: a person, the guard (rules + judge), or nobody */
  guard?: GuardMode;
  /** git snapshots of the working tree taken before each turn */
  checkpoints?: Checkpoint[];
  /** what the whole session changed (first checkpoint to the working tree), as of the last turn end */
  diffStat?: DiffStat;
  /** modes the harness offers (Claude Code permission modes, ACP session modes) */
  modes?: string[];
  /** thinking/effort levels, when the harness reports them per session */
  thinkingLevels?: string[];
  /** harness-reported queue (kept for older runners; the UI prefers `pending`) */
  queued: string[];
  /** work the agent keeps running between turns (Claude Code background agents, shells, …) */
  background?: BackgroundTask[];
  /** messages you sent that the agent has not taken yet; they enter the transcript once it does */
  pending?: PendingMessage[];
  /** after Stop: pending messages wait until you send them */
  pendingHeld?: boolean;
  /** user messages steered into the running turn; editing one sends a correction */
  amendable?: string[];
  statuses: Record<string, string>;
  pendingUi: UiRequest[];
  cost?: number;
  /** older runners: context window used, 0-100 (newer ones send `context`) */
  contextPercent?: number;
  /** how full the model's context window is, as of its last request */
  context?: ContextUsage;
}

export interface ContextUsage {
  /** tokens the model saw on its last request (input + cache read + cache write); unknown right after compaction */
  used?: number;
  /** the model's context window */
  max?: number;
  /** the model these numbers are for */
  model?: string;
  /** breakdown of `used`, when the harness reports one */
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** `max` is Tether's guess from the model name; the harness hasn't reported it */
  maxEstimated?: boolean;
}

export interface UsageWindow {
  /** "5h", "Weekly", "Weekly · Opus", … */
  label: string;
  /** percent of the window used, 0-100 */
  percent?: number;
  resetsAt?: number;
}

export interface ProviderUsage {
  provider: "claude" | "codex";
  label: string;
  plan?: string;
  windows: UsageWindow[];
  limited?: boolean;
  error?: string;
}

export interface UsageReport {
  providers: ProviderUsage[];
  fetchedAt: number;
}

/** Which subscription's limits a harness/model draws on (undefined: pay-as-you-go or unknown). */
export function usageProvider(harness: string | undefined, model?: string): ProviderUsage["provider"] | undefined {
  if (harness === "claude-code") return "claude";
  if (harness === "codex") return "codex";
  if (model?.startsWith("openai-codex/")) return "codex";
  return undefined;
}

export interface BackgroundTask {
  id: string;
  description: string;
  /** "local_agent", "local_bash", … */
  type?: string;
}

// ---------- notifications ----------

export type NotifyKind = "question" | "finished" | "blocked";

export const NOTIFY_KINDS: { id: NotifyKind; label: string; hint: string }[] = [
  { id: "question", label: "Questions", hint: "The agent asks you something or waits for an approval" },
  { id: "finished", label: "Finished", hint: "A turn ends" },
  { id: "blocked", label: "Blocked", hint: "The guard blocks a call, every model is at its usage limit, the agent goes quiet or fails" },
];

export interface AgentNotice {
  id: string;
  kind: NotifyKind;
  title: string;
  body: string;
  sessionId: string;
  projectPath: string;
  /** project folder name */
  project: string;
  ts: number;
}

export interface PendingMessage {
  id: string;
  text: string;
  /** steer: folded into the running turn; followUp: runs after it */
  mode: "steer" | "followUp";
  ts: number;
  /** steer: when its grace period ends and it may go to the agent */
  readyAt?: number;
}

export interface SessionSummary {
  /** runner-unique: `${harness}:${nativeId}` */
  id: string;
  harness: HarnessId;
  nativeId: string;
  projectPath: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  live: boolean;
  status: RunStatus;
  /** waiting on a permission prompt or question */
  needsInput?: boolean;
  /** archived or removed: listed only behind the project's "Archived (n)" toggle */
  archived?: boolean;
}

export interface SessionSearchResult {
  session: SessionSummary;
  /** Matching text from a message you sent, or the session title. */
  excerpt: string;
  ts: number;
}

export interface ProjectInfo {
  path: string;
  name: string;
  sessionCount: number;
  updatedAt: number;
  pinned: boolean;
  /** sessions with a running agent process, so a collapsed project can list them without listSessions */
  live: SessionSummary[];
  /** hidden from the project list (nothing is deleted) */
  archived?: boolean;
}

export interface SessionSnapshot {
  session: SessionSummary;
  messages: Msg[];
  state: LiveState;
  seq: number;
}

// ---------- events (runner -> server -> browsers) ----------

export type SessionEvent =
  | { type: "msg"; msg: Msg } // insert or replace by id
  | { type: "delta"; msgId: string; part: number; kind: "text" | "thinking"; text: string }
  | { type: "tool"; msgId: string; toolId: string; patch: Partial<Extract<Part, { type: "tool" }>> }
  | { type: "state"; state: Partial<LiveState> }
  | { type: "reset"; messages: Msg[] } // compaction, fork: replace transcript
  | { type: "toast"; level: "info" | "warning" | "error"; text: string };

// ---------- master context (shared memory and skills, docs/master-context.md) ----------

export type MemoryType = "user" | "feedback" | "project" | "reference";

export interface MemoryEntry {
  /** path inside the store's memory/ folder without ".md": "global/<slug>" or "repos/<dir>/<slug>" */
  id: string;
  slug: string;
  name: string;
  description: string;
  type: MemoryType;
  /** "global" or "repo:<repo-key>" */
  scope: string;
  /** provenance, e.g. "claude:~/.claude/projects/-home-ubuntu-x/memory/y.md", "mcp:claude-code:<id>" */
  sources: string[];
  /** ISO timestamp */
  updated: string;
  body: string;
}

export interface MemoryCommit {
  sha: string;
  ts: number;
  message: string;
  /** unified diff of this entry in that commit */
  patch?: string;
}

export type ContextActivityKind =
  | "new"
  | "duplicate"
  | "update"
  | "contradicts"
  | "edit"
  | "delete"
  | "resolve"
  | "import"
  | "export"
  | "skill"
  | "drift"
  | "error";

export interface ContextActivity {
  id: string;
  ts: number;
  kind: ContextActivityKind;
  text: string;
  memoryId?: string;
  /** where the change came from (a source path, "mcp", "you") */
  source?: string;
  commit?: string;
  /** the Tether session that produced it, when known */
  sessionId?: string;
}

export type ConflictStatus = "open" | "kept-new" | "kept-old" | "dismissed";

/** A new memory contradicted an existing one. Newest wins until you say otherwise. */
export interface MemoryConflict {
  id: string;
  memoryId: string;
  name: string;
  scope: string;
  oldBody: string;
  newBody: string;
  /** the two claims, one sentence each */
  oldClaim?: string;
  newClaim?: string;
  source: string;
  /** the Tether session that produced the new claim, for the inline card */
  sessionId?: string;
  /** the commit that applied the new version ("Keep old" restores the file from before it) */
  commit?: string;
  ts: number;
  status: ConflictStatus;
}

export interface ContextSkill {
  name: string;
  /** name in harness skill dirs when a builtin already uses `name` (`<name>-tether`) */
  exposedAs?: string;
  description?: string;
  /** where copies were found ("claude", "codex", …) with their paths */
  sources: { harness: string; path: string }[];
  /** copies that differed from the one kept (the newest) */
  drift?: string[];
  enabled: boolean;
  /** repo-scoped skills (repo .claude/skills, .agents/skills) are listed but left in place */
  repo?: string;
}

/** What "Import" will do, shown by the first-run wizard before anything is touched. */
export interface ContextImportPreview {
  memories: { harness: string; path: string; title: string; scope: string }[];
  skills: { name: string; from: string; drift: string[]; exposedAs?: string }[];
  /** real directories that will be moved to the backup folder and replaced by symlinks */
  backups: { path: string; skill: string; to: string }[];
  /** symlinks that will be created */
  symlinks: { path: string; target: string }[];
  /** files where Tether will add or update its managed block / own file */
  managedFiles: string[];
  /** MCP configs where `tether-context` will be registered */
  mcpConfigs: string[];
  /** sources that couldn't be read (shown, not fatal) */
  warnings: string[];
}

export interface ContextStatus {
  /** import has run: watchers, merge, export and session injection are on */
  enabled: boolean;
  importedAt?: number;
  dir: string;
  memories: number;
  skills: number;
  openConflicts: number;
  /** a merge pass is running */
  busy: boolean;
}

/** Background model shared by the safety judge and the memory merge: "harness:model". */
export interface BackgroundModelSetting {
  model: string;
  /** harnesses that can run background work on this runner */
  harnesses: HarnessId[];
}

/** runner -> browsers, not tied to one session */
export type ContextEvent =
  | { type: "activity"; activity: ContextActivity }
  | { type: "conflict"; conflict: MemoryConflict }
  | { type: "status"; status: ContextStatus };

// ---------- RPC ops (browser -> server -> runner) ----------

export interface Ops {
  listProjects: { args: {}; result: ProjectInfo[] };
  addProject: { args: { path: string }; result: ProjectInfo };
  removeProject: { args: { path: string }; result: {} };
  archiveProject: { args: { path: string; archived: boolean }; result: {} };
  listDirs: { args: { path?: string }; result: { path: string; dirs: string[] } };
  listSessions: { args: { projectPath: string }; result: SessionSummary[] };
  searchSessions: { args: { query: string }; result: SessionSearchResult[] };
  createSession: {
    args: { projectPath: string; harness: HarnessId; model?: string; profile?: string; prompt?: string; permissionMode?: string; guard?: GuardMode };
    result: SessionSummary;
  };
  /** projectPath (optional) saves the runner a search of every project for a stored session */
  openSession: { args: { sessionId: string; projectPath?: string }; result: SessionSnapshot };
  closeSession: { args: { sessionId: string }; result: {} };
  archiveSession: { args: { sessionId: string; archived: boolean }; result: {} };
  /** Stops the agent process (aborting a running turn, dropping unsent messages) and archives the session. Nothing on disk is deleted. */
  removeSession: { args: { sessionId: string }; result: {} };
  prompt: { args: { sessionId: string; text: string; mode?: "steer" | "followUp" }; result: {} };
  abort: { args: { sessionId: string }; result: {} };
  setModel: { args: { sessionId: string; model?: string; profile?: string }; result: {} };
  setGuard: { args: { sessionId: string; mode: GuardMode }; result: {} };
  /** the whole session, or with `checkpoint` the one turn that started at that checkpoint */
  getSessionDiff: { args: { sessionId: string; checkpoint?: string }; result: SessionDiff };
  approveBlocked: { args: { sessionId: string; toolId: string }; result: {} };
  guardSetup: {
    args: { install?: boolean; judgeModel?: string; defaultMode?: GuardMode };
    result: { antigravityHook: boolean; judgeModel: string; defaultMode: GuardMode };
  };
  setChain: { args: { sessionId: string; chain: string[]; preferEarlier?: boolean }; result: {} };
  setThinking: { args: { sessionId: string; level: string }; result: {} };
  setPermissionMode: { args: { sessionId: string; mode: string }; result: {} };
  editPending: {
    args: { sessionId: string; id: string; text?: string; mode?: "steer" | "followUp"; index?: number; remove?: boolean; now?: boolean };
    result: {};
  };
  takePending: { args: { sessionId: string }; result: { text: string } };
  /** Web Push: the runner's key, and this device's subscription if any (by endpoint) */
  pushStatus: { args: { endpoint?: string }; result: { publicKey: string; kinds?: NotifyKind[] } };
  pushSubscribe: {
    args: { subscription: { endpoint: string; keys: { p256dh: string; auth: string } }; kinds: NotifyKind[]; label?: string };
    result: {};
  };
  pushUnsubscribe: { args: { endpoint: string }; result: {} };
  pushTest: { args: { endpoint: string }; result: {} };
  listNotifications: { args: {}; result: AgentNotice[] };
  amendSteer: { args: { sessionId: string; msgId: string; text: string }; result: {} };
  uiRespond: { args: { sessionId: string; response: UiResponse }; result: {} };
  getUsage: { args: { force?: boolean }; result: UsageReport };
  renameSession: { args: { sessionId: string; projectPath: string; title: string }; result: {} };
  listModels: { args: { harness: HarnessId; sessionId?: string }; result: { models: ModelRef[]; thinkingLevels: string[]; permissionModes: string[] } };
  getProfiles: { args: {}; result: ModelProfile[] };
  setProfiles: { args: { profiles: ModelProfile[] }; result: ModelProfile[] };
  listCommands: { args: { sessionId: string }; result: { name: string; description?: string }[] };
  // master context
  contextStatus: { args: {}; result: ContextStatus };
  /** scope: "global", "repo:<key>", or a project path (resolved to its repo key); query searches */
  listMemories: { args: { scope?: string; query?: string }; result: MemoryEntry[] };
  getMemory: { args: { id: string }; result: MemoryEntry };
  /** edits are commits; remove deletes the entry */
  editMemory: {
    args: { id: string; name?: string; description?: string; type?: MemoryType; body?: string; remove?: boolean };
    result: MemoryEntry | {};
  };
  memoryHistory: { args: { id: string }; result: MemoryCommit[] };
  contextActivity: { args: { limit?: number; before?: number }; result: ContextActivity[] };
  listConflicts: { args: { status?: ConflictStatus | "all" }; result: MemoryConflict[] };
  resolveConflict: { args: { id: string; action: "keep-new" | "keep-old" | "dismiss" }; result: MemoryConflict };
  listSkills: { args: {}; result: ContextSkill[] };
  setSkillEnabled: { args: { name: string; enabled: boolean }; result: ContextSkill[] };
  /** dry run of the first import: reads sources, touches nothing */
  contextImportPreview: { args: {}; result: ContextImportPreview };
  /** the first-run "Import" button: imports, backs up and symlinks skills, exports, then keeps syncing */
  contextImport: { args: {}; result: ContextStatus };
  /** turns the context off and removes every tether-context MCP registration Tether made; keeps the store */
  contextDisable: { args: {}; result: ContextStatus };
  getBackgroundModel: { args: {}; result: BackgroundModelSetting };
  setBackgroundModel: { args: { model: string }; result: BackgroundModelSetting };
}

export type OpName = keyof Ops;

// ---------- wire messages ----------

export interface RunnerInfo {
  id: string;
  hostname: string;
  version: string;
  harnesses: HarnessId[];
  connected: boolean;
}

/** runner -> server */
export type RunnerToServer =
  | { t: "hello"; runner: Omit<RunnerInfo, "connected"> }
  | { t: "result"; id: string; ok: boolean; data?: unknown; error?: string }
  | { t: "event"; sessionId: string; seq: number; event: SessionEvent }
  | { t: "sessions"; projectPath?: string; session?: SessionSummary }
  | { t: "context"; event: ContextEvent }
  | { t: "pong" };

/** server -> runner */
export type ServerToRunner = { t: "rpc"; id: string; op: OpName; args: unknown } | { t: "ping" };

/** browser -> server */
export type BrowserToServer = { t: "rpc"; id: string; runnerId: string; op: OpName; args: unknown } | { t: "ping" };

/** server -> browser */
export type ServerToBrowser =
  | { t: "hello"; user: { name: string; email: string } }
  | { t: "runners"; runners: RunnerInfo[] }
  | { t: "result"; id: string; ok: boolean; data?: unknown; error?: string }
  | { t: "event"; runnerId: string; sessionId: string; seq: number; event: SessionEvent }
  | { t: "sessions"; runnerId: string; projectPath?: string; session?: SessionSummary }
  | { t: "context"; runnerId: string; event: ContextEvent }
  | { t: "pong" };
