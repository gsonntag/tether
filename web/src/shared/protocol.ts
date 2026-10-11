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
  /** A file attached to a user message, stored on the runner (web/src/shared/attachments.ts). */
  | { type: "file"; path: string; name: string; mimeType: string; size: number }
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
    }
  | {
      /**
       * A skill sent inline with a user message (`/name args` on a harness that can't run that
       * skill itself, or pi's own `/skill:name`): a chip that expands to what the agent got.
       */
      type: "skill";
      name: string;
      /** SKILL.md */
      location?: string;
      content: string;
    };

export type GuardMode = "ask" | "edits" | "auto" | "full";
/** Who approves tool calls, strictest first. "ask" also asks before edits inside the project. */
/**
 * Harness modes that approve tool calls on their own, before the guard is asked. The mode picker
 * never offers them and a resume never restores them: the guard setting decides approvals.
 */
export const APPROVING_MODES = new Set(["acceptEdits", "auto", "bypassPermissions", "dontAsk", "accept-edits", "yolo"]);

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
  source?: "agent" | "task" | "compaction" | "command" | "channel" | "memory";
  /** assistant: ended in an error */
  error?: string;
  streaming?: boolean;
}

import type { Attachment } from "./attachments";
export type { Attachment } from "./attachments";

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
  /** older runners: work the agent keeps running between turns (newer ones send `activity`) */
  background?: BackgroundTask[];
  /** subagents, shells, monitors, wakeups… running now, plus the last few that finished */
  activity?: ActivityItem[];
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

/** Older runners' flat list (newer ones send `activity`); also what a restart reports as stopped. */
export interface BackgroundTask {
  id: string;
  description: string;
  /** "local_agent", "local_bash", … */
  type?: string;
}

// ---------- activity: everything a session has going on besides the transcript ----------

export type ActivityKind = "subagent" | "shell" | "monitor" | "schedule" | "workflow" | "tool" | "other";
/** running: working now; waiting: armed for later (a wakeup, a cron job) */
export type ActivityStatus = "running" | "waiting" | "done" | "failed" | "stopped";

export const ACTIVITY_KINDS: { id: ActivityKind; label: string; plural: string }[] = [
  { id: "subagent", label: "agent", plural: "agents" },
  { id: "shell", label: "shell", plural: "shells" },
  { id: "monitor", label: "monitor", plural: "monitors" },
  { id: "workflow", label: "workflow", plural: "workflows" },
  { id: "schedule", label: "scheduled", plural: "scheduled" },
  { id: "tool", label: "tool call", plural: "tool calls" },
  { id: "other", label: "task", plural: "tasks" },
];

/** One tool call inside a subagent: its mini-transcript. */
export interface ActivityStep {
  id: string;
  tool: string;
  /** "Editing Sidebar.tsx", "Running bun test" */
  label: string;
  status: ToolStatus;
  ts: number;
}

export interface ActivityItem {
  id: string;
  kind: ActivityKind;
  title: string;
  /** the subagent's prompt, the cron job's prompt, … */
  description?: string;
  status: ActivityStatus;
  startedAt: number;
  endedAt?: number;
  /** the transcript tool call that started it */
  toolId?: string;
  /** the subagent that started it (a subagent's own shells and agents) */
  parentId?: string;
  /** runs on its own while the turn goes on (false: the turn waits for it) */
  background?: boolean;
  /** Stop works on it */
  stoppable?: boolean;
  // subagent
  agentType?: string;
  model?: string;
  toolUses?: number;
  tokens?: number;
  /** what it's doing now ("Editing Sidebar.tsx"), or the harness's own progress line */
  latest?: string;
  /** its recent tool calls, oldest first */
  steps?: ActivityStep[];
  worktree?: { path?: string; branch?: string };
  /** the final report, or why it failed */
  summary?: string;
  // shell, monitor
  command?: string;
  /** the last lines of output */
  output?: string;
  // monitor, schedule
  /** what's watched or what will run ("check the build") */
  watching?: string;
  /** when it fires next */
  nextAt?: number;
  /** "every 30 minutes" */
  schedule?: string;
}

export const ACTIVITY_KEEP_FINISHED = 20;
export const ACTIVITY_MAX_STEPS = 40;
export const isActive = (a: ActivityItem) => a.status === "running" || a.status === "waiting";

// ---------- notifications ----------

export type NotifyKind = "question" | "finished" | "blocked" | "memory";

