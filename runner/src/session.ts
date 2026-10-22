import {
  formatEntry,
  parseEntry,
  type ChainEntry,
  type HarnessId,
  type LiveState,
  type Msg,
  type SessionEvent,
  type SessionSnapshot,
  type SessionSummary,
  type UiRequest,
  type UiResponse,
} from "../../web/src/shared/protocol";
import { resolve } from "node:path";
import { userParts } from "../../web/src/shared/bash";
import { attachmentBlock, splitAttachments } from "../../web/src/shared/attachments";
import { referencedFolders, sessionKey } from "./attachments";
import { APPROVING_MODES } from "../../web/src/shared/protocol";
import { applyEvent, emptyState, findPlan, findTool, type Transcript } from "../../web/src/shared/reducer";
import { tagToolParts, tagToolPatch } from "./toolKind";
import { guardEnv, registerGuard, unregisterGuard } from "./bridge";
import { computeDiff, diffStat, snapshot, treeHash, workingTreeStats } from "./checkpoint";
import { checkPaths, fileDiff, readProjectFile, readProjectFileChunk } from "./files";
import { config, prefs, saveConfig, saveConfigSoon } from "./config";
import { simulateUsage, usageChanged } from "./usage";
import { describeFault, fmtSpan, parseDevCommand, simulatedUsage, type Fault } from "./faults";
import { mergeContext, switchModel } from "./contextWindow";
import { notify } from "./notify";
import { accountOf, backoffMs, classify, confirmLimit, isTransient, markExhausted, nextEntry, parseReset, pickEntry, profile, providerOf, type Classified, type UsageCheck } from "./fallback";
import { modelDisplay } from "../../web/src/models";
import { attachmentWrite, commandOf, isContextTool, judge, kindOf, rules, type GuardMode, type Verdict } from "./guard";
import { hiddenSkills, resolveMessage, skillsFor, slashMenu, type NativeSkill } from "./skillcmd";
import { libraryCommands, offlineNativeCommands } from "./commands";
import { connectorFor } from "./connectors";
import { advance, bySoonest, describeList, describeOne, fmtWhen, MAX_SCHEDULES, newSchedule, ofKind, parseTimerCommand, scheduleChanged } from "./schedule";
import { sessionTrust } from "./mcp/registry";
import { load as loadMcpRegistry } from "./mcp/store";
import { hookTool, hooksFor, runHooks, type HookOutcome } from "./hooks";
import { descendants, HARNESSES, isActive, ownWork, type StartedBy, type SubagentLink, type ActivityItem, type ActivityKind, type BackgroundTask, type Checkpoint, type ContextUsage, type GoalNote, type GoalStatus, type GuardVerdict, type Part, type PendingMessage, type SessionDiff, type SessionGoal, type SessionPlan, type SessionReview, type SessionSchedule, type SlashCommand, type TodoItem } from "../../web/src/shared/protocol";
import { displayText, invocationText, parseInvocation } from "../../web/src/shared/skill";
import {
  budgetHit,
  checkGoal,
  continuationPrompt,
  describeGoal,
  fmtBudget,
  fromCodexStatus,
  GOAL_CHECK_EVERY,
  GOAL_STALL_TURNS,
  isGoalPrompt,
  kickoffPrompt,
  newGoal,
  parseGoalCommand,
  STATUS_LABEL,
  TETHER_COMMANDS,
  transcriptTail,
  withNote,
  type GoalVerdict,
} from "./goal";
import { isRelay, splitAgentWritten, subagentTask } from "../../web/src/shared/subagents";
import { describePlan, IMPLEMENT_PROMPT, isPlanMode, lastReply, mutates, parseChecklist, parseTodos, PLAN_MODE_REASON, PLAN_WAIT_REASON, todoInput, todosFromInput } from "./plan";
import { describeFindings, fixMessage, MAX_REVIEWS, mergeReview, parseReport, parseReviewCommand, reportFromReply, REVIEW_READ_ONLY_REASON, type ReviewRequest } from "./review";
import { PlanReviews } from "./planReview";

export type Emit = (sessionId: string, seq: number, event: SessionEvent) => void;
export type SummaryChanged = (s: SessionSummary) => void;
export interface HandoffOpts {
  /** the old agent stopped in the middle of its task (a limit, or "Continue on …" after an error) */
  interrupted?: boolean;
}
/** Moves the conversation to a new session in another harness (runner/src/index.ts). */
export type Handoff = (from: LiveSession, to: ChainEntry, reason: string, pendingPrompt?: string, opts?: HandoffOpts) => Promise<void>;

export interface SessionSink {
  emit: Emit;
  summary: SummaryChanged;
  handoff: Handoff;
  /**
   * `/compact` where the harness can't compact itself: the conversation restarts as a new session on
   * the same harness and model, seeded with a brief (handoffRun.ts runCompact). Absent: not offered.
   */
  compact?: (from: LiveSession, focus?: string) => Promise<void>;
  /** `/review`: starts a read-only review session on another harness (review.ts runReview). Absent: not offered. */
  review?: (from: LiveSession, req: ReviewRequest) => Promise<void>;
  /** A review session's result, for the session it reviews (review.ts applyReview), live or not. */
  reviewResult?: (sessionId: string, reviewId: string, patch: Partial<SessionReview>) => void;
  /** Cross-harness subagents (crossAgents.ts): the agent_* tools, and what a subagent's parent hears. Absent: not offered. */
  agents?: AgentHub;
  /** The leader agent (leader.ts): its session_* tools. Absent: not offered. */
  leader?: LeaderHub;
}

/** What the leader session asks the leader manager (runner/src/leader.ts). */
export interface LeaderHub {
  /** sessions_overview, session_read, session_message, session_answer, session_escalate, session_stop */
  tool(from: LiveSession, tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ ok: boolean; text: string }>;
}

/** What sessions tell the cross-harness subagent manager (runner/src/crossAgents.ts), and ask it. */
export interface AgentHub {
  /** agent_harnesses, agent_start, agent_status, agent_wait, agent_message, agent_result, agent_stop, agent_list */
  tool(from: LiveSession, tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ ok: boolean; text: string }>;
  /** a subagent changed (status, what it's doing, a question): its parent's activity item follows */
  changed(s: LiveSession): void;
  /** a subagent's turn ended; once it has settled, its parent hears */
  turnEnded(s: LiveSession, outcome: "finished" | "failed" | "stopped"): void;
  /** the parent was stopped, archived or removed: its subagents stop too */
  stopAll(parent: LiveSession | string): Promise<void>;
  /** a parent's stored subagents came back (loadPrefs, a new process): its activity items are rebuilt */
  restored(parent: LiveSession): void;
  /** the Stop button on a subagent's activity item */
  stop(parent: LiveSession, name: string): Promise<void>;
  /** what the user asked in the top session of a subagent's tree (its goal()), when that session runs */
  userAsk(s: LiveSession): string | undefined;
}

let counter = 0;
export const newId = (prefix: string) => `${prefix}${Date.now().toString(36)}${(counter++).toString(36)}`;

/** A fully idle agent process closes after this; the next message starts it again. */
export const IDLE_CLOSE = { ms: 5 * 60_000 };
/** How long a review under way keeps the session it reviews open past IDLE_CLOSE. */
const REVIEW_KEEP_OPEN_MS = 3 * 60 * 60_000;
const STALL_WARN_MS = 15 * 60_000;
/** how long "Continue on …" keeps this session off the entry it left, when the error gave no reset */
const MANUAL_SKIP_MS = 60 * 60_000;
/** backoffs on an entry whose usage Tether can't check before its rate-limit error shows with "Continue on …" */
const UNVERIFIED_BACKOFFS = 3;
/** ask_user's answer when nobody answered (the same as Claude Code's AskUserQuestion gets) */
export const NOBODY_ANSWERED = "Nobody answered. Make the most reasonable choice yourself, say which one you made, and continue.";

/** Whether the leader agent may answer this request for the user: a question marked leaderMay, or a plan; never anything userOnly. */
export const leaderMayAnswer = (r: UiRequest | undefined): boolean => !!r && !r.userOnly && (r.kind === "plan" || (r.kind === "question" && !!r.leaderMay));

/**
 * A question's answers as the agent gets them: the leader's say so, so the model doesn't take
 * them for the user's own click (Claude's AskUserQuestion, Codex's requestUserInput).
 */
export function leaderAnswers(r: UiResponse): Record<string, string> | undefined {
  if (!r.answers || r.by !== "leader") return r.answers;
  return Object.fromEntries(Object.entries(r.answers).map(([q, a]) => [q, `(answered by the user's leader agent, passing on what the user told it) ${a}`]));
}

/**
 * One live agent session. The runner keeps the authoritative transcript here; every change goes
 * through emit(), which applies it locally and forwards it to the server with a sequence number,
 * so any number of browsers can join at any time (snapshot + following events).
 */
/** How often a moving conversation re-sends its summary, so session lists stay in order. */
const SUMMARY_EVERY_MS = 10_000;

const conversational = (m: Msg) => m.role === "user" || m.role === "assistant";

/**
 * The time of the session's most recent message after `event` (call it before applying the event):
 * what session lists sort by. Only user and agent messages count, by their own timestamps, so a
 * replayed history keeps its times and notices, state and activity never move it. An assistant
 * message still being written counts as new on every change, so a long reply stays at the top.
 */
export function movedAt(event: SessionEvent, updatedAt: number, messages: Msg[], now = Date.now()): number {
  const streaming = (id: string) => {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.id === id) return messages[i]!.role === "assistant" && !!messages[i]!.streaming;
    return false;
  };
  switch (event.type) {
    case "reset": {
      // Never back: a resumed session starts at its stored last-message time (lastActivity.ts), which
      // can be later than any replayed message's (Codex replays at turn starts, Claude at the start
      // of each reply, and a tool result's line comes after both).
      const last = event.messages.reduce((t, m) => (conversational(m) ? Math.max(t, m.ts || 0) : t), 0);
      return Math.max(last, updatedAt);
    }
    case "msg": {
      const m = event.msg;
      if (!conversational(m)) return updatedAt;
      if (m.role === "assistant" && (m.streaming || streaming(m.id))) return Math.max(updatedAt, m.ts || 0, now);
      return Math.max(updatedAt, m.ts || 0);
    }
    case "delta":
      return streaming(event.msgId) ? Math.max(updatedAt, now) : updatedAt;
    default:
      return updatedAt;
  }
}


/** Held back by plan mode or a review session (not a safety block): running it anyway needs a second yes. */
const held = (g: GuardVerdict | undefined) => g?.decision === "deny" && g.by === "mode";
const HELD_CONFIRM = "This call was held back by plan mode or a review. Confirm to run it anyway.";

export abstract class LiveSession {
  readonly harness: HarnessId;
  nativeId: string;
  projectPath: string;
  title: string;
  createdAt: number;
  /**
   * When the session's most recent message was written (see movedAt): what the session lists sort
   * by. State, activity, notices and a history replay never move it forward, so resuming sessions
   * after a runner restart doesn't shuffle them all to the top.
   */
  updatedAt: number;
  /** when a summary last went out because updatedAt moved (see emit) */
  private movedSentAt = 0;
  t: Transcript = { messages: [], state: emptyState() };
  seq = 0;
  closed = false;

  private fallbackAttempt = 0;
  private waitTimer?: ReturnType<typeof setTimeout>;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private watchdog?: ReturnType<typeof setInterval>;
  private lastActivity = Date.now();
  private stallWarned = false;
  /** Saving waits until loadPrefs() ran, so start() can't overwrite stored settings. */
  private prefsLoaded = false;
  private diffBaseSha?: string;
  onClose?: () => void;
  /** plan review: drafts, discussions, revisions (runner/src/planReview.ts) */
  readonly plans: PlanReviews = new PlanReviews(this);

  constructor(
    harness: HarnessId,
    init: { nativeId: string; projectPath: string; title?: string; createdAt?: number; updatedAt?: number },
    protected sink: SessionSink,
  ) {
    this.harness = harness;
    this.nativeId = init.nativeId;
    this.projectPath = init.projectPath;
    this.title = init.title ?? "New session";
    this.createdAt = init.createdAt ?? Date.now();
    this.updatedAt = init.updatedAt ?? this.createdAt;
    this.t.state.preferEarlier = true;
    this.watchdog = setInterval(() => this.checkStall(), 60_000);
    this.guardKey = registerGuard(this);
  }

  get id() {
    return `${this.harness}:${this.nativeId}`;
  }

  summary(): SessionSummary {
    return {
      id: this.id,
      harness: this.harness,
      nativeId: this.nativeId,
      projectPath: this.projectPath,
      title: this.title,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      live: !this.closed,
      // A closed session has no process, so nothing can be running.
      status: this.closed ? "idle" : this.t.state.status,
      needsInput: this.t.state.pendingUi.length > 0,
      // runningKinds and workingCount go with activeCount ({} / 0 when only wakeups are armed):
      // browsers read their absence as an older runner that doesn't say.
      ...(this.activeCount ? { activeCount: this.activeCount, workingCount: this.workingCount, runningKinds: this.runningKinds() } : {}),
      ...(this.t.state.reviewOf ? { reviewOf: this.t.state.reviewOf.sessionId } : {}),
      ...(this.t.state.startedBy ? { startedBy: { sessionId: this.t.state.startedBy.sessionId, name: this.t.state.startedBy.name } } : {}),
      ...(this.t.state.leader ? { leader: true } : {}),
      ...(this.goalState?.status === "active" ? { goalActive: true } : {}),
      ...(this.schedules.length ? { nextRunAt: Math.min(...this.schedules.map((x) => x.nextAt)) } : {}),
    };
  }

  snapshot(): SessionSnapshot {
    return { session: this.summary(), messages: this.t.messages, state: this.t.state, seq: this.seq };
  }

  emit(event: SessionEvent): void {
    // Tool cards say what they are (shell, edit…) whatever the harness calls them.
    if (event.type === "msg") tagToolParts([event.msg]);
    else if (event.type === "reset") tagToolParts(event.messages);
    else if (event.type === "tool") tagToolPatch(() => findTool(this.t.messages, event.toolId)?.part, event.patch);
    const before = this.t.state.status;
    const beforeModel = this.t.state.model;
    const moved = movedAt(event, this.updatedAt, this.t.messages);
    const finished = this.fault?.state === "active" ? finishedTools(event, this.t.messages) : undefined;
    // Tool calls that finish during a turn go to your PostToolUse hooks (a history replay doesn't).
    const hookDone =
      !this.nativeHooks && this.t.state.status === "running" && (event.type === "tool" || event.type === "msg") && hooksFor("PostToolUse", { skip: this.hookSkip }).length
        ? finishedTools(event, this.t.messages)
        : undefined;
    applyEvent(this.t, event);
    this.seq++;
    this.lastActivity = Date.now();
    this.stallWarned = false;
    this.sink.emit(this.id, this.seq, event);
    if (moved !== this.updatedAt) {
      this.updatedAt = moved;
      // Browsers sort session lists by this; they only hear it through summaries, which otherwise
      // go out on title and status changes. A long turn would keep its start time and sink.
      if (Date.now() - this.movedSentAt > SUMMARY_EVERY_MS) {
        this.movedSentAt = Date.now();
        this.sink.summary(this.summary());
      }
    }
    if (event.type === "state") {
      const s = event.state;
      if (s.status === "idle") usageChanged();
      if (s.status === "running" && before !== "running") {
        this.continueOffer = undefined;
        this.withdrawOffer();
        this.turnTrouble = this.userStopped = false;
        this.finishDeferred = false;
        clearTimeout(this.settleTimer);
        clearTimeout(this.shellWaitTimer);
      }
      // A turn starts when Tether sends one (a queued message can start it without leaving
      // "running"), or when the harness starts one itself from idle; a retry inside a turn
      // (waiting → running) doesn't.
      if (s.status === "running" && (this.turnStarting || before === "idle")) {
        this.turnStarting = false;
        this.faultTurnStarted();
        this.goalTurnStarted();
        this.planTurnStarted();
        this.stopHookTurn = this.stopHookNext;
        this.stopHookChain = this.stopHookNext ? this.stopHookChain + 1 : 0;
        this.stopHookNext = false;
      }
      // The adapter showed the error on the message only (pi, Antigravity): the offer gets a notice.
      if (s.status === "idle" && before !== "idle" && this.continueOffer && !s.handoffTo) this.notice(this.continueOffer.text || "The turn ended with an error.", "error");
      if (s.status === "idle" && before !== "idle") this.endForeground();
      if (s.status === "idle" && before !== "idle" && !s.handoffTo) this.turnOver();
      if (s.status === "idle" && before !== "idle" && !this.t.state.handoffTo && !this.nativeHooks && !this.userStopped && !this.turnTrouble && !this.closed && !this.restarting && hooksFor("Stop", { skip: this.hookSkip }).length) {
        const run = this.hold(() => this.stopHooks()).catch((e) => console.error(`hooks: Stop for ${this.id} failed: ${e?.message ?? e}`));
        this.stopHookRun = run.finally(() => {
          if (this.stopHookRun === run) this.stopHookRun = undefined;
        });
      }
      if (s.status === "idle" && before !== "idle") this.goalTurnOver();
      if (s.status === "idle" && before !== "idle" && !s.handoffTo) this.planTurnOver();
      if (s.status === "idle" && before !== "idle") this.reviewTurnOver();
      // A cross-harness subagent's turn ended: its parent hears once it has settled (crossAgents.ts).
      if (s.status === "idle" && before !== "idle" && this.t.state.startedBy && !this.t.state.handoffTo && !this.closed)
        this.sink.agents?.turnEnded(this, this.userStopped ? "stopped" : this.turnTrouble ? "failed" : "finished");
      // A new process starts with no activity: the subagents this session started are still out there.
      if (s.activity && this.t.state.subagents?.length) this.sink.agents?.restored(this);
      // An approval or question the goal loop waited on was answered after the turn had ended.
      if (s.pendingUi && !s.pendingUi.length && this.goalHeld) {
        this.goalHeld = false;
        this.continueGoal();
      }
      // A scheduled run held back by a question or a plan review goes once it's answered.
      if (s.pendingUi && !s.pendingUi.length && this.t.state.pending?.[0]?.scheduleId) setTimeout(() => this.sendRunNow(), 0);
      if (s.status === "idle" && before !== "idle") void this.refreshDiffStats();
      if (s.status === "running" || s.pending) this.scheduleSteers();
      // The goal and loops/schedules are in the summary too (goalActive, nextRunAt): the lists show them.
      if (s.status !== undefined || s.pendingUi !== undefined || s.goal !== undefined || s.schedules !== undefined) {
        this.sink.summary(this.summary());
        this.armIdle();
      } else if (s.reviews !== undefined || s.pending !== undefined) this.armIdle(); // a review settled: the idle close counts from its result
      if (["status", "chain", "profile", "preferEarlier", "handoffFrom", "handoffTo", "forkedFrom", "guard", "checkpoints", "pending", "background", "context", "model", "thinking", "permissionMode", "modes", "thinkingLevels", "goal", "plan", "schedules", "reviews", "reviewOf", "subagents", "startedBy", "leader"].some((k) => k in s))
        this.savePrefs();
      if (s.activity) this.activityChanged();
      if (s.model && beforeModel && s.model !== beforeModel && this.t.state.context) {
        const context = switchModel(this.t.state.context, s.model);
        if (context !== this.t.state.context) this.setState({ context });
      }
    }
    if (event.type === "activity") this.activityChanged();
    if (event.type === "msg") this.notePlanParts(event.msg);
    if (finished?.length) this.faultToolsFinished(finished);
    for (const id of hookDone ?? []) {
      const p = findTool(this.t.messages, id)?.part;
      // Done, or a command that ran and failed (not one the guard or a hook stopped).
      if (p && (p.status === "done" || (p.status === "error" && kindOf(p.name) === "shell" && p.guard?.decision !== "deny" && !!p.output)))
        void this.postToolHook(id).catch((e) => console.error(`hooks: PostToolUse for ${this.id} failed: ${e?.message ?? e}`));
    }
    // A verdict can arrive before its tool card (Antigravity hooks run before the step event).
    if (event.type === "msg" && (this.pendingVerdicts.size || this.judging.size))
      for (const p of event.msg.parts)
        if (p.type === "tool" && this.pendingVerdicts.has(p.id)) {
          const guard = this.pendingVerdicts.get(p.id)!;
          this.pendingVerdicts.delete(p.id);
          this.emit({ type: "tool", msgId: event.msg.id, toolId: p.id, patch: { guard } });
        } else if (p.type === "tool" && this.judging.has(p.id) && !p.judging && !p.guard)
          this.emit({ type: "tool", msgId: event.msg.id, toolId: p.id, patch: { judging: true } });
    this.plans.observe(event);
    // A subagent's parent shows what it's doing now (throttled there).
    if (this.t.state.startedBy) this.sink.agents?.changed(this);
  }

  setState(state: Partial<LiveState>) {
    this.emit({ type: "state", state });
  }

  /**
   * Updates how full the context window is. Fields left out keep their value, unless the report
   * is for another model (its window differs); a missing window is guessed from the model name.
   */
  setContext(c: ContextUsage | undefined) {
    if (!c) return;
    // A goal's token budget: what each model request used, as the harness reports it (approximate).
    if (this.goalTurn && c.used !== undefined && c.used !== this.lastUsed) this.goalTokens += c.used;
    if (c.used !== undefined) this.lastUsed = c.used;
    this.setState({ context: mergeContext(this.t.state.context, c) });
  }

  /** After compaction: `used` is unknown (or the harness's post-compaction count) until the next request. */
  contextCompacted(used?: number) {
    const prev = this.t.state.context;
    if (prev) this.setState({ context: { ...prev, used, input: undefined, cacheRead: undefined, cacheWrite: undefined } });
  }

  /** A new session takes its title from the first message, as typed (`/skill args`, not SKILL.md). */
  protected autoTitle(text: string) {
    if (this.title === "New session") this.setTitle(displayText(text).replace(/\s+/g, " ").slice(0, 120));
  }

