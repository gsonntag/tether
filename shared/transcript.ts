// The transcript and live state of a session, as every harness is shown (SPEC §5). Adapters
// translate their harness's own store and stream into these shapes; the UI renders only these.

import type { Attachment } from "./attachments";
import type { ShellRun } from "./shellRun";

export type HarnessId = "claude" | "codex";

export const HARNESS_LABELS: Record<HarnessId, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

/** The agent as a sentence names it: "Claude is working…", "Codex wants to run a command". */
export const AGENT_NAMES: Record<HarnessId, string> = {
  claude: "Claude",
  codex: "Codex",
};

/** The agent's name for a session id (`codex:…` -> "Codex"). */
export const agentOf = (sessionId: string | undefined): string => AGENT_NAMES[(sessionId?.split(":")[0] ?? "") as HarnessId] ?? "Claude";

/**
 * What a harness does better or differently (SPEC §2.5, §6, §6a). The core and the UI branch only
 * on these, never on the harness id.
 */
export interface HarnessCapabilities {
  /** a message can go into a running turn */
  canSteer: boolean;
  /** "handoff": the TUI takes over the session; "shared": the TUI joins the live thread */
  terminal: "handoff" | "shared";
  subagents: {
    /** subagents show as child sessions with their own transcript */
    view: boolean;
    /** a running subagent can be stopped on its own */
    stop: boolean;
    steer: "direct" | "via-parent" | false;
  };
  /**
   * The harness keeps sessions running itself, outside the runner (Codex's daemon): a turn running
   * when the runner stopped goes on, and the runner rejoins it when it starts again.
   */
  persistent?: boolean;
  /**
   * When a setting changed during a turn takes effect: "now" (default; Claude Code applies it to the
   * running turn) or "nextTurn" (Codex fixes a turn's settings when it starts). With "nextTurn" the
   * running turn's own values show beside the change (LiveState.turnSettings).
   */
  settingsApply?: "now" | "nextTurn";
}

// ---------- transcript ----------

export type ToolStatus = "running" | "done" | "error";
/** A tool call by what it does, whatever the harness names it. The UI renders tool cards by kind. */
export type ToolKind = "shell" | "edit" | "write" | "read" | "search" | "fetch" | "todo" | "task" | "other";

export interface ToolPart {
  type: "tool";
  id: string;
  name: string;
  kind: ToolKind;
  input: unknown;
  status: ToolStatus;
  output?: string;
  /** the command a shell call runs */
  command?: string;
  /** the file (or folder) a read, edit or write is about */
  path?: string;
  /** set when the call ran inside a subagent */
  parentToolId?: string;
  /** a call that started a subagent (kind "task"): the subagent's session (SPEC §6a) */
  childSessionId?: string;
  /**
   * `output` was cut short (shared/limits.ts): its full length; `fullPart` fetches it. 0 (sent on
   * patches) means whole.
   */
  truncated?: number;
  /** `input` was cut short (long strings trimmed, or replaced by a preview); `fullPart` has it whole */
  inputTruncated?: boolean;
}

/**
 * `truncated` on any part: its content was cut short to keep frames small (shared/limits.ts),
 * and this is the full length (characters; for an image, the base64 length, with `data` empty).
 * The `fullPart` op returns the whole part.
 */
export type Part =
  | { type: "text"; text: string; truncated?: number }
  | { type: "thinking"; text: string; truncated?: number }
  | { type: "image"; mimeType: string; data: string; truncated?: number }
  | ToolPart;

export type Role = "user" | "assistant" | "notice";

export interface Msg {
  id: string;
  role: Role;
  parts: Part[];
  ts: number;
  /** assistant: the model that produced it */
  model?: string;
  /** notice: severity */
  level?: "info" | "warning" | "error";
  /** notice: a session it points to ("Open it") */
  link?: { sessionId: string; label: string };
  /** assistant: the turn ended in this error */
  error?: string;
  streaming?: boolean;
  /**
   * user: a turn the harness added that you didn't type (another session's message, a channel,
   * a subagent's report): who it's from. The UI shows it apart from your own messages.
   */
  origin?: { kind: string; name?: string };
  /**
   * user: a message to a subagent that Tether passed on through the main agent (SPEC §6a,
   * subagents.steer "via-parent"): whether the main agent delivered it.
   */
  relay?: "sending" | "delivered" | "failed";
  /**
   * user: a `!` command you ran from the composer (shared/shellRun.ts), its card: `parts[0]` is a
   * shell tool part with the command and its output; this says where it is (running, queued for the
   * agent, sent).
   */
  shell?: ShellRun;
  /**
   * Parts at the end left out to keep the message small (shared/limits.ts): `parts` holds the
   * first ones, and parts[parts.length …] can be fetched one by one with `fullPart`.
   */
  partsOmitted?: number;
}