export const NOTIFY_KINDS: { id: NotifyKind; label: string; hint: string }[] = [
  { id: "question", label: "Questions", hint: "The agent asks you something or waits for an approval" },
  { id: "finished", label: "Finished", hint: "A turn ends" },
  { id: "blocked", label: "Blocked", hint: "The guard blocks a call, every model is at its usage limit, the agent goes quiet or fails" },
  { id: "memory", label: "Memory conflicts", hint: "A new memory contradicts an older one (the newest was kept)" },
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
  /** kind "memory": the (newest) conflict it is about, for the Memory page link */
  conflictId?: string;
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
  /** activity items running or armed right now (subagents, shells, …) */
  activeCount?: number;
  /**
   * Of those, the ones doing work now (not an armed wakeup or cron job), by kind: with an idle
   * status, the session is still working in the background.
   */
  runningKinds?: Partial<Record<ActivityKind, number>>;
  /** of those, the ones working now (not an armed wakeup or cron job); sent with activeCount */
  workingCount?: number;
}

/**
 * How session lists sort: by the time of the most recent user or agent message (`updatedAt`),
 * newest first, whether or not the session is live. Ties go by id, so the order is stable.
 */
export function byRecent(a: Pick<SessionSummary, "id" | "updatedAt">, b: Pick<SessionSummary, "id" | "updatedAt">): number {
  return b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Web app preferences kept in the runner's config (getUiPrefs / setUiPrefs). */
export interface UiPrefs {
  /** sidebar project lists show sessions whose latest message is this recent, in days; 0 = all */
  sidebarDays: number;
}
/** The sidebar windows on offer, in days (0 = all). */
export const SIDEBAR_DAYS = [1, 3, 7, 30, 0] as const;
export const DEFAULT_SIDEBAR_DAYS = 3;

/** A live session's activity, for the runner-wide Running page. */
export interface SessionActivity {
  session: SessionSummary;
  items: ActivityItem[];
}

/**
 * A session at a glance, for the Home dashboard. The runner pushes one whenever a session changes
 * (at most about once a second per session), so every browser sees every runner's sessions live
 * without opening them. Kept small: no transcript, tool inputs clipped.
 */
export interface SessionPulse {
  session: SessionSummary;
  model?: string;
  /** what it's doing now: "Running bun test", "Thinking", "Waiting for approval", a wait reason */
  action?: string;
  /** when the current turn started (status running) */
  turnStartedAt?: number;
  /** activity items running now, by kind */
  activity?: Partial<Record<ActivityKind, number>>;
  /** armed wakeups and cron jobs */
  armed?: number;
  context?: { used?: number; max?: number };
  /** permission prompts and questions waiting on you (tool inputs clipped) */
  pendingUi?: UiRequest[];
  /** the last line the agent wrote */
  lastText?: string;
  /** what the whole session changed, as of its last turn end */
  diffStat?: DiffStat;
  /** when its last turn ended */
  finishedAt?: number;
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
  /** insert or replace activity items by id (see upsertActivity) */
  | { type: "activity"; items: ActivityItem[] }
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
  /** what the running import / sync pass is doing, with counts when known */
  progress?: ContextProgress;
}

/** What turning the master context off undid, for the page to show afterwards. */
export interface ContextTurnedOff {
  /** harness files Tether cleaned (~-shortened): managed blocks, MCP entries, its own files */
  files: string[];
  /** skill symlinks removed / skill copies put back as real dirs */
  skillLinks: number;
  restoredSkills: number;
  warnings: string[];
}

export interface ContextProgress {
  phase: "skills" | "scan" | "merge" | "export" | "disable";
  done: number;
  total: number;
}

/** Background model shared by the safety judge and the memory merge: "harness:model". */
export interface BackgroundModelSetting {
  model: string;
  /** the Auto-mode safety judge runs on this model; false: turned off */
  judge: boolean;
  /** harnesses that can run background work on this runner */
  harnesses: HarnessId[];
}

/** runner -> browsers, not tied to one session */
export type ContextEvent =
  | { type: "activity"; activity: ContextActivity }
  | { type: "conflict"; conflict: MemoryConflict }
  | { type: "status"; status: ContextStatus };

/** An entry in the composer's `/` menu. */
export interface SlashCommand {
  name: string;
  description?: string;
  /** absent: a harness command (older runners send only these) */
  kind?: "command" | "skill";
  /** skill: where it comes from ("claude", "codex", "agents", "repo", …), for badges */
  sources?: string[];
  /** skill: the harness runs it itself; otherwise Tether sends SKILL.md along with the message */
  native?: boolean;
}

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
  /** attachments: files uploaded with uploadAttachment, listed at the end of the message */
  prompt: { args: { sessionId: string; text: string; mode?: "steer" | "followUp"; attachments?: Attachment[] }; result: {} };
  /**
   * One chunk of a file attached to a message (base64 `data` at byte `offset`). Chunks may arrive
   * in any order; the one that completes the file returns it.
   */
  uploadAttachment: {
    args: { sessionId: string; uploadId: string; name: string; mimeType: string; size: number; offset: number; data: string };
    result: { attachment?: Attachment };
  };
  /** Drops an upload removed from the composer before it was sent (by path once done, else by upload id). */
  discardAttachment: { args: { sessionId: string; path?: string; uploadId?: string }; result: {} };
  /** Reads part of an attachment (any session's) for the transcript: thumbnails and downloads. */
  readAttachment: { args: { path: string; offset?: number; length?: number }; result: { data: string; size: number; mimeType: string } };
  abort: { args: { sessionId: string }; result: {} };
  setModel: { args: { sessionId: string; model?: string; profile?: string }; result: {} };
  setGuard: { args: { sessionId: string; mode: GuardMode }; result: {} };
  /** the whole session, or with `checkpoint` the one turn that started at that checkpoint */
  getSessionDiff: { args: { sessionId: string; checkpoint?: string }; result: SessionDiff };
  approveBlocked: { args: { sessionId: string; toolId: string }; result: {} };
  /** stops one activity item (a subagent, shell, monitor…) where the harness can */
  stopActivity: { args: { sessionId: string; id: string }; result: {} };
  /** live sessions with activity, running items first; `recentMs` also keeps items that ended that recently */
  listActivity: { args: { recentMs?: number }; result: SessionActivity[] };
  /** the Home dashboard: every live session, plus sessions whose turn ended recently (newest first) */
  listPulses: { args: {}; result: SessionPulse[] };
  guardSetup: {
    /** judgeModel is legacy: "off" turns the judge off, anything else turns it on (setJudgeEnabled) */
    /** `install` is ignored: runners pass the Antigravity hook to each agy process themselves */
    args: { install?: boolean; judgeModel?: string; defaultMode?: GuardMode };
    /** judgeModel: the background model when the judge is on, else "off" */
    result: { antigravityHook: boolean; judgeModel: string; judgeEnabled: boolean; defaultMode: GuardMode };
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
  /** `stale`: no request with that id was waiting (already answered, timed out or cancelled); nothing happened */
  uiRespond: { args: { sessionId: string; response: UiResponse }; result: { stale?: boolean } };
  getUsage: { args: { force?: boolean }; result: UsageReport };
  renameSession: { args: { sessionId: string; projectPath: string; title: string }; result: {} };
  listModels: { args: { harness: HarnessId; sessionId?: string }; result: { models: ModelRef[]; thinkingLevels: string[]; permissionModes: string[] } };
  getProfiles: { args: {}; result: ModelProfile[] };
  setProfiles: { args: { profiles: ModelProfile[] }; result: ModelProfile[] };
  /** the `/` menu: the harness's own commands and the skills this session can run */
  listCommands: { args: { sessionId: string }; result: SlashCommand[] };
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
  /**
   * Turns the master context off: stops watching, removes every export (managed blocks, MCP
   * registrations, Tether's own files, skill symlinks — replaced copies are put back as real
   * copies). The store and its backups are kept; importing again turns it back on.
   */
  contextDisable: { args: {}; result: ContextStatus & { turnedOff?: ContextTurnedOff } };
  getBackgroundModel: { args: {}; result: BackgroundModelSetting };
  setBackgroundModel: { args: { model: string }; result: BackgroundModelSetting };
  setJudgeEnabled: { args: { enabled: boolean }; result: BackgroundModelSetting };
  /** web app preferences kept on the runner, so every device shares them */
  getUiPrefs: { args: {}; result: UiPrefs };
  setUiPrefs: { args: Partial<UiPrefs>; result: UiPrefs };
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
  /** dashboard updates, throttled per session */
  | { t: "pulse"; pulses: SessionPulse[] }
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
  | { t: "pulse"; runnerId: string; pulses: SessionPulse[] }
  | { t: "pong" };