  setTitle(title: string) {
    // A harness that names sessions after the first message (pi) would name it after SKILL.md.
    title = config().titles[this.id] ?? displayText(title);
    if (!title || title === this.title) return;
    this.title = title;
    this.sink.summary(this.summary());
  }

  notice(text: string, level: Msg["level"] = "info", extra?: Pick<Msg, "title" | "collapsed" | "source">) {
    const id = newId("n");
    // An error that fallback didn't act on: the button moves the session on by hand.
    const offer = level === "error" ? this.continueOffer : undefined;
    const action = offer && { kind: "continueOn" as const, label: `Continue on ${entryLabel(offer.entry, this.harness)}`, entry: formatEntry(offer.entry) };
    if (offer) {
      this.continueOffer = undefined;
      this.withdrawOffer();
      this.offerMsgId = id;
    }
    this.emit({ type: "msg", msg: { id, role: "notice", parts: [{ type: "text", text }], ts: Date.now(), level, ...extra, ...(action ? { action } : {}) } });
    if (level === "error") {
      this.turnTrouble = true;
      this.alert("blocked", "Failed", text);
    }
  }

  // ---- notifications (runner/src/notify.ts pushes them to your devices) ----

  /** the running turn failed (already notified), so its end isn't also "finished" */
  private turnTrouble = false;
  private userStopped = false;

  private mcpAuthShown = new Set<string>();

  /**
   * Registry MCP servers this launch has no OAuth token for: a notice with an Authorize button,
   * once per server per session. `live`: a sign-in reaches this session without a restart (Claude).
   */
  mcpAuthNotice(need: { id: string; name: string; status: "needs" | "expired" }[] | undefined, live = false) {
    for (const n of need ?? []) {
      if (this.mcpAuthShown.has(n.id)) continue;
      this.mcpAuthShown.add(n.id);
      const what = n.status === "expired" ? `The sign-in to the ${n.name} MCP server has expired.` : `The ${n.name} MCP server needs authorization.`;
      const then = live ? "Its tools work once you sign in." : "Sign in, then start a new session to use its tools.";
      this.emit({
        type: "msg",
        msg: { id: newId("n"), role: "notice", level: "warning", parts: [{ type: "text", text: `${what} ${then}` }], ts: Date.now(), action: { kind: "mcpAuth", label: `Authorize ${n.name}`, server: n.id } },
      });
    }
  }

  protected alert(kind: "question" | "finished" | "blocked", what: string, detail: string) {
    const project = this.projectPath.split("/").pop() ?? "";
    notify({
      kind,
      title: `${what} · ${this.title}`.slice(0, 120),
      body: [project, detail.replace(/\s+/g, " ").trim()].filter(Boolean).join(": ").slice(0, 300),
      sessionId: this.id,
      projectPath: this.projectPath,
    });
  }

  /** the turn ended while subagents or shells still ran: "Finished" waits until they settle */
  private finishDeferred = false;
  private settleTimer?: ReturnType<typeof setTimeout>;
  /** How long the last item's end waits for a turn the agent starts on its own to report it. */
  static SETTLE_MS = 5_000;
  /**
   * Shells and monitors can run for good (a dev server, a log watch): once only they are left,
   * "Finished" waits this long at most and then says what's still running.
   */
  static SHELL_WAIT_MS = 3 * 60_000;
  private shellWaitTimer?: ReturnType<typeof setTimeout>;

  /** Agents and workflows always end and report back; "Finished" waits for them however long. */
  private get agentsWorking(): boolean {
    return (this.t.state.activity ?? []).some((a) => a.status === "running" && (a.kind === "subagent" || a.kind === "workflow"));
  }

  private turnOver() {
    const loopTurn = this.loopTurn;
    this.loopTurn = false;
    if (this.userStopped || this.turnTrouble || this.closed) return;
    // Under a goal the loop goes on, and a stop sends its own notification (stopGoal).
    if (this.goalTurn || this.goalState?.status === "active") return;
    // A loop's runs (/loop) don't each send "Finished": a 10-minute loop would notify all day.
    if (loopTurn) return;
    // A review session: the session it reviews says when the review is in.
    if (this.t.state.reviewOf) return;
    // A cross-harness subagent: the session that started it hears, and says when it's all done.
    if (this.t.state.startedBy) return;
    // Only when truly done: nothing the agent started is still working (armed wakeups and cron
    // jobs don't count). The last one to finish sends it (activityChanged).
    if (this.workingCount) {
      this.finishDeferred = true;
      this.armShellWait();
      return;
    }
    this.sendFinished();
  }

  private sendFinished(stillRunning?: ActivityItem[]) {
    clearTimeout(this.shellWaitTimer);
    const last = [...this.t.messages].reverse().find((m) => m.role === "assistant");
    const text = last?.parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join(" ") ?? "";
    const still = stillRunning?.length ? ` (still running: ${stillRunning.map((a) => a.command ?? a.title).join(", ")})` : "";
    this.alert("finished", "Finished", (text.slice(-300) || "The agent is waiting for your next message.") + still);
  }

  /** While "Finished" waits on shells and monitors alone, it goes out after SHELL_WAIT_MS anyway. */
  private armShellWait() {
    clearTimeout(this.shellWaitTimer);
    this.shellWaitTimer = setTimeout(() => {
      if (!this.finishDeferred || this.t.state.status !== "idle" || this.closed) return;
      if (this.agentsWorking) return this.armShellWait();
      const running = (this.t.state.activity ?? []).filter((a) => a.status === "running");
      if (!running.length) return;
      this.finishDeferred = false;
      if (this.userStopped || this.turnTrouble) return;
      this.sendFinished(running);
    }, LiveSession.SHELL_WAIT_MS);
  }

  // ---- activity: subagents, background shells, monitors, wakeups (adapters derive the items) ----

  /** the activity part of the last summary sent: a change sends a new one */
  private lastActivityKey = "[0,0,[]]";

  /** Items running or armed (waiting) right now. */
  get activeCount(): number {
    return ownWork(this.t.state.activity ?? []).length;
  }

  /** Items doing work right now: not an armed wakeup or cron job waiting for its time. */
  get workingCount(): number {
    return ownWork(this.t.state.activity ?? []).filter((a) => a.status === "running").length;
  }

  /** Items doing work right now, by kind. */
  runningKinds(): Partial<Record<ActivityKind, number>> {
    const out: Partial<Record<ActivityKind, number>> = {};
    for (const a of ownWork(this.t.state.activity ?? [])) if (a.status === "running") out[a.kind] = (out[a.kind] ?? 0) + 1;
    return out;
  }

  activity(id: string): ActivityItem | undefined {
    return this.t.state.activity?.find((a) => a.id === id);
  }

  /** updates waiting to go out together (latest action, steps, output): see upsertActivity */
  private activityQueue = new Map<string, ActivityItem>();
  private activityTimer?: ReturnType<typeof setTimeout>;
  /** How long progress-only updates wait to be sent together (a subagent's step comes in 2-3 frames). */
  static ACTIVITY_BATCH_MS = 250;
  /** foreground items the session ended when their turn did (the adapter may not know) */
  private endedWithTurn = new Set<string>();
  /** items stopped from Tether: their end doesn't send "Finished" (you were there) */
  private stoppedByUser = new Set<string>();

  /**
   * Inserts or replaces activity items (by id). A new item or a status change goes out at once
   * (counts and "Finished" depend on it); progress on a running item is batched, so a busy
   * subagent sends a few updates a second at most.
   */
  upsertActivity(...items: ActivityItem[]) {
    let now = false;
    for (let a of items) {
      const cur = this.activityQueue.get(a.id) ?? this.activity(a.id);
      // Ended with its turn: a late frame from the adapter can't revive it.
      if (this.endedWithTurn.has(a.id) && cur && !isActive(cur) && isActive(a)) a = { ...a, status: cur.status, endedAt: cur.endedAt };
      if (!cur || cur.status !== a.status) now = true;
      this.activityQueue.set(a.id, a);
    }
    if (now) this.flushActivity();
    else if (this.activityQueue.size && !this.activityTimer) this.activityTimer = setTimeout(() => this.flushActivity(), LiveSession.ACTIVITY_BATCH_MS);
  }

  private flushActivity() {
    clearTimeout(this.activityTimer);
    this.activityTimer = undefined;
    const items = [...this.activityQueue.values()];
    this.activityQueue.clear();
    if (items.length) this.emit({ type: "activity", items });
  }

  /**
   * The turn is over, so nothing that ran inside it (background: false — a long tool call, a
   * foreground subagent, a sleep) can still be going. Ends any the harness left open (an interrupt
   * that skipped its result, …): otherwise "Finished" never comes, the session counts as busy
   * across restarts and never closes when idle.
   */
  private endForeground() {
    this.flushActivity();
    const now = Date.now();
    const all = this.t.state.activity ?? [];
    const ended = all.filter((a) => isActive(a) && a.background === false);
    // What they started ends with them (a foreground workflow's agents).
    const stale = [...ended, ...descendants(all, new Set(ended.map((a) => a.id))).filter(isActive)];
    for (const a of stale) this.endedWithTurn.add(a.id);
    if (stale.length) this.upsertActivity(...stale.map((a) => ({ ...a, status: "stopped" as const, endedAt: now })));
  }

  private activityChanged() {
    // Browsers tell "working in the background" from idle (and agents from shells) by these, so
    // the summary goes out when an item starts, ends, or a wakeup fires — not only on status changes.
    // Sorted, so the same counts in another item order don't send again.
    const key = JSON.stringify([this.activeCount, this.workingCount, Object.entries(this.runningKinds()).sort()]);
    if (key !== this.lastActivityKey) {
      this.lastActivityKey = key;
      this.sink.summary(this.summary());
      this.savePrefs();
      this.armIdle();
    }
    // The last working item ended while the session sat idle: the deferred "Finished" goes out,
    // unless the agent starts a turn about it first (that turn's end decides instead).
    if (this.finishDeferred && !this.workingCount && this.t.state.status === "idle") {
      clearTimeout(this.settleTimer);
      this.settleTimer = setTimeout(() => {
        if (!this.finishDeferred || this.workingCount || this.t.state.status !== "idle") return;
        this.finishDeferred = false;
        // You stopped the last one yourself: you know it's over.
        const last = (this.t.state.activity ?? []).reduce<ActivityItem | undefined>((l, a) => ((a.endedAt ?? 0) > (l?.endedAt ?? 0) ? a : l), undefined);
        if (last && this.stoppedByUser.has(last.id)) return;
        this.turnOver();
      }, LiveSession.SETTLE_MS);
    }
  }

  /** The Stop button on one activity item. */
  async stopActivity(id: string) {
    const item = this.activity(id);
    if (!item) throw new Error("That item is no longer listed.");
    if (!isActive(item)) return;
    // A cross-harness subagent: its own session stops.
    if (item.sessionId && this.t.state.subagents?.some((l) => `xa:${l.id}` === item.id)) {
      if (!this.sink.agents) throw new Error("This runner can't stop subagents.");
      return this.sink.agents.stop(this, item.id.slice(3));
    }
    if (!item.stoppable || !this.stopActivityItem) throw new Error(`${this.harness} can't stop this from Tether.`);
    this.stoppedByUser.add(id);
    await this.stopActivityItem(item);
  }
  /** Adapters that can stop an item (Claude Code stopTask, …). */
  protected stopActivityItem?(item: ActivityItem): Promise<void>;

  /** The agent process is gone: nothing it ran is still going. */
  private endActivity() {
    const now = Date.now();
    this.upsertActivity(...(this.t.state.activity ?? []).filter(isActive).map((a) => ({ ...a, status: "stopped" as const, endedAt: now })));
  }

  addUserMessage(text: string, id = newId("u")) {
    // Shell runs already have their own card; don't show them again inside the prompt they ride on.
    for (const block of this.shellShown) if (text.includes(block)) text = text.replace(block, "").trim();
    this.emit({ type: "msg", msg: { id, role: "user", parts: userParts(text, id), ts: Date.now() } });
  }

  // ---- `!` shell mode ----
  // The person runs a command themselves, outside the guard. It shows as a Bash card right away;
  // like Claude Code's `!`, the agent sees the command and its output with the next message.

  private shellContext: string[] = [];
  private shellShown = new Set<string>();

  async runShell(command: string) {
    return this.hold(() => this.runShellNow(command));
  }

  private async runShellNow(command: string) {
    const id = newId("sh");
    const toolId = `${id}:bash0`;
    const guard: GuardVerdict = { decision: "allow", by: "user", reason: "Run by you directly, outside the guard" };
    this.emit({ type: "msg", msg: { id, role: "user", parts: [{ type: "tool", id: toolId, name: "Bash", input: { command }, status: "running", guard }], ts: Date.now() } });
    const proc = Bun.spawn(["bash", "-lc", command], { cwd: this.projectPath, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 10 * 60_000 });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    const cap = (s: string) => (s.length > 30_000 ? s.slice(0, 30_000) + "\n…(truncated)" : s.trimEnd());
    const tail = code ? `\n(exit code ${code})` : "";
    const output = [cap(stdout), cap(stderr)].filter(Boolean).join("\n") + tail;
    this.emit({ type: "tool", msgId: id, toolId, patch: { status: code ? "error" : "done", output: output.trim() } });
    const block = `<bash-input>${command}</bash-input>\n<bash-stdout>${cap(stdout)}</bash-stdout><bash-stderr>${cap(stderr) + tail}</bash-stderr>`;
    this.shellContext.push(block);
    this.shellShown.add(block);
  }

  /** Shell runs the agent hasn't seen yet, to go with the next message. */
  withShellContext(text: string): string {
    if (!this.shellContext.length) return text;
    const ctx = this.shellContext.join("\n\n");
    this.shellContext = [];
    return `${text}\n\n${ctx}`;
  }

  // ---- messages the agent has not taken yet ----
  // Tether holds every message sent while the agent works in `pending`: an ordered list that any
  // device can edit, reorder or cancel, saved to disk. Messages only leave from the top:
  //  - steers at the top go into the running turn once their grace period is over (the harness
  //    folds them in at its next step); a queued message blocks everything behind it;
  //  - when the turn ends, the top of the list starts the next turn: the steers at the top (together),
  //    or else the first queued message alone. Queued messages go one per turn, never merged; steers
  //    right below a queued message become eligible to steer into the turn it starts.
  // After Stop nothing leaves on its own (`pendingHeld`) until you send.
  // A steer that already went out can't be taken back; editing it sends a correction instead.

  static STEER_GRACE_MS = 5_000;
  private steerTimer?: ReturnType<typeof setTimeout>;
  /** user messages delivered as steers into the running turn (editable through a correction) */
  private steered = new Map<string, string>();
  /** a turn is being started from the pending list: steers wait until it has been sent */
  private draining = false;
  /** A waiting message is on its way to the agent right now (it left the list but isn't in the conversation yet). */
  get delivering(): boolean {
    return this.draining;
  }

  /** Sends a message: starts a turn when idle, otherwise adds it to the pending list. */
  async prompt(text: string, mode: "steer" | "followUp" = "steer", opts: { alone?: boolean } = {}) {
    // Held open until the message has reached the agent (the idle close waits); hold() runs
    // promptNow synchronously up to its first await, so the disarm below stays synchronous.
    return this.hold(() => this.promptNow(text, mode, opts.alone));
  }

  private async promptNow(text: string, mode: "steer" | "followUp", alone?: boolean) {
    // A new message changes the plan's approval: synchronously, since planReview.ts arms its
    // auto-approval right after calling this (so nothing below disarms again: keepArmed).
    this.plans.disarm();
    // A plan under discussion comes up for review again after this turn only when this message is
    // that discussion (discussPlan); any other message may change the plan.
    this.planDiscussed = this.discussNext;
    this.discussNext = undefined;
    if (await this.tetherCommand(text)) return;
    if (this.t.state.status === "waiting") this.cancelWait();
    // Your own message starts a fresh run of retries.
    if (this.t.state.status !== "running") this.fallbackAttempt = 0;
    if (this.t.state.status === "idle") {
      // An approved plan's turn is starting: this goes in after it, not as a second turn alongside.
      // Compacting: it waits, and goes on in the new session.
      // A message is on its way out (its UserPromptSubmit hooks can take a while): this goes in after it.
      if (this.planStarting || this.restarting || this.draining) {
        this.pend(text, mode, { keepArmed: true, alone });
        return;
      }
      if (!this.t.state.pending?.length) {
        this.draining = true;
        let sent = false;
        try {
          sent = await this.sendTyped(text);
        } finally {
          this.draining = false;
        }
        // A hook held it back: what came in meanwhile goes now.
        if (!sent && this.t.state.status === "idle" && this.t.state.pending?.length) await this.drainPending();
        else this.scheduleSteers();
        return;
      }
      // Held after Stop: sending releases the hold; the new message joins the bottom of the list,
      // and the list goes out from the top as usual (one queued message per turn).
      this.pend(text, mode, { keepArmed: true, alone });
      this.setState({ pendingHeld: undefined });
      await this.drainPending();
      return;
    }
    this.pend(text, mode, { keepArmed: true, alone });
  }

  /** a plan the next prompt() discusses (discussPlan) */
  private discussNext?: string;

  /** Sends your comments on a plan (plan review's Discuss): the agent's answer isn't a new plan, and that plan comes up for review again. */
  async discussPlan(planId: string, text: string, mode: "steer" | "followUp" = "followUp") {
    this.discussNext = findPlan(this.t.messages, planId) ? planId : undefined;
    await this.prompt(text, mode);
  }

  /** Tether's own commands (/goal, /loop, /schedule, /compact, /review, dev faults): true when it was one, handled here. */
  async tetherCommand(text: string): Promise<boolean> {
    if (this.devCommand(text)) return true;
    if (await this.goalCommand(text)) return true;
    if (await this.scheduleCommand(text)) return true;
    if (await this.compactCommand(text)) return true;
    return await this.reviewCommand(text);
  }

  protected pend(text: string, mode: "steer" | "followUp", opts: { now?: boolean; keepArmed?: boolean; alone?: boolean } = {}): PendingMessage {
    if (!opts.keepArmed) this.plans.disarm();
    const now = Date.now();
    const p: PendingMessage = {
      id: crypto.randomUUID(),
      text,
      mode,
      ts: now,
      ...(mode === "steer" ? { readyAt: opts.now ? now : now + LiveSession.STEER_GRACE_MS } : {}),
      ...(opts.alone ? { alone: true } : {}),
    };
    const list = this.t.state.pending ?? [];
    this.setPending(opts.now ? [p, ...list] : [...list, p]);
    return p;
  }

  private setPending(list: PendingMessage[]) {
    this.setState({ pending: list, ...(list.length ? {} : { pendingHeld: undefined }) }); // emit() reschedules steers
  }

  private scheduleSteers() {
    clearTimeout(this.steerTimer);
    const head = this.t.state.pending?.[0];
    if (!head || head.mode !== "steer" || !this.steer || this.draining || this.t.state.pendingHeld || this.t.state.status !== "running") return;
    this.steerTimer = setTimeout(() => this.deliverSteers(), Math.max(0, (head.readyAt ?? 0) - Date.now()));
  }

  private async deliverSteers() {
    const list = this.t.state.pending ?? [];
    if (this.closed || this.draining || this.t.state.status !== "running" || this.t.state.pendingHeld) return;
    const now = Date.now();
    let n = 0;
    // Tether's notes and another agent's messages are never joined with yours (who wrote them must match).
    while (n < list.length && list[n]!.mode === "steer" && (list[n]!.readyAt ?? 0) <= now && joins(list, n)) n++;
    if (!n) return this.scheduleSteers();
    const batch = list.slice(0, n);
    const text = await this.joinResolved(batch);
    // Resolving can wait on the harness: if the turn ended or the list changed meanwhile, the
    // batch is still at the top of the list and goes out from there.
    const cur = this.t.state.pending ?? [];
    if (this.closed || this.draining || this.t.state.status !== "running" || this.t.state.pendingHeld || !batch.every((b, i) => cur[i]?.id === b.id)) return this.scheduleSteers();
    this.setState({ pending: cur.slice(n) });
    let ok = false;
    try {
      ok = await this.steer!(text);
    } catch {}
    if (ok) {
      if (!this.echoesUserMessages) {
        const id = `u-${batch[0]!.id}`;
        this.addUserMessage(text, id);
        // A correction quotes the message as typed, not the skill it was expanded into.
        this.steered.set(id, joinPending(batch));
        this.setState({ amendable: [...this.steered.keys()] });
      }
    } else {
      // The turn ended meanwhile (or can't take steers right now): back on top, for the next turn.
      this.setState({ pending: [...batch, ...(this.t.state.pending ?? [])] });
      if ((this.t.state.status as string) === "idle") await this.drainPending();
      else if (this.t.state.status === "running" && !this.draining) {
        // Still running but not taking steers right now (e.g. compaction): try again shortly, not in a tight loop.
        clearTimeout(this.steerTimer);
        this.steerTimer = setTimeout(() => this.deliverSteers(), 1_000);
        return;
      }
    }
    this.scheduleSteers();
  }

  /** Adapter: the turn is over. Pending messages (unless held after Stop) start the next turn; true if they did. */
  protected async drainPending(): Promise<boolean> {
    // Held open until the next turn has been sent (the idle close waits).
    return this.hold(() => this.drainPendingNow());
  }

  private async drainPendingNow(): Promise<boolean> {
    clearTimeout(this.steerTimer);
    if (this.steered.size) {
      this.steered.clear();
      this.setState({ amendable: undefined });
    }
    if (this.closed || this.t.state.pendingHeld) return false;
    // Steers left at the top may go into this new turn, but only once it has really been sent.
    this.draining = true;
    let sent = false;
    try {
      // A message a UserPromptSubmit hook holds back is dropped; the next one goes instead.
      while (!sent && !this.closed) {
        const list = this.t.state.pending ?? [];
        const n = nextTurnSize(list);
        if (!n) break;
        this.setPending(list.slice(n));
        sent = await this.sendTyped(joinPending(list.slice(0, n)), list.slice(0, n));
      }
    } finally {
      this.draining = false;
    }
    this.scheduleSteers();
    return sent;
  }