// ---------- live state ----------

export type SessionMode = "stored" | "live" | "terminal";
export type RunStatus = "idle" | "running" | "waiting";

/** One question of a question request, with the choices offered (the person may also type). */
export interface RequestQuestion {
  question: string;
  /** a short tag for it ("Color") */
  header?: string;
  options: { label: string; description?: string }[];
  /** several options may be picked */
  multiSelect?: boolean;
}

/**
 * An approval or question waiting for a person (SPEC §7). It shows in its own session and in every
 * session above it (a subagent's request shows in its parent too); `sessionId` is the one that asked.
 */
export interface Request {
  id: string;
  sessionId: string;
  kind: "approval" | "question";
  tool?: string;
  input?: unknown;
  /** the first question's text and options (`questions` has them all) */
  question?: string;
  options?: string[];
  questions?: RequestQuestion[];
  openedAt: number;
  /** `input` was cut short to travel (shared/limits.ts) */
  inputTruncated?: boolean;
  /** what the tool does, as the transcript's tool cards draw it */
  toolKind?: ToolKind;
  command?: string;
  path?: string;
  /** the tool call in the transcript this request is about */
  toolId?: string;
  /** a short line from the harness on what this is ("notes.txt") */
  title?: string;
  /** why the harness asks ("This command uses shell operators that require approval") */
  reason?: string;
  /** the harness asks for network access (Codex's network approvals) */
  network?: boolean;
  /** a plan to approve (leaving plan mode), as markdown */
  plan?: string;
  /** ways to approve that also switch the permission mode ("Approve and accept edits") */
  approveAs?: Choice[];
  /** the mode a plain approval leaves the session in (approving a plan leaves plan mode) */
  approveMode?: string;
  /** a policy step is still deciding it: shown, but there is nothing to answer yet */
  checking?: boolean;
  /** asked by a subagent: its title, for the parent's view */
  agent?: string;
}

/**
 * How a person answers a request (the `answerRequest` op). Approve: `allow`, optionally switching to
 * one of the request's `approveAs` modes. A question: `allow` with one answer per question (several
 * picks joined by ", "). Deny: `allow: false`, with a reason Claude reads, or none (which stops the
 * turn, as declining in the harness's own UI does).
 */
export type RequestAnswer = { allow: true; answers?: string[]; mode?: string } | { allow: false; reason?: string };

/** A message waiting to go out after the running turn (SPEC §9). */
export interface QueuedMessage {
  id: string;
  text: string;
  attachments?: Attachment[];
  queuedAt: number;
  /** `text` was cut to travel (shared/limits.ts capQueued): its full UTF-8 length; the runner has it whole */
  truncated?: number;
  /** a `!` command's output on its way to the agent: the command, and its card's message id */
  shell?: { command: string; cardId: string };
}

export interface TerminalState {
  kind: "handoff" | "shared";
  /** Back to Tether is under way: the TUI was asked to quit */
  returning?: boolean;
  /** the TUI is waiting on the person (a permission prompt, a question): what it said */
  attention?: string;
}

export interface LiveState {
  mode: SessionMode;
  status: RunStatus;
  /** the model the session uses: an alias ("opus", "default") or a full id */
  model?: string;
  /** what `model` runs now, when the harness says (e.g. "claude-opus-5-5") */
  modelResolved?: string;
  effort?: string;
  permissionMode?: string;
  requests: Request[];
  queue: QueuedMessage[];
  /**
   * Set while the harness's TUI runs in a terminal (SPEC §8). "handoff": the session is in terminal
   * mode and the TUI drives it; "shared": the TUI joined the live thread beside Tether.
   */
  terminal?: TerminalState;
  /**
   * The terminal's TUI moved on to this session (/clear, /resume): the view follows it there.
   */
  continuedIn?: string;
  /**
   * Queued messages wait, untouched, while set (SPEC §8, §9): while the TUI drives (released by
   * Back to Tether), after Stop, after a failed turn, and after a turn cut off by a runner restart
   * (released when you send, or with Resume). `queueHeldBy` says why.
   */
  queueHeld?: boolean;
  queueHeldBy?: "terminal" | "stopped" | "restart" | "failed";
  /**
   * Waiting for Claude Code from before a restart (SPEC §4): messages sent now queue, held, and
   * Resume can't release them until this clears.
   */
  restartWait?: boolean;
  /** messages that left the queue lately and how (the last few): sent to the harness, or cancelled */
  queueGone?: { id: string; how: "sent" | "cancelled" }[];
  /**
   * Settings changed while a turn runs, on a harness where that takes effect from the next turn
   * (capabilities.settingsApply "nextTurn"): what the running turn still runs with. Cleared when the
   * turn ends.
   */
  turnSettings?: {
    model?: string;
    effort?: string;
    permissionMode?: string;
    /** it has more access than the session now shows, or isn't known (Tether offers to stop it) */
    looser?: boolean;
    /** what runs with these: the turn, or a subagent (which keeps its settings after the turn ends) */
    who?: "turn" | "subagent";
    /** a subagent's: its session (Stop stops just it) */
    subagentSessionId?: string;
  };
  /** why the session can't run right now (the harness failed to start, isn't signed in, …) */
  error?: string;
}

