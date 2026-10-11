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
import { userParts } from "../../web/src/shared/bash";
import { attachmentBlock, splitAttachments } from "../../web/src/shared/attachments";
import { referencedFolders, sessionKey } from "./attachments";
import { APPROVING_MODES } from "../../web/src/shared/protocol";
import { applyEvent, emptyState, type Transcript } from "../../web/src/shared/reducer";
import { guardEnv, registerGuard, unregisterGuard } from "./bridge";
import { computeDiff, diffStat, snapshot, workingTreeStats } from "./checkpoint";
import { config, prefs, saveConfigSoon } from "./config";
import { usageChanged } from "./usage";
import { mergeContext, switchModel } from "./contextWindow";
import { notify } from "./notify";
import { backoffMs, classify, markExhausted, pickEntry, profile, providerOf, type Classified } from "./fallback";
import { attachmentWrite, commandOf, judge, kindOf, rules, type GuardMode, type Verdict } from "./guard";
import { hiddenSkills, resolveMessage, skillsFor, slashMenu, type NativeSkill } from "./skillcmd";
import { isActive, type ActivityItem, type BackgroundTask, type Checkpoint, type ContextUsage, type GuardVerdict, type Part, type PendingMessage, type SessionDiff, type SlashCommand } from "../../web/src/shared/protocol";
import { displayText, invocationText, parseInvocation } from "../../web/src/shared/skill";

export type Emit = (sessionId: string, seq: number, event: SessionEvent) => void;
export type SummaryChanged = (s: SessionSummary) => void;
/** Moves the conversation to a new session in another harness (runner/src/index.ts). */
export type Handoff = (from: LiveSession, to: ChainEntry, reason: string, pendingPrompt?: string) => Promise<void>;

export interface SessionSink {
  emit: Emit;
  summary: SummaryChanged;
  handoff: Handoff;
}

let counter = 0;
export const newId = (prefix: string) => `${prefix}${Date.now().toString(36)}${(counter++).toString(36)}`;