  // ---- `/skill args` (runner/src/skillcmd.ts) ----
  // Resolved for this harness only as a message goes out, so waiting messages keep reading (and
  // editing) as typed, and a skill the harness can't run itself is sent along with the message.

  /** Skills this harness can run itself, as it reports them now; undefined when it can't say. */
  protected async nativeSkills(): Promise<NativeSkill[] | undefined> {
    return undefined;
  }

  /** How this harness is told to run one of its own skills (its connector's syntax); undefined: it can't now (expand). */
  protected nativeSkillText(name: string, args: string): string | undefined {
    return connectorFor(this.harness).skills.invoke(name, args);
  }

  /** the harness's last answer, and when */
  private nativeCache?: { at: number; skills: NativeSkill[] };
  static NATIVE_FRESH_MS = 30_000;
  static NATIVE_TIMEOUT_MS = 5_000;

  /**
   * What the harness can run itself. A send reuses an answer from the last 30 s (the menu that was
   * just open asked); otherwise it asks, waiting at most 5 s, and falls back to the last answer
   * (then to the skill's location, see decide()) so a slow harness never holds a message long.
   */
  private async nativeNow(fresh = false): Promise<NativeSkill[] | undefined> {
    const c = this.nativeCache;
    if (!fresh && c && Date.now() - c.at < LiveSession.NATIVE_FRESH_MS) return c.skills;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<undefined>((r) => (timer = setTimeout(() => r(undefined), LiveSession.NATIVE_TIMEOUT_MS)));
    try {
      const skills = await Promise.race([this.nativeSkills().catch(() => undefined), timeout]);
      if (skills) this.nativeCache = { at: Date.now(), skills };
      return skills ?? c?.skills;
    } finally {
      clearTimeout(timer);
    }
  }

  /** The message as typed, for the one `send()` is called with now (a handoff re-resolves it). */
  private outgoing?: { sent: string; typed: string };

  /** Resolves and sends; preferBest() can still see what was typed. */
  private async sendTyped(typed: string, batch?: PendingMessage[]): Promise<boolean> {
    const resolved = batch ? await this.joinResolved(batch) : await this.resolveSkills(typed);
    const sent = await this.promptHooks(typed, resolved);
    if (sent === undefined) return false; // held back by a UserPromptSubmit hook
    this.outgoing = { sent, typed };
    this.loopTurn = !!batch?.length && batch.every((p) => this.schedules.some((s) => s.id === p.scheduleId && s.kind === "loop"));
    this.turnStarting = true;
    try {
      await this.send(sent);
    } finally {
      this.outgoing = undefined;
    }
    return true;
  }

  /** the harness's last command list, and when (your library commands it runs itself) */
  private commandCache?: { at: number; names: Set<string> };

  /** The commands this harness runs itself, like nativeNow(); with no answer, a guess from where its command files are. */
  private async nativeCommandsNow(fresh = false): Promise<Set<string>> {
    const c = this.commandCache;
    if (!fresh && c && Date.now() - c.at < LiveSession.NATIVE_FRESH_MS) return c.names;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<undefined>((r) => (timer = setTimeout(() => r(undefined), LiveSession.NATIVE_TIMEOUT_MS)));
    try {
      const list = await Promise.race([this.listCommands().catch(() => undefined), timeout]);
      if (list) this.commandCache = { at: Date.now(), names: new Set(list.map((x) => x.name)) };
      return list ? this.commandCache!.names : (c?.names ?? offlineNativeCommands(this.harness, this.projectPath));
    } finally {
      clearTimeout(timer);
    }
  }

  /** One message as it goes out: `/skill args` becomes this harness's own invocation, or the expanded skill; one of your commands it doesn't have is filled in. */
  async resolveSkills(text: string, inner = false): Promise<string> {
    const inv = parseInvocation(text);
    if (!inv) return text;
    const native = await this.nativeNow();
    const commands = "name" in inv ? libraryCommands().filter((c) => c.name === inv.name) : [];
    return resolveMessage(text, {
      commands,
      // Not at the start of what's sent, the harness wouldn't run it: fill it in.
      commandNative: inner || !commands.length ? new Set() : await this.nativeCommandsNow(),
      harness: this.harness,
      projectPath: this.projectPath,
      skills: skillsFor(this.harness, this.projectPath, native),
      // Not at the start of what's sent, a native `/name` would be plain text: expand instead.
      native: inner ? new Set() : native && new Set(native.map((n) => n.name)),
      nativeText: (name, args) => this.nativeSkillText(name, args),
    });
  }

  /** Whether the harness runs a native skill invocation anywhere in a message (Codex's skill items), or only at its start. */
  protected nativeAnywhere = false;

  /** Waiting messages joined into one: only the first can use the harness's own `/name`. */
  private async joinResolved(list: PendingMessage[]): Promise<string> {
    return (await Promise.all(list.map((p, i) => this.resolveSkills(p.text, i > 0 && !this.nativeAnywhere)))).join("\n\n");
  }

  /** The composer's `/` menu: Tether's commands, the skills this session can run, then the harness's own commands. */
  async slashMenu(): Promise<SlashCommand[]> {
    const [commands, native] = await Promise.all([this.listCommands().catch(() => []), this.nativeNow(true)]);
    if (commands.length || native) rememberMenu(this.harness, this.projectPath, { commands, native });
    return menuOf(this.harness, this.projectPath, { commands, native });
  }

  private takeAllPending(): string | undefined {
    const list = this.t.state.pending ?? [];
    if (!list.length) return undefined;
    this.setPending([]);
    return joinPending(list);
  }

  /** Edits, reorders, cancels or sends one pending message (from any device). */
  async editPending(id: string, change: PendingChange) {
    return this.hold(() => this.editPendingNow(id, change));
  }

  private async editPendingNow(id: string, change: PendingChange) {
    const list = editedPending(this.t.state.pending ?? [], id, change);
    if (change.remove || change.text?.trim() === "") return this.setPending(list);
    if (change.now && this.t.state.status === "idle") {
      // Held after Stop (or the turn just ended): the hold is released and this message starts the
      // next turn; the rest follow from the top as usual.
      this.setState({ pending: list, pendingHeld: undefined });
      await this.drainPending();
      return;
    }
    if (change.now) this.setState({ pendingHeld: undefined });
    this.setPending(list);
  }

  /** ↑ in an empty composer: everything pending comes back as one text to rewrite. */
  takePending(): string {
    return this.takeAllPending() ?? "";
  }

  /** Editing a steer the agent already has: it can't be taken back, so the change goes in as a correction. */
  /** A steer the agent already has, as typed (amendSteer can change it). */
  steeredText(msgId: string): string | undefined {
    return this.steered.get(msgId);
  }

  amendSteer(msgId: string, text: string) {
    const before = this.steered.get(msgId);
    if (before === undefined) throw new Error("That message can't be changed any more: the turn it went into has ended.");
    // The browser edits only the words; the files attached to the message stay as they were (and
    // aren't sent again).
    const was = splitAttachments(before);
    const now = splitAttachments(text).text;
    if (now.trim() === was.text.trim()) return;
    const files = was.files.length ? ` The files attached to it (${was.files.map((f) => f.name).join(", ")}) still apply.` : "";
    this.pend(`I changed my earlier message. It said:\n\n${quote(was.text)}\n\nIt now says:\n\n${quote(now)}\n\nFollow the new version.${files}`, "steer");
  }

  /**
   * Force send: the message (new `text`, or the waiting message `id`) goes out now, ahead of
   * everything waiting. A running turn is stopped first, without a "Finished" and without holding
   * the rest; the message starts the next turn and the others follow from the top as usual.
   */
  async forceSend(o: { text?: string; id?: string; alone?: boolean }) {
    return this.hold(() => this.forceSendNow(o));
  }

  private async forceSendNow(o: { text?: string; id?: string; alone?: boolean }) {
    this.plans.disarm();
    this.planDiscussed = undefined;
    const list = [...(this.t.state.pending ?? [])];
    let p: PendingMessage;
    if (o.id) {
      const i = list.findIndex((x) => x.id === o.id);
      if (i < 0) throw new Error("That message was already sent.");
      const { readyAt: _, ...rest } = list.splice(i, 1)[0]!;
      p = { ...rest, mode: "followUp" };
    } else if (o.text?.trim()) p = { id: crypto.randomUUID(), text: o.text, mode: "followUp", ts: Date.now(), ...(o.alone ? { alone: true } : {}) };
    else throw new Error("Nothing to send.");
    clearTimeout(this.steerTimer);
    this.setState({ pending: [p, ...list], pendingHeld: undefined });
    if (this.t.state.status === "waiting") this.cancelWait();
    // Your own message starts a fresh run of retries.
    this.fallbackAttempt = 0;
    if (this.t.state.status === "idle") {
      // An approved plan's turn is starting, a compaction is under way or a message is on its way
      // out: this one is at the top of the list and goes next.
      if (this.planStarting || this.restarting || this.draining) return;
      await this.drainPending();
      return;
    }
    this.userStopped = true;
    // Stopped as a stop, not as the simulated error.
    if (this.fault && this.fault.state !== "armed") this.fault = undefined;
    // Not a dismissal: a plan review the abort cancels keeps holding changes back (tetherPlanReview).
    this.forcedReview = this.planReviewId;
    this.clearJudging();
    await this.abort();
  }

  /** The Stop button: aborts the turn. Pending messages stay, held until you send them. */
  async stop() {
    this.userStopped = true;
    // Your Stop pauses the goal: the loop would otherwise start the next turn.
    const g = this.goalState;
    if (g?.status === "active") {
      clearTimeout(this.goalTimer);
      this.putGoal({ ...g, status: "paused", reason: "Paused when you stopped the session.", updatedAt: Date.now() });
      this.notice("Goal paused. /goal resume picks it up again.");
    }
    // Your Stop ends the turn as a stop, not as the simulated error.
    if (this.fault && this.fault.state !== "armed") this.fault = undefined;
    this.plans.disarm();
    this.planDiscussed = this.planReraise = undefined;
    clearTimeout(this.steerTimer);
    if (this.t.state.pending?.length) this.setState({ pendingHeld: true });
    this.clearJudging();
    // Its cross-harness subagents stop with it.
    if (this.t.state.subagents?.some((l) => l.status === "working" || l.status === "waiting")) void this.sink.agents?.stopAll(this).catch(() => {});
    await this.abort();
  }

  // ---- persistence of per-session settings ----

  /** Restores settings saved by an earlier run of this session (call once the id is final). */
  loadPrefs() {
    this.prefsLoaded = true;
    const p = prefs(this.id);
    const restore: Partial<LiveState> = {};
    if (p.chain) restore.chain = p.chain;
    if (p.profile) restore.profile = p.profile;
    if (p.preferEarlier !== undefined) restore.preferEarlier = p.preferEarlier;
    if (p.handoffFrom) restore.handoffFrom = p.handoffFrom;
    if (p.handoffTo) restore.handoffTo = p.handoffTo;
    if (p.forkedFrom) restore.forkedFrom = p.forkedFrom;
    if (p.guard) restore.guard = p.guard;
    if (p.checkpoints) restore.checkpoints = p.checkpoints;
    if (p.context && !this.t.state.context) restore.context = p.context;
    // An active goal nothing will drive (the session wasn't running when it was saved, so no
    // restart resumes it, or it was handed off): paused, so /goal resume picks it up.
    let goal = p.goal;
    if (goal?.status === "active" && (!p.active || p.handoffTo)) {
      const reason = p.handoffTo ? "Continued in another session." : "Paused when the runner restarted.";
      goal = { ...goal, status: "paused", reason, updatedAt: Date.now() };
    }
    if (goal) restore.goal = goal;
    // A review that was open went with the old process; the plan stays, unreviewed.
    if (p.plan) restore.plan = p.plan.status === "review" ? { ...p.plan, status: "draft" } : p.plan;
    // Loops and schedules handed off went with the conversation.
    if (p.schedules?.length && !p.handoffTo) restore.schedules = p.schedules;
    // A review still starting went with the runner; one running finishes when its session resumes.
    if (p.reviews?.length)
      restore.reviews = p.reviews.map((r) => (r.status === "starting" ? { ...r, status: "failed" as const, error: "The runner restarted before the review started." } : r));
    // A review session opened again (not one just started): between turns its first report is in
    // already (or it failed), so only a new review_report changes the card.
    if (p.reviewOf && !this.t.state.reviewOf) {
      restore.reviewOf = p.reviewOf;
      this.reviewSettled = !p.active;
    }
    // Cross-harness subagents it started (handed off: they went with the conversation), and who started it.
    if (p.subagents?.length && !p.handoffTo) restore.subagents = p.subagents;
    if (p.startedBy && !this.t.state.startedBy) restore.startedBy = p.startedBy;
    if (p.leader && !this.t.state.leader) restore.leader = true;
    // Messages it hadn't taken when it stopped come back held, to send (or edit) when you choose.
    if (p.pending?.length && !this.t.state.pending?.length) Object.assign(restore, { pending: p.pending, pendingHeld: true });
    this.diffBaseSha = p.diffBaseSha;
    if (Object.keys(restore).length) this.setState(restore);
    // What it runs on now (model, modes, effort levels…), for showing it while it isn't running.
    else this.savePrefs();
    if (restore.subagents) this.sink.agents?.restored(this);
    if (restore.schedules) scheduleChanged();
    if (this.diffBaseSha || p.checkpoints?.length) void this.refreshDiffStats();
    // The harness's own goal follows Tether's again (it may still hold an older one).
    if (goal && this.mirrorGoal) void this.mirrorGoal(goal).catch(() => {});
    this.plans.load();
  }

  /**
   * After a resume: puts back the model, effort and mode the session last ran with (`saved`, read
   * before the session started, since starting re-saves its prefs). Not every harness keeps these
   * in its own session store (Claude doesn't), so a Haiku session would otherwise come back on the
   * default model. Modes come back only if they keep the guard asking.
   */
  async reapplyChoices(saved: { model?: string; thinking?: string; permissionMode?: string } | undefined) {
    if (!saved) return;
    const st = this.t.state;
    const warn = (what: string) => (e: any) => this.notice(`Could not restore the ${what}: ${e?.message ?? e}`, "warning");
    // A harness that has no model or effort choice (Kiro over ACP) has nothing to restore: no warning.
    if (saved.model && saved.model !== "default" && saved.model !== st.model && this.offers("model")) await this.applyModel(saved.model).catch(warn("model"));
    const levels = this.t.state.thinkingLevels;
    if (saved.thinking && saved.thinking !== this.t.state.thinking && this.offers("thinking")) {
      if (!levels || levels.includes(saved.thinking)) await this.setThinking(saved.thinking).catch(warn("effort"));
      else this.notice(`Could not restore the effort: ${this.t.state.model ?? "this model"} doesn't offer “${saved.thinking}”.`, "warning");
    }
    const mode = saved.permissionMode;
    if (mode && mode !== this.t.state.permissionMode && !APPROVING_MODES.has(mode)) {
      if (this.t.state.modes?.includes(mode)) await this.setPermissionMode(mode).catch(warn("mode"));
      else this.notice(`Could not restore the mode: ${this.harness} doesn't offer “${mode}” here.`, "warning");
    }
  }

  /** Whether this harness lets the model or effort be chosen (restoring skips what it doesn't). */
  protected offers(_what: "model" | "thinking"): boolean {
    return true;
  }

  /** Whether the agent is doing anything a restart would interrupt. */
  get busy(): boolean {
    // Cross-harness subagents are sessions of their own: they resume by themselves after a restart.
    const working = ownWork(this.t.state.activity ?? []).filter((a) => a.status === "running" && !a.sessionId).length;
    return this.t.state.status !== "idle" || working > 0 || (!this.t.state.activity && !!this.t.state.background?.length);
  }

  /** What a restart would stop, as the agent is told after one. */
  private backgroundWork(): BackgroundTask[] {
    if (!this.t.state.activity) return this.t.state.background ?? [];
    return ownWork(this.t.state.activity).filter((a) => a.status === "running" && !a.sessionId).map((a) => ({ id: a.id, description: a.title, type: a.agentType ? `${a.kind}: ${a.agentType}` : a.kind }));
  }

  savePrefs() {
    if (!this.prefsLoaded || this.nativeId.startsWith("pending-")) return;
    const s = this.t.state;
    const bg = this.backgroundWork();
    Object.assign(prefs(this.id), {
      chain: s.chain,
      profile: s.profile,
      preferEarlier: s.preferEarlier,
      handoffFrom: s.handoffFrom,
      handoffTo: s.handoffTo,
      forkedFrom: s.forkedFrom,
      guard: s.guard,
      checkpoints: s.checkpoints,
      context: s.context,
      model: s.model,
      thinking: s.thinking,
      permissionMode: s.permissionMode,
      modes: s.modes,
      thinkingLevels: s.thinkingLevels,
      diffBaseSha: this.diffBaseSha,
      pending: s.pending?.length ? s.pending : undefined,
      background: bg.length ? bg : undefined,
      goal: s.goal ?? undefined,
      plan: s.plan ?? undefined,
      schedules: s.schedules?.length ? s.schedules : undefined,
      reviews: s.reviews?.length ? s.reviews : undefined,
      reviewOf: s.reviewOf,
      subagents: s.subagents?.length ? s.subagents : undefined,
      startedBy: s.startedBy,
      leader: s.leader || undefined,
      // An active goal keeps the session going between turns: a restart resumes it like a turn.
      active: this.busy || (s.goal?.status === "active" && !s.handoffTo && !s.pendingUi.length),
      // Only Tether's own wait (waitThenContinue), not a harness's internal retry.
      waitingUntil: this.waitTimer ? s.waitingUntil : undefined,
      waitingReason: this.waitTimer ? s.waitingReason : undefined,
      projectPath: this.projectPath,
    });
    saveConfigSoon();
  }

  // ---- UI requests (permissions, extension dialogs, questions) ----

  private uiWaiters = new Map<string, (r: UiResponse) => void>();

  askUi(req: UiRequest, timeoutMs?: number): Promise<UiResponse> {
    this.setState({ pendingUi: [...this.t.state.pendingUi, req] });
    const tool = req.tool ? `${req.tool.name}${commandOf(req.tool.input) ? `: ${commandOf(req.tool.input)}` : ""}` : "";
    this.alert(
      "question",
      req.kind === "permission" ? "Approval needed" : "Question",
      req.questions?.[0]?.question ?? (req.kind === "permission" ? `Allow ${tool || req.title}?` : [req.title, req.message].filter(Boolean).join(": ")),
    );
    return new Promise((resolve) => {
      const done = (r: UiResponse) => {
        this.uiWaiters.delete(req.id);
        this.setState({ pendingUi: this.t.state.pendingUi.filter((u) => u.id !== req.id) });
        resolve(r);
      };
      this.uiWaiters.set(req.id, done);
      if (timeoutMs) setTimeout(() => this.uiWaiters.has(req.id) && done({ id: req.id, cancelled: true }), timeoutMs);
    });
  }

  /**
   * Answers the waiting request with this id; false when none is waiting (answered from another
   * device, a second tap, timed out, cancelled). Ids are unique, so an answer never lands on a
   * different request that has since taken the first one's place.
   */
  uiRespond(r: UiResponse): boolean {
    const done = this.uiWaiters.get(r.id);
    if (!done) return false;
    // A tool approval (or anything that gives an agent more permission) is the user's own click,
    // never the leader's: whatever the leader manager does, it can't answer one here.
    const req = this.t.state.pendingUi.find((u) => u.id === r.id);
    // An allowlist: only questions marked leaderMay (ask_user, AskUserQuestion, requestUserInput) and plans.
    if (r.by === "leader" && !leaderMayAnswer(req)) return false;
    if (this.t.state.pendingUi.some((u) => u.id === r.id && u.kind === "plan")) this.plans.disarm();
    done(r);
    return true;
  }

  /** Records the person's answer on a plan part (plan review approving it from Tether). */
  markPlan(planId: string, outcome: "approved" | "feedback") {
    const hit = findPlan(this.t.messages, planId);
    if (hit && hit.part.outcome !== outcome) this.emit({ type: "msg", msg: { ...hit.msg, parts: hit.msg.parts.map((p) => (p === hit.part ? { ...hit.part, outcome } : p)) } });
  }

  cancelAllUi() {
    for (const [id, done] of this.uiWaiters) done({ id, cancelled: true });
  }

  /** A handoff: cancels the approvals and questions still open here; returns them for the brief. */
  cancelOpenUi(): UiRequest[] {
    const open = [...this.t.state.pendingUi];
    this.cancelAllUi();
    return open;
  }

