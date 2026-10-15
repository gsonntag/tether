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

/**
 * Harnesses whose sessions open only by starting their agent (it alone can replay the
 * conversation). The others show a stored conversation without it; the agent starts when you send.
 */
export const STARTS_ON_OPEN: ReadonlySet<HarnessId> = new Set<HarnessId>(["kiro"]);

// ---------- transcript ----------

export type ToolStatus = "running" | "done" | "error";
/** A tool call by what it does: "search" looks through files, "fetch" reads the web, "task" runs a subagent. */
export type ToolKind = "shell" | "edit" | "write" | "read" | "search" | "fetch" | "todo" | "task" | "other";

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
      /** What the call is, whatever the harness names it (runner/src/toolKind.ts). Older transcripts lack it. */
      kind?: ToolKind;
      /** the command a shell call runs */
      command?: string;
      /** the file (or folder) a read, edit or write is about */
      path?: string;
      /** Set when the tool ran inside a subagent (Claude Code Task tool). */
      parentToolId?: string;
      /** The guard's verdict on this call */
      guard?: GuardVerdict;
      /** The guard's judge model is deciding this call; cleared by the verdict or the call ending. */
      judging?: boolean;
      /** A blocked shell command the user ran from Tether instead ("Run it myself"). */
      userRun?: { status: "running" | "done"; exitCode?: number; output?: string };
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
  /** hook: one of your PreToolUse hooks (runner/src/hooks.ts) */
  by: "rule" | "judge" | "user" | "mode" | "hook";
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

/** A file reference in the transcript, checked by the runner (checkPaths). */
export interface PathCheck {
  /** relative to the project directory, normalized */
  path: string;
  /** a regular file there now */
  exists: boolean;
  /** differs from the session's first checkpoint (deleted files too) */
  changed: boolean;
}

/** How one turn changed one file (fileDiff). */
export interface FileTurnStat {
  checkpoint: string;
  /** 0-based position among the session's kept checkpoints ("Turn index + 1") */
  index: number;
  label: string;
  ts: number;
  additions: number;
  deletions: number;
  binary?: boolean;
}

/** One file's changes, for the file panel. */
export interface FileDiffResult {
  /** relative to the project directory */
  path: string;
  exists: boolean;
  base: SessionDiff["base"];
  /** absent: the file didn't change in that scope */
  file?: SessionFileDiff;
  /** the turns that changed this file, oldest first */
  turns: FileTurnStat[];
  /** a credential or secrets file (.env, keys, tokens…, by the guard's rules) */
  sensitive?: boolean;
  /** its lines were left out (`file.patch` empty): a secrets file the user hasn't asked to see */
  withheld?: boolean;
}

/** A project file as it is now (readFile). */
export interface FileContents {
  path: string;
  size: number;
  /** UTF-8 text; absent for binary files */
  content?: string;
  binary?: boolean;
  /** cut short: past the byte cap, or past the line cap */
  truncated?: "bytes" | "lines";
  /** a credential or secrets file (.env, keys, tokens…, by the guard's rules) */
  sensitive?: boolean;
  /** content left out: a secrets file the user hasn't asked to see (ask again with `reveal`) */
  withheld?: boolean;
}

/** A piece of a project file's raw bytes (base64), for previews and downloads. */
export interface FileChunk {
  path: string;
  size: number;
  offset: number;
  data: string;
  mimeType: string;
  sensitive?: boolean;
  /** a secrets file the user hasn't asked to see: nothing sent (ask again with `reveal`) */
  withheld?: boolean;
}

/** Downloads and previews of project files: the largest file, and how much one request carries. */
export const FILE_DOWNLOAD_LIMITS = { bytes: 100 * 1024 * 1024, chunk: 256 * 1024 };

/** Caps for the file panel's File tab. */
export const FILE_VIEW_LIMITS = { bytes: 1024 * 1024, lines: 20_000 };

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
  source?: "agent" | "task" | "compaction" | "command" | "channel" | "memory" | "leader";
  /** assistant: ended in an error */
  error?: string;
  streaming?: boolean;
  /**
   * notice: a button under it. "continueOn": move the session to a chain entry (continueOn op);
   * "mcpAuth": sign in to a registry MCP server (startMcpAuth)
   */
  action?: { kind: "continueOn"; label: string; entry: string } | { kind: "mcpAuth"; label: string; server: string };
}