const IDLE_CLOSE_MS = 30 * 60_000;
const STALL_WARN_MS = 15 * 60_000;

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
      const last = event.messages.reduce((t, m) => (conversational(m) ? Math.max(t, m.ts || 0) : t), 0);
      return last || updatedAt;
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
      // workingCount always rides along, so 0 tells "only armed wakeups / cron jobs" apart from an
      // older runner that never sent it.
      ...(this.activeCount ? { activeCount: this.activeCount, workingCount: this.workingCount } : {}),
    };
  }

  snapshot(): SessionSnapshot {
    return { session: this.summary(), messages: this.t.messages, state: this.t.state, seq: this.seq };
  }

  emit(event: SessionEvent): void {
    const before = this.t.state.status;
    const beforeModel = this.t.state.model;
    const moved = movedAt(event, this.updatedAt, this.t.messages);
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
        this.turnTrouble = this.userStopped = false;
        this.finishDeferred = false;
        clearTimeout(this.settleTimer);
        clearTimeout(this.shellWaitTimer);
      }
      if (s.status === "idle" && before !== "idle") this.endForeground();
      if (s.status === "idle" && before !== "idle" && !s.handoffTo) this.turnOver();
      if (s.status === "idle" && before !== "idle") void this.refreshDiffStats();
      if (s.status === "running" || s.pending) this.scheduleSteers();
      if (s.status !== undefined || s.pendingUi !== undefined) {
        this.sink.summary(this.summary());
        this.armIdle();
      }
      if (["status", "chain", "profile", "preferEarlier", "handoffFrom", "handoffTo", "guard", "checkpoints", "pending", "background", "context", "model", "thinking", "permissionMode"].some((k) => k in s))
        this.savePrefs();
      if (s.activity) this.activityChanged();
      if (s.model && beforeModel && s.model !== beforeModel && this.t.state.context) {
        const context = switchModel(this.t.state.context, s.model);
        if (context !== this.t.state.context) this.setState({ context });
      }
    }
    if (event.type === "activity") this.activityChanged();
    // A verdict can arrive before its tool card (Antigravity hooks run before the step event).
    if (event.type === "msg" && (this.pendingVerdicts.size || this.judging.size))
      for (const p of event.msg.parts)
        if (p.type === "tool" && this.pendingVerdicts.has(p.id)) {
          const guard = this.pendingVerdicts.get(p.id)!;
          this.pendingVerdicts.delete(p.id);
          this.emit({ type: "tool", msgId: event.msg.id, toolId: p.id, patch: { guard } });
        } else if (p.type === "tool" && this.judging.has(p.id) && !p.judging && !p.guard)
          this.emit({ type: "tool", msgId: event.msg.id, toolId: p.id, patch: { judging: true } });
  }

  setState(state: Partial<LiveState>) {
    this.emit({ type: "state", state });
  }

  /**
   * Updates how full the context window is. Fields left out keep their value, unless the report
   * is for another model (its window differs); a missing window is guessed from the model name.
   */
  setContext(c: ContextUsage | undefined) {
    if (c) this.setState({ context: mergeContext(this.t.state.context, c) });
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
    this.emit({ type: "msg", msg: { id: newId("n"), role: "notice", parts: [{ type: "text", text }], ts: Date.now(), level, ...extra } });
    if (level === "error") {
      this.turnTrouble = true;
      this.alert("blocked", "Failed", text);
    }
  }

  // ---- notifications (runner/src/notify.ts pushes them to your devices) ----

  /** the running turn failed (already notified), so its end isn't also "finished" */
  private turnTrouble = false;
  private userStopped = false;

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
    if (this.userStopped || this.turnTrouble || this.closed) return;
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

  private lastActiveCount = 0;
  private lastWorkingCount = 0;

  /** Items running or armed (waiting) right now. */
  get activeCount(): number {
    return (this.t.state.activity ?? []).filter(isActive).length;
  }

  /** Items doing work right now: not an armed wakeup or cron job waiting for its time. */
  get workingCount(): number {
    return (this.t.state.activity ?? []).filter((a) => a.status === "running").length;
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
    const stale = (this.t.state.activity ?? []).filter((a) => isActive(a) && a.background === false);
    for (const a of stale) this.endedWithTurn.add(a.id);
    if (stale.length) this.upsertActivity(...stale.map((a) => ({ ...a, status: "stopped" as const, endedAt: now })));
  }

  private activityChanged() {
    const n = this.activeCount;
    const working = this.workingCount;
    if (n !== this.lastActiveCount || working !== this.lastWorkingCount) {
      this.lastActiveCount = n;
      this.lastWorkingCount = working;
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

  /** Sends a message: starts a turn when idle, otherwise adds it to the pending list. */
  async prompt(text: string, mode: "steer" | "followUp" = "steer") {
    if (this.t.state.status === "waiting") this.cancelWait();
    if (this.t.state.status === "idle") {
      if (!this.t.state.pending?.length) return this.sendTyped(text);
      // Held after Stop: sending releases the hold; the new message joins the bottom of the list,
      // and the list goes out from the top as usual (one queued message per turn).
      this.pend(text, mode);
      this.setState({ pendingHeld: undefined });
      await this.drainPending();
      return;
    }
    this.pend(text, mode);
  }

  protected pend(text: string, mode: "steer" | "followUp", opts: { now?: boolean } = {}): PendingMessage {
    const now = Date.now();
    const p: PendingMessage = { id: crypto.randomUUID(), text, mode, ts: now, ...(mode === "steer" ? { readyAt: opts.now ? now : now + LiveSession.STEER_GRACE_MS } : {}) };
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
    while (n < list.length && list[n]!.mode === "steer" && (list[n]!.readyAt ?? 0) <= now) n++;
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
    clearTimeout(this.steerTimer);
    if (this.steered.size) {
      this.steered.clear();
      this.setState({ amendable: undefined });
    }
    if (this.closed || this.t.state.pendingHeld) return false;
    const list = this.t.state.pending ?? [];
    const n = nextTurnSize(list);
    if (!n) return false;
    // Steers left at the top may go into this new turn, but only once it has really been sent.
    this.draining = true;
    try {
      this.setPending(list.slice(n));
      await this.sendTyped(joinPending(list.slice(0, n)), list.slice(0, n));
    } finally {
      this.draining = false;
    }
    this.scheduleSteers();
    return true;
  }

  // ---- `/skill args` (runner/src/skillcmd.ts) ----
  // Resolved for this harness only as a message goes out, so waiting messages keep reading (and
  // editing) as typed, and a skill the harness can't run itself is sent along with the message.

  /** Skills this harness can run itself, as it reports them now; undefined when it can't say. */
  protected async nativeSkills(): Promise<NativeSkill[] | undefined> {
    return undefined;
  }

  /** How this harness is told to run one of its own skills; undefined: it can't now (expand). */
  protected nativeSkillText(name: string, args: string): string | undefined {
    return invocationText(name, args);
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
  private async sendTyped(typed: string, batch?: PendingMessage[]) {
    const sent = batch ? await this.joinResolved(batch) : await this.resolveSkills(typed);
    this.outgoing = { sent, typed };
    try {
      await this.send(sent);
    } finally {
      this.outgoing = undefined;
    }
  }

  /** One message as it goes out: `/skill args` becomes this harness's own invocation, or the expanded skill. */
  async resolveSkills(text: string, inner = false): Promise<string> {
    if (!parseInvocation(text)) return text;
    const native = await this.nativeNow();
    return resolveMessage(text, {
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

  /** The composer's `/` menu: the skills this session can run, then the harness's own commands. */
  async slashMenu(): Promise<SlashCommand[]> {
    const [commands, native] = await Promise.all([this.listCommands().catch(() => []), this.nativeNow(true)]);
    const skills = skillsFor(this.harness, this.projectPath, native);
    return slashMenu(skills, commands, native && new Set(native.map((n) => n.name)), this.harness, this.projectPath, hiddenSkills());
  }

  private takeAllPending(): string | undefined {
    const list = this.t.state.pending ?? [];
    if (!list.length) return undefined;
    this.setPending([]);
    return joinPending(list);
  }

  /** Edits, reorders, cancels or sends one pending message (from any device). */
  async editPending(id: string, change: { text?: string; mode?: "steer" | "followUp"; index?: number; remove?: boolean; now?: boolean }) {
    const list = [...(this.t.state.pending ?? [])];
    const i = list.findIndex((p) => p.id === id);
    if (i < 0) throw new Error("That message was already sent.");
    if (change.remove || change.text?.trim() === "") {
      list.splice(i, 1);
      return this.setPending(list);
    }
    const p: PendingMessage = { ...list[i]! };
    if (change.text !== undefined) p.text = change.text;
    if (change.mode) p.mode = change.mode;
    if (change.now) p.mode = "steer";
    // An edited steer gets a fresh grace period; "send now" skips it.
    if (p.mode === "steer") p.readyAt = change.now ? Date.now() : change.text !== undefined || change.mode ? Date.now() + LiveSession.STEER_GRACE_MS : (p.readyAt ?? Date.now());
    else delete p.readyAt;
    list.splice(i, 1);
    const to = change.now ? 0 : Math.max(0, Math.min(list.length, change.index ?? i));
    list.splice(to, 0, p);
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

  /** The Stop button: aborts the turn. Pending messages stay, held until you send them. */
  async stop() {
    this.userStopped = true;
    clearTimeout(this.steerTimer);
    if (this.t.state.pending?.length) this.setState({ pendingHeld: true });
    this.clearJudging();
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
    if (p.guard) restore.guard = p.guard;
    if (p.checkpoints) restore.checkpoints = p.checkpoints;
    if (p.context && !this.t.state.context) restore.context = p.context;
    this.diffBaseSha = p.diffBaseSha;
    if (Object.keys(restore).length) this.setState(restore);
    if (this.diffBaseSha || p.checkpoints?.length) void this.refreshDiffStats();
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
    if (saved.model && saved.model !== "default" && saved.model !== st.model) await this.applyModel(saved.model).catch(warn("model"));
    const levels = this.t.state.thinkingLevels;
    if (saved.thinking && saved.thinking !== this.t.state.thinking && (!levels || levels.includes(saved.thinking))) await this.setThinking(saved.thinking).catch(warn("effort"));
    const mode = saved.permissionMode;
    if (mode && mode !== this.t.state.permissionMode && this.t.state.modes?.includes(mode) && !APPROVING_MODES.has(mode))
      await this.setPermissionMode(mode).catch(warn("mode"));
  }

  /** Whether the agent is doing anything a restart would interrupt. */
  get busy(): boolean {
    return this.t.state.status !== "idle" || this.workingCount > 0 || (!this.t.state.activity && !!this.t.state.background?.length);
  }

  /** What a restart would stop, as the agent is told after one. */
  private backgroundWork(): BackgroundTask[] {
    if (!this.t.state.activity) return this.t.state.background ?? [];
    return this.t.state.activity.filter((a) => a.status === "running").map((a) => ({ id: a.id, description: a.title, type: a.agentType ? `${a.kind}: ${a.agentType}` : a.kind }));
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
      guard: s.guard,
      checkpoints: s.checkpoints,
      context: s.context,
      model: s.model,
      thinking: s.thinking,
      permissionMode: s.permissionMode,
      diffBaseSha: this.diffBaseSha,
      pending: s.pending?.length ? s.pending : undefined,
      background: bg.length ? bg : undefined,
      active: this.busy,
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
    done(r);
    return true;
  }

  cancelAllUi() {
    for (const [id, done] of this.uiWaiters) done({ id, cancelled: true });
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
    const pick = pickEntry(chain, this.harness);
    if (!("entry" in pick) || this.sameEntry(pick.entry, this.currentEntry)) return false;
    // Only move *up* the chain here; never sideways to an entry after the current one.
    const idx = (e: ChainEntry) => chain.findIndex((c) => this.sameEntry(parseEntry(c, this.harness), e));
    const cur = idx(this.currentEntry);
    if (cur >= 0 && idx(pick.entry) > cur) return false;
    if (pick.entry.harness === this.harness) {
      await this.applyModel(pick.entry.model);
      this.notice(`Back on ${pick.entry.model}: its usage limit has reset.`);
      return false;
    }
    // The new harness resolves `/skill` for itself: hand over the message as typed.
    const typed = this.outgoing?.sent === pendingPrompt ? this.outgoing.typed : pendingPrompt;
    await this.sink.handoff(this, pick.entry, `${formatEntry(pick.entry)} is available again`, typed);
    return true;
  }

  /**
   * Called by an adapter when a turn ended in an error. Returns true when fallback took over
   * (the adapter must not report the session idle-with-error then).
   */
  protected async handleTurnError(errorText: string | undefined, status?: number | null, hint?: Classified): Promise<boolean> {
    const chain = this.chain;
    if (!chain) return false;
    const c = hint ?? classify(errorText, status);
    if (c.kind === "other") return false;
    const current = this.currentEntry;

    if (c.kind === "quota") {
      const key = providerOf(current.model, current.harness);
      const until = markExhausted(key, c.resetAt);
      this.notice(`Usage limit reached on ${key} (resets ${fmtTime(until)}).`, "warning");
    }
    const pick = pickEntry(chain, this.harness);
    if ("waitUntil" in pick) {
      this.alert("blocked", "Waiting on usage limits", `Every model in the chain is at its limit; it continues at ${fmtTime(pick.waitUntil)}.`);
      this.waitThenContinue(pick.waitUntil, "Every model in this session's chain is at its usage limit");
      return true;
    }
    if (!this.sameEntry(pick.entry, current)) {
      this.fallbackAttempt = 0;
      if (pick.entry.harness !== this.harness) {
        await this.sink.handoff(this, pick.entry, c.kind === "quota" ? `${current.harness} (${current.model}) hit its usage limit` : `${current.harness} is rate limited`);
        return true;
      }
      await this.applyModel(pick.entry.model);
      this.notice(`Switched to ${pick.entry.model}.`);
      await this.continueTurn();
      return true;
    }
    // Same entry (rate limited, or nothing better available): back off and retry, indefinitely.
    const delay = c.resetAt ? Math.max(5_000, c.resetAt - Date.now()) : backoffMs(this.fallbackAttempt++);
    this.waitThenContinue(Date.now() + delay, c.kind === "rate_limit" ? `Rate limited on ${current.model}` : `Waiting on ${current.model}`);
    return true;
  }

  private waitThenContinue(until: number, reason: string) {
    clearTimeout(this.waitTimer);
    this.setState({ status: "waiting", waitingReason: reason, waitingUntil: until });
    this.waitTimer = setTimeout(async () => {
      this.waitTimer = undefined;
      if (this.closed || this.t.state.status !== "waiting") return;
      const chain = this.chain;
      if (chain) {
        const pick = pickEntry(chain, this.harness);
        if ("waitUntil" in pick) return this.waitThenContinue(pick.waitUntil, reason);
        if (pick.entry.harness !== this.harness) {
          this.setState({ waitingReason: undefined, waitingUntil: undefined });
          return this.sink.handoff(this, pick.entry, `${formatEntry(pick.entry)} has reset`);
        }
        if (pick.entry.model !== this.t.state.model) {
          await this.applyModel(pick.entry.model);
          this.notice(`Switched to ${pick.entry.model}.`);
        }
      }
      this.setState({ waitingReason: undefined, waitingUntil: undefined });
      await this.continueTurn();
    }, Math.max(1_000, until - Date.now()));
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

  /** What the user asked for, for the judge: the first request and the latest ones. */
  goal(): string {
    const asks = this.t.messages
      .filter((m) => m.role === "user")
      .map((m) => m.parts.map((p) => (p.type === "text" ? p.text : p.type === "skill" ? `/${p.name}` : "")).join(" ").trim())
      .filter((t) => t && !t.startsWith("You are taking over"));
    const pick = asks.length > 4 ? [asks[0]!, "…", ...asks.slice(-3)] : asks;
    return pick.map((t) => t.slice(0, 1500)).join("\n---\n");
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
    const call = { tool, input, cwd: this.projectPath, attachments: this.attachmentFolders() };
    const key = JSON.stringify([tool, input]);
    let v: Verdict;
    let always = false;
    if (this.approved.has(key)) v = { decision: "allow", by: "user", reason: "Approved after it was blocked." };
    else if (this.guardMode === "full") v = attachmentWrite(call) ?? { decision: "allow", by: "mode", reason: "Full access." };
    else {
      const r = rules(call);
      const askEdit = this.guardMode === "ask" && r?.decision === "allow" && kindOf(tool) === "edit";
      if (r?.decision === "allow" && !askEdit) v = r;
      else if (this.guardMode === "ask" || this.guardMode === "edits") {
        const res = await this.askUi({
          id: newId("perm"),
          kind: "permission",
          title: `Allow ${tool}?`,
          message: r?.decision === "deny" ? `⚠ ${r.reason}` : undefined,
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
  async approveBlocked(toolId: string) {
    for (const m of this.t.messages)
      for (const p of m.parts)
        if (p.type === "tool" && p.id === toolId) {
          this.approved.add(JSON.stringify([p.name, p.input]));
          this.emit({ type: "tool", msgId: m.id, toolId, patch: { guard: { decision: "allow", by: "user", reason: "Approved after it was blocked." } } });
          const what = commandOf(p.input) ?? JSON.stringify(p.input).slice(0, 300);
          const text = `The user approved your earlier blocked ${p.name} call (${what}). Run it now if it is still needed, then continue.`;
          if (this.t.state.status === "running" && this.steer) this.pend(text, "steer", { now: true });
          else if (this.t.state.status === "running") this.pend(text, "followUp");
          else await this.continueTurn(text);
          return;
        }
    throw new Error("Tool call not found");
  }

  setGuard(mode: GuardMode) {
    this.setState({ guard: mode });
    this.onGuardChanged?.();
  }
  /** Adapters whose harness needs restarting or reconfiguring on a guard change. */
  protected onGuardChanged?: () => void;

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

  /** The whole session's changes, or with a checkpoint id the changes of the turn that started there. */
  async diff(checkpointId?: string): Promise<SessionDiff> {
    const list = this.t.state.checkpoints ?? [];
    if (!checkpointId) return computeDiff(this.projectPath, this.diffBaseSha ?? list[0]?.sha);
    const i = list.findIndex((c) => c.id === checkpointId);
    if (i < 0) throw new Error("That turn's checkpoint is no longer kept.");
    return computeDiff(this.projectPath, list[i]!.sha, list[i + 1]?.sha);
  }

  get diffBase() {
    return this.diffBaseSha;
  }

  inheritDiffBase(sha?: string) {
    if (!sha || this.diffBaseSha) return;
    this.diffBaseSha = sha;
    this.savePrefs();
  }

  // ---- housekeeping ----

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

  private armIdle() {
    clearTimeout(this.idleTimer);
    // Closing the process would also end its subagents, shells and armed wakeups.
    const idle = () => this.t.state.status === "idle" && this.t.state.pendingUi.length === 0 && this.activeCount === 0;
    if (!idle()) return;
    this.idleTimer = setTimeout(() => idle() && this.close(), IDLE_CLOSE_MS);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.waitTimer);
    clearTimeout(this.steerTimer);
    clearTimeout(this.idleTimer);
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

/** How many messages from the top start the next turn: the steers at the top, else one queued message. */
export function nextTurnSize(list: PendingMessage[]): number {
  let n = 0;
  while (n < list.length && list[n]!.mode === "steer") n++;
  return n || (list.length ? 1 : 0);
}
const joinPending = (list: PendingMessage[]) => list.map((p) => p.text).join("\n\n");
const quote = (t: string) => t.trim().split("\n").map((l) => `> ${l}`).join("\n");

export function fmtTime(ms: number) {
  const d = new Date(ms);
  const sameDay = new Date().toDateString() === d.toDateString();
  return sameDay ? d.toTimeString().slice(0, 5) : d.toISOString().slice(0, 16).replace("T", " ");
}