  /**
   * A mid-turn handoff: stops what the old agent still had going (shells, monitors, subagents,
   * schedules) where the harness can, and returns each with whether it stopped, for the brief. A
   * subagent's own items go with it.
   */
  async stopBackground(timeoutMs = 5_000): Promise<{ item: ActivityItem; stopped: boolean }[]> {
    this.flushActivity();
    // Not cross-harness subagents: they are sessions of their own, and go on.
    const active = (this.t.state.activity ?? []).filter((a) => isActive(a) && a.background !== false && !a.sessionId);
    const ids = new Set(active.map((a) => a.id));
    const out: { item: ActivityItem; stopped: boolean }[] = [];
    for (const item of active.filter((a) => !a.parentId || !ids.has(a.parentId))) {
      let stopped = false;
      if (item.stoppable && this.stopActivityItem) {
        this.stoppedByUser.add(item.id);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([this.stopActivityItem(item), new Promise((_, rej) => (timer = setTimeout(() => rej(new Error("timed out")), timeoutMs)))]);
          stopped = true;
        } catch {
        } finally {
          clearTimeout(timer);
        }
      }
      out.push({ item, stopped });
    }
    return out;
  }

  // ---- model chain & fallback ----

  get chain(): string[] | undefined {
    const c = this.t.state.chain;
    return c && c.length ? c : undefined;
  }

  get currentEntry(): ChainEntry {
    return { harness: this.harness, model: this.t.state.model ?? "default" };
  }

  private sameEntry(a: ChainEntry, b: ChainEntry) {
    return a.harness === b.harness && a.model === b.model;
  }

  /**
   * Before a new user turn: go back to the earliest available chain entry. Returns true when the
   * conversation was handed off to another harness (the prompt went with it).
   */
  protected async preferBest(pendingPrompt: string): Promise<boolean> {
    await this.checkpoint(pendingPrompt);
    const chain = this.chain;
    if (!chain || this.t.state.preferEarlier === false) return false;
    const pick = pickEntry(chain, this.harness, (key) => this.skipUntil(key));
    if (!("entry" in pick) || this.sameEntry(pick.entry, this.currentEntry)) return false;
    // Only move *up* the chain here; never sideways to an entry after the current one.
    const idx = (e: ChainEntry) => chain.findIndex((c) => this.sameEntry(parseEntry(c, this.harness), e));
    const cur = idx(this.currentEntry);
    if (cur >= 0 && idx(pick.entry) > cur) return false;
    if (pick.entry.harness === this.harness) {
      const key = providerOf(pick.entry.model, pick.entry.harness);
      const wasSkipped = this.skipped.delete(key);
      await this.applyModel(pick.entry.model);
      this.notice(wasSkipped ? `Back on ${entryLabel(pick.entry)}.` : `Back on ${entryLabel(pick.entry)}: its usage limit has reset.`);
      return false;
    }
    // The new harness resolves `/skill` for itself: hand over the message as typed.
    const typed = this.outgoing?.sent === pendingPrompt ? this.outgoing.typed : pendingPrompt;
    await this.sink.handoff(this, pick.entry, `${entryLabel(pick.entry)} is available again`, typed);
    return true;
  }

  /**
   * Called by an adapter when a turn ended in an error. Returns true when fallback took over
   * (the adapter must not report the session idle-with-error then). Otherwise, with a chain set,
   * the adapter's error notice gets a "Continue on <next>" button (see notice()).
   *
   * Only a definite limit moves the session (docs/harness-platform.md, Phase 1): the harness's
   * own structured signal (`hint.definite`), or text that looks like a limit confirmed by a fresh
   * usage fetch for the entry's account. 429/overloaded backs off on the same model. Entries whose
   * account Tether can't check never switch on their own.
   */
  protected async handleTurnError(errorText: string | undefined, status?: number | null, hint?: Classified): Promise<boolean> {
    const chain = this.chain;
    if (!chain) return false;
    const c = hint ?? classify(errorText, status);
    const current = this.currentEntry;
    let verifiable = !!accountOf(current);
    // A possible limit, rate-limit wording included (pi's "You have hit your ChatGPT usage limit …
    // Try again in ~N min", an Anthropic 429), is checked against the account's usage first. An
    // adapter's own rate-limit hint is taken as it is.
    let limit: { resetAt?: number } | undefined;
    if (c.kind === "quota" && c.definite) limit = { resetAt: c.resetAt ?? (await this.checkUsage(current)).limit?.resetAt };
    else if (c.kind === "quota" || (c.kind === "rate_limit" && verifiable && !hint)) {
      const check = await this.checkUsage(current);
      limit = check.limit;
      // A check that failed (expired login, network, an API change) proves nothing either way.
      if (check.unknown) verifiable = false;
    }
    const transient = c.kind === "rate_limit" || (c.kind === "quota" && !c.definite && !this.userStopped && !this.closed && isTransient(errorText, status));
    if (!limit && transient) {
      // Not a confirmed limit: back off and retry on the same model; never a switch. On an entry
      // whose usage can't be checked the backoff could go on forever on a real limit, so after
      // UNVERIFIED_BACKOFFS failed tries the error shows, with "Continue on …".
      if (!verifiable && this.fallbackAttempt >= UNVERIFIED_BACKOFFS) {
        this.offerContinue(errorText);
        return false;
      }
      const n = this.fallbackAttempt++;
      const delay = c.resetAt ? Math.max(5_000, c.resetAt - Date.now()) : backoffMs(n);
      this.waitThenContinue(Date.now() + delay, `Rate limited on ${entryLabel(current)}`);
      return true;
    }
    if (!limit) {
      this.offerContinue(errorText);
      return false;
    }
    const until = markExhausted(providerOf(current.model, current.harness), limit.resetAt ?? c.resetAt);
    this.notice(`Usage limit reached on ${entryLabel(current)} (resets ${fmtTime(until)}).`, "warning");
    // Stopped (or closed) while the usage check ran: the limit stands, but nothing moves on.
    if (this.userStopped || this.closed) return false;
    const pick = pickEntry(chain, this.harness);
    if ("waitUntil" in pick) {
      this.alert("blocked", "Waiting on usage limits", `Every model in the chain is at its limit; it continues at ${fmtTime(pick.waitUntil)}.`);
      this.waitThenContinue(pick.waitUntil, "Every model in this session's chain is at its usage limit");
      return true;
    }
    if (this.sameEntry(pick.entry, current)) {
      // Outside the chain's keys (shouldn't happen): wait for the reset rather than loop.
      this.waitThenContinue(until, `Waiting on ${entryLabel(current)}`);
      return true;
    }
    this.fallbackAttempt = 0;
    if (pick.entry.harness !== this.harness) {
      await this.sink.handoff(this, pick.entry, `${entryLabel(current)} hit its usage limit`, undefined, { interrupted: true });
      return true;
    }
    await this.applyModel(pick.entry.model);
    this.notice(`Switched to ${entryLabel(pick.entry)}.`);
    this.turnStarting = true;
    await this.continueTurn();
    return true;
  }

  // ---- "Continue on <next>": an error fallback didn't act on, moved on by hand ----

  /** quota key -> until when this session's preferBest leaves it alone ("Continue on …" moved off it) */
  private skipped = new Map<string, number>();
  private skipUntil(key: string) {
    const until = this.skipped.get(key);
    return until && until > Date.now() ? until : undefined;
  }

  /** set by handleTurnError; the next error notice carries it as a button */
  private continueOffer?: { entry: ChainEntry; text?: string };
  /** the notice whose button is live (withdrawn when a new turn starts) */
  private offerMsgId?: string;

  private offerContinue(errorText?: string) {
    const chain = this.chain;
    if (!chain || this.userStopped) return;
    const next = nextEntry(chain, this.currentEntry, this.harness);
    this.continueOffer = next && { entry: next, text: errorText?.trim() || undefined };
  }

  /** The session moved on: an older notice's button would act on a stale error. */
  private withdrawOffer() {
    const id = this.offerMsgId;
    this.offerMsgId = undefined;
    const msg = id && this.t.messages.find((m) => m.id === id);
    if (msg && msg.action) this.emit({ type: "msg", msg: { ...msg, action: undefined } });
  }

  /** The "Continue on …" button: moves to that entry (same harness: model switch; else handoff) and continues. */
  async continueOn(msgId: string) {
    const msg = this.t.messages.find((m) => m.id === msgId);
    const action = msg?.action;
    if (!msg || action?.kind !== "continueOn") throw new Error("That error has been dealt with already.");
    if (this.t.state.status === "running") throw new Error("The session is already working again.");
    this.cancelWait();
    if (this.offerMsgId === msgId) this.withdrawOffer();
    else this.emit({ type: "msg", msg: { ...msg, action: undefined } });
    const to = parseEntry(action.entry, this.harness);
    const from = this.currentEntry;
    // You judged it unusable for now: this session's next message shouldn't go straight back to
    // it. Only here, though: no limit was confirmed, so other sessions keep using it.
    const key = providerOf(from.model, from.harness);
    if (key !== providerOf(to.model, to.harness)) {
      const text = msg.parts.map((p) => (p.type === "text" ? p.text : "")).join(" ");
      this.skipped.set(key, parseReset(text) ?? Date.now() + MANUAL_SKIP_MS);
    }
    this.fallbackAttempt = 0;
    if (to.harness !== this.harness) return this.sink.handoff(this, to, `You moved it on from ${entryLabel(from)} after an error`, undefined, { interrupted: true });
    await this.applyModel(to.model);
    this.notice(`Switched to ${entryLabel(to)}.`);
    this.turnStarting = true;
    await this.continueTurn();
  }

  /** After a runner restart: picks a saved wait back up (a past time continues right away). */
  resumeWait(until: number, reason: string, text?: string) {
    this.waitThenContinue(until, reason, text);
  }

  private waitThenContinue(until: number, reason: string, text?: string) {
    clearTimeout(this.waitTimer);
    // The timer goes first: savePrefs (on the status change) persists the wait only while it's armed.
    this.waitTimer = setTimeout(async () => {
      this.waitTimer = undefined;
      if (this.closed || this.t.state.status !== "waiting") return;
      const chain = this.chain;
      if (chain) {
        const pick = pickEntry(chain, this.harness);
        if ("waitUntil" in pick) return this.waitThenContinue(pick.waitUntil, reason, text);
        if (pick.entry.harness !== this.harness) {
          this.setState({ waitingReason: undefined, waitingUntil: undefined });
          return this.sink.handoff(this, pick.entry, `${entryLabel(pick.entry)} has reset`, undefined, { interrupted: true });
        }
        if (pick.entry.model !== this.t.state.model) {
          await this.applyModel(pick.entry.model);
          this.notice(`Switched to ${entryLabel(pick.entry)}.`);
        }
      }
      this.setState({ waitingReason: undefined, waitingUntil: undefined });
      this.turnStarting = true;
      await this.continueTurn(text);
    }, Math.max(1_000, until - Date.now()));
    this.setState({ status: "waiting", waitingReason: reason, waitingUntil: until });
  }

  /**
   * A fresh usage fetch for the entry's account (fallback.ts confirmLimit), shown inline in the
   * chat while it runs ("Checking usage on …"): it can take a while.
   */
  private async checkUsage(entry: ChainEntry): Promise<UsageCheck> {
    if (!accountOf(entry)) return { unknown: true };
    this.setState({ checking: `Checking usage on ${entryLabel(entry)}…` });
    try {
      return await confirmLimit(entry);
    } finally {
      if (!this.closed) this.setState({ checking: null });
    }
  }

  /** Clears fallback state after a successful turn. */
  protected turnSucceeded() {
    this.fallbackAttempt = 0;
  }

  protected cancelWait(): boolean {
    if (!this.waitTimer) return false;
    clearTimeout(this.waitTimer);
    this.waitTimer = undefined;
    this.setState({ status: "idle", waitingReason: undefined, waitingUntil: undefined });
    return true;
  }

  /** Picks a profile (copied into this session's chain) or a single model (clears the chain). */
  async setModelOrProfile(model?: string, profileName?: string) {
    if (profileName) {
      const p = profile(profileName);
      if (!p) throw new Error(`No model profile "${profileName}"`);
      await this.setChain([...p.chain], undefined, p.name);
    } else if (model) {
      this.setState({ profile: undefined, chain: undefined });
      await this.applyModel(model);
    }
  }

  /** Sets this session's own fallback order. The first entry for this harness becomes current. */
  async setChain(chain: string[], preferEarlier?: boolean, profileName?: string) {
    this.setState({ chain, profile: profileName, ...(preferEarlier !== undefined ? { preferEarlier } : {}) });
    const pick = pickEntry(chain, this.harness);
    if ("entry" in pick && pick.entry.harness === this.harness && pick.entry.model !== this.t.state.model) await this.applyModel(pick.entry.model);
  }

  // ---- guard: who approves tool calls ----

  private pendingVerdicts = new Map<string, GuardVerdict>();
  private guardKey: string;
  /** Env for agent processes whose gate calls back into the guard (pi extension, agy hook). */
  get guardEnv() {
    return guardEnv(this.guardKey);
  }
  private approved = new Set<string>();

  get guardMode(): GuardMode {
    return this.t.state.guard ?? config().guard?.defaultMode ?? "auto";
  }

  /** What the user asked for, for the judge: the goal when one is set, the first request and the latest ones. */
  goal(): string {
    const asks = this.userAsks();
    const pick = asks.length > 4 ? [asks[0]!, "…", ...asks.slice(-3)] : asks;
    const text = pick.map((t) => t.slice(0, 1500)).join("\n---\n");
    // A goal states the task outright; the latest asks still say what's happening now.
    const g = this.goalState;
    const own = g ? `Goal: ${g.objective.slice(0, 1500)}${text ? `\n---\n${text}` : ""}` : text;
    // A subagent: what the user asked is the top session's; its task was written by another agent.
    if (!this.t.state.startedBy) return own;
    const task = this.t.messages.map((m) => (m.role === "user" ? subagentTask(m.parts.map((p) => (p.type === "text" ? p.text : "")).join("\n")) : undefined)).find(Boolean);
    const root = this.sink.agents?.userAsk(this);
    return [
      `What the user asked (in the session at the top of this subagent's tree):\n${root?.trim() || "(not available)"}`,
      task ? `This session is a subagent. Its task was written by the agent that started it, not by the user:\n${task.slice(0, 1500)}` : "This session is a subagent started by another agent.",
      own ? `In this session the user also wrote:\n${own}` : "",
    ]
      .filter(Boolean)
      .join("\n---\n");
  }

  /**
   * The user's own messages: Tether's notes about subagents quote other agents, a parent's
   * messages and task to its subagent are another agent's, a brief or a goal prompt is Tether's.
   */
  private userAsks(): string[] {
    return this.t.messages
      .filter((m) => m.role === "user")
      .map((m) => splitAgentWritten(m.parts.map((p) => (p.type === "text" ? p.text : p.type === "skill" ? `/${p.name}` : "")).join(" ").trim()).user)
      // "Implement the plan." is Tether's (an approval, maybe the leader's), not the user's ask.
      .filter((t) => t && !t.startsWith("You are taking over") && !isGoalPrompt(t) && t !== IMPLEMENT_PROMPT);
  }

  /** Every message text this session has (or will) send, attachment blocks included. */
  sentTexts(): string[] {
    const texts: string[] = [];
    for (const m of this.t.messages)
      if (m.role === "user")
        for (const p of m.parts) {
          if (p.type === "text") texts.push(p.text);
          else if (p.type === "file") texts.push(attachmentBlock([p]));
        }
    for (const p of this.t.state.pending ?? []) texts.push(p.text);
    return texts;
  }

  /**
   * The attachment folders (names under attachmentsDir()) this session's agent may read: its own,
   * and any its messages list files from (a handoff brings the earlier session's files along).
   */
  attachmentFolders(extra: string[] = []): string[] {
    return [...new Set([sessionKey(this.id), ...this.inheritedAttachments, ...referencedFolders([...this.sentTexts(), ...extra])])];
  }

  /** Attachment folders of the session this one took over from (its brief lists their files). */
  inheritedAttachments: string[] = [];

  /** A lifecycle ping from an out-of-process gate (see bridge.ts). Adapters that use one override it. */
  gateEvent(_event: string, _meta: Record<string, unknown>) {}

  /**
   * Decides one tool call. Adapters call this from their permission hook (Claude Code canUseTool,
   * ACP request_permission, the Antigravity PreToolUse bridge) and turn the answer into the
   * harness's own allow/deny. `_meta` is harness-specific context from an out-of-process gate.
   */
  async checkTool(tool: string, input: unknown, toolId?: string, _meta?: Record<string, unknown>): Promise<{ allow: boolean; reason?: string; always?: boolean }> {
    const kind = kindOf(tool);
    // The registry's trusted MCP servers, as they apply to this harness in this repo.
    const mcp = kind === "mcp" || kind === "other" ? await sessionTrust(this.harness, this.projectPath).catch(() => undefined) : undefined;
    const call = { tool, input, cwd: this.projectPath, attachments: this.attachmentFolders(), mcp };
    const key = JSON.stringify([tool, input]);
    let v: Verdict;
    let always = false;
    // A review session, plan mode (or a plan waiting for review) hold back changes, whatever the guard mode.
    const held = this.reviewHold(tool, input) ?? this.planHold(tool, input);
    // Your PreToolUse hooks (hooks.ts) come first, as in Claude Code; "Approve & retry" skips them.
    const hook = this.approved.has(key) || held ? undefined : await this.preToolHook(tool, input, toolId);
    const hookAllow = hook?.decision === "allow" ? hook.reason : undefined;
    if (this.approved.has(key)) v = { decision: "allow", by: "user", reason: "Approved after it was blocked." };
    else if (held) v = { decision: "deny", by: "mode", reason: held };
    // `continue: false` wins over any decision, as in Claude Code: the call doesn't run and the agent stops.
    else if (hook?.stop) v = { decision: "deny", by: "hook", reason: hook.stop };
    else if (hook?.decision === "deny") v = { decision: "deny", by: "hook", reason: hook.reason || "Blocked by a PreToolUse hook." };
    // A hook's allow skips the judge and the person; the guard's own deny rules still apply.
    else if (hookAllow !== undefined && this.guardMode !== "full") {
      const r = rules(call);
      v = r?.decision === "deny" ? r : { decision: "allow", by: "hook", reason: hookAllow || "Allowed by a PreToolUse hook." };
    }
    // Reading in a review session needs no judge: only the rules (secrets, other sessions' files) apply.
    else if (this.t.state.reviewOf) {
      const r = rules(call);
      v = r?.decision === "deny" ? r : { decision: "allow", by: "mode", reason: "Read-only review." };
    } else if (this.guardMode === "full") v = attachmentWrite(call) ?? { decision: "allow", by: "mode", reason: "Full access." };
    else {
      const r = rules(call);
      // A hook's "ask" puts the call in front of you where someone is meant to answer (Ask, Edits).
      const askEdit = (this.guardMode === "ask" && r?.decision === "allow" && kindOf(tool) === "edit") || (hook?.decision === "ask" && r?.decision !== "deny");
      if (r?.decision === "allow" && !askEdit) v = r;
      else if (this.guardMode === "ask" || this.guardMode === "edits") {
        const res = await this.askUi({
          id: newId("perm"),
          kind: "permission",
          title: `Allow ${tool}?`,
          message: r?.decision === "deny" ? `⚠ ${r.reason}` : hook?.decision === "ask" && hook.reason ? hook.reason : undefined,
          tool: { name: tool, input },
        });
        v = res.allow ? { decision: "allow", by: "user", reason: "You allowed it." } : { decision: "deny", by: "user", reason: res.value || "You denied it." };
        always = !!res.always;
      } else if (r?.decision === "deny") v = r;
      else {
        // The card shows "checking…" while the judge thinks; the verdict below replaces it.
        toolId = this.findCall(tool, toolId)?.part.id ?? toolId;
        if (toolId) this.setJudging(toolId, true);
        try {
          v = await judge(call, this.goal());
        } catch (e) {
          if (toolId) this.setJudging(toolId, false);
          throw e;
        }
        if (toolId) this.judging.delete(toolId);
      }
    }
    // A denied call isn't a notification: the agent sees the reason and carries on, and the verdict
    // shows on the tool card.
    const verdict: GuardVerdict = { decision: v.decision === "allow" ? "allow" : "deny", by: v.by, reason: v.reason };
    this.annotate(tool, toolId, verdict);
    return { allow: verdict.decision === "allow", reason: v.reason, always };
  }

  /** The card for this call: by id, or else the newest running one of that tool still undecided. */
  private findCall(tool: string, toolId?: string) {
    for (let i = this.t.messages.length - 1; i >= 0; i--) {
      const m = this.t.messages[i]!;
      const p = m.parts.find((x): x is Extract<Part, { type: "tool" }> => x.type === "tool" && (toolId ? x.id === toolId : x.name === tool && x.status === "running" && !x.guard && !x.judging));
      if (p) return { msg: m, part: p };
    }
  }

  private annotate(tool: string, toolId: string | undefined, guard: GuardVerdict) {
    const hit = this.findCall(tool, toolId);
    // The verdict also clears `judging` (see the reducer).
    if (hit) return this.emit({ type: "tool", msgId: hit.msg.id, toolId: hit.part.id, patch: { guard } });
    if (toolId) this.pendingVerdicts.set(toolId, guard);
  }

  /** Calls the judge is deciding right now (the card may not exist yet, see emit). */
  private judging = new Set<string>();

  private setJudging(toolId: string, on: boolean) {
    if (on) this.judging.add(toolId);
    else this.judging.delete(toolId);
    const hit = this.findCall("", toolId);
    if (hit && !!hit.part.judging !== on) this.emit({ type: "tool", msgId: hit.msg.id, toolId, patch: { judging: on } });
  }

  /** Stop or close: no card should keep saying "checking…" (a late verdict still lands). */
  private clearJudging() {
    for (const id of [...this.judging]) this.setJudging(id, false);
    for (const m of this.t.messages)
      for (const p of m.parts) if (p.type === "tool" && p.judging) this.emit({ type: "tool", msgId: m.id, toolId: p.id, patch: { judging: false } });
  }

  /** "Approve & retry" on a blocked call: allow that exact call from now on and tell the agent. */
  async approveBlocked(toolId: string, confirmed = false) {
    return this.hold(() => this.approveBlockedNow(toolId, confirmed));
  }

  private async approveBlockedNow(toolId: string, confirmed: boolean) {
    for (const m of this.t.messages)
      for (const p of m.parts)
        if (p.type === "tool" && p.id === toolId) {
          if (held(p.guard) && !confirmed) throw new Error(HELD_CONFIRM);
          this.approved.add(JSON.stringify([p.name, p.input]));
          this.emit({ type: "tool", msgId: m.id, toolId, patch: { guard: { decision: "allow", by: "user", reason: "Approved after it was blocked." } } });
          const what = commandOf(p.input) ?? JSON.stringify(p.input).slice(0, 300);
          await this.tellAgent(`The user approved your earlier blocked ${p.name} call (${what}). Run it now if it is still needed, then continue.`);
          return;
        }
    throw new Error("Tool call not found");
  }

  private runningBlocked = new Set<string>();

  /**
   * "Run it myself" on a blocked shell command: the runner runs it in the session's directory, like
   * `!` shell mode, shows the output on the card and hands it to the agent, which doesn't run it again.
   */
  async runBlocked(toolId: string, confirmed = false) {
    // Held open while the command runs and its output reaches the agent (the idle close waits).
    return this.hold(() => this.runBlockedNow(toolId, confirmed));
  }

  private async runBlockedNow(toolId: string, confirmed: boolean) {
    const hit = this.findCall("", toolId);
    // Shell commands only: an MCP or other tool with a `command` argument isn't one to run here.
    const command = hit?.part.kind === "shell" ? commandOf(hit.part.input) : undefined;
    if (!hit || !command) throw new Error("Shell command not found");
    if (this.runningBlocked.has(toolId) || hit.part.userRun) return;
    if (hit.part.guard?.decision !== "deny") throw new Error("Only a blocked command can be run this way");
    if (held(hit.part.guard) && !confirmed) throw new Error(HELD_CONFIRM);
    this.runningBlocked.add(toolId);
    const { msg } = hit;
    try {
      const guard: GuardVerdict = { decision: "allow", by: "user", reason: "Run by you directly, outside the guard" };
      this.emit({ type: "tool", msgId: msg.id, toolId, patch: { guard, userRun: { status: "running" } } });
      const input: any = hit.part.input;
      const dir = typeof input?.cwd === "string" ? input.cwd : typeof input?.workdir === "string" ? input.workdir : undefined;
      const cwd = dir ? resolve(this.projectPath, dir) : this.projectPath;
      const proc = Bun.spawn(["bash", "-lc", command], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 10 * 60_000 });
      const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      const cap = (s: string) => (s.length > 30_000 ? s.slice(0, 30_000) + "\n…(truncated)" : s.trimEnd());
      const output = [cap(stdout), cap(stderr)].filter(Boolean).join("\n").trim();
      this.emit({ type: "tool", msgId: msg.id, toolId, patch: { userRun: { status: "done", exitCode: code, output } } });
      await this.tellAgent(
        `Your blocked command was run by the user instead, so don't run it again:\n<bash-input>${command}</bash-input>\n` +
          `<bash-stdout>${cap(stdout)}</bash-stdout><bash-stderr>${cap(stderr)}${code ? `\n(exit code ${code})` : ""}</bash-stderr>\nContinue from there.`,
      );
    } finally {
      this.runningBlocked.delete(toolId);
    }
  }

  /** A note from Tether to the agent: into the running turn where possible, else it starts one. */
  private async tellAgent(text: string) {
    if (this.t.state.status === "running" && this.steer) this.pend(text, "steer", { now: true });
    else if (this.t.state.status === "running") this.pend(text, "followUp");
    else {
      this.turnStarting = true;
      await this.continueTurn(text);
    }
  }

  setGuard(mode: GuardMode) {
    this.setState({ guard: mode });
    this.onGuardChanged?.();
  }
  /** Adapters whose harness needs restarting or reconfiguring on a guard change. */
  protected onGuardChanged?: () => void;

  // ---- your hooks (runner/src/hooks.ts), for harnesses Tether runs them for ----
  // PreToolUse in checkTool, PostToolUse as tool cards finish, Stop when a turn ends, and
  // UserPromptSubmit before your message goes out. Claude Code runs them through its SDK instead
  // (nativeHooks); `hookSkip` leaves out the ones the harness already runs from its own config.

  /** The harness runs Tether's hooks itself (Claude Code's SDK callbacks): none run here. */
  protected nativeHooks = false;
  /** commandKeys of hooks the harness already runs natively (Codex's trusted hooks) */
  protected hookSkip?: Set<string>;
  /** a Stop hook's run, which the goal loop waits for before it continues */
  private stopHookRun?: Promise<void>;
  /** this turn was started by a Stop hook (`stop_hook_active`), and how many in a row */
  private stopHookTurn = false;
  private stopHookNext = false;
  private stopHookChain = 0;
  static MAX_STOP_CONTINUATIONS = 20;

  /** What every hook gets on stdin, in Claude Code's field names. */
  private hookInput(): Record<string, unknown> {
    return { session_id: this.id, transcript_path: "", permission_mode: this.t.state.permissionMode ?? "default", tether: { harness: this.harness, session_id: this.id } };
  }

  private get hookEnv(): Record<string, string> {
    return { TETHER_HARNESS: this.harness, TETHER_SESSION_ID: this.id };
  }

  private hookTool(tool: string, input: unknown) {
    const reg = loadMcpRegistry();
    return hookTool(tool, input, reg.servers.flatMap((s) => [s.name, ...(s.aliases ?? [])]));
  }

  /** systemMessage lines and failed hooks: inline in the chat. */
  private hookMessages(o: HookOutcome) {
    for (const m of o.messages) this.notice(m, "warning", { title: "Hook" });
    if (o.stop) {
      this.notice(o.stop, "warning", { title: "Stopped by a hook" });
      void this.stop().catch(() => {});
    }
  }

  /**
   * Calls a native hook allowed (Claude Code's SDK callback), by tool call id: checkTool treats them
   * like a hook's allow here, so plan mode, a review and the guard's deny rules still apply.
   */
  protected hookAllows = new Map<string, string>();

  private async preToolHook(tool: string, input: unknown, toolId?: string): Promise<HookOutcome | undefined> {
    if (this.nativeHooks) {
      const reason = toolId ? this.hookAllows.get(toolId) : undefined;
      if (toolId) this.hookAllows.delete(toolId);
      return reason !== undefined ? { decision: "allow", reason, context: [], messages: [], ran: 1 } : undefined;
    }
    const t = this.hookTool(tool, input);
    const runs = hooksFor("PreToolUse", { tool: t.name, skip: this.hookSkip });
    if (!runs.length) return undefined;
    const o = await runHooks("PreToolUse", { ...this.hookInput(), tool_name: t.name, tool_input: t.input, tool_use_id: toolId ?? "", tether: { harness: this.harness, session_id: this.id, tool_name: tool } }, { cwd: this.projectPath, runs, env: this.hookEnv });
    this.hookMessages(o);
    return o;
  }

  /** A tool card finished during a turn: PostToolUse hooks; what they say goes to the agent. */
  private async postToolHook(toolId: string) {
    const hit = findTool(this.t.messages, toolId);
    if (!hit || hit.msg.role !== "assistant") return;
    const p = hit.part;
    const t = this.hookTool(p.name, p.input);
    const runs = hooksFor("PostToolUse", { tool: t.name, skip: this.hookSkip });
    if (!runs.length) return;
    const output = p.output ?? "";
    const response = t.name === "Bash" ? { stdout: output, stderr: "", interrupted: false, isImage: false } : { output };
    const o = await runHooks(
      "PostToolUse",
      { ...this.hookInput(), tool_name: t.name, tool_input: t.input, tool_response: response, tool_use_id: p.id, tether: { harness: this.harness, session_id: this.id, tool_name: p.name } },
      { cwd: this.projectPath, runs, env: this.hookEnv },
    );
    if (this.closed) return;
    this.hookMessages(o);
    const said = [o.decision === "block" ? o.reason : undefined, ...o.context].filter(Boolean).join("\n\n");
    if (said) await this.hookFeedback(`PostToolUse hook feedback for ${t.name}:\n${said}`);
  }

  /** Feedback for the agent: into the running turn where it can take it, else with its next turn. */
  private async hookFeedback(text: string) {
    return this.hold(() => this.hookFeedbackNow(text));
  }

  private async hookFeedbackNow(text: string) {
    if (this.closed || this.t.state.handoffTo) return;
    if (this.t.state.status === "running" && this.steer) this.pend(text, "steer", { now: true });
    else if (this.t.state.status === "running") this.pend(text, "followUp");
    // You stopped the agent (or its turn failed): the feedback waits for your next message.
    else if (this.userStopped || this.t.state.pendingHeld || this.turnTrouble) {
      this.pend(text, "followUp");
      if (this.userStopped || this.t.state.pendingHeld) this.setState({ pendingHeld: true });
    } else {
      this.turnStarting = true;
      await this.continueTurn(text).catch((e) => {
        this.turnStarting = false;
        this.notice(`Couldn't send a hook's feedback: ${e?.message ?? e}`, "warning");
      });
    }
  }

  /** The turn ended: Stop hooks; a block sends their reason as the next prompt, like Claude Code. */
  private async stopHooks() {
    const runs = hooksFor("Stop", { skip: this.hookSkip });
    if (!runs.length) return;
    const last = [...this.t.messages].reverse().find((m) => m.role === "assistant");
    const text = last?.parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("\n") ?? "";
    const o = await runHooks("Stop", { ...this.hookInput(), stop_hook_active: this.stopHookTurn, last_assistant_message: text }, { cwd: this.projectPath, runs, env: this.hookEnv });
    if (this.closed || this.t.state.handoffTo || this.userStopped) return;
    for (const m of o.messages) this.notice(m, "warning", { title: "Hook" });
    if (o.decision !== "block" || o.stop) return;
    if (this.stopHookChain >= LiveSession.MAX_STOP_CONTINUATIONS) {
      this.notice(`Stop hooks kept the agent going ${this.stopHookChain} times in a row, so Tether let it stop. ${o.reason ?? ""}`.trim(), "warning", { title: "Hook" });
      return;
    }
    const prompt = `Stop hook feedback:\n${o.reason}`;
    if (this.t.state.status === "idle" && !this.t.state.pending?.length && !this.t.state.pendingUi.length && !this.restarting) {
      this.stopHookNext = true;
      this.turnStarting = true;
      await this.continueTurn(prompt).catch((e) => {
        this.stopHookNext = this.turnStarting = false;
        this.notice(`Couldn't continue after a Stop hook: ${e?.message ?? e}`, "warning");
      });
    } else this.pend(prompt, "followUp");
  }

  /**
   * Your message is about to go out: UserPromptSubmit hooks. Undefined: held back (the reason shows
   * inline); otherwise the text to send, with any context they added.
   */
  private async promptHooks(typed: string, sent: string): Promise<string | undefined> {
    // Not your words: a hook's own feedback waiting in the list.
    if (this.nativeHooks || /^(PostToolUse|Stop) hook feedback/.test(typed)) return sent;
    const runs = hooksFor("UserPromptSubmit", { skip: this.hookSkip });
    if (!runs.length) return sent;
    const o = await runHooks("UserPromptSubmit", { ...this.hookInput(), prompt: typed }, { cwd: this.projectPath, runs, env: this.hookEnv });
    for (const m of o.messages) this.notice(m, "warning", { title: "Hook" });
    if (o.decision === "block" || o.stop) {
      this.notice(`${o.reason ?? o.stop ?? ""}\n\nYour message:\n${typed}`.trim(), "warning", { title: "A hook held your message back" });
      return undefined;
    }
    if (!o.context.length) return sent;
    const block = `<user-prompt-submit-hook>\n${o.context.join("\n\n")}\n</user-prompt-submit-hook>`;
    // The agent gets it; the transcript shows your message as typed.
    this.shellShown.add(block);
    return `${sent}\n\n${block}`;
  }

  /** Whether "Approve & retry" let this exact call through (a native hook skips it too). */
  protected isApproved(tool: string, input: unknown): boolean {
    return this.approved.has(JSON.stringify([tool, input]));
  }

  /** A native hook (Claude Code's SDK callback) denied a call: the card says so, like the guard's verdicts. */
  protected hookDenied(tool: string, toolId: string | undefined, reason: string) {
    this.annotate(tool, toolId, { decision: "deny", by: "hook", reason });
  }

  // ---- checkpoints ----

  /**
   * Snapshots the working tree before a turn. Every turn gets an entry, even when nothing changed
   * (it then shares the previous commit), so each turn's changes line up with the transcript.
   */
  async checkpoint(label: string) {
    try {
      const list = this.t.state.checkpoints ?? [];
      const id = newId("c");
      // Named by id, not position: positions repeat once the list is capped.
      const ref = `refs/tether/checkpoints/${this.harness}-${this.nativeId.replace(/[^\w.-]/g, "_")}/${id}`;
      const prev = list[list.length - 1];
      const sha = await snapshot(this.projectPath, ref, label, prev?.sha);
      if (!sha) return;
      if (!this.diffBaseSha) {
        this.diffBaseSha = list[0]?.sha ?? sha;
        this.savePrefs();
      }
      // The previous turn is over: its changes are now fixed.
      const stat = prev && (sha === prev.sha ? { files: 0, additions: 0, deletions: 0 } : await diffStat(this.projectPath, prev.sha, sha).catch(() => undefined));
      const cp: Checkpoint = { id, sha, ts: Date.now(), label: displayText(label).replace(/\s+/g, " ").slice(0, 120) };
      const now = (this.t.state.checkpoints ?? []).map((c) => (c.id === prev?.id && stat ? { ...c, stat } : c));
      this.setState({ checkpoints: [...now, cp].slice(-50) });
    } catch (e: any) {
      console.error(`checkpoint failed for ${this.id}: ${e?.message ?? e}`);
    }
  }

  /**
   * After a turn: what the whole session and the turn that just ended changed, for the session
   * header and the transcript. Both are measured against the working tree as it is now.
   */
  async refreshDiffStats() {
    const list = this.t.state.checkpoints ?? [];
    const last = list[list.length - 1];
    const base = this.diffBaseSha ?? list[0]?.sha;
    if (!base) return;
    try {
      const [total, turn] = await workingTreeStats(this.projectPath, last ? [base, last.sha] : [base]);
      const now = this.t.state.checkpoints ?? [];
      const update: Partial<LiveState> = {};
      if (total) update.diffStat = total;
      if (last && turn && now[now.length - 1]?.id === last.id) update.checkpoints = now.map((c) => (c.id === last.id ? { ...c, stat: turn } : c));
      if (Object.keys(update).length && !this.closed) this.setState(update);
    } catch (e: any) {
      console.error(`diff stats failed for ${this.id}: ${e?.message ?? e}`);
    }
  }

  /** Its changes and files: what the Changes view and file references read (see sessionFiles). */
  get files() {
    return sessionFiles({ projectPath: this.projectPath, diffBase: this.diffBaseSha, checkpoints: this.t.state.checkpoints });
  }

  /** The whole session's changes, or with a checkpoint id the changes of the turn that started there. */
  diff(checkpointId?: string): Promise<SessionDiff> {
    return this.files.diff(checkpointId);
  }

  get diffBase() {
    return this.diffBaseSha;
  }

  // ---- file references (runner/src/files.ts): read-only, inside the project ----

  checkPaths(paths: string[]) {
    return this.files.checkPaths(paths);
  }

  fileDiff(path: string, checkpointId?: string, reveal?: boolean) {
    return this.files.fileDiff(path, checkpointId, reveal);
  }

  readFile(path: string, maxBytes?: number, reveal?: boolean) {
    return this.files.readFile(path, maxBytes, reveal);
  }

  inheritDiffBase(sha?: string) {
    if (!sha || this.diffBaseSha) return;
    this.diffBaseSha = sha;
    this.savePrefs();
  }

  // ---- dev fault injection (runner/src/faults.ts, TETHER_DEV=1) ----
  // armed: waits for a turn to start; active: this turn, counting finished tool calls; firing: the
  // adapter was asked to stop the real turn, and its end is replaced by the harness's own error.

  private fault?: { f: Fault; state: "armed" | "active" | "firing"; tools: Set<string> };
  /** Tether is starting a turn: the next "running" begins it, even from "running" (see emit) */
  private turnStarting = false;

  /** `/tether …` (dev only): handled here, never sent to the harness. True when it was one. */
  devCommand(text: string): boolean {
    const c = parseDevCommand(text);
    if (!c) return false;
    switch (c.cmd) {
      case "error":
        this.notice(c.text, "warning");
        break;
      case "limit-off":
        this.fault = undefined;
        this.notice("Simulated limit cleared.");
        break;
      case "limit": {
        this.fault = { f: c.fault, state: "armed", tools: new Set() };
        const running = this.t.state.status === "running";
        this.notice(describeFault(c.fault, running));
        if (c.fault.now && running) this.faultTurnStarted();
        break;
      }
      case "usage":
        simulateUsage(c.provider, simulatedUsage(c.provider, c.percent, c.resetMs));
        this.notice(`Simulated ${c.provider === "claude" ? "Claude" : "Codex"} usage: ${Math.round(c.percent)}%${c.resetMs ? `, resetting in ${fmtSpan(c.resetMs)}` : ""}. It stands in for the real usage until cleared.`);
        break;
      case "usage-clear":
        simulateUsage("claude");
        simulateUsage("codex");
        this.notice("Simulated usage cleared.");
        break;
      case "exhausted": {
        const e = parseEntry(c.entry, this.harness);
        markExhausted(providerOf(e.model, e.harness), Date.now() + c.ms);
        this.notice(`${entryLabel(e, this.harness)} counts as at its usage limit for ${fmtSpan(c.ms)}.`);
        break;
      }
      case "exhausted-clear":
        for (const k of Object.keys(config().exhausted)) delete config().exhausted[k];
        saveConfig();
        this.notice("No model counts as at its usage limit now.");
        break;
    }
    return true;
  }

  private faultTurnStarted() {
    const fault = this.fault;
    if (fault?.state !== "armed") return;
    fault.state = "active";
    fault.tools.clear();
    if (fault.f.afterTools === 0) this.fireFault();
  }

  private faultToolsFinished(ids: string[]) {
    const fault = this.fault;
    if (fault?.state !== "active") return;
    for (const id of ids) fault.tools.add(id);
    if (fault.tools.size >= fault.f.afterTools) this.fireFault();
  }

  /** Stops the real turn (after the adapter's current step, which may be what set it off). */
  private fireFault() {
    if (this.fault) this.fault.state = "firing";
    void Promise.resolve()
      .then(() => this.faultInterrupt?.())
      .catch((e) => console.error(`simulated limit: could not stop the turn of ${this.id}: ${e?.message ?? e}`));
  }

  /**
   * Adapter, at the end of a turn: the simulated error this turn ends with instead, if one was set
   * for it. A turn that ends before its tool count is reached ends with it too.
   */
  protected takeFault(): Fault | undefined {
    const fault = this.fault;
    if (!fault || fault.state === "armed") return undefined;
    this.fault = undefined;
    return fault.f;
  }

  /** Adapter: stops the running turn the harness's own way, for a simulated error (see takeFault). */
  protected faultInterrupt?(): void | Promise<void>;

  // ---- goal (/goal, runner/src/goal.ts) ----
  // While the goal is active, every turn that ends with nothing waiting on the user (no queued
  // message, approval or question) is followed by a short continuation prompt. The loop stops when
  // the goal is done (the agent says so and the background model agrees), blocked (by the agent,
  // GOAL_STALL_TURNS turns without progress, or a routine check every GOAL_CHECK_EVERY turns that
  // finds it stuck), out of its budget, or paused (Stop, /goal pause, a failed turn). Each stop the
  // user didn't make is a notification.

  /** the turn running under an active goal: where its messages start, and whether goal_update was called */
  private goalTurn?: { from: number; startedAt: number; updated: boolean };
  /** turns in a row without a tool call, a change to the working tree or a goal_update */
  private goalIdle = 0;
  /** goal turns since the background model last checked the goal (GOAL_CHECK_EVERY) */
  private goalUnchecked = 0;
  /** the working tree after the last goal turn (checkpoint.ts treeHash) */
  private goalTree?: string;
  /** tokens the harness reported during the running goal turn */
  private goalTokens = 0;
  private lastUsed?: number;
  /** the agent said the goal is done (goal_update, or Codex marked it complete): checked when the turn ends */
  private goalClaim?: string;
  /** the turn ended on an approval or question: the loop goes on once it's answered */
  private goalHeld = false;
  private goalTimer?: ReturnType<typeof setTimeout>;
  /** The harness continues a goal itself (Codex): Tether gives it this long before it continues instead. */
  static GOAL_NATIVE_SETTLE_MS = 5_000;
  /** set by adapters whose harness keeps its own copy of the goal and drives it (mirrorGoal worked) */
  protected nativeGoal = false;
  /** Adapters whose harness has goals of its own: mirror Tether's into it (null: cleared). */
  protected mirrorGoal?(g: SessionGoal | null): Promise<void>;

  get goalState(): SessionGoal | undefined {
    return this.t.state.goal ?? undefined;
  }

  /** bumped when the goal is set, cleared or changes status: a check that outlived its goal is dropped */
  private goalEpoch = 0;

  /** Sets (or clears) the goal, mirrored into the harness's own goal where it has one. */
  private putGoal(g: SessionGoal | null, mirror = true): Promise<void> {
    const was = this.goalState;
    if (!g || !was || g.createdAt !== was.createdAt || g.status !== was.status) this.goalEpoch++;
    this.setState({ goal: g });
    if (!mirror || !this.mirrorGoal) return Promise.resolve();
    return this.mirrorGoal(g).catch((e) => console.error(`goal: could not mirror into ${this.harness} for ${this.id}: ${e?.message ?? e}`));
  }

  /** set by adoptGoal: the harness's own goal is set once the brief's turn runs */
  private mirrorOnTurn = false;

  /**
   * A goal that came over in a handoff (Decision 6): it carries on here, loop and all. The
   * harness's own copy waits for the brief's turn to start, so it can't start a turn of its own first.
   */
  async adoptGoal(g: SessionGoal) {
    this.goalIdle = 0;
    this.goalUnchecked = 0;
    this.goalClaim = undefined;
    this.goalTree = await treeHash(this.projectPath).catch(() => undefined);
    this.mirrorOnTurn = !!this.mirrorGoal;
    await this.putGoal({ ...g, native: undefined, updatedAt: Date.now() }, false);
  }

  /**
   * The goal went over to `next` in a handoff: paused here, quietly (no notification), so this
   * session's loop and the harness's own copy (Codex) don't work it alongside the new session.
   * `where`: the new session's harness and model, as the handoff notice names it.
   */
  handOverGoal(where: string) {
    const g = this.goalState;
    if (g?.status !== "active") return;
    clearTimeout(this.goalTimer);
    this.goalHeld = false;
    this.goalClaim = undefined;
    void this.putGoal({ ...g, status: "paused", reason: `Continued on ${where}.`, updatedAt: Date.now() });
  }

  /** The loop stopped on its own: the goal's status and why, a notice, and a notification (a Needs-you item unless done). */
  private stopGoal(status: Exclude<GoalStatus, "active">, reason: string, by: GoalNote["by"] = "tether") {
    const g = this.goalState;
    if (!g) return;
    clearTimeout(this.goalTimer);
    this.goalHeld = false;
    void this.putGoal({ ...withNote(g, reason, by), status, reason, updatedAt: Date.now() });
    const head = status === "done" ? "Goal done" : status === "budget" ? "Goal out of budget" : status === "paused" ? "Goal paused" : "Goal blocked";
    this.notice(`${head}: ${reason}`, status === "done" ? "info" : "warning");
    if (status === "done") this.alert("finished", "Goal done", `${g.objective.slice(0, 120)}: ${reason}`);
    else this.alert("blocked", head, reason);
  }

  /** `/goal …`: handled here, never sent to the harness. True when it was one. */
  async goalCommand(text: string): Promise<boolean> {
    const c = parseGoalCommand(text);
    if (!c) return false;
    const g = this.goalState;
    const idle = () => this.t.state.status === "idle" && !this.t.state.pending?.length && !this.t.state.handoffTo;
    switch (c.cmd) {
      case "error":
        this.notice(c.text, "warning");
        break;
      case "status":
        this.notice(g ? describeGoal(g) : "No goal is set. Set one with /goal <objective>; Tether keeps the agent working on it until it's done.");
        break;
      case "set": {
        const goal = newGoal(c.objective, c.budget);
        this.autoTitle(c.objective);
        this.goalIdle = 0;
        this.goalUnchecked = 0;
        this.goalClaim = undefined;
        this.goalHeld = false;
        clearTimeout(this.goalTimer);
        this.notice(`Goal set${goal.budget ? ` (budget: ${fmtBudget(goal.budget)})` : ""}. Tether keeps the agent working on it until it's done; /goal pause stops it.`);
        this.goalTree = await treeHash(this.projectPath).catch(() => undefined);
        await this.putGoal(goal);
        // Running: the loop picks it up when this turn ends.
        if (idle()) this.continueGoal({ kickoff: true });
        break;
      }
      case "pause":
        if (!g) this.notice("No goal is set.");
        else if (g.status !== "active") this.notice(`The goal is ${STATUS_LABEL[g.status].toLowerCase()} already.`);
        else {
          clearTimeout(this.goalTimer);
          await this.putGoal({ ...withNote(g, "Paused by you.", "user"), status: "paused", reason: "Paused by you.", updatedAt: Date.now() });
          this.notice("Goal paused. /goal resume picks it up again.");
        }
        break;
      case "resume":
        if (!g) this.notice("No goal is set. Set one with /goal <objective>.");
        else if (g.status === "active") {
          // Idle with nothing driving it (it shouldn't happen, but if it does): continue it now.
          if (idle() && !this.goalTurn && !this.turnStarting) {
            this.notice("Goal resumed.");
            this.continueGoal();
          } else this.notice("The goal is active already.");
        }
        else if (budgetHit(g)) this.notice(`${budgetHit(g)} Set it again with a larger budget: /goal <objective> --turns <n>.`, "warning");
        else {
          this.goalIdle = 0;
          this.goalUnchecked = 0;
          this.goalClaim = undefined;
          await this.putGoal({ ...withNote(g, "Resumed by you.", "user"), status: "active", reason: undefined, updatedAt: Date.now() });
          this.notice("Goal resumed.");
          if (idle()) this.continueGoal();
        }
        break;
      case "clear":
        if (!g) this.notice("No goal is set.");
        else {
          clearTimeout(this.goalTimer);
          this.goalTurn = undefined;
          this.goalHeld = false;
          await this.putGoal(null);
          this.notice("Goal cleared.");
        }
        break;
    }
    return true;
  }

  /**
   * The `tether-context` goal tools (context/mcp.ts, through bridge.ts): `get` describes the goal,
   * `update` records progress, a "done" claim (checked when the turn ends), or a stop.
   */
  goalTool(action: string, args: { status?: unknown; note?: unknown }): { ok: boolean; text: string } {
    const g = this.goalState;
    if (action === "get") return { ok: true, text: g ? describeGoal(g) : "No goal is set for this session. The user sets one with /goal in Tether." };
    if (action !== "update") return { ok: false, text: `Unknown goal action "${action}".` };
    if (!g) return { ok: false, text: "No goal is set for this session." };
    const status = String(args.status ?? "active");
    const note = String(args.note ?? "").trim();
    if (!["active", "done", "blocked", "paused"].includes(status)) return { ok: false, text: 'status must be "active", "done", "blocked" or "paused".' };
    if (g.status !== "active") return { ok: true, text: `The goal is ${STATUS_LABEL[g.status].toLowerCase()}${g.reason ? ` (${g.reason})` : ""}; nothing changes until the user resumes it.` };
    if (this.goalTurn) this.goalTurn.updated = true;
    else this.goalIdle = 0;
    switch (status) {
      case "done":
        this.goalClaim = note || "The agent says the goal is done.";
        void this.putGoal(withNote(g, note || "Says the goal is done.", "agent"), false);
        // Outside a turn (a harness reporting between turns): checked now.
        if (!this.goalTurn && this.t.state.status === "idle") void this.afterGoalTurn(undefined);
        return { ok: true, text: "Noted. When this turn ends, Tether checks the goal against the conversation; if something is missing you'll be told what. End your turn now with a short summary." };
      case "blocked":
        this.stopGoal("blocked", note || "The agent can't go on without you.", "agent");
        return { ok: true, text: "The goal is marked blocked and the user has been notified. End your turn saying what you need from them." };
      case "paused":
        this.stopGoal("paused", note ? `Paused by the agent: ${note}` : "Paused by the agent.", "agent");
        return { ok: true, text: "The goal is paused. End your turn." };
      default:
        void this.putGoal(withNote(g, note || "Progress reported.", "agent"), false);
        return { ok: true, text: "Noted. Keep going." };
    }
  }

  /** Adapters with a native goal (Codex): its status changed there. Tether's copy stays the source of truth. */
  protected nativeGoalChanged(nativeStatus: string, tokensUsed?: number) {
    const g = this.goalState;
    if (!g) return;
    // Handed off: the goal runs in the new session; this harness's copy just follows Tether's.
    if (this.t.state.handoffTo) {
      if (fromCodexStatus(nativeStatus) !== g.status) void this.mirrorGoal?.(g).catch(() => {});
      return;
    }
    if (tokensUsed !== undefined && tokensUsed > g.used.tokens) void this.putGoal({ ...g, used: { ...g.used, tokens: tokensUsed } }, false);
    const s = fromCodexStatus(nativeStatus);
    if (!s || s === g.status) return;
    // Stopped in Tether: the harness's copy follows Tether's, not the other way round.
    if (g.status !== "active") return void this.mirrorGoal?.(g).catch(() => {});
    const harness = HARNESSES.find((h) => h.id === this.harness)?.label ?? this.harness;
    if (this.goalTurn) this.goalTurn.updated = true;
    if (s === "done") {
      this.goalClaim = `${harness} marked the goal complete.`;
      if (!this.goalTurn && this.t.state.status === "idle") void this.afterGoalTurn(undefined);
    } else if (s === "blocked") this.stopGoal("blocked", `${harness} marked the goal blocked.`, "agent");
    else if (s === "budget") this.stopGoal("budget", `${harness} says the goal used its token budget.`, "agent");
    else if (s === "paused") this.stopGoal("paused", `Paused in ${harness}.`, "agent");
  }

  private goalTurnStarted() {
    if (this.mirrorOnTurn) {
      this.mirrorOnTurn = false;
      if (this.goalState) void this.putGoal(this.goalState);
    }
    if (this.goalState?.status !== "active") return;
    clearTimeout(this.goalTimer);
    this.goalTurn = { from: this.t.messages.length, startedAt: Date.now(), updated: false };
    this.goalTokens = 0;
  }

  /** A turn ended (status went idle): count it against the goal and decide what comes next. */
  private goalTurnOver() {
    const turn = this.goalTurn;
    this.goalTurn = undefined;
    const g = this.goalState;
    if (!g || g.status !== "active" || this.closed || this.t.state.handoffTo) return;
    if (turn) {
      const used = { turns: g.used.turns + 1, tokens: g.used.tokens + this.goalTokens, ms: g.used.ms + (Date.now() - turn.startedAt) };
      void this.putGoal({ ...g, used, updatedAt: Date.now() }, false);
    }
    this.goalTokens = 0;
    // Stop paused it already; a failed turn (its error notice went out) pauses it here.
    if (this.userStopped) return;
    if (this.turnTrouble) {
      void this.putGoal({ ...this.goalState!, status: "paused", reason: "Paused because the turn ended with an error.", updatedAt: Date.now() });
      this.notice("Goal paused because the turn ended with an error. /goal resume picks it up again.");
      return;
    }
    void this.afterGoalTurn(turn);
  }

  /**
   * Progress; a "done" claim, a stall, or GOAL_CHECK_EVERY turns without a check go to the
   * background model; the budget; then the next turn.
   */
  private async afterGoalTurn(turn: { from: number; updated: boolean } | undefined) {
    const tree = await treeHash(this.projectPath).catch(() => undefined);
    const changed = tree !== this.goalTree;
    this.goalTree = tree;
    const g0 = this.goalState;
    if (!g0 || g0.status !== "active" || this.closed) return;
    const epoch = this.goalEpoch;
    const tools = turn ? this.t.messages.slice(turn.from).reduce((n, m) => n + m.parts.filter((p) => p.type === "tool").length, 0) : 0;
    // A turn Tether didn't see start (the goal was set mid-turn) isn't counted as idle.
    const progress = !turn || turn.updated || tools > 0 || changed;
    this.goalIdle = progress ? 0 : this.goalIdle + 1;
    if (turn) this.goalUnchecked++;
    const claim = this.goalClaim;
    this.goalClaim = undefined;
    let check: string | undefined;
    const kind = claim !== undefined ? "done" : this.goalIdle >= GOAL_STALL_TURNS ? "stalled" : this.goalUnchecked >= GOAL_CHECK_EVERY ? "periodic" : undefined;
    if (kind) {
      const stalled = kind === "stalled";
      this.goalUnchecked = 0;
      let verdict: GoalVerdict | undefined;
      let failure = "";
      try {
        verdict = await checkGoal({ goal: g0, transcript: transcriptTail(this.t.messages), claim: kind, cwd: this.projectPath });
      } catch (e: any) {
        failure = e?.message ?? String(e);
      }
      // Paused, cleared, replaced or handed off while the check ran (a pause and resume too).
      if (epoch !== this.goalEpoch || this.goalState?.status !== "active" || this.closed || this.t.state.handoffTo) return;
      if (kind === "periodic") {
        // A routine check: done or stuck stops the loop; otherwise (or with no check possible) it goes on.
        if (verdict?.done) return this.stopGoal("done", verdict.reason || "The objective is achieved.");
        if (verdict?.blocked) return this.stopGoal("blocked", verdict.reason || "The agent seems stuck.");
        if (!verdict) console.error(`goal: periodic check for ${this.id} failed: ${failure}`);
      } else {
        if (!verdict) {
          // No check possible: the agent's word stands for "done"; a stall still stops.
          if (stalled) return this.stopGoal("blocked", `No progress for ${GOAL_STALL_TURNS} turns in a row (Tether couldn't check whether it's done: ${failure}).`);
          return this.stopGoal("done", `${claim} (Tether couldn't double-check it: ${failure})`);
        }
        if (verdict.done) return this.stopGoal("done", verdict.reason || claim || "The objective is achieved.");
        if (stalled) return this.stopGoal("blocked", `No progress for ${GOAL_STALL_TURNS} turns in a row. ${verdict.reason}`.trim());
        check = verdict.reason || "The conversation doesn't show the objective achieved yet.";
        this.goalIdle = 0;
        void this.putGoal(withNote(this.goalState!, `Not done yet: ${check}`, "tether"), false);
      }
    }
    const over = budgetHit(this.goalState!);
    if (over) return this.stopGoal("budget", over);
    this.continueGoal({ check });
  }

  /**
   * The next goal turn, once nothing waits on the user. A harness that drives its own goal gets a
   * moment to continue by itself first; a rejected "done" goes out at once, with the reason.
   */
  private continueGoal(opts: { check?: string; kickoff?: boolean } = {}) {
    clearTimeout(this.goalTimer);
    const wait = this.nativeGoal && !opts.check ? LiveSession.GOAL_NATIVE_SETTLE_MS : 0;
    this.goalTimer = setTimeout(() => void this.hold(() => this.sendGoalTurn(opts)), wait);
  }

  private async sendGoalTurn(opts: { check?: string; kickoff?: boolean }) {
    // A Stop hook that sends the agent on goes first; the goal waits for that turn to end.
    if (this.stopHookRun) await this.stopHookRun;
    const g = this.goalState;
    if (!g || g.status !== "active" || this.closed || this.t.state.handoffTo) return;
    // A message, fallback, a plan approval or the harness's own goal started a turn; queued messages go first.
    if (this.t.state.status !== "idle" || this.t.state.pending?.length || this.planStarting || this.draining) return;
    if (this.t.state.pendingUi.length) {
      this.goalHeld = true;
      return;
    }
    const over = budgetHit(g);
    if (over) return this.stopGoal("budget", over);
    const text = opts.kickoff ? kickoffPrompt(g) : continuationPrompt(g, opts.check);
    await this.checkpoint(text);
    if (this.t.state.status !== "idle" || this.goalState?.status !== "active") return;
    this.turnStarting = true;
    try {
      await this.continueTurn(text);
    } catch (e: any) {
      this.turnStarting = false;
      const why = e?.message ?? String(e);
      // Paused, so /goal resume tries again (nothing else would drive it now).
      if (this.goalState?.status === "active")
        void this.putGoal({ ...this.goalState, status: "paused", reason: `Paused because Tether couldn't continue it: ${why}`, updatedAt: Date.now() });
      this.notice(`Could not continue the goal: ${why}. /goal resume tries again.`, "error");
      return;
    }
    // A rejected "done" left the harness's own copy complete: active again, now that the turn runs.
    if (opts.check && this.goalState) void this.putGoal(this.goalState);
  }

  // ---- plan and todos (runner/src/plan.ts), ask_user ----
  // One plan and todo list per session, from plan_set / todo_set or the harness's own plan and
  // todo tools (recorded as their parts go by, see notePlanParts). Where the harness has no plan
  // review of its own, Tether's review card stands in: when a plan-mode turn ends (Codex, ACP; pi
  // in Tether's plan mode), or an ACP agent leaves plan mode by itself. While planning, and while
  // a plan waits for that review, the guard holds back every call that would change something.

  /** Adapters whose harness plans without a review step Tether can see (Codex, ACP) or not at all (pi): planning now. */
  protected planning(): boolean {
    return false;
  }
  /** Adapters: out of plan mode once its plan is approved (Codex default, ACP's previous mode, pi's own). */
  protected async leavePlanMode(): Promise<void> {}
  /** A plan-mode turn's last reply counts as its plan when it wrote none with plan_set (pi, ACP: no plan item of their own). */
  protected planFromReply = false;
  /** The harness reviews plans itself (Claude Code's ExitPlanMode, Antigravity): plan_set only records. */
  protected nativePlanReview = false;

  /** a plan the agent left plan mode without: its review is pending, and changes wait for it (ACP) */
  private planGate = false;
  /** the plan part written during the running turn, and where the turn's messages start */
  private turnPlan?: string;
  /** a plan you're discussing (plan review's Discuss): it goes up for review again after the agent answers, unless it writes a new one */
  private planDiscussed?: string;
  /** a review force send cancelled while changes waited for it (planGate): it comes up again after that turn */
  private planReraise?: string;
  /** the review open when force send aborted the turn */
  private forcedReview?: string;
  private planTurnFrom = 0;
  /** plan and todo parts recorded already: an older one sent again can't replace a newer one */
  private planParts = new Set<string>();
  private todoPart?: string;
  /** the todo card todo_set made last */
  private ownTodoPart?: string;
  /** the open review (askUi id), and the plan part it is for */
  private planReviewId?: string;
  private planReviewPart?: string;
  /** a plan was approved and its implementing turn is on its way (the goal loop waits for it) */
  private planStarting = false;

  get planState(): SessionPlan | undefined {
    return this.t.state.plan ?? undefined;
  }

  private putPlan(patch: Partial<SessionPlan>) {
    const cur = this.planState ?? { text: "", todos: [], status: "draft" as const, updatedAt: 0 };
    const next: SessionPlan = { ...cur, ...patch, updatedAt: Date.now() };
    if (JSON.stringify({ ...next, updatedAt: 0 }) === JSON.stringify({ ...cur, updatedAt: 0 })) return;
    this.setState({ plan: next });
  }

  private planTurnStarted() {
    this.planStarting = false;
    this.turnPlan = undefined;
    this.planTurnFrom = this.t.messages.length;
  }

  /** Plans and todo lists in what the agent writes (any harness): the session's plan follows them. */
  private notePlanParts(msg: Msg) {
    if (msg.role !== "assistant") return;
    for (const p of msg.parts) {
      if (p.type === "plan") {
        if (p.checklist) {
          // ACP's plan updates are a checklist: the session's todo list.
          const todos = parseChecklist(p.text);
          if (todos.length && this.newerPart(p.id, "todo")) this.putPlan({ todos });
          continue;
        }
        if (!p.text.trim() || !this.newerPart(p.id, "plan")) continue;
        if (this.t.state.status !== "idle") this.turnPlan = p.id;
        const cur = this.planState;
        const status = p.outcome === "approved" ? "approved" : p.outcome === "feedback" ? "feedback" : cur?.partId === p.id && cur.status === "review" ? "review" : "draft";
        this.putPlan({ text: p.text, partId: p.id, status });
      } else if (p.type === "tool" && /^todowrite$/i.test(p.name)) {
        const todos = todosFromInput(p.input);
        if (todos && this.newerPart(p.id, "todo")) this.putPlan({ todos });
      }
    }
  }

  /** Whether this part may set the plan (todo list): the one that last did, or one not seen before. */
  private newerPart(id: string, kind: "plan" | "todo"): boolean {
    if (kind === "todo") {
      if (this.todoPart === id) return true;
      if (this.planParts.has(`todo:${id}`)) return false;
      this.planParts.add(`todo:${id}`);
      this.todoPart = id;
      return true;
    }
    if (this.planState?.partId === id) return true;
    if (this.planParts.has(id)) return false;
    this.planParts.add(id);
    return true;
  }

  /** Why plan mode holds this call back, if it does (checkTool). */
  private planHold(tool: string, input: unknown): string | undefined {
    const planning = this.planning();
    if (!planning && !this.planGate) return undefined;
    if (!mutates(tool, input)) return undefined;
    return planning && !this.planReviewId ? PLAN_MODE_REASON : PLAN_WAIT_REASON;
  }

  /** A turn ended: in plan mode, its plan goes up for review. */
  private planTurnOver() {
    const partId = this.turnPlan;
    this.turnPlan = undefined;
    // Answering your comments on a plan isn't a new plan: that plan goes up for review again. Only
    // after this turn's answer: a stopped or failed one leaves nothing to come back to.
    const discussed = this.planDiscussed && findPlan(this.t.messages, this.planDiscussed) ? this.planDiscussed : undefined;
    this.planDiscussed = undefined;
    // A compaction's turn writes no plan, whatever mode the session is in.
    if (this.compactTurn) return void (this.compactTurn = false);
    // (A review force send cancelled waits for the forced message's turn, not this stopped one.)
    if (this.closed || this.userStopped || this.turnTrouble) return;
    const reraise = this.planGate && this.planReraise && findPlan(this.t.messages, this.planReraise) ? this.planReraise : undefined;
    this.planReraise = undefined;
    if (!this.planning() && !this.planGate) return;
    const id = partId ?? discussed ?? reraise ?? (this.planFromReply ? this.replyAsPlan() : undefined);
    if (!id) return;
    // Up for review already (an ACP agent left plan mode by itself mid-turn): that card stays.
    if (this.planReviewId && this.planReviewPart === id) return;
    // A turn you started while an older plan waited (a message instead of the review): the newer plan replaces it.
    if (this.planReviewId) this.uiRespond({ id: this.planReviewId, cancelled: true });
    void this.tetherPlanReview(id);
  }

  /** The turn's last reply becomes its plan: the text part turns into a plan part (no second copy). */
  private replyAsPlan(): string | undefined {
    const hit = lastReply(this.t.messages, this.planTurnFrom);
    if (!hit) return undefined;
    const id = newId("plan");
    this.emit({ type: "msg", msg: { ...hit.msg, parts: hit.msg.parts.map((p, i) => (i === hit.index ? { type: "plan" as const, id, text: hit.text.trim() } : p)) } });
    return id;
  }

  /**
   * An agent left plan mode by itself (ACP), with no approved plan: changes wait for one. Its plan,
   * if it wrote one, goes up for review now; otherwise the turn's end looks for one.
   */
  protected leftPlanMode() {
    // Tether's own way out of plan mode (an approval, the mode picker) never comes here (ACP's
    // settingMode), so an earlier plan's approval doesn't count for this one.
    this.planGate = true;
    if (this.turnPlan && !this.planReviewId) void this.tetherPlanReview(this.turnPlan);
  }

  private get harnessLabel() {
    return HARNESSES.find((h) => h.id === this.harness)?.label ?? this.harness;
  }

  /** Tether's review card for a plan part; Approve leaves plan mode and has it carried out, feedback goes back as a message. */
  private async tetherPlanReview(partId: string) {
    const id = newId("plan-review");
    this.planReviewId = id;
    this.planReviewPart = partId;
    this.putPlan({ status: "review" });
    let res: UiResponse;
    try {
      // Approved after a discussion, and this is that plan again, unchanged: no second ask (planReview.ts).
      if (this.plans.autoApproves(findPlan(this.t.messages, partId)?.part.text ?? "")) res = { id, allow: true };
      else res = await this.askUi({ id, kind: "plan", title: `${this.harnessLabel}'s plan is ready for review`, planId: partId });
    } finally {
      if (this.planReviewId === id) this.planReviewId = this.planReviewPart = undefined;
    }
    if (this.closed) return;
    const current = this.planState?.partId === partId;
    if (res.cancelled) {
      // Replaced by a newer review: that one has the plan now.
      if (this.planReviewId) return;
      // Force send stopped the turn: not a dismissal. Changes keep waiting, and the plan comes up
      // for review again after the forced message's turn (unless that turn writes a new one).
      const forced = this.forcedReview === id;
      if (forced) this.forcedReview = undefined;
      if (forced && this.planGate) {
        this.planReraise = partId;
        return;
      }
      if (current && this.planState?.status === "review") this.putPlan({ status: "draft" });
      // Dismissed or stopped: you chose not to wait for it, so changes no longer do either.
      this.planGate = false;
      return;
    }
    if (res.allow) {
      // The go-ahead is on its way: a message sent meanwhile waits for it (prompt).
      this.planStarting = true;
      this.setPlanPart(partId, { outcome: "approved" });
      if (current) this.putPlan({ status: "approved" });
      this.planGate = false;
      try {
        await this.leavePlanMode();
      } catch (e: any) {
        this.notice(`Could not leave plan mode: ${e?.message ?? e}`, "warning");
      }
      return this.implementPlan();
    }
    // Discuss (plan review): the plan stays under review, changes keep waiting; the agent answers
    // your comments, then this plan (or a new one it writes) comes up for review again.
    if (res.discuss && res.value) {
      await this.discussPlan(partId, res.value, "steer");
      return;
    }
    const feedback = res.value?.trim() || "Please revise the plan.";
    this.setPlanPart(partId, { outcome: "feedback" });
    if (current) this.putPlan({ status: "feedback" });
    await this.prompt(feedback);
  }

  private setPlanPart(partId: string, patch: { text?: string; outcome?: "approved" | "feedback" }) {
    const hit = findPlan(this.t.messages, partId);
    if (hit) this.emit({ type: "msg", msg: { ...hit.msg, parts: hit.msg.parts.map((p) => (p === hit.part ? { ...hit.part, ...patch } : p)) } });
  }

  /**
   * Plan review approving a plan no request waits for (planReview.ts): where Tether reviews this
   * harness's plans and its plan mode (or a plan gate) is still on, the approval goes through here,
   * like Approve on the review card: out of plan mode, then the plan is carried out (with `notes`).
   * False where a message does it (Claude Code, Antigravity, or no longer planning).
   */
  async approvePlan(planId: string, notes?: string): Promise<boolean> {
    if (this.nativePlanReview || (!this.planning() && !this.planGate)) return false;
    this.planDiscussed = this.planReraise = undefined;
    this.planStarting = true;
    this.setPlanPart(planId, { outcome: "approved" });
    if (this.planState?.partId === planId) this.putPlan({ status: "approved" });
    this.planGate = false;
    try {
      await this.leavePlanMode();
    } catch (e: any) {
      this.notice(`Could not leave plan mode: ${e?.message ?? e}`, "warning");
    }
    await this.implementPlan(notes);
    return true;
  }

  /** After an approval: the agent carries the plan out (in the running turn, if there is one). */
  private async implementPlan(notes?: string) {
    // Held open until the plan's turn has started (the idle close waits).
    return this.hold(() => this.implementPlanNow(notes));
  }

  private async implementPlanNow(notes?: string) {
    const text = notes ? `${IMPLEMENT_PROMPT}\n\nNotes for the work:\n\n${notes}` : IMPLEMENT_PROMPT;
    if (this.t.state.handoffTo || this.closed) {
      this.planStarting = false;
      return;
    }
    if (this.t.state.status !== "idle") {
      this.planStarting = false;
      this.pend(text, "steer", { now: true });
      return;
    }
    this.planStarting = true;
    try {
      await this.checkpoint(text);
      this.turnStarting = true;
      await this.continueTurn(text);
    } catch (e: any) {
      this.planStarting = this.turnStarting = false;
      this.notice(`Could not start on the plan: ${e?.message ?? e}`, "error");
      // Messages sent while it was starting go out now.
      if (this.t.state.status === "idle") await this.drainPending();
    }
  }

  /** You picked a mode yourself (the mode picker): out of plan mode, nothing waits for a review any more. */
  protected modeChosen(mode: string) {
    if (isPlanMode(mode)) return;
    this.planGate = false;
    this.planDiscussed = this.planReraise = undefined;
  }

  /** A plan that came over in a handoff: the new session's plan, shown again (an open review starts over). */
  adoptPlan(p: SessionPlan) {
    const plan: SessionPlan = { ...p, status: p.status === "review" ? "draft" : p.status, partId: undefined, updatedAt: Date.now() };
    if (plan.text.trim()) {
      const partId = newId("plan");
      plan.partId = partId;
      this.planParts.add(partId);
      const outcome = plan.status === "approved" ? { outcome: "approved" as const } : {};
      this.emit({ type: "msg", msg: { id: newId("a"), role: "assistant", parts: [{ type: "plan", id: partId, text: plan.text, ...outcome }], ts: Date.now(), model: this.t.state.model } });
    }
    this.setState({ plan });
    if (plan.todos.length) this.showTodos(plan.todos);
  }

  /** The todo card (Claude Code's TodoWrite shape): updated in place until a user message comes after it. */
  private showTodos(todos: TodoItem[]) {
    // Only a card Tether made: the harness's own todo card is its to change.
    const part = this.todoPart === this.ownTodoPart ? this.ownTodoPart : undefined;
    const last = part ? this.t.messages.findLastIndex((m) => m.parts.some((p) => p.type === "tool" && p.id === part)) : -1;
    const msg = last >= 0 && !this.t.messages.slice(last + 1).some((m) => m.role === "user") ? this.t.messages[last] : undefined;
    if (msg) {
      this.emit({ type: "msg", msg: { ...msg, parts: msg.parts.map((p) => (p.type === "tool" && p.id === part ? { ...p, input: todoInput(todos) } : p)) } });
      return;
    }
    const id = newId("todo");
    this.planParts.add(`todo:${id}`);
    this.todoPart = this.ownTodoPart = id;
    this.emit({ type: "msg", msg: { id: newId("a"), role: "assistant", parts: [{ type: "tool", id, name: "TodoWrite", input: todoInput(todos), status: "done" }], ts: Date.now(), model: this.t.state.model } });
  }

  /**
   * The session tools of `tether-context` (context/mcp.ts, through bridge.ts): goal_get /
   * goal_update, plan_get / plan_set / todo_set, ask_user (which waits for the answer; `signal`
   * ends the wait when the agent gives up on the call).
   */
  async sessionTool(tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ ok: boolean; text: string }> {
    switch (tool) {
      case "goal_get":
        return this.goalTool("get", args);
      case "goal_update":
        return this.goalTool("update", args);
      case "plan_get":
        return { ok: true, text: describePlan(this.planState) };
      case "plan_set":
        return this.planSet(args.markdown);
      case "todo_set":
        return this.todoSet(args.items);
      case "ask_user":
        return this.askUser(args, signal);
      case "review_report":
        return this.reviewReport(args);
    }
    if (tool.startsWith("agent_")) {
      // The leader starts no subagents (its MCP server doesn't list them; the runner refuses them too).
      if (this.isLeaderSession) return { ok: false, text: "The leader agent doesn't start subagents." };
      if (!this.sink.agents) return { ok: false, text: "This Tether runner can't start subagents." };
      return this.sink.agents.tool(this, tool, args, signal);
    }
    // The leader's tools: the manager checks that this is the leader session.
    if (tool === "sessions_overview" || tool.startsWith("session_")) {
      if (!this.sink.leader) return { ok: false, text: "This Tether runner has no leader agent." };
      return this.sink.leader.tool(this, tool, args, signal);
    }
    return { ok: false, text: `Unknown tool "${tool}".` };
  }

  private planSet(markdown: unknown): { ok: boolean; text: string } {
    const text = String(markdown ?? "").trim();
    if (!text) return { ok: false, text: "markdown is required: the plan, as markdown." };
    if (text.length > 100_000) return { ok: false, text: "The plan is too long (100,000 characters at most)." };
    const cur = this.planState;
    // Rewritten in the same turn before anyone reviewed it: the same card, updated.
    const hit = cur?.partId && cur.partId === this.turnPlan && cur.status === "draft" ? findPlan(this.t.messages, cur.partId) : undefined;
    if (hit) this.setPlanPart(hit.part.id, { text });
    else this.emit({ type: "msg", msg: { id: newId("a"), role: "assistant", parts: [{ type: "plan", id: newId("plan"), text }], ts: Date.now(), model: this.t.state.model } });
    if (this.planning() || this.planGate)
      return { ok: true, text: "Plan saved. End your turn now: Tether shows it to the user for review, and you'll hear back when they approve it or send feedback. Don't change anything until then." };
    if (this.nativePlanReview && this.t.state.permissionMode === "plan")
      return { ok: true, text: "Plan saved in Tether. You're in your own plan mode: still present the plan for approval the usual way (in Claude Code, ExitPlanMode)." };
    return { ok: true, text: "Plan saved. The user sees it in Tether, and it carries over if the session moves to another agent." };
  }

  private todoSet(items: unknown): { ok: boolean; text: string } {
    const todos = parseTodos(items);
    if (typeof todos === "string") return { ok: false, text: todos };
    this.putPlan({ todos });
    this.showTodos(todos);
    const done = todos.filter((t) => t.status === "completed").length;
    return { ok: true, text: `Todo list updated: ${done} of ${todos.length} done.` };
  }

  /** How long a question waits when nobody is meant to be there to answer it (guard on Auto or Dangerously skip). */
  static UNATTENDED_QUESTION_MS = 15 * 60_000;

  /** How long a question waits: a person in the loop (Ask, Accept edits) is waited for; otherwise UNATTENDED_QUESTION_MS. */
  questionTimeout(): number | undefined {
    return this.guardMode === "ask" || this.guardMode === "edits" ? undefined : LiveSession.UNATTENDED_QUESTION_MS;
  }

  /** ask_user: the question card, on any harness; waits for the answer (or the unattended timeout). */
  async askUser(args: Record<string, unknown>, signal?: AbortSignal): Promise<{ ok: boolean; text: string }> {
    const question = String(args.question ?? "").trim();
    if (!question) return { ok: false, text: "question is required." };
    const raw = Array.isArray(args.options) ? args.options : [];
    const options = raw
      .map((o: any) => (typeof o === "string" ? { label: o.trim() } : { label: String(o?.label ?? "").trim(), ...(o?.description ? { description: String(o.description) } : {}) }))
      .filter((o) => o.label)
      .slice(0, 12);
    const id = newId("q");
    if (signal?.aborted) return { ok: false, text: "The question was cancelled." };
    signal?.addEventListener("abort", () => this.uiRespond({ id, cancelled: true }));
    const res = await this.askUi(
      { id, kind: "question", title: `${this.harnessLabel} has a question`, questions: [{ question, options, multiSelect: args.multiSelect === true }], leaderMay: true },
      this.questionTimeout(),
    );
    const answer = res.answers?.[question]?.trim();
    if (res.cancelled || !answer) return { ok: true, text: NOBODY_ANSWERED };
    if (res.by === "leader") return { ok: true, text: `The user's leader agent answered for them, passing on what the user told it: ${answer}` };
    return { ok: true, text: `The user answered: ${answer}` };
  }

  // ---- loops and schedules (/loop, /schedule, runner/src/schedule.ts) ----
  // The runner-wide Scheduler calls runSchedule() when a run is due (opening the session first if
  // its process had closed). A run is a queued user message in `pending`, tagged with the schedule:
  // it starts a turn at once when the session is idle, else it waits for the running turn to end.
  // While it waits, more runs of the same schedule collapse into it.

  /** the running turn was started by runs of loops only, or is a compaction (no "Finished" notification for it) */
  private loopTurn = false;

  get schedules(): SessionSchedule[] {
    return this.t.state.schedules ?? [];
  }

  private putSchedules(list: SessionSchedule[]) {
    this.setState({ schedules: [...list].sort(bySoonest) });
    scheduleChanged();
  }

  /** `/loop …` and `/schedule …`: handled here, never sent to the harness. True when it was one. */
  async scheduleCommand(text: string): Promise<boolean> {
    const c = parseTimerCommand(text);
    if (!c) return false;
    const now = Date.now();
    switch (c.cmd) {
      case "error":
        this.notice(c.text, "warning");
        break;
      case "list":
        this.notice(describeList(this.schedules, c.kind, now));
        break;
      case "remove": {
        const mine = ofKind(this.schedules, c.kind);
        const gone = c.which === "all" ? mine : mine.slice(c.which - 1, c.which);
        const what = c.kind === "loop" ? "loop" : "schedule";
        if (!mine.length) this.notice(c.kind === "loop" ? "No loops are running." : "No schedules are set.");
        else if (!gone.length) this.notice(`There's no ${what} ${c.which}. ${describeList(this.schedules, c.kind, now)}`, "warning");
        else {
          for (const s of gone) this.deleteSchedule(s.id, true);
          this.notice(gone.length === 1 ? `${c.kind === "loop" ? "Loop stopped" : "Schedule deleted"}: ${describeOne(gone[0]!, now).replace(/ Next .*$/, "")}` : `${gone.length} ${what}s ${c.kind === "loop" ? "stopped" : "deleted"}.`);
        }
        break;
      }
      case "add": {
        // Runs here would never go (runSchedule): the conversation goes on in the new session.
        if (this.t.state.handoffTo) {
          this.notice("This conversation continues in another session. Set it there.", "warning");
          break;
        }
        if (this.schedules.length >= MAX_SCHEDULES) {
          this.notice(`This session has ${MAX_SCHEDULES} loops and schedules already. Stop one first.`, "warning");
          break;
        }
        const s = newSchedule(c, now);
        if (!s) {
          this.notice("That never runs.", "warning");
          break;
        }
        this.putSchedules([...this.schedules, s]);
        if (s.kind === "loop") {
          this.notice(`Loop set: ${s.label}. It runs now, then next at ${fmtWhen(s.nextAt + (s.everyMs ?? 0), now)}. /loop stop ends it.`);
          this.runSchedule(s.id, now);
        } else this.notice(`Scheduled ${s.label}: next run ${fmtWhen(s.nextAt, now)}. /schedule delete removes it.`);
        // A loop or schedule set on a new session names it.
        this.autoTitle(s.prompt);
        break;
      }
    }
    return true;
  }

  /**
   * A run is due (the Scheduler, or a new loop's first run): the schedule moves on to its next
   * run (a one-off is removed) and its prompt is queued. False when it wasn't due or isn't here.
   */
  runSchedule(id: string, now = Date.now()): boolean {
    const s = this.schedules.find((x) => x.id === id);
    // A timer may fire a little early; one fired late for a run already moved on is dropped.
    if (!s || s.nextAt > now + 1_000 || this.closed || this.t.state.handoffTo) return false;
    const next = advance(s, now);
    this.putSchedules(this.schedules.flatMap((x) => (x.id !== id ? [x] : next ? [next] : [])));
    this.queueRun(s);
    return true;
  }

  /**
   * Queues one run of `s`, unless one is waiting already (overlapping runs collapse into it).
   * After Stop the hold keeps your messages back, but not the loop: a run that fires while held
   * goes by itself (the run that was waiting when you stopped goes with it, collapsed).
   */
  private queueRun(s: SessionSchedule) {
    const list = this.t.state.pending ?? [];
    if (!list.some((p) => p.scheduleId === s.id)) this.setPending([...list, { id: crypto.randomUUID(), text: s.prompt, mode: "followUp", ts: Date.now(), scheduleId: s.id }]);
    this.sendRunNow(s.id);
  }

  /**
   * A queued run goes out at once only when nothing else is going on: idle, no turn being
   * started, nothing waiting on the user (a plan review, a question). Otherwise it waits; the end
   * of the running turn sends it like any queued message. Held after Stop, only the run of
   * `fired` (one that just came due) goes, alone; the rest stays held.
   */
  private sendRunNow(fired?: string) {
    const st = this.t.state;
    if (this.closed || st.status !== "idle" || st.pendingUi.length || st.handoffTo) return;
    if (this.turnStarting || this.draining || this.planStarting || this.restarting) return;
    const failed = (e: any) => this.notice(`Could not send the scheduled prompt: ${e?.message ?? e}`, "error");
    if (st.pendingHeld) {
      const run = fired ? st.pending?.find((p) => p.scheduleId === fired) : undefined;
      if (run) void this.hold(() => this.sendHeldRun(run)).catch(failed);
      return;
    }
    if (st.pending?.[0]?.scheduleId) void this.drainPending().catch(failed);
  }

  private async sendHeldRun(run: PendingMessage) {
    this.draining = true;
    try {
      this.setPending((this.t.state.pending ?? []).filter((p) => p.id !== run.id));
      await this.sendTyped(run.text, [run]);
    } finally {
      this.draining = false;
    }
  }

  /** A run that was waiting when the runner stopped (resumeActive): queued again as it was. */
  requeueRun(p: PendingMessage) {
    const list = this.t.state.pending ?? [];
    if (!list.some((x) => x.scheduleId === p.scheduleId)) this.setPending([...list, { ...p, mode: "followUp", readyAt: undefined }]);
    this.sendRunNow();
  }

  /** Stops a loop or deletes a schedule; a run of it still waiting in the queue goes too. */
  deleteSchedule(id: string, quiet = false): SessionSchedule | undefined {
    const s = this.schedules.find((x) => x.id === id);
    if (!s) return undefined;
    this.putSchedules(this.schedules.filter((x) => x.id !== id));
    const list = this.t.state.pending ?? [];
    if (list.some((p) => p.scheduleId === id)) this.setPending(list.filter((p) => p.scheduleId !== id));
    if (!quiet) this.notice(`${s.kind === "loop" ? "Loop stopped" : "Schedule deleted"}: ${describeOne(s).replace(/ Next .*$/, "")}`);
    return s;
  }

  /** Loops and schedules that came over in a handoff: they run here now. */
  adoptSchedules(list: SessionSchedule[]) {
    if (!list.length) return;
    const mine = new Set(this.schedules.map((s) => s.id));
    this.putSchedules([...this.schedules, ...list.filter((s) => !mine.has(s.id))]);
  }

  /** They went over to the new session in a handoff: none run here any more. */
  handOverSchedules() {
    if (this.schedules.length) this.putSchedules([]);
  }

  // ---- cross-harness subagents (agent_start…, runner/src/crossAgents.ts) ----
  // The parent keeps one link per subagent (`subagents`, saved in prefs) and shows each as an
  // activity item; the subagent has `startedBy`. The manager in crossAgents.ts does the rest.

  get subagents(): SubagentLink[] {
    return this.t.state.subagents ?? [];
  }

  /** A subagent's link changed (or is new): kept here and shown as its activity item. */
  putSubagent(link: SubagentLink, item?: ActivityItem) {
    const list = this.subagents;
    const i = list.findIndex((l) => l.id === link.id);
    this.setState({ subagents: i >= 0 ? list.map((l) => (l.id === link.id ? link : l)) : [...list, link] });
    if (item) this.upsertActivity(item);
  }

  /** Subagents that came over in a handoff: this session follows them from now on. */
  adoptSubagents(list: SubagentLink[]) {
    const mine = new Set(this.subagents.map((l) => l.id));
    const add = list.filter((l) => !mine.has(l.id));
    if (add.length) this.setState({ subagents: [...this.subagents, ...add] });
    this.sink.agents?.restored(this);
  }

  /** Handed off: the subagents are followed by the new session (their items leave this one). */
  handOverSubagents() {
    if (!this.subagents.length) return;
    this.setState({ subagents: [], activity: (this.t.state.activity ?? []).filter((a) => !(a.sessionId && a.id.startsWith("xa:"))) });
  }

  /** This session moved on from `from` (a fallback, /compact): it is the same subagent. Before start. */
  inheritStartedBy(from: LiveSession) {
    if (from.t.state.startedBy) this.t.state.startedBy = from.t.state.startedBy;
  }

  /** Whether this is the leader agent's session, also before its prefs are loaded (its launch adds the leader tools). */
  get isLeaderSession(): boolean {
    return !!(this.t.state.leader ?? config().sessions[this.id]?.leader);
  }

  /** The leader's conversation moved on from `from` (a fallback, /compact): this is the leader now. Before start. */
  inheritLeader(from: LiveSession) {
    if (from.isLeaderSession) this.t.state.leader = true;
  }

  /** Whether changes are held back here (a review session, plan mode or a plan awaiting review): no subagents start. */
  get holdsChanges(): boolean {
    return !!this.t.state.reviewOf || this.planning() || !!this.planGate;
  }

  /**
   * A note from Tether about a subagent: into the running turn (a steer where the harness takes
   * them, else queued); idle, it starts a turn. Waiting on a limit, or held after your Stop, it waits.
   */
  async tetherNote(text: string) {
    const st = this.t.state;
    // Always alone: joined with your own queued message, the subagent's words would read as yours.
    if (st.status === "running") this.pend(text, this.steer ? "steer" : "followUp", { keepArmed: true, alone: true });
    else if (st.status === "waiting" || st.pendingHeld || this.restarting || this.planStarting) this.pend(text, "followUp", { keepArmed: true, alone: true });
    else await this.prompt(text, "followUp", { alone: true });
  }

  // ---- review (/review, runner/src/review.ts) ----
  // The session reviewed keeps one card per review (`reviews`), which the review session's report
  // fills in through the sink (reviewResult, also when this session is closed). The review session
  // has `reviewOf`: the guard holds back every change in it, and review_report reports.

  get reviews(): SessionReview[] {
    return this.t.state.reviews ?? [];
  }

  /** A new review's card (the oldest go past MAX_REVIEWS). */
  putReview(r: SessionReview) {
    this.setState({ reviews: [...this.reviews.filter((x) => x.id !== r.id), r].slice(-MAX_REVIEWS) });
  }

  /** Review cards that came over in a handoff: shown at the end of this conversation. */
  adoptReviews(list: SessionReview[]) {
    const mine = new Set(this.reviews.map((r) => r.id));
    const add = list.filter((r) => !mine.has(r.id)).map(({ afterMsgId: _, ...r }) => r);
    if (add.length) this.setState({ reviews: [...this.reviews, ...add].slice(-MAX_REVIEWS) });
  }

  /** A review's card changes (its session reports, fails, or findings are sent). */
  updateReview(id: string, patch: Partial<SessionReview>) {
    const cur = this.reviews.find((r) => r.id === id);
    if (!cur) return;
    const next = mergeReview(cur, patch);
    this.setState({ reviews: this.reviews.map((r) => (r.id === id ? next : r)) });
    // One push, from the session the conversation goes on in.
    if (this.t.state.handoffTo) return;
    const by = HARNESSES.find((h) => h.id === next.harness)?.label ?? next.harness;
    if (next.status === "done" && cur.status !== "done") this.alert("finished", "Review finished", `${by}: ${describeFindings(next.findings)}${next.summary ? `. ${next.summary}` : ""}`);
    else if (next.status === "failed" && cur.status !== "failed") this.alert("blocked", "Review failed", next.error ?? `${by} didn't report.`);
  }

  /** `/review [harness[:model]] [focus]`: handled here on every harness, never sent as is. True when it was one. */
  async reviewCommand(text: string): Promise<boolean> {
    const req = parseReviewCommand(text);
    if (!req) return false;
    const st = this.t.state;
    if (st.reviewOf) this.notice("This is a review session. Run /review in the session it reviews.", "warning");
    else if (st.handoffTo) this.notice("This conversation continues in another session. Review it there.", "warning");
    else if (st.status !== "idle") this.notice("The agent is still working. Review its changes once it's done, or stop it first.", "warning");
    else if (!this.sink.review) this.notice("This runner can't run reviews.", "warning");
    else {
      try {
        await this.sink.review(this, req);
      } catch (e: any) {
        this.notice(e?.message ?? String(e), "warning");
      }
    }
    return true;
  }

  /** "Send to agent" / "Send all" on a review card: a queued message asking the agent to fix those findings. */
  async sendReviewFindings(reviewId: string, indexes?: number[]) {
    const r = this.reviews.find((x) => x.id === reviewId);
    if (!r) throw new Error("That review is no longer kept.");
    if (this.t.state.handoffTo) throw new Error("This conversation continues in another session.");
    const pick = indexes ? [...new Set(indexes)].filter((i) => Number.isInteger(i) && r.findings[i]) : r.findings.map((_, i) => i).filter((i) => !r.sent.includes(i));
    if (!pick.length) throw new Error(indexes ? "That finding is no longer there." : "Every finding was sent already.");
    this.updateReview(r.id, { sent: [...new Set([...r.sent, ...pick])].sort((a, b) => a - b) });
    await this.prompt(fixMessage(r, pick), "followUp");
  }

  /** Whether this is a review session, also before its prefs are loaded (a launch narrows its tools). */
  get isReviewSession(): boolean {
    return !!(this.t.state.reviewOf ?? config().sessions[this.id]?.reviewOf);
  }

  /** the review session's first result went out (a report, or its first turn ended without one) */
  private reviewSettled = false;
  /** where the review session's running turn starts in the transcript (its reply is read from there) */
  private reviewTurnFrom = 0;

  /** Why a review session holds this call back, if it does (checkTool). */
  private reviewHold(tool: string, input: unknown): string | undefined {
    // Every edit, plan files too (plan mode lets those through; a review has none to write).
    if (!this.t.state.reviewOf) return undefined;
    return (kindOf(tool) === "edit" && !isContextTool(tool, input)) || mutates(tool, input) ? REVIEW_READ_ONLY_REASON : undefined;
  }

  /** A review session handed off (a /compact without native compaction, a fallback): `from`'s review goes on here, read-only, and reports once. */
  inheritReview(from: LiveSession) {
    const of = from.t.state.reviewOf;
    if (!of) return;
    this.t.state.reviewOf = of;
    this.reviewSettled = from.reviewSettled;
  }

  private reportReview(patch: Partial<SessionReview>) {
    const of = this.t.state.reviewOf;
    if (!of) return;
    this.reviewSettled = true;
    this.sink.reviewResult?.(of.sessionId, of.reviewId, patch);
  }

  /** review_report: the findings go to the card in the session reviewed. */
  private reviewReport(args: Record<string, unknown>): { ok: boolean; text: string } {
    if (!this.t.state.reviewOf) return { ok: false, text: "review_report works only in a review session (/review in Tether)." };
    const r = parseReport(args);
    if (typeof r === "string") return { ok: false, text: r };
    this.reportReview({ status: "done", findings: r.findings, summary: r.summary, error: undefined });
    const n = r.findings.length;
    return { ok: true, text: `Reported ${n} ${n === 1 ? "finding" : "findings"}: the user sees them in the session you reviewed. You're done: end your turn with a short summary.` };
  }

  /** A review session's turn ended: its first one without review_report reports from the reply's JSON, or fails. */
  private reviewTurnOver() {
    const from = this.reviewTurnFrom;
    this.reviewTurnFrom = this.t.messages.length;
    if (!this.t.state.reviewOf || this.reviewSettled || this.t.state.handoffTo) return;
    if (this.userStopped) return this.reportReview({ status: "failed", error: "Stopped before it reported." });
    let reply = "";
    for (const m of this.t.messages.slice(from)) if (m.role === "assistant") for (const p of m.parts) if (p.type === "text") reply += `${p.text}\n`;
    const r = reportFromReply(reply);
    if (r) return this.reportReview({ status: "done", findings: r.findings, summary: r.summary, error: undefined });
    this.reportReview({
      status: "failed",
      error: this.turnTrouble ? "The reviewer ran into an error. Open the review session to see it." : "The reviewer finished without reporting findings. Open the review session to read what it said.",
    });
  }

  // ---- housekeeping ----

  // ---- fork and /compact (runner/src/fork.ts, handoffRun.ts runCompact) ----

  /**
   * Adapters whose harness forks at a message point (Adapter.fork) record, per transcript message,
   * where its own fork would cut to keep that message: Claude Code's last transcript entry for it,
   * Codex's turn.
   */
  protected forkMarks = new Map<string, string>();

  /** the running turn is the harness's own compaction (/compact) */
  private compactTurn = false;

  /** The harness's own fork point that keeps exactly the first `n` messages; undefined: it has none (Tether forks with a brief). */
  forkPoint(_n: number): string | undefined {
    return undefined;
  }

  /** The mark of the last of the first `n` messages the harness has (Tether's own notices and `!` runs don't count); undefined when that one has none. */
  protected lastMark(n: number): string | undefined {
    for (let i = Math.min(n, this.t.messages.length) - 1; i >= 0; i--) {
      const m = this.t.messages[i]!;
      const mark = this.forkMarks.get(m.id);
      if (mark) return mark;
      if (!tetherOnly(m)) return undefined;
    }
    return undefined;
  }

  /**
   * Adapters whose harness compacts its context on request: starts that (`focus`: what the summary
   * should keep) and returns true; false when it can't (or not with a focus), and Tether restarts the
   * conversation on a brief instead.
   */
  protected async nativeCompact(_focus?: string): Promise<boolean> {
    return false;
  }

  /** `/compact [focus]`: handled here on every harness, never sent as is. True when it was one. */
  async compactCommand(text: string): Promise<boolean> {
    const m = text.trim().match(/^\/compact(?:\s+([\s\S]*))?$/);
    if (!m) return false;
    const focus = m[1]?.trim() || undefined;
    const st = this.t.state;
    if (st.handoffTo) this.notice("This conversation continues in another session. Compact it there.", "warning");
    else if (this.restarting) this.notice("Already compacting: a new session is starting.", "warning");
    else if (st.status !== "idle" || st.pendingUi.length) this.notice("The agent is busy. Compact once it's done, or stop it first.", "warning");
    else {
      // Like a loop's run, compacting doesn't send "Finished" when it's done.
      this.loopTurn = this.compactTurn = true;
      try {
        if (await this.nativeCompact(focus)) return true;
        this.loopTurn = this.compactTurn = false;
        if (!this.sink.compact) this.notice("This runner can't compact this session.", "warning");
        // The restart ends this process, and with it whatever still runs in the background.
        // (Cross-harness subagents are sessions of their own: they go on, and report to the new session.)
        else if (this.busy) this.notice("Background tasks are still running here, and compacting would stop them. Compact once they're done, or stop them first.", "warning");
        else {
          // Until the new session takes over, messages wait (and move over with the conversation).
          this.restarting = true;
          this.notice("Compacting: starting a new session with a brief of this conversation.", "info");
          await this.sink.compact(this, focus);
        }
      } catch (e: any) {
        // Back to idle while the flags still say it was a compaction: no "Finished" for it.
        if (this.t.state.status !== "idle") this.setState({ status: "idle" });
        this.loopTurn = this.compactTurn = false;
        this.notice(`Compacting failed: ${e?.message ?? e}`, "error");
      } finally {
        if (this.restarting) {
          this.restarting = false;
          // It failed: what was sent meanwhile goes out here after all.
          const s = this.t.state;
          if (!this.closed && !s.handoffTo && s.status === "idle" && s.pending?.length && !s.pendingHeld) await this.drainPending();
        }
      }
    }
    return true;
  }

  /** Tether's /compact is starting the new session: this one takes no new turns meanwhile */
  protected restarting = false;

  private checkStall() {
    const s = this.t.state;
    if (s.status !== "running" || s.pendingUi.length || this.stallWarned) return;
    // A shell command, tool call or subagent that's still running isn't a stall: long builds and
    // test runs are quiet. Only a turn with nothing running and nothing streaming is.
    if (this.workingCount || this.toolRunning()) return;
    if (Date.now() - this.lastActivity > STALL_WARN_MS) {
      this.stallWarned = true;
      this.notice(`No activity for ${Math.round(STALL_WARN_MS / 60_000)} minutes. A tool may be stuck; Stop and send "continue" if it doesn't recover.`, "warning");
      this.alert("blocked", "No activity", `Nothing for ${Math.round(STALL_WARN_MS / 60_000)} minutes; a tool may be stuck.`);
    }
  }

  /** A tool call in the latest messages hasn't returned yet. */
  private toolRunning(): boolean {
    for (const m of this.t.messages.slice(-5)) for (const p of m.parts) if (p.type === "tool" && p.status === "running") return true;
    return false;
  }

  /** agent-bound work under way (a message on its way to a turn, a `!` command…): the idle close waits for it */
  private inFlight = 0;

  /**
   * Runs work that needs the agent process, keeping it open meanwhile: a message only reaches
   * "running" after several awaits (skills, the checkpoint, attachments), and a `!` command never does.
   */
  async hold<T>(work: () => Promise<T>): Promise<T> {
    this.inFlight++;
    clearTimeout(this.idleTimer);
    try {
      return await work();
    } finally {
      this.inFlight--;
      this.armIdle();
    }
  }

  private armIdle() {
    clearTimeout(this.idleTimer);
    if (this.closed) return;
    // Closing the process would also end its subagents, shells and armed wakeups; an active goal or
    // an armed Tether loop or schedule keeps it open too (it will work again). Messages held after
    // Stop stay with a live process, ready to send; agent-bound work under way (hold) keeps it open.
    const idle = () =>
      this.inFlight === 0 &&
      this.t.state.status === "idle" &&
      this.t.state.pendingUi.length === 0 &&
      this.activeCount === 0 &&
      !this.t.state.pending?.length &&
      this.goalState?.status !== "active" &&
      !this.schedules.length;
    if (!idle()) return;
    // A review still under way keeps it open, so its result lands on the card live and pushes (a
    // review whose session went away without reporting holds it at most REVIEW_KEEP_OPEN_MS).
    const reviewing = () => this.reviews.some((r) => (r.status === "starting" || r.status === "running") && Date.now() - r.updatedAt < REVIEW_KEEP_OPEN_MS);
    const fire = () => {
      if (!idle()) return;
      if (reviewing()) this.idleTimer = setTimeout(fire, IDLE_CLOSE.ms);
      else this.close();
    };
    this.idleTimer = setTimeout(fire, IDLE_CLOSE.ms);
  }

  close() {
    if (this.closed) return;
    // A subagent's process going away mid-turn (removed, crashed) ends that turn as stopped; an
    // idle one closing is just closed. A runner shutting down says nothing: it resumes after.
    const midTurn = this.t.state.status !== "idle";
    this.closed = true;
    if (this.t.state.startedBy && !this.t.state.handoffTo) {
      if (midTurn) this.sink.agents?.turnEnded(this, "stopped");
      else this.sink.agents?.changed(this);
    }
    clearTimeout(this.waitTimer);
    clearTimeout(this.steerTimer);
    clearTimeout(this.idleTimer);
    clearTimeout(this.goalTimer);
    clearInterval(this.watchdog);
    clearTimeout(this.settleTimer);
    clearTimeout(this.shellWaitTimer);
    clearTimeout(this.activityTimer);
    unregisterGuard(this.guardKey);
    this.clearJudging();
    this.cancelAllUi();
    this.shutdown();
    this.flushActivity();
    this.endActivity();
    this.sink.summary(this.summary());
    this.onClose?.();
  }

  // ---- adapter API ----
  abstract start(): Promise<void>;
  /**
   * Starts a turn with this message (the session is idle, or a turn just ended): fallback via
   * preferBest(), the user message in the transcript (unless the harness echoes it), the turn.
   */
  protected abstract send(text: string): Promise<void>;
  /** Folds a message into the running turn; false when the harness can't take it now. Absent: no steering. */
  protected steer?(text: string): Promise<boolean>;
  /** The harness puts user messages into the transcript itself (pi). */
  protected echoesUserMessages = false;
  abstract abort(): Promise<void>;
  /** Sets the model on the harness and records it in state. */
  abstract applyModel(model: string): Promise<void>;
  abstract setThinking(level: string): Promise<void>;
  abstract setPermissionMode(mode: string): Promise<void>;
  abstract rename(title: string): Promise<void>;
  abstract listCommands(): Promise<{ name: string; description?: string }[]>;
  /** Resumes after a fallback switch, a wait, or a runner restart. */
  abstract continueTurn(text?: string): Promise<void>;
  protected abstract shutdown(): void;
}