import type { Attachment } from "./attachments";
export type { Attachment } from "./attachments";
import type { PlanDraft, PlanReviewState } from "./plan";

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
  /** only the user's own click answers it, never the leader agent (it gives an agent more permission) */
  userOnly?: boolean;
  /**
   * a question the leader agent may answer as the user tells it (Tether's ask_user, Claude's
   * AskUserQuestion, Codex's requestUserInput); plans too. Nothing else is (an allowlist).
   */
  leaderMay?: boolean;
}

// ---------- goal (/goal, runner/src/goal.ts) ----------

/** active: Tether keeps the agent going; the others stop the loop until resumed. */
export type GoalStatus = "active" | "paused" | "done" | "blocked" | "budget";

/** An optional limit the user set; a goal without one runs until it's done. */
export interface GoalBudget {
  turns?: number;
  tokens?: number;
  /** wall time while active, in ms */
  ms?: number;
}

export interface GoalNote {
  ts: number;
  text: string;
  /** agent: goal_update; tether: the loop, the guard or the done check; user: a /goal command */
  by: "agent" | "tether" | "user";
}

export interface SessionGoal {
  objective: string;
  status: GoalStatus;
  budget?: GoalBudget;
  /** what the goal has used so far (tokens: as the harness reports them, approximate) */
  used: { turns: number; tokens: number; ms: number };
  /** progress notes, oldest first (capped) */
  notes: GoalNote[];
  /** why it stopped, for paused / blocked / budget / done */
  reason?: string;
  createdAt: number;
  updatedAt: number;
  /** the harness's own goal mirrors it (Codex thread goals) */
  native?: boolean;
}

// ---------- loops and schedules (/loop, /schedule, runner/src/schedule.ts) ----------

/**
 * A prompt the runner sends to the session on a timer, as a queued user message:
 *   loop  every `everyMs` (/loop 10m …)
 *   cron  on a 5-field cron expression in the runner's local time (/schedule 0 9 * * 1-5 …)
 *   once  once, at `nextAt` (/schedule at 15:00 …, /schedule in 2h …)
 */
export interface SessionSchedule {
  id: string;
  kind: "loop" | "cron" | "once";
  prompt: string;
  everyMs?: number;
  cron?: string;
  /** how it was written: "every 10m", "0 9 * * 1-5", "at 15:00" */
  label: string;
  /** when it runs next */
  nextAt: number;
  lastRunAt?: number;
  runs: number;
  createdAt: number;
}

// ---------- plan and todos (plan_set / todo_set, runner/src/plan.ts) ----------

export interface TodoItem {
  text: string;
  status: "pending" | "in_progress" | "completed";
}

/**
 * The session's plan, kept by Tether so it survives a handoff: the latest plan the agent wrote
 * (plan_set, Claude Code's ExitPlanMode, a Codex plan-mode plan, …) and its todo list.
 *   draft     written, not (yet) up for review
 *   review    waiting for the user's approval
 *   approved  the user approved it
 *   feedback  the user sent it back with comments
 */
export interface SessionPlan {
  text: string;
  todos: TodoItem[];
  status: "draft" | "review" | "approved" | "feedback";
  /** the transcript's plan part that shows it */
  partId?: string;
  updatedAt: number;
}

// ---------- review (/review, runner/src/review.ts) ----------

export type ReviewSeverity = "critical" | "high" | "medium" | "low";

/** One finding a review reported (the tether-context tool review_report). */
export interface ReviewFinding {
  /** relative to the project directory */
  file: string;
  /** in the file as it is now */
  line?: number;
  severity: ReviewSeverity;
  issue: string;
  fix: string;
}

/**
 * A review of the session's changes (/review), run by another harness or model in a read-only
 * session of its own, shown as one card in the session it reviewed.
 *   starting  the review session is being started
 *   running   the reviewer is working
 *   done      it reported (findings may be empty)
 *   failed    it ended without a report, or couldn't start (`error`)
 */
export interface SessionReview {
  id: string;
  status: "starting" | "running" | "done" | "failed";
  /** the review session, once it exists */
  sessionId?: string;
  harness: HarnessId;
  model?: string;
  focus?: string;
  /** what was reviewed: the session's changes when the review started */
  stat?: DiffStat;
  findings: ReviewFinding[];
  /** the reviewer's one-line verdict */
  summary?: string;
  error?: string;
  /** findings already sent to the agent, by index */
  sent: number[];
  /** the card sits after this transcript message (the last one when the review started) */
  afterMsgId?: string;
  createdAt: number;
  updatedAt: number;
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
  /** plan, with allow: false: `value` asks to talk the plan over, not to revise it (it stays under review) */
  discuss?: boolean;
  /** who answered: the user (default), or the leader agent passing on what the user said (never a permission) */
  by?: "user" | "leader";
}