/** One row in the sidebar and Home. */
export interface SessionSummary {
  /** `${harness}:${nativeId}` */
  id: string;
  harness: HarnessId;
  nativeId: string;
  projectPath: string;
  title: string;
  mode: SessionMode;
  status: RunStatus;
  updatedAt: number;
  /** open requests, for the status dot and Home */
  requests?: number;
  /**
   * A turn ended and nobody has looked since (Home's inbox, SPEC §10): it finished, or it failed.
   * Shared by every device: opening the session on any of them clears it.
   */
  unread?: "finished" | "failed";
  /** a failed turn's error, with `unread: "failed"` */
  failure?: string;
  /** messages waiting in its queue */
  queued?: number;
  /** its queue is paused for you (after Stop, a failure or a restart): Home shows it as needing you */
  queuePaused?: boolean;
  /** a subagent: the session that started it, and the tool call that did (SPEC §6a) */
  parentSessionId?: string;
  parentToolId?: string;
  /** a subagent: its kind, as the harness names it (e.g. "general-purpose") */
  agentType?: string;
}

/** A folder sessions run in, as discovered from the harness stores (SPEC §4). */
export interface ProjectInfo {
  path: string;
  /** the folder's own name */
  name: string;
  harnesses: HarnessId[];
  /** the newest session's last activity */
  updatedAt: number;
  sessions: number;
}

/** A model as a picker shows it. */
export interface ModelOption {
  /** what to pass to setModel: an alias ("opus") or a full id */
  id: string;
  /** a human label: "Opus 5.5", "Default (Opus 5.5)" */
  label: string;
  description?: string;
  /** what the alias runs now */
  resolved?: string;
  /** effort levels it takes; absent: none */
  efforts?: string[];
}

export interface Choice {
  id: string;
  label: string;
  description?: string;
}

/** What `listModels` offers for a harness. */
export interface ModelList {
  models: ModelOption[];
  efforts: Choice[];
  permissionModes: Choice[];
}

/**
 * A session as a subscriber first sees it. `messages` is only the newest window (at most the
 * subscribe's `limit`), never the whole transcript, so opening a long session stays fast on a
 * phone. Older messages come page by page from `history` as the reader scrolls up. Pages are
 * cut by bytes too, and big parts arrive cut short (`limits.ts`: `newestPage`, `capMessage`); the
 * runner applies the same caps to every `msg` and `reset` event.
 */
export interface SessionSnapshot {
  session: SessionSummary;
  /** what its harness can do (SPEC §6) */
  capabilities: HarnessCapabilities;
  /** the newest messages, oldest first */
  messages: Msg[];
  /** there are messages before `messages[0]` (fetch them with `history`) */
  hasOlder: boolean;
  state: LiveState;
  /** the seq of the last event folded into this snapshot */
  seq: number;
}

/** How many messages a snapshot or a history page carries unless asked otherwise. */
export const TRANSCRIPT_PAGE = 50;

// ---------- session events (runner -> server -> subscribed browsers) ----------

export type SessionEvent =
  /**
   * `isNew`: a message appended at the end of the transcript. Without it, a replacement of a
   * message the browser may not have loaded (an older page): ignored if it isn't loaded.
   */
  | { type: "msg"; msg: Msg; isNew?: boolean }
  /** streamed text appended to a text or thinking part, or to a tool part's output */
  | { type: "delta"; msgId: string; part: number; text: string }
  | { type: "tool"; msgId: string; toolId: string; patch: Partial<ToolPart> }
  | { type: "state"; state: Partial<LiveState> }
  /** replace the transcript (after compaction): the newest window, as in a snapshot */
  | { type: "reset"; messages: Msg[]; hasOlder: boolean }
  /**
   * The real event was too big to send (shared/limits.ts, frame guard). It still takes its seq;
   * subscribers subscribe again for a fresh (capped) snapshot.
   */
  | { type: "resync" };

// Events always refer to messages by id. One that patches a message outside what the browser has
// loaded (an older page it never fetched) is simply skipped: the page carries the current text
// when it's fetched. shared/window.ts applies events to a loaded window this way.