/** What a session's changes and file references are measured against; a session that isn't running has it from its saved settings. */
export interface FilesView {
  projectPath: string;
  /** first working-tree snapshot (SessionPrefs.diffBaseSha) */
  diffBase?: string;
  checkpoints?: Checkpoint[];
}

/** The Changes view and file references, for a running session or one that isn't (index.ts). */
export function sessionFiles(v: FilesView) {
  const list = v.checkpoints ?? [];
  const base = v.diffBase ?? list[0]?.sha;
  return {
    async diff(checkpointId?: string): Promise<SessionDiff> {
      if (!checkpointId) return computeDiff(v.projectPath, base);
      const i = list.findIndex((c) => c.id === checkpointId);
      if (i < 0) throw new Error("That turn's checkpoint is no longer kept.");
      return computeDiff(v.projectPath, list[i]!.sha, list[i + 1]?.sha);
    },
    checkPaths: (paths: string[]) => checkPaths(v.projectPath, paths, base),
    fileDiff: (path: string, checkpointId?: string, reveal?: boolean) => fileDiff(v.projectPath, path, base, list, checkpointId, reveal === true),
    readFile: (path: string, maxBytes?: number, reveal?: boolean) => readProjectFile(v.projectPath, path, maxBytes, reveal === true),
    readFileChunk: (path: string, offset?: number, length?: number, reveal?: boolean) => readProjectFileChunk(v.projectPath, path, offset, length, reveal === true),
  };
}