export interface LiveState {
  status: RunStatus;
  /** shown while status=waiting (quota reset, backoff) */
  waitingReason?: string;
  waitingUntil?: number;
  /** a check running between turns, shown inline in the chat ("Checking usage on GPT-5…"); null when done (undefined doesn't survive JSON) */
  checking?: string | null;
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
  /** a fork ("Fork from here"): the session it was forked from, and where */
  forkedFrom?: { sessionId: string; reason: string };
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
  /** the session's goal (/goal); Tether keeps the agent working while it is active. null: cleared
   *  (an undefined field doesn't survive JSON, so browsers would keep the old goal) */
  goal?: SessionGoal | null;
  /** the session's plan and todo list (null: none; see SessionGoal for why not undefined) */
  plan?: SessionPlan | null;
  /** Tether's loops and schedules (/loop, /schedule), soonest first; [] when none */
  schedules?: SessionSchedule[];
  /** reviews of this session's changes (/review), oldest first */
  reviews?: SessionReview[];
  /** this session is a read-only review of another one (/review): the guard holds back every change */
  reviewOf?: { sessionId: string; reviewId: string };
  /** plan reviews by plan id (shared/plan.ts); present (maybe empty) once the runner keeps them */
  plans?: Record<string, PlanReviewState>;
  /** cross-harness subagents this session started (agent_start, runner/src/crossAgents.ts), oldest first */
  subagents?: SubagentLink[];
  /** this session is a cross-harness subagent: who started it */
  startedBy?: StartedBy;
  /** this session is the runner's leader agent (runner/src/leader.ts) */
  leader?: boolean;
}

/** A cross-harness subagent: a Tether session started by another one with agent_start. */
export interface SubagentLink {
  /** its name, unique among the parent's subagents: what the agent_* tools take as `id` */
  id: string;
  /** the subagent's session (the latest, if it moved on to another session since) */
  sessionId: string;
  harness: HarnessId;
  model?: string;
  effort?: string;
  mode?: string;
  guard: GuardMode;
  task: string;
  cwd: "worktree" | "shared";
  /** where it works */
  path: string;
  /** cwd "worktree": its git worktree, branch and the commit it started from */
  worktree?: { path: string; branch: string; base: string; repo?: string };
  /** working: a turn is running; waiting: it waits for the user (a question or an approval) */
  status: "working" | "waiting" | "finished" | "failed" | "stopped";
  startedAt: number;
  endedAt?: number;
  /** turns it has ended, and how many of those the parent was told about (agent_wait or a message) */
  turns: number;
  told: number;
  /** the start of its last report */
  report?: string;
  /** what it left running when its last turn ended (a dev server, a watch) */
  background?: string[];
  /** agent_message calls the parent made to it */
  messages?: number;
}

export interface StartedBy {
  /** the parent session */
  sessionId: string;
  /** its name among the parent's subagents (SubagentLink.id) */
  name: string;
  /** 1: started by a top-level session, 2: by a subagent */
  depth: number;
  /** the top-level session of the tree */
  rootId: string;
  /** the parent's project folder: the session is listed there, also when it works in a worktree */
  projectPath: string;
  /** its own worktree (made again from the branch if it was removed), and the repository it belongs to */
  worktree?: { path: string; branch: string; repo: string };
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
  // A Codex model routed to another provider ("openrouter/x", "ollama/y") isn't on the ChatGPT login.
  if (harness === "codex") return codexOnChatGpt(model) ? "codex" : undefined;
  if (model?.startsWith("openai-codex/")) return "codex";
  return undefined;
}

/** A Codex model id on the ChatGPT account: a bare id, or one routed to "openai/…". */
export function codexOnChatGpt(model?: string): boolean {
  const i = model?.indexOf("/") ?? -1;
  return i <= 0 || model!.slice(0, i) === "openai";
}

/**
 * Whether a usage limit on this chain entry moves the session down the chain on its own: Tether
 * can confirm the limit, from the harness's own limit error (Claude Code, Codex, Antigravity) or
 * by reading the account's usage (pi on the ChatGPT login). Anything else only offers "Continue on …".
 */