// ---- the `/` menu of a session that isn't running ----

type MenuSource = { commands: { name: string; description?: string }[]; native?: NativeSkill[] };
/** what each harness last reported (its commands, the skills it runs itself), by project and overall */
const lastMenus = new Map<string, MenuSource>();

function rememberMenu(harness: HarnessId, projectPath: string, src: MenuSource) {
  lastMenus.delete(`${harness}\0${projectPath}`);
  lastMenus.set(`${harness}\0${projectPath}`, src);
  lastMenus.set(harness, src);
  while (lastMenus.size > 200) lastMenus.delete(lastMenus.keys().next().value!);
}

function menuOf(harness: HarnessId, projectPath: string, src: MenuSource | undefined): SlashCommand[] {
  const native = src?.native;
  const menu = slashMenu(skillsFor(harness, projectPath, native), src?.commands ?? [], native && new Set(native.map((n) => n.name)), harness, projectPath, hiddenSkills(), libraryCommands());
  // Tether handles these before the harness sees the message, so its own of the same name never runs.
  const own = new Set(TETHER_COMMANDS.map((c) => c.name));
  return [...TETHER_COMMANDS, ...menu.filter((c) => !own.has(c.name))];
}

/**
 * The `/` menu without starting the agent: the skills as they are now, with the commands the
 * harness reported when it last ran here (else anywhere); none before it ever has.
 */
export function storedSlashMenu(harness: HarnessId, projectPath: string): SlashCommand[] {
  return menuOf(harness, projectPath, lastMenus.get(`${harness}\0${projectPath}`) ?? lastMenus.get(harness));
}

export type PendingChange = { text?: string; mode?: "steer" | "followUp"; index?: number; remove?: boolean; now?: boolean };

/**
 * The pending list after one edit (LiveSession.editPending; index.ts for a session that isn't
 * running). Removing, or emptying its text, drops it; "send now" puts it on top as a steer.
 */
export function editedPending(list: PendingMessage[], id: string, change: PendingChange, now = Date.now()): PendingMessage[] {
  const out = [...list];
  const i = out.findIndex((p) => p.id === id);
  if (i < 0) throw new Error("That message was already sent.");
  if (change.remove || change.text?.trim() === "") {
    out.splice(i, 1);
    return out;
  }
  const p: PendingMessage = { ...out[i]! };
  if (change.text !== undefined) p.text = change.text;
  if (change.mode) p.mode = change.mode;
  if (change.now) p.mode = "steer";
  // An edited steer gets a fresh grace period; "send now" skips it.
  if (p.mode === "steer") p.readyAt = change.now ? now : change.text !== undefined || change.mode ? now + LiveSession.STEER_GRACE_MS : (p.readyAt ?? now);
  else delete p.readyAt;
  out.splice(i, 1);
  const to = change.now ? 0 : Math.max(0, Math.min(out.length, change.index ?? i));
  out.splice(to, 0, p);
  return out;
}