export function switchesAutomatically(harness: string | undefined, model?: string): boolean {
  return !!usageProvider(harness, model) || harness === "antigravity";
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

/** One phase of a workflow, as the harness reports it (never made up from counts). */
export interface ActivityPhase {
  title: string;
  status: "done" | "running" | "pending" | "failed";
  /** "2 of 5 agents done", or what the phase is doing now */
  detail?: string;
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
  /** the subagent or workflow that started it (a subagent's own shells and agents, a workflow's agents) */
  parentId?: string;
  /** the parent workflow's phase it works in: an index into the parent's `phases` */
  phase?: number;
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
  /** a cross-harness subagent (agent_start): its own Tether session, and the harness it runs in */
  sessionId?: string;
  harness?: HarnessId;
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
  // workflow
  /** its phases in order, when the harness reports them (Claude Code workflows, pi workflows and chains) */
  phases?: ActivityPhase[];
}

export const ACTIVITY_KEEP_FINISHED = 20;
export const ACTIVITY_MAX_STEPS = 40;
export const isActive = (a: ActivityItem) => a.status === "running" || a.status === "waiting";
/**
 * The items that count as the session's work: active ones not started by another active item. A
 * workflow's 30 agents or a subagent's own shells are part of it, not work of their own (counts,
 * "busy", what a restart reports).
 */
export function ownWork(items: ActivityItem[]): ActivityItem[] {
  const live = new Set(items.filter(isActive).map((a) => a.id));
  return items.filter((a) => isActive(a) && !(a.parentId && a.parentId !== a.id && live.has(a.parentId)));
}
/** Everything started by `ids`, at any depth (the ids themselves excluded). */
export function descendants(items: ActivityItem[], ids: Set<string>): ActivityItem[] {
  const out: ActivityItem[] = [];
  const seen = new Set(ids);
  for (let grew = true; grew; ) {
    grew = false;
    for (const a of items)
      if (a.parentId && seen.has(a.parentId) && !seen.has(a.id)) {
        seen.add(a.id);
        out.push(a);
        grew = true;
      }
  }
  return out;
}
/**
 * Which finished items to keep first: the newest, but a workflow's or subagent's own items after
 * every top-level one (a 30-agent workflow mustn't push the session's other results out).
 */
export const finishedOrder = (a: ActivityItem, b: ActivityItem) => (a.parentId ? 1 : 0) - (b.parentId ? 1 : 0) || (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt);

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
  /** a run of this loop or schedule (SessionSchedule.id): one at a time waits, more collapse into it */
  scheduleId?: string;
  /** written by Tether or another agent (a note about a subagent, a parent's message): never joined with yours in one turn */
  alone?: boolean;
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
  /** a review session (/review): the session it reviews. Listed under that one, not in the sidebar */
  reviewOf?: string;
  /** a cross-harness subagent: the session that started it (agent_start) */
  startedBy?: { sessionId: string; name: string; title?: string };
  /** the project folder it's listed in, when that isn't `projectPath` (a subagent in its own worktree) */
  listedUnder?: string;
  /** when you last opened it, on any device (markViewed) */
  viewedAt?: number;
  /** its goal (/goal) is active: Tether keeps it working, between turns too */
  goalActive?: boolean;
  /** its soonest Tether loop or schedule run (/loop, /schedule): it will work again then */
  nextRunAt?: number;
  /** the runner's leader agent: kept out of the lists (but for its own questions); the Leader item opens it */
  leader?: boolean;
}

/** The project folder a session is listed in: its own, or its parent's for a subagent working in a worktree. */
export const listPath = (s: Pick<SessionSummary, "projectPath" | "listedUnder">): string => s.listedUnder ?? s.projectPath;

/**
 * How session lists sort: by the time of the most recent user or agent message (`updatedAt`),
 * newest first, whether or not the session is live. Ties go by id, so the order is stable.
 */