/** How many messages from the top start the next turn: the steers at the top, else one queued message. */
export function nextTurnSize(list: PendingMessage[]): number {
  // Tether's notes and another agent's messages are never joined with yours (either way round):
  // a run of steers stops where who wrote them changes.
  let n = 0;
  while (n < list.length && list[n]!.mode === "steer" && joins(list, n)) n++;
  return n || (list.length ? 1 : 0);
}

/**
 * Whether the n-th waiting message may go out together with the ones above it: never when who
 * wrote them differs (yours, or Tether's / another agent's), and the user's words relayed by the
 * leader always go alone (joined after an agent's note they'd read as part of it).
 */
function joins(list: PendingMessage[], n: number): boolean {
  if (n === 0) return true;
  return !!list[n]!.alone === !!list[0]!.alone && !isRelay(list[n]!.text) && !isRelay(list[0]!.text);
}

/** Tool calls this event reports finished that weren't before (call it before applying the event). */
export function finishedTools(event: SessionEvent, messages: Msg[]): string[] {
  const done = (s?: string) => s === "done" || s === "error";
  const find = (msgId: string) => {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.id === msgId) return messages[i];
  };
  if (event.type === "tool") {
    if (!done(event.patch.status)) return [];
    const old = find(event.msgId)?.parts.find((p) => p.type === "tool" && p.id === event.toolId);
    return old?.type === "tool" && done(old.status) ? [] : [event.toolId];
  }
  if (event.type !== "msg") return [];
  const old = find(event.msg.id);
  return event.msg.parts
    .filter((p): p is Extract<Part, { type: "tool" }> => p.type === "tool" && done(p.status))
    .filter((p) => {
      const was = old?.parts.find((q) => q.type === "tool" && q.id === p.id);
      return !(was?.type === "tool" && done(was.status));
    })
    .map((p) => p.id);
}
/** A transcript message only Tether has (a notice, a `!` run): no harness keeps it, so no fork point is in it. */
export const tetherOnly = (m: Msg) => m.role === "notice" || (m.role === "user" && m.parts.every((p) => p.type === "tool"));
export const joinPending = (list: PendingMessage[]) => list.map((p) => p.text).join("\n\n");
const quote = (t: string) => t.trim().split("\n").map((l) => `> ${l}`).join("\n");

/** "Opus 5.5", or "GPT-6 Luna in Codex" when it runs in another harness than `harness`. */
export function entryLabel(e: ChainEntry, harness?: HarnessId): string {
  const name = modelDisplay(e.model, e.harness).name;
  return harness && e.harness !== harness ? `${name} in ${HARNESSES.find((h) => h.id === e.harness)?.label ?? e.harness}` : name;
}

export function fmtTime(ms: number) {
  const d = new Date(ms);
  const sameDay = new Date().toDateString() === d.toDateString();
  return sameDay ? d.toTimeString().slice(0, 5) : d.toISOString().slice(0, 16).replace("T", " ");
}