export function byRecent(a: Pick<SessionSummary, "id" | "updatedAt">, b: Pick<SessionSummary, "id" | "updatedAt">): number {
  return b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** "Last touched": the latest message, or the last time you opened it, whichever is later. */
export function lastTouched(s: Pick<SessionSummary, "updatedAt" | "viewedAt">, viewedAt?: number): number {
  return Math.max(s.updatedAt, s.viewedAt ?? 0, viewedAt ?? 0);
}

/** Like byRecent, by last touched. `viewed` (sessionId -> when opened) adds what this device knows. */
export function byTouched(viewed: Record<string, number> = {}) {
  return (a: Pick<SessionSummary, "id" | "updatedAt" | "viewedAt">, b: Pick<SessionSummary, "id" | "updatedAt" | "viewedAt">): number =>
    lastTouched(b, viewed[b.id]) - lastTouched(a, viewed[a.id]) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Web app preferences kept in the runner's config (getUiPrefs / setUiPrefs). */
export interface UiPrefs {
  /** sidebar project lists show sessions whose latest message is this recent, in days; 0 = all */
  sidebarDays: number;
  /** shell tool calls start expanded in the transcript */
  expandShell: boolean;
  /** what reaches the leader agent by itself: batched updates, questions and blocks only, or nothing */
  leaderUpdates: LeaderUpdates;
}
export type LeaderUpdates = "digest" | "questions" | "off";
export const LEADER_UPDATES: { id: LeaderUpdates; label: string }[] = [
  { id: "digest", label: "Updates" },
  { id: "questions", label: "Questions only" },
  { id: "off", label: "Off" },
];
/** The sidebar windows on offer, in days (0 = all). */
export const SIDEBAR_DAYS = [1, 3, 7, 30, 0] as const;
export const DEFAULT_SIDEBAR_DAYS = 3;
export const DEFAULT_UI_PREFS: UiPrefs = { sidebarDays: DEFAULT_SIDEBAR_DAYS, expandShell: false, leaderUpdates: "digest" };

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
  /** its soonest Tether loop or schedule run (/loop, /schedule) and how many it has */
  nextRun?: { at: number; label: string; count: number };
  /** its latest notice (finished, blocked, a question), for Home on devices that follow another runner's */
  notice?: AgentNotice;
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
  /** MCP servers in the harnesses' configs that the import adds to Tether's MCP registry (older runners: absent) */
  mcpServers?: string[];
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

/** A part of a harness's setup that Tether maps its own config onto (runner/src/connectors/). */
export type SlotId = "mcp" | "skills" | "memory" | "commands" | "agents" | "hooks" | "env" | "goal" | "plan" | "todos" | "ask_user" | "schedules" | "fork" | "compact" | "review" | "crossAgents";

/** native: the harness does it itself; emulated: Tether stands in for it; unsupported: neither. */
export type CapabilityLevel = "native" | "emulated" | "unsupported";

export interface SlotCapability {
  level: CapabilityLevel;
  /** a short human note: how, or why not */
  note: string;
}

/** The capability matrix: what each harness supports per slot. */
export type HarnessCapabilities = Record<HarnessId, Record<SlotId, SlotCapability>>;

// ---------- MCP registry (runner/src/mcp/) ----------

/** How a registry MCP server is reached. */
export type McpTransport =
  | { type: "stdio"; command: string; args: string[]; env: Record<string, string>; cwd?: string }
  | { type: "http" | "sse"; url: string; headers: Record<string, string> };

/**
 * How one harness gets a registry server:
 *   session  injected into each Tether session at launch
 *   global   written into the harness's own global config (no per-session path)
 *   native   already in the harness's own config: left alone, not injected again
 *   none     not delivered (turned off, out of scope, or the harness can't take it)
 */
export interface McpDelivery {
  harness: HarnessId;
  how: "session" | "global" | "native" | "none";
  note: string;
}

/** Where a registry server applies: every project, or the repos it's linked to ("repo:<repo-key>"). */
export type McpScope = "global" | string[];

/** A registry server as the web app sees it: env and header values stay on the runner. */
export interface McpServerView {
  id: string;
  name: string;
  scope: McpScope;
  enabled: boolean;
  /** its tools are allowed by the guard without the judge or a person */
  trusted: boolean;
  type: McpTransport["type"];
  /** the command line or URL */
  summary: string;
  envKeys: string[];
  headerKeys: string[];
  /** provenance: "claude:~/.claude.json", "codex:~/.codex/config.toml", "you", … */
  sources: string[];
  delivery: McpDelivery[];
  /**
   * an http/SSE server Tether can sign in to (no Authorization header of its own, and not one that
   * answered without credentials)
   */
  oauth?: boolean;
  /** its OAuth sign-in, when it has or needs one */
  auth?: McpAuthStatus;
}

/**
 * An MCP server's OAuth sign-in (tokens stay on the runner):
 *   connected  Tether holds a token (refreshed at launch when it runs out)
 *   needs      the server asks for a sign-in and there is no token
 *   expired    the token ran out and couldn't be refreshed: sign in again
 */
export type McpAuthStatus = "connected" | "needs" | "expired";

/** startMcpAuth: the sign-in page to open, or the authorization server can't register Tether by itself. */
export type McpAuthStart = { url: string } | { needsClient: true; redirectUri: string };

export interface McpFindResult {
  servers: McpServerView[];
  /** names of servers new to the registry */
  added: string[];
  warnings: string[];
}

// ---------- hooks (runner/src/hooks.ts) ----------

/** The Claude Code hook events Tether runs for every harness. */
export type HookEventName = "PreToolUse" | "PostToolUse" | "Stop" | "UserPromptSubmit";

/** One hook as the web app sees it: Claude Code's matcher group shape, plus on/off and where it came from. */
export interface HookView {
  id: string;
  event: HookEventName;
  /** tool-name matcher (Claude-style: `Bash`, `Edit|Write`, `mcp__github__.*`); empty: every tool */
  matcher: string;
  hooks: { type: "command"; command: string; timeout?: number }[];
  enabled: boolean;
  /** "you", or the settings file it was imported from ("claude:~/.claude/settings.json") */
  sources: string[];
  /** Claude Code runs it itself from its own settings, so Tether doesn't run it again there */
  claudeNative?: boolean;
}

export interface HookFindResult {
  hooks: HookView[];
  /** how many hooks were new */
  added: number;
  warnings: string[];
}

// ---------- commands, subagents, secrets (runner/src/commands.ts, subagents.ts, secrets.ts) ----------

/** One of your custom `/` commands in Tether's library. */
export interface LibraryCommandView {
  id: string;
  name: string;
  description: string;
  /** the template */
  body: string;
  argumentHint?: string;
  /** whose argument rules fill it: Claude Code's ($ARGUMENTS, $0 is the first) or the shell-like ones ($1 is the first, $@) */
  style: "claude" | "shell";
  enabled: boolean;
  /** "you", or the file it was imported from ("claude:~/.claude/commands/fix.md") */
  sources: string[];
}

export interface CommandFindResult {
  commands: LibraryCommandView[];
  /** names new to the library */
  added: string[];
  warnings: string[];
}

/** One of your subagent definitions, and how each harness gets it. */
export interface SubagentView {
  id: string;
  name: string;
  description: string;
  prompt: string;
  tools?: string[];
  model?: string;
  enabled: boolean;
  sources: string[];
  /** session: handed over at launch; global: written into its agent folder; native: it has its own of that name; none: can't */
  delivery: { harness: HarnessId; how: "session" | "global" | "native" | "none"; note: string }[];
}

export interface SubagentFindResult {
  agents: SubagentView[];
  added: string[];
  warnings: string[];
}

/** A secret's name (its value stays on the runner). */
export interface SecretView {
  name: string;
  updatedAt: number;
}

/** An entry in the composer's `/` menu. */
export interface SlashCommand {
  name: string;
  description?: string;
  /** absent: a harness command (older runners send only these); tether: Tether's own (/goal) */
  kind?: "command" | "skill" | "tether";
  /** a skill, or a command from your library: where it comes from ("claude", "codex", "agents", "repo", …), for badges */
  sources?: string[];
  /**
   * a skill: the harness runs it itself, otherwise Tether sends SKILL.md along with the message; a
   * library command (`sources` set): the harness runs it itself, otherwise Tether fills it in
   */
  native?: boolean;
}

// ---------- RPC ops (browser -> server -> runner) ----------

export interface Ops {
  listProjects: { args: {}; result: ProjectInfo[] };
  /** create: make the folder (and its parents) when it doesn't exist yet */
  addProject: { args: { path: string; create?: boolean }; result: ProjectInfo };
  /** a new folder `parent/name` with git init; github: also a GitHub repo of that name as its origin (gh CLI) */
  createProject: { args: { name: string; parent: string; github?: { owner?: string; private: boolean } }; result: ProjectInfo };
  /** the account the runner's gh CLI is logged in to (none: no gh, or logged out) */
  githubAccount: { args: {}; result: { login: string; orgs: string[] } | null };
  /** owner's repos (default the gh account's own), up to 1000, most recently updated first */
  githubRepos: { args: { owner?: string }; result: { nameWithOwner: string; description?: string; isPrivate: boolean; updatedAt: string }[] };
  /** repo: org/repo or any git URL (GitHub goes over SSH); cloned into parent (default ~) */
  cloneProject: { args: { repo: string; parent?: string }; result: ProjectInfo };
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
  /** Stops the running turn and sends now, ahead of everything waiting: a new message (`text`) or a waiting one (`id`). */
  forceSend: { args: { sessionId: string; text?: string; id?: string; attachments?: Attachment[] }; result: {} };
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
  /**
   * File references from the transcript (relative to the project or absolute): those that are a
   * file in the project or changed in this session, keyed by the path as asked. Others are left out.
   */
  checkPaths: { args: { sessionId: string; paths: string[] }; result: Record<string, PathCheck> };
  /** one file's changes over the whole session, or with `checkpoint` in the turn that started there */
  fileDiff: { args: { sessionId: string; path: string; checkpoint?: string; reveal?: boolean }; result: FileDiffResult };
  /** a project file's current contents, up to FILE_VIEW_LIMITS (read-only); a secrets file's only with `reveal` */
  readFile: { args: { sessionId: string; path: string; maxBytes?: number; reveal?: boolean }; result: FileContents };
  /** raw bytes of a project file, a piece at a time (see FILE_DOWNLOAD_LIMITS); a secrets file's only with `reveal` */
  readFileChunk: { args: { sessionId: string; path: string; offset?: number; length?: number; reveal?: boolean }; result: FileChunk };
  /** `confirmed`: required for a call plan mode or a review held back ("by": "mode") */
  approveBlocked: { args: { sessionId: string; toolId: string; confirmed?: boolean }; result: {} };
  /**
   * "Fork from here": a new session in the same directory with the conversation up to and including
   * `msgId` (the harness's own fork where it can, else a brief), on `harness` and `model`. On a user
   * message the new session answers that message again; `prompt` goes after it (or is the first
   * message, on any other message).
   */
  forkSession: { args: { sessionId: string; msgId: string; harness: HarnessId; model?: string; prompt?: string }; result: SessionSummary };
  /**
   * A review card's "Send to agent" / "Send all": queues a message asking the agent to fix those
   * findings (`indexes`; absent: every one not sent yet).
   */
  sendReviewFindings: { args: { sessionId: string; reviewId: string; indexes?: number[] }; result: {} };
  /** the "Continue on …" button of an error notice (msgId): moves the session to that chain entry */
  continueOn: { args: { sessionId: string; msgId: string }; result: {} };
  /** runs a blocked shell command on the runner and gives the agent its output */
  runBlocked: { args: { sessionId: string; toolId: string; confirmed?: boolean }; result: {} };
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
  /** stops a loop or deletes a schedule (/loop, /schedule) */
  deleteSchedule: { args: { sessionId: string; id: string }; result: {} };
  /** Web Push: the runner's key, and this device's subscription if any (by endpoint) */
  pushStatus: { args: { endpoint?: string }; result: { publicKey: string; kinds?: NotifyKind[] } };
  pushSubscribe: {
    args: { subscription: { endpoint: string; keys: { p256dh: string; auth: string } }; kinds: NotifyKind[]; label?: string };
    result: {};
  };
  pushUnsubscribe: { args: { endpoint: string }; result: {} };
  pushTest: { args: { endpoint: string }; result: {} };
  listNotifications: { args: {}; result: AgentNotice[] };
  /** empties the runner's notification list (the bell and sidebar dots, on every device) */
  clearNotifications: { args: {}; result: {} };
  amendSteer: { args: { sessionId: string; msgId: string; text: string }; result: {} };
  /**
   * A plan's draft comments, kept on the runner so every device has them; null clears it. `base`:
   * the review's `rev` the edit started from; when it has moved on, nothing is saved (`stale`, with
   * the draft as it is now, to merge into).
   */
  setPlanDraft: {
    args: { sessionId: string; planId: string; draft: PlanDraft | null; base?: number };
    result: { rev?: number; stale?: boolean; draft?: PlanDraft };
  };
  /**
   * Discuss (the agent answers the comments, the plan stays as it is), Revise (sent back for a new
   * plan) or Approve, with the draft as this device has it (`base`: its `rev`; refused when the
   * draft has moved on since). Revise and Approve clear the draft.
   */
  planAction: { args: { sessionId: string; planId: string; action: "discuss" | "revise" | "approve"; draft: PlanDraft; base?: number }; result: {} };
  /** `stale`: no request with that id was waiting (already answered, timed out or cancelled); nothing happened */
  uiRespond: { args: { sessionId: string; response: UiResponse }; result: { stale?: boolean } };
  getUsage: { args: { force?: boolean }; result: UsageReport };
  renameSession: { args: { sessionId: string; projectPath: string; title: string }; result: {} };
  listModels: { args: { harness: HarnessId; sessionId?: string }; result: { models: ModelRef[]; thinkingLevels: string[]; permissionModes: string[] } };
  /** per harness and slot: native, emulated or unsupported (runner/src/connectors/) */
  harnessCapabilities: { args: {}; result: HarnessCapabilities };
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
  // MCP registry
  listMcpServers: { args: {}; result: McpServerView[] };
  /**
   * Adds servers from pasted text: a command line, a URL, or a JSON snippet (`{"mcpServers": …}`,
   * `{"name": {…}}` or one server's object). `scope`: "global" or a project path (its repo).
   */
  addMcpServer: { args: { text: string; name?: string; scope?: string }; result: McpServerView[] };
  /**
   * turns a server on or off, marks it trusted, or removes it (and only Tether's copies in harness
   * configs); `signOut` drops its OAuth tokens
   */
  setMcpServer: { args: { id: string; enabled?: boolean; trusted?: boolean; remove?: boolean; signOut?: boolean }; result: McpServerView[] };
  /**
   * Starts an OAuth sign-in for an http/SSE server. `redirectUri` is the app's
   * `/api/mcp-oauth/callback`; `clientId` (and secret) when its authorization server can't
   * register Tether by itself.
   */
  startMcpAuth: { args: { id: string; redirectUri: string; clientId?: string; clientSecret?: string }; result: McpAuthStart };
  /** the app server's callback relays the authorization server's answer here */
  finishMcpAuth: { args: { state: string; code?: string; error?: string; errorDescription?: string; iss?: string }; result: { id: string; name: string } };
  /** "Find servers": imports every harness's MCP config into the registry */
  findMcpServers: { args: {}; result: McpFindResult };
  // Hooks (runner/src/hooks.ts)
  listHooks: { args: {}; result: HookView[] };
  /**
   * Adds hooks from pasted JSON in Claude Code's settings shape: `{"hooks": {"PreToolUse": [...]}}`,
   * `{"PreToolUse": [...]}`, or one `{"event", "matcher", "hooks"}` entry.
   */
  addHooks: { args: { text: string }; result: HookView[] };
  /** turns a hook on or off, removes it, or replaces it with edited JSON (`{"event", "matcher", "hooks"}`) */
  setHook: { args: { id: string; enabled?: boolean; remove?: boolean; json?: string }; result: HookView[] };
  /** "Find hooks": imports the hooks in ~/.claude/settings.json (read only) */
  findHooks: { args: {}; result: HookFindResult };
  // Your commands (runner/src/commands.ts)
  listLibraryCommands: { args: {}; result: LibraryCommandView[] };
  /** adds a command, or replaces the one with that name: `text` is the template, front matter optional */
  addLibraryCommand: { args: { name: string; text: string; style?: "claude" | "shell" }; result: LibraryCommandView[] };
  setLibraryCommand: { args: { id: string; enabled?: boolean; remove?: boolean }; result: LibraryCommandView[] };
  /** "Find commands": imports every harness's command files (read only) */
  findLibraryCommands: { args: {}; result: CommandFindResult };
  // Your subagents (runner/src/subagents.ts)
  listSubagents: { args: {}; result: SubagentView[] };
  /** adds a subagent, or replaces the one with that name: `text` is a Claude Code agent file */
  addSubagent: { args: { text: string; name?: string }; result: SubagentView[] };
  setSubagent: { args: { id: string; enabled?: boolean; remove?: boolean }; result: SubagentView[] };
  findSubagents: { args: {}; result: SubagentFindResult };
  // Env and secrets (runner/src/secrets.ts): values go in, never come back
  listSecrets: { args: {}; result: SecretView[] };
  setSecret: { args: { name: string; value?: string; remove?: boolean }; result: SecretView[] };
  getBackgroundModel: { args: {}; result: BackgroundModelSetting };
  setBackgroundModel: { args: { model: string }; result: BackgroundModelSetting };
  setJudgeEnabled: { args: { enabled: boolean }; result: BackgroundModelSetting };
  /** web app preferences kept on the runner, so every device shares them */
  getUiPrefs: { args: {}; result: UiPrefs };
  setUiPrefs: { args: Partial<UiPrefs>; result: UiPrefs };
  /** when each session was last opened (sessionId -> ms), on any device */
  getViewed: { args: {}; result: Record<string, number> };
  /** you opened (or are looking at) a session: now, by the runner's clock */
  markViewed: { args: { sessionId: string; projectPath?: string }; result: { viewedAt: number } };
  /**
   * Sessions touched (a message, or opened) in the last `days` (0: any time), plus every live
   * one, across projects, most recently touched first: the sidebar's Recent and Home.
   */
  listRecent: { args: { days: number }; result: SessionSummary[] };
  /** the runner's leader agent (runner/src/leader.ts), if it has one */
  getLeader: { args: {}; result: { session?: SessionSummary } };
  /** starts the leader agent (one per runner: an existing one is returned) */
  createLeader: { args: { harness: HarnessId; model?: string }; result: SessionSummary };
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
  /** a session was opened (markViewed), for every browser to merge */
  | { t: "viewed"; sessionId: string; viewedAt: number }
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
  | { t: "viewed"; runnerId: string; sessionId: string; viewedAt: number }
  | { t: "pong" };
