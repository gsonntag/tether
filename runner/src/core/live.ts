// Live mode (SPEC §4): driving a session through its harness's programmatic interface. A session
// goes live when you send it something (or create it), and back to stored after 5 idle minutes
// (never while its subagents or background tasks still run) or when its process ends.
//
// Each live session's driver reports through a Sink made here: transcript events go into the
// session's transcript and out with the next seq, status changes become turnStarted/turnEnded,
// permission requests go to the request desk (core/requests.ts), and subagents become child
// sessions (SPEC §6a).

import { FALLBACK_BACKOFF_MS, fallbackOrder, fallbackStepProblem, type FallbackProgress, type FallbackChain, type FallbackHarness, type FallbackPresetEdit, type FallbackSetup, type FallbackStep } from "../../../shared/fallbackChain";
import { LEVELS, mapMode } from "../../../shared/move";
import { levelOf } from "./permissionLevel";
import { Commands } from "./commands";
import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { CredentialStore, redact, redactValue, type CredentialSnapshot } from "../credentials";
import type { ClaudeAccounts } from "../adapters/claude/accounts";
import { hasSourceModels, isAccountSource, isCredentialSource, isSubscriptionSource, type AccountSource, isBillingSource, resolveSourceModel, type BillingSource, type CredentialSource, type SourceChoices, type SourceOption } from "../../../shared/credentials";
import { addSideCost, type CostLedger } from "../costs";
import type { SessionCost } from "../../../shared/costs";
import { withAttachments, type Attachment } from "../../../shared/attachments";
import { needsHarnessLogin, type HarnessLoginStatus } from "../../../shared/harnessLogin";
import { probeClaudeAccount } from "./harnessLogin";
import { samePlanIdentity } from "../adapters/claude/context";
import { FROM_TETHER } from "../../../shared/fromTether";
import { SIDE_KEEPS, SIDE_STAYS, sideCommandRefusal } from "../../../shared/sideChat";
import { modelIdProblem, reportedAt } from "../../../shared/labels";
import { sessionId as makeId, parseSessionId } from "../../../shared/ids";
import { MESSAGE_TEXT_MAX } from "../../../shared/limits";
import { PLAN_MODE } from "../../../shared/plan";
import { sourceSwitchBlockMessage, sourceSwitchBlocker } from "../../../shared/sourceSwitch";
import { AGENT_NAMES, HARNESS_LABELS, type Billing, type HarnessId, type LiveState, type ModelList, type PlanUsage, type Msg, type RequestAnswer } from "../../../shared/transcript";
import { SendCancelled, type Driver, type PlanIdentity, type SendHooks, type Sink, type StartOpts, type SubagentStart } from "./adapter";
import { BufferedSink } from "./bufferedSink";
import { AttachmentStore } from "./attachments";
import type { RequestBroker } from "./broker";
import { ReadState } from "./inbox";
import { MessageQueue } from "./queue";
import { RequestDesk } from "./requests";
import { Session } from "./session";
import { chosenOf, type SessionCore } from "./sessions";
import { Transcript } from "./transcript";
import { RetryControl } from "./retryControl";
import { lockWorktree } from "./worktreeLock";

/** How a message is sent (LiveControl.send). */
type SendOpts = {
  stop?: boolean;
  queued?: boolean;
  tether?: boolean;
  continued?: boolean;
  retryId?: string;
  fallback?: symbol;
  hopId?: symbol;
  continuedFallback?: boolean;
  clientId?: string;
  beforeEnqueue?: SendHooks["beforeEnqueue"];
  provisional?: boolean;
};

/** A step-specific problem (permission rejection, signed-out account, pre-turn start failure) that backs off the step instead of cancelling the chain (R2). */
class FallbackStepProblemError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FallbackStepProblemError";
  }
}

class FallbackHandoffTimeoutError extends Error {
  constructor() {
    super("Background work is still running. Stop it, or send a message to try again.");
    this.name = "FallbackHandoffTimeoutError";
  }
}

/** Idle this long, a live session's process closes. */
export const IDLE_CLOSE_MS = 5 * 60_000;

/** What the quiet wait after a restart shows (SPEC §4). */
export const waitingText = (harness: HarnessId): string => `Waiting for ${AGENT_NAMES[harness]} from before the restart to finish…`;
const SETUP_TEXT = "The worktree's setup is still running.";
const SETUP_FAILED_TEXT = "The worktree's setup failed.";
const notice = (text: string, level: Msg["level"] = "info"): Msg => ({ id: `n-${randomUUID()}`, role: "notice", level, ts: Date.now(), parts: [{ type: "text", text }] });

/**
 * What terminal mode lends live control (terminal/control.ts sets it): a new session can start in
 * the TUI, and a handoff (or Back to Tether) under way can be waited for. While a handoff TUI drives,
 * a message waits in Tether's queue for Back to Tether; Tether types nothing into the TUI (SPEC §8).
 */
export interface TerminalSeam {
  startIn(s: Session): Promise<void>;
  /** a handoff to the TUI, or Back to Tether, under way finishes (whichever way) */
  settled(s: Session): Promise<void> | undefined;
  /** why the SDK may not drive the session now (its TUI drives, or is taking over) */
  blocked(s: Session): string | undefined;
}

/**
 * Crash-loop guards for the continue after a restart: a restart this soon after the last automatic
 * continue doesn't continue again (a runner crashing on the continue restarts within seconds), and
 * one turn is continued at most this many times without ending.
 */
export const AUTO_CONTINUE_GUARD_MS = 30_000;
export const AUTO_CONTINUE_MAX = 5;
/** What Tether tells the agent after a restart cut its turn off (marked as Tether's own). */
export const AUTO_CONTINUE_TEXT = `${FROM_TETHER}Tether: continue after restart. The runner restarted mid-turn; carry on where you left off, and check whether any command you were running finished.`;

/**
 * What Tether tells the agent after a restart stopped its subagents (the runner's restart ends Claude
 * Code, and every subagent in it). `turnCut`: the main turn was cut off too.
 */
export function restartText(lost: readonly { title: string; agentType?: string }[], turnCut: boolean): string {
  if (!lost.length) return AUTO_CONTINUE_TEXT;
  const list = lost.map((a) => `- ${a.title}${a.agentType ? ` (${a.agentType})` : ""}`).join("\n");
  const head = turnCut ? AUTO_CONTINUE_TEXT : `${FROM_TETHER}Tether: continue after restart. The runner restarted while subagents were still working.`;
  return `${head}\nThe restart stopped these subagents before they finished; their results will not arrive:\n${list}\nStart again any whose work is still needed (in the background as before), then carry on.`;
}

/** A turn whose answer is in the store: its last message (past Tether's notices) is the agent's, ending in text. */
export function turnFinished(msgs: readonly Msg[]): boolean {
  const last = [...msgs].reverse().find((m) => !(m.role === "notice"));
  if (!last || last.role !== "assistant" || last.streaming || last.error) return false;
  const p = last.parts.at(-1);
  return p?.type === "text" && !!p.text.trim();
}

export { SendCancelled };

/** How long a source change waits for the harness to answer the first message on it. */
const CARRY_ANSWER_MS = 30_000;

export class LiveControl {
  readonly retries: RetryControl;
  private readonly idleMs: number;
  terminal?: TerminalSeam;
  readonly desk: RequestDesk;
  readonly queue: MessageQueue;
  readonly read: ReadState;
  readonly attachments: AttachmentStore;
  readonly commands: Commands;
  /** shutting down: drivers close, but their open requests stay saved for the next start */
  private stopping = false;
  private readonly subscriptionRevisions = new Map<string, string>();
  /** how long a cut-off session's store must be quiet before Tether continues it (tests shorten these) */
  quiet = { quietMs: 15_000, pollMs: 3_000, maxMs: 10 * 60_000 };
  /**
   * Sessions in the quiet wait after a restart: nothing may start Claude on them (send queues, the
   * queue stays held, Resume refuses) until `autoContinue` decides. Kept in runner.json as `running`
   * and `restartWait`, so a restart meanwhile comes back here.
   */
  private restartWaits = new Set<string>();
  /** sessions a module holds for a moment (a checkpoint restore), and why: sends queue meanwhile */
  private holds = new Map<string, string>();
  /** folders (real paths) a module holds, and why: every main session in one is held, stored or new */
  private heldFolders = new Map<string, string>();
  /** messages to subagents the main agent was asked to pass on (via-parent), by main session */
  private relays = new Map<string, { childId: string; nativeId: string; msgId: string; text: string }[]>();

  constructor(
    private core: SessionCore,
    broker: RequestBroker,
    private opts: {
      idleMs?: number;
      /** the most sessions live at once (TETHER_MAX_LIVE_SESSIONS); absent or 0: no limit */
      maxLive?: number;
      attachmentsDir?: string;
      credentials?: CredentialStore;
      claudeAccounts?: ClaudeAccounts;
      costs?: CostLedger;
      probeClaudeAccount?: (source: AccountSource) => Promise<HarnessLoginStatus>;
    } = {},
  ) {
    this.idleMs = opts.idleMs ?? IDLE_CLOSE_MS;
    this.retries = new RetryControl(core, {
      identity: (s) => this.retryIdentity(s),
      extended: (s) => s.state.retryThrottled === true && !isSubscriptionSource(this.sourceOf(s)),
      revision: (s) => core.adapter(s.summary.harness).storeRevision?.(s.summary.nativeId, s.summary.projectPath),
      blocked: (s) => s.state.mode === "terminal" || !!s.state.terminal || !!s.state.requests.length || !!this.terminal?.blocked(s) || !!core.o.prefs.get(s.id).nextSource || this.restartWaits.has(s.id),
      held: (s) => !!this.heldWhy(s.id),
      send: (s, r) => this.send(s.id, r.text, r.attachments, { tether: r.tether, retryId: r.id }),
      exhausted: (s, r, error) => {
        if (!this.canAdvanceFallback(s)) return false;
        void this.advanceFallback(s, undefined, r, false, false, false, error);
        return true;
      },
    });
    this.desk = new RequestDesk(core, broker, {
      send: (id, text) => this.send(id, text, [], { tether: true }),
      setPermissionMode: (id, mode) => this.setPermissionMode(id, mode),
      tell: (id, text) => this.tell(id, text),
      beforePlan: (id) => core.o.prefs.get(id).beforePlan,
    });
    this.queue = new MessageQueue(core, {
      send: (id, text, attachments) => this.send(id, text, attachments, { queued: true }),
      waiting: (id) => this.restartWaits.has(id),
      paused: (id) => !!this.heldWhy(id),
      settingUp: (id) => core.sessions.get(id)?.state.setup === "running",
    });
    this.read = new ReadState(core);
    this.commands = new Commands({ core, models: (s) => this.listModels(s.summary.harness, s.id), setModel: (id, m) => this.setModel(id, m), setEffort: (id, e) => this.setEffort(id, e), status: (s, st) => this.status(s, st) });
    this.attachments = new AttachmentStore(opts.attachmentsDir ?? "/nonexistent-tether-attachments");
    AttachmentStore.current = this.attachments;
    const bus = core.o.bus;
    bus.on("message", ({ sessionId, msg }) => this.relayCheck(sessionId, msg.parts));
    bus.on("toolCall", ({ sessionId, tool }) => this.relayCheck(sessionId, [tool]));
    bus.on("turnEnded", ({ sessionId }) => this.relayTurnEnded(sessionId));
    // The terminal opened during the wait: you took over, so nothing is continued, then or later.
    bus.on("modeChanged", ({ sessionId, to }) => {
      const s = core.sessions.get(sessionId);
      if (s && to === "terminal" && s.retry) this.cancelRetrySession(s);
      if (to !== "terminal" || !s || !this.restartWaits.has(sessionId)) return;
      this.endWait(s);
      if (s.state.queueHeldBy === "restart") this.queue.hold(s, "terminal", { over: true });
    });
  }

  // ---------------- ops ----------------

  private retryIdentity(s: Session) {
    const source = this.sourceOf(s);
    const deployment = this.deploymentOf(s);
    const credential = isAccountSource(source) ? undefined : this.opts.credentials?.snapshot(source, deployment);
    const scope = createHash("sha256").update(JSON.stringify([s.summary.harness, source, isAccountSource(source) ? this.revisionOf(s) : credential?.revision, credential?.endpoint, deployment ?? s.state.model])).digest("hex");
    const fingerprint = createHash("sha256").update(JSON.stringify([scope, s.state.model, s.state.effort, s.state.permissionMode])).digest("hex");
    return { scope, fingerprint };
  }

  /**
   * Ends a retry chain before it recovers. A waiting chain's turn already ended as "recovering",
   * which listeners (peers, texting) skipped: its real end is now, as a stop. A Tether
   * send that replaces the chain neither holds the queue nor ends the turn: its own turn's end does.
   */
  private cancelRetrySession(s: Session, o: { tether?: boolean; due?: "stopped" } = {}) {
    const waiting = (s.retry ?? this.core.o.prefs.get(s.id).retry)?.phase === "waiting";
    s.retrySuppressed = true;
    this.retries.clear(s);
    if (o.tether) return;
    // Scheduled messages due behind the retry wait for you: you stopped it, or it was cancelled.
    this.queue.hold(s, "stopped", { due: o.due ?? "retry" });
    if (waiting) this.core.o.bus.emit("turnEnded", { sessionId: s.id, stopped: true });
  }

  async cancelRetry(id: string) {
    const s = await this.core.open(id);
    if (s.retry?.phase === "sending") return this.interrupt(id);
    if (s.retry || this.core.o.prefs.get(id).retry) this.cancelRetrySession(s);
  }

  async retryNow(id: string) {
    await this.retries.now(await this.core.open(id));
  }

  credentialsChanged() {
    for (const s of this.core.sessions.values()) {
      if (s.retry && s.retry.fingerprint !== this.retryIdentity(s).fingerprint) this.cancelRetrySession(s);
    }
  }

  claudeAccountInUse(source: AccountSource) {
    return [...this.core.sessions.values()].some((s) => s.summary.harness === "claude" && (this.sourceOf(s) === source || s.state.billing?.source === source)
      && (s.sending || s.starting || s.driver?.busy() || sourceSwitchBlocker(s.state) === "background" ||
          s.state.mode === "terminal" || !!this.terminal?.blocked(s)));
  }

  async releaseClaudeAccount(source: AccountSource) {
    await Promise.all([...this.core.sessions.values()].filter((s) =>
      s.summary.harness === "claude" && s.driver && (this.sourceOf(s) === source || s.state.billing?.source === source)
    ).map((s) => this.release(s)));
  }

  harnessLoginChanged(harness: HarnessId, source: BillingSource = "subscription") {
    this.subscriptionRevisions.set(this.subscriptionScope(harness, source), randomUUID());
    this.core.clearPlan(harness, source);
    for (const s of this.core.sessions.values()) {
      if (s.summary.harness === harness && s.retry && this.sourceOf(s) === source) this.cancelRetrySession(s);
    }
  }

  /** Reconcile before timers and queues resume. Uncertain dispatches require a person to continue. */
  async restoreRetries() {
    for (const id of this.core.o.prefs.retrying()) {
      const saved = this.core.o.prefs.get(id).retry;
      let s: Session | undefined;
      try {
        s = await this.core.open(id);
        this.core.pin(s);
        await this.core.load(s);
        if (s.capabilities.persistent && !s.driver && s.state.mode !== "terminal") await this.ensureDriver(s, true);
        if (this.core.o.prefs.get(id).retry !== saved) continue;
        if (this.retries.restore(s, saved)) continue;
        this.retries.clear(s);
        const error = "Automatic retry stopped after the runner restarted. Check the conversation and send a message to continue.";
        s.apply({ type: "msg", msg: notice(error, "warning") });
        if (s.state.status === "idle") {
          this.queue.hold(s, "failed");
          this.read.set(id, { failure: error });
        }
      } catch {
        this.core.o.prefs.set(id, { retry: undefined, running: undefined, queueHeldBy: "failed" });
        this.core.o.prefs.flush();
        this.read.set(id, { failure: "The saved rate limit retry could not be restored. Send a message to continue." });
      } finally {
        if (s) this.core.unpin(s);
      }
    }
  }

  async newSession(args: { harness: HarnessId; projectPath: string; terminal?: boolean; createFolder?: boolean; source?: BillingSource } & StartOpts, background = false): Promise<{ sessionId: string }> {
    this.core.adapter(args.harness); // throws for a harness this runner can't drive, before anything is made
    if (args.terminal && !this.terminal) throw new Error("This runner has no terminal support (is tmux installed?).");
    const folder = this.core.folder(args.projectPath, args.createFolder === true);
    const opts: StartOpts = { model: args.model, effort: args.effort, permissionMode: args.permissionMode };
    const s = await this.createSession(args.harness, folder, opts, await this.sourceForNew(args.harness, args.source));
    this.core.touch(s);
    if (args.terminal) {
      // Its TUI creates it (SPEC §8): for a handoff harness, no SDK process at all; a shared TUI
      // joins Tether's own connection to the session, which starts first (terminal/control.ts).
      try {
        await this.terminal!.startIn(s);
      } catch (e) {
        await this.release(s).catch(() => {});
        this.core.book.remove([s.id]);
        this.core.sessions.delete(s.id);
        throw e;
      }
      return { sessionId: s.id };
    }
    // Started now, so a problem (not signed in, …) shows before anything is typed. A failure is
    // already in the session's state; the session still opens. `background` (a browser's
    // newSession): not waited for, so the session opens at once with its state saying it's starting
    // (a first message waits for the same start).
    const started = this.ensureDriver(s).catch(() => {});
    if (!background) await started;
    return { sessionId: s.id };
  }

  /**
   * Starts a turn. `stop`: Stop and send now (SPEC §9). A message you send releases a queue held
   * after Stop or a failed turn: it goes on after this turn (`queued`: the queue's own sends;
   * `tether`: sent on your behalf, which releases nothing; `continued`: the continue after a restart,
   * the one send that ends the quiet wait). During the wait everything else queues.
   */
  async send(id: string, text: string, attachments: Attachment[] = [], o: SendOpts = {}) {
    const prefs = this.core.o.prefs.get(id);
    // A message you send to an archived session brings it back into the lists once it's taken (SPEC
    // §10 Archiving): it's in use again. Not a closed side chat (it stays closed), nor the queue's own
    // sends. Under its worktree's lock (core/worktreeLock.ts): never while cleanup on archive removes
    // that worktree, and cleanup sees it unarchived after. A session that went on under another id
    // sends to that one, whose own send does this.
    if (o.queued || o.retryId || o.continued || !prefs.archived || prefs.sideOf) return this.sendNow(id, text, attachments, o);
    const s = await this.core.open(id);
    if (s.summary.parentSessionId || s.rebuilt || s.movedTo) return this.sendNow(id, text, attachments, o);
    const go = async () => {
      await this.sendNow(id, text, attachments, o);
      if (this.core.o.prefs.get(id).archived) await this.core.setArchived(s, false, undefined, "send: a message to it");
    };
    return prefs.worktree?.path ? lockWorktree(prefs.worktree.path, go) : go();
  }

  private async sendNow(id: string, text: string, attachments: Attachment[] = [], o: SendOpts = {}) {
    if (!text?.trim() && !attachments.length) throw new Error("Type a message first.");
    if (text.length > MESSAGE_TEXT_MAX) throw new Error("That message is too long.");
    this.sideCommand(id, text);
    const s = await this.core.open(id);
    if (!o.fallback && !o.continuedFallback && !o.retryId) this.cancelFallbackTimer(id);
    if (!o.fallback && this.hasHopLock(s, o.hopId)) await this.waitForHop(s, o.hopId);
    const fallback = this.fallingBack.get(s);
    if (fallback && fallback !== o.fallback) throw new Error("The fallback chain is switching this session. Try again shortly.");
    if (o.retryId && (s.retry?.id !== o.retryId || s.retry.phase !== "sending")) throw new SendCancelled();
    if (!o.retryId && (s.retry || this.core.o.prefs.get(id).retry)) {
      if (o.queued) throw new Error("A rate limit retry is waiting.");
      this.cancelRetrySession(s, { tether: o.tether });
    }
    // A subagent the harness lets you message: into its running turn (SPEC §6a).
    if (s.summary.parentSessionId) return this.steer(id, text, attachments);
    const to = s.rebuilt || s.movedTo ? await this.current(s) : s;
    if (to !== s) {
      await this.send(to.id, text, attachments, o);
      // After the send, so a message that didn't go stays in the box it was typed in.
      s.setState({ continuedIn: to.id });
      return;
    }
    // Moving to or from the terminal: the message goes wherever the session ends up, never to an
    // SDK process started beside a TUI, nor to a TUI that is quitting.
    const moving = this.terminal?.settled(s);
    if (moving) await moving;
    // The wait ended meanwhile (the terminal opened): there's nothing to continue any more.
    if (o.continued && !this.restartWaits.has(id)) return;
    // The TUI drives: the message waits in the queue, held until Back to Tether (SPEC §8, §9).
    // (A message of the queue going out as a handoff took over goes back to the front, as it was.)
    if (s.state.mode === "terminal") {
      if (o.queued) throw new Error("The terminal is driving.");
      return void (await this.queue.add(id, text, attachments));
    }
    // Claude Code from before the restart may be running: nothing starts beside it. Held, whatever
    // the queue held before; it goes on once the wait ends.
    if (!o.continued && this.restartWaits.has(id)) {
      if (o.queued) throw new Error(waitingText(s.summary.harness));
      return void (await this.queue.add(id, text, attachments));
    }
    // Held by a module (a checkpoint restore changing the files): it waits in the queue till the release.
    const held = this.heldWhy(id);
    if (held) {
      if (o.queued) throw new Error(held);
      return void (await this.queue.add(id, text, attachments));
    }
    // A new worktree's setup runs, or failed (SPEC §4): nothing goes before it's done, or you say
    // Send anyway (Resume); what you send waits, held.
    if (!o.continued && s.state.setup) {
      if (o.queued) throw new Error(s.state.setup === "running" ? SETUP_TEXT : SETUP_FAILED_TEXT);
      return void (await this.queue.add(id, text, attachments));
    }
    if (o.stop && (s.state.status !== "idle" || s.sending)) {
      // Background work isn't in the way: the message starts the main agent's next turn beside it.
      if (!s.driver?.onlyBackground?.()) await this.interrupt(id);
      const until = this.core.now() + 15_000;
      while ((s.state.status !== "idle" || s.sending) && !s.driver?.onlyBackground?.() && this.core.now() < until) await Bun.sleep(100);
    }
    // A command Tether answers itself (the model, the terminal's): no turn.
    if (s.state.status === "idle" && !s.sending && !o.tether && !o.continued && this.commands.routed(s, text)) {
      const me = {};
      s.sending = me;
      s.clientId = o.clientId;
      try {
        return await this.commands.run(s, text);
      } finally {
        s.sending = undefined;
      }
    }
    if (!o.fallback && !o.continuedFallback && !o.retryId && s.state.status === "idle" && !s.sending && !s.starting &&
      !s.retrySuppressed && s.state.fallbackChain?.active !== undefined && !this.core.o.prefs.get(id).nextSource) {
      const { active, steps } = s.state.fallbackChain;
      const progress = this.core.o.prefs.get(id).fallbackProgress;
      if (progress && fallbackOrder(steps.length, active, progress, this.core.now(), true).length &&
        await this.advanceFallback(s, undefined, { text, attachments, tether: o.tether }, false, true)) return;
    }
    if (o.fallback) {
      if (this.fallingBack.get(s) !== o.fallback || s.retrySuppressed) throw new SendCancelled();
      this.fallingBack.delete(s);
    }
    const next = this.core.o.prefs.get(id).nextSource;
    if (next && s.state.status === "idle" && !s.sending) return this.carry(s, next, text, attachments, o);
    // Only background work runs: the main agent is free, and a steer starts its next turn.
    // (Not with a deployment waiting: that goes with the next process start.)
    if (!s.sending && s.driver?.steer && s.driver.onlyBackground?.() && !this.core.o.prefs.get(id).nextDeployment) {
      if (!o.queued && !o.tether && s.state.queueHeldBy !== "terminal") this.queue.release(s);
      s.limitHit = s.lastSend = undefined;
      return s.driver.steer(withAttachments(text, attachments), attachments);
    }
    // Checked and claimed with no await in between, so two sends can't both start a turn.
    if (s.state.status !== "idle" || s.sending) throw new Error(`${AGENT_NAMES[s.summary.harness]} is still working. Stop it first, or wait for it to finish.`);
    if (!o.queued && !o.tether && s.state.queueHeldBy !== "terminal") this.queue.release(s);
    const me = {};
    s.sending = me;
    if (o.continued) {
      this.endWait(s, true);
      if (s.state.queueHeldBy === "restart") this.queue.release(s);
      s.apply({ type: "msg", msg: notice("The Tether runner restarted mid-turn; continuing.") });
    } else if (this.core.o.prefs.get(id).continues) this.core.o.prefs.set(id, { continues: undefined });
    // Running from now: starting Claude can take seconds, and Stop works meanwhile (cancelSend).
    s.setState({ error: undefined });
    this.status(s, "running");
    try {
      this.applyNextDeployment(s);
      await this.core.load(s);
      const d = await this.ensureDriver(s, false, true, o.hopId);
      if (o.retryId && (s.retry?.id !== o.retryId || s.retry.fingerprint !== this.retryIdentity(s).fingerprint)) throw new SendCancelled();
      // A credential change racing process startup is never allowed to send on the old source.
      this.checkCredential(s);
      // Stopped before the message went out (interrupt already set idle and freed the session):
      // the caller hears it wasn't sent (a queued message goes back, your text stays in the box).
      if (s.cancelSend === me) throw new SendCancelled();
      // Joined a turn another client (Codex's TUI) started: busy, as if it had been live all along.
      if (d.turnRunning?.()) {
        s.sending = undefined;
        throw new Error(`${AGENT_NAMES[s.summary.harness]} is still working on a turn started elsewhere. Stop it first, or wait for it to finish.`);
      }
      // A driver that pins the shown settings on the turn needs no confirmation first.
      if (!d.pinsSettings) await this.confirmSettings(s, d);
      if (s.cancelSend === me) throw new SendCancelled();
      // Again right before it goes: a turn may have started elsewhere meanwhile.
      if (d.turnRunning?.()) {
        s.sending = undefined;
        throw new Error(`${AGENT_NAMES[s.summary.harness]} is still working on a turn started elsewhere. Stop it first, or wait for it to finish.`);
      }
      this.core.touch(s, { updatedAt: this.core.now() });
      // Handed to the harness from here: its turn starts (a change now is against that turn).
      s.sentOut = me;
      if (o.continued) {
        this.core.o.prefs.set(id, { autoContinuedAt: this.core.now(), continues: (this.core.o.prefs.get(id).continues ?? 0) + 1 });
        this.core.o.prefs.flush();
      }
      const shown: StartOpts = { ...(s.state.model ? { model: s.state.model } : {}), ...(s.state.effort ? { effort: s.state.effort } : {}), ...(s.state.permissionMode ? { permissionMode: s.state.permissionMode } : {}) };
      this.checkCredential(s);
      if (o.retryId && (s.retry?.id !== o.retryId || s.retrySuppressed || s.retry.fingerprint !== this.retryIdentity(s).fingerprint)) throw new SendCancelled();
      s.lastSend = { text, attachments, ...(o.tether ? { tether: true } : {}) };
      s.retrySuppressed = false;
      s.turnActed = false;
      s.limitHit = undefined;
      s.rateHit = undefined;
      s.clientId = o.clientId;
      await d.send(withAttachments(text, attachments), attachments, shown, o.beforeEnqueue ? { beforeEnqueue: o.beforeEnqueue } : undefined);
      s.fresh = false;
      if (this.core.o.prefs.get(id).blank) this.core.o.prefs.set(id, { blank: undefined });
      if (o.continued) this.core.log(`${id}: continued the turn the restart cut off`);
    } catch (e) {
      if (s.sending === me) s.clientId = undefined;
      if (s.sending === me && e instanceof SendCancelled && s.state.status !== "idle") {
        s.stopped = true;
        this.status(s, "idle");
      }
      if (s.sending === me && !(e instanceof SendCancelled)) {
        if (o.provisional) {
          this.status(s, "idle");
          throw e;
        }
        this.markSourceSwitchFailed(s);
        s.turnError = redact((e as Error)?.message ?? String(e));
        const hit = (e as { rateLimit?: { retryAt?: number } })?.rateLimit;
        if (hit && typeof hit === "object") s.rateHit = hit;
        // Errors show in the chat. A failed start has said this already, and repeats don't add a row.
        s.apply({ type: "msg", msg: notice(s.turnError, "error") });
        s.setState({ error: s.turnError });
        this.status(s, "idle");
        if (s.retry?.phase === "waiting") return;
      }
      if (s.sending === me && !s.retry) s.lastSend = undefined;
      throw e;
    } finally {
      if (s.sending === me) s.sending = undefined;
      if (s.sentOut === me) s.sentOut = undefined;
      if (s.cancelSend === me) s.cancelSend = undefined;
      if (s.state.status === "idle" && !s.retry) s.lastSend = undefined;
      // A send keeps a session in memory: it may go now (a start that failed).
      this.core.scheduleEvict(s);
    }
  }

  /**
   * A source change reaching its next message (capabilities.sourceCarry): the message goes to a new
   * thread on that source with the history, and that thread takes the session's place once the
   * harness has answered it. Until then nothing has changed: anything that fails leaves this thread,
   * its source and the message where they were, with the change still waiting. Nothing falls back.
   */
  private async carry(s: Session, source: BillingSource, text: string, attachments: Attachment[], o: { queued?: boolean; tether?: boolean }) {
    if (s.carrying) throw new Error(`${AGENT_NAMES[s.summary.harness]} is still working. Stop it first, or wait for it to finish.`);
    if (!this.carrier) throw new Error("This runner can't change a session's source.");
    s.carrying = true;
    this.core.pin(s);
    try {
      if (!o.queued && !o.tether && s.state.queueHeldBy !== "terminal") this.queue.release(s);
      const { nextModel, nextFallbackSettings } = this.core.o.prefs.get(s.id);
      if (nextFallbackSettings?.permissionMode && !this.fallbackModeAllowed(s, nextFallbackSettings.permissionMode)) {
        throw new Error("The fallback step exceeds this session's current permissions.");
      }
      const id = await this.carrier(s.id, source, nextModel, nextFallbackSettings);
      const n = await this.core.open(id);
      this.core.pin(n);
      try {
        await this.core.load(n);
        const seen = new Set(n.transcript!.messages.map((m) => m.id));
        await this.send(id, text, attachments, { tether: true });
        await this.answered(n, seen);
      } catch (e) {
        await this.close(n);
        await this.core.adapter(n.summary.harness).move?.discard?.(n.summary.nativeId).catch(() => {});
        this.core.dropFresh(n);
        throw e;
      } finally {
        this.core.unpin(n);
      }
      await this.replaceWith(s, n);
    } catch (e) {
      this.markSourceSwitchFailed(s);
      s.apply({ type: "msg", msg: notice(redact((e as Error)?.message ?? String(e)), "error") });
      throw e;
    } finally {
      s.carrying = false;
      this.core.unpin(s);
    }
  }

  /** Back once the harness has answered, or says it won't. Slow isn't failed: its errors then show in the chat. */
  private async answered(n: Session, seen: Set<string>, cancelled?: () => boolean) {
    const until = this.core.now() + CARRY_ANSWER_MS;
    while (this.core.now() < until) {
      if (cancelled?.()) throw new SendCancelled();
      const fresh = (n.transcript?.messages ?? []).filter((m) => !seen.has(m.id));
      if (fresh.some((m) => m.role === "assistant" && !m.error && m.parts.length)) return;
      if (n.state.status === "idle" && !n.sending) {
        const said = fresh.find((m) => m.role === "notice" && m.level === "error");
        const failed = fresh.find((m) => typeof m.error === "string")?.error;
        if (said || failed || n.turnError) throw new Error(failed || said?.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join(" ") || n.turnError);
        return;
      }
      await Bun.sleep(50);
    }
  }

  private carryCost(s: Session, n: Session) {
    const paid = n.state.billing?.kind === "apiKey" || n.state.billing?.kind === "provider";
    const costs = this.opts.costs;
    if (!costs) return;
    try {
      // Nothing in the ledger to carry: nothing was spent, unless it was and Tether can't say what.
      let cost = costs.carry(s.id, n.id);
      if (!cost && !s.fresh && !this.spendKnown(s)) {
        cost = costs.markUnknown(n.id, "earlier-usage");
        this.core.o.prefs.set(n.id, { metered: true });
      }
      if (cost && paid) n.setState({ cost });
    } catch {
      if (paid) n.setState({ cost: { estimated: true, complete: false, reasons: ["unsaved"] } });
      this.core.log("Couldn't carry this session's API cost to its new thread. Its total is unknown.");
    }
  }

  private async replaceWith(s: Session, n: Session) {
    const prefs = this.core.o.prefs;
    const { title, pinned, pinnedRow } = prefs.get(s.id);
    const kept = this.keptPrefs(s);
    // The pin goes with the conversation: the new thread takes the old one's place in Pinned.
    prefs.set(n.id, { movedTo: undefined, carried: undefined, carrying: undefined, ...(title ? { title } : {}), ...(pinned ? { pinned, pinnedRow } : {}), ...kept });
    const { forkedFrom, worktree: _, fallbackProgress: __, ...state } = kept;
    n.setState({ ...state, continuedIn: undefined, carried: undefined, retryThrottled: isSubscriptionSource(this.sourceOf(n)) ? undefined : !!kept.retryThrottled });
    n.movedTo = undefined;
    prefs.set(s.id, { movedTo: n.id, carried: true, projectPath: s.summary.projectPath, pinned: undefined, pinnedRow: undefined, nextSource: undefined, nextFallbackSettings: undefined, nextModel: undefined, nextBilling: undefined, nextDeployment: undefined, sourceSwitchFailed: undefined });
    this.core.moveSides(s.id, n.id);
    prefs.flush();
    s.movedTo = n.id;
    this.core.book.remove([s.id]);
    this.core.touch(n, { title: title ?? s.summary.title, ...(forkedFrom ? { forkedFrom } : {}) });
    this.core.book.upsert([n.summary]);
    this.carryCost(s, n);
    // What waits (scheduled messages too) goes on in the new thread, where the views go.
    await this.queue.handOver(s.id, n.id).catch((e) => this.core.log(`${s.id}: its queue stayed: ${e?.message ?? e}`));
    await this.close(s, true);
    s.setState({ continuedIn: n.id, carried: true, nextBilling: undefined, sourceSwitchFailed: undefined });
  }

  /**
   * The session to go on with, for an id that was opened again after it left memory: itself, unless
   * its harness can't start that id a second time. Then a new session takes over, in the same folder
   * with the same settings; views follow `continuedIn`.
   */
  async current(s: Session): Promise<Session> {
    if (s.movedTo) return this.current(await this.core.open(s.movedTo));
    if (!s.rebuilt || !s.fresh || s.driver || s.starting) return s;
    // A store appeared meanwhile: the id is taken, so it resumes.
    if (await this.core.hasStore(s)) {
      s.fresh = false;
      this.core.o.prefs.set(s.id, { blank: undefined });
      return s;
    }
    if (!this.core.adapter(s.summary.harness).renew) return s;
    s.renewing ??= this.renew(s).finally(() => (s.renewing = undefined));
    return s.renewing;
  }

  private async renew(s: Session): Promise<Session> {
    const a = this.core.adapter(s.summary.harness);
    this.core.pin(s);
    try {
      const folder = this.core.folder(s.summary.projectPath);
      const { model, effort, permissionMode } = s.state;
      const source = this.sourceOf(s);
      const deployment = this.deploymentOf(s);
      const credential = this.credentialFor(s.summary.harness, source, deployment);
      const { nativeId, opts } = await a.renew!(folder, { ...(credential ? { credential } : {}), ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(permissionMode ? { permissionMode } : {}) });
      const n = this.core.create(s.summary.harness, nativeId, folder, opts);
      const kept = this.keptPrefs(s);
      const { pinned, pinnedRow } = this.core.o.prefs.get(s.id);
      this.core.o.prefs.set(n.id, { source, ...(deployment ? { deployment } : {}), ...(pinned ? { pinned, pinnedRow } : {}), ...kept });
      const { forkedFrom, worktree: _, fallbackProgress: __, ...state } = kept;
      n.setState({ ...state, retryThrottled: isSubscriptionSource(source) ? undefined : !!kept.retryThrottled });
      this.core.touch(n, forkedFrom ? { forkedFrom } : {});
      try {
        await this.ensureDriver(n);
      } catch (e) {
        this.core.dropFresh(n);
        this.core.o.prefs.set(n.id, { blank: undefined });
        throw e;
      }
      s.movedTo = n.id;
      this.core.o.prefs.set(s.id, { blank: undefined, movedTo: n.id, pinned: undefined, pinnedRow: undefined });
      this.core.moveSides(s.id, n.id);
      return n;
    } finally {
      this.core.unpin(s);
    }
  }

  /**
   * The person's words to the agent, sent for them (a plan's notes or feedback): into the running
   * turn when the harness takes that, else as a new message.
   */
  async tell(id: string, text: string, attachments: Attachment[] = []) {
    const s = await this.core.open(id);
    if (s.state.status !== "idle" && s.capabilities.canSteer && s.driver?.steer && s.state.mode !== "terminal") return this.steer(id, text, attachments);
    return this.send(id, text, attachments);
  }

  /** A side chat (SPEC §16a) refuses `/` commands, whoever sends them. */
  sideCommand(id: string, text: string) {
    const why = this.core.o.prefs.get(id).sideOf ? sideCommandRefusal(text) : undefined;
    if (why) throw new Error(why);
  }

  /** Going into plan mode: the mode it leaves is kept, so approving a plan goes back to it. */
  private notePlanEntry(s: Session, mode: string | undefined) {
    const was = s.state.permissionMode;
    if (mode === PLAN_MODE && was && was !== PLAN_MODE && !s.summary.parentSessionId) this.core.o.prefs.set(s.id, { beforePlan: was });
  }

  /**
   * A message into the running turn (capabilities.canSteer), or into a subagent's own turn
   * (capabilities.subagents.steer "direct"). It can't be taken back once the harness has it.
   */
  async steer(id: string, text: string, attachments: Attachment[] = []) {
    if (!text?.trim() && !attachments.length) throw new Error("Type a message first.");
    if (text.length > MESSAGE_TEXT_MAX) throw new Error("That message is too long.");
    this.sideCommand(id, text);
    const s = await this.core.open(id);
    const parentId = s.summary.parentSessionId;
    if (parentId) {
      const how = s.capabilities.subagents.steer;
      if (!how) throw new Error("Subagents can't take messages here. Message the main session instead.");
      // Its main session's driver, however deep it is nested.
      const parent = this.rootOf(s);
      if (!s.childRunning || !parent?.driver) throw new Error("This subagent has finished. Message the main session instead.");
      if (how === "via-parent") return this.relay(parent, s, withAttachments(text, attachments));
      if (!parent.driver.steerSubagent) throw new Error("Subagents can't take messages here. Message the main session instead.");
      return parent.driver.steerSubagent(s.summary.nativeId, withAttachments(text, attachments), attachments);
    }
    if (!s.capabilities.canSteer) throw new Error(`${AGENT_NAMES[s.summary.harness]} can't take a message while it works. Wait for it to finish.`);
    // A send still on its way (Claude Code starting): this follows that message, into its turn.
    while (s.sending && s.sentOut !== s.sending) await Bun.sleep(20);
    if (s.state.mode === "terminal") return void (await this.queue.add(id, text, attachments));
    if (s.state.status === "idle" || !s.driver?.steer) throw new Error("Nothing is running to steer. Send it as a new message instead.");
    // A command waits for the turn, as in the queue (SPEC §9 Commands).
    if (await this.commands.isCommand(s, text)) return void (await this.queue.add(id, text, attachments));
    s.turnActed = true;
    await s.driver.steer(withAttachments(text, attachments), attachments);
  }

  // ---------------- subagents steered through the main agent (SPEC §6a) ----------------

  /**
   * Asks the main agent to pass a message on to a running subagent (subagents.steer "via-parent").
   * The message shows in the subagent's view as yours, "sending" until the main agent's delivering
   * tool call is seen, or "failed" when its turn ends without one.
   */
  private async relay(parent: Session, child: Session, text: string) {
    const d = parent.driver!;
    if (!d.relayMessage) throw new Error("Subagents can't take messages here. Message the main session instead.");
    const ask = FROM_TETHER + d.relayMessage(child.summary.nativeId, text);
    const msgId = `n-relay-${randomUUID()}`;
    const entry = { childId: child.id, nativeId: child.summary.nativeId, msgId, text };
    const list = this.relays.get(parent.id) ?? [];
    list.push(entry);
    this.relays.set(parent.id, list);
    child.apply({ type: "msg", msg: { id: msgId, role: "user", ts: this.core.now(), relay: "sending", parts: [{ type: "text", text }] } });
    try {
      if (parent.state.status !== "idle" && d.steer) await d.steer(ask);
      else await this.send(parent.id, ask, [], { tether: true });
    } catch (e) {
      this.relayDone(parent.id, entry, "failed");
      throw e;
    }
  }

  /** A tool call of a main session's: one of its pending relays delivered? */
  private relayCheck(sessionId: string, parts: Msg["parts"]) {
    const list = this.relays.get(sessionId);
    const d = this.core.sessions.get(sessionId)?.driver;
    if (!list?.length || !d?.relayedBy) return;
    for (const p of parts) {
      if (p.type !== "tool") continue;
      const hit = list.find((r) => d.relayedBy!(r.nativeId, p, r.text));
      if (hit) this.relayDone(sessionId, hit, "delivered");
    }
  }

  /** The harness reports the main agent messaged a subagent: the oldest message pending for it went. */
  private relayed(sessionId: string, nativeId: string) {
    const hit = this.relays.get(sessionId)?.find((r) => r.nativeId === nativeId);
    if (hit) this.relayDone(sessionId, hit, "delivered");
  }

  /** The main agent's turn ended: what it didn't pass on (and isn't about to) wasn't delivered. */
  private relayTurnEnded(sessionId: string) {
    if (!this.relays.get(sessionId)?.length) return;
    // A relay that arrived as the turn ended starts a turn of its own: give it that turn.
    setTimeout(() => {
      const s = this.core.sessions.get(sessionId);
      if (s && s.state.status !== "idle") return;
      for (const r of [...(this.relays.get(sessionId) ?? [])]) this.relayDone(sessionId, r, "failed");
    }, 3000).unref?.();
  }

  private relayDone(parentId: string, r: { childId: string; msgId: string }, how: "delivered" | "failed") {
    const list = (this.relays.get(parentId) ?? []).filter((x) => x !== r);
    if (list.length) this.relays.set(parentId, list);
    else this.relays.delete(parentId);
    const c = this.core.sessions.get(r.childId);
    const m = c?.transcript?.get(r.msgId);
    if (c && m) c.apply({ type: "msg", msg: { ...m, relay: how } });
  }

  /** A status change made by the core itself (not the driver), with the same consequences. */
  private status(s: Session, status: LiveState["status"]) {
    const before = s.state.status;
    if (s.setState({ status })) this.statusChanged(s, before);
  }

  /** The commands left in background terminals with more access than what's shown (the header's note). */
  async stopBackground(id: string) {
    const s = await this.core.open(id);
    await s.driver?.stopBackground?.();
  }

  /** Ctrl+B for one subagent (SPEC §6a). `id`: the session whose transcript has the call. */
  async backgroundSubagent(id: string, toolId: string) {
    const s = await this.core.open(id);
    const root = s.summary.parentSessionId ? this.rootOf(s) : s;
    await root?.driver?.backgroundSubagent?.(toolId);
  }

  /** The main session a subagent runs under (nested ones too), which has the driver. */
  private rootOf(s: Session): Session | undefined {
    const known = s.rootId ? this.core.sessions.get(s.rootId) : undefined;
    if (known) return known;
    let at: Session | undefined = s;
    for (let i = 0; at?.summary.parentSessionId && i < 50; i++) at = this.core.sessions.get(at.summary.parentSessionId);
    return at;
  }

  /**
   * Holds an idle session (modules: a checkpoint restore): sends queue and the queue waits until the
   * release, which lets it go on. Refused unless it's idle with nothing being sent.
   */
  /** why the session is held, when it is (shell commands and the terminal refuse meanwhile) */
  heldWhy(id: string): string | undefined {
    const own = this.holds.get(id);
    if (own || !this.heldFolders.size) return own;
    const s = this.core.sessions.get(id);
    if (!s || s.summary.parentSessionId) return undefined;
    const p = realOf(s.summary.projectPath);
    for (const [root, why] of this.heldFolders) if (overlaps(p, root)) return why;
    return undefined;
  }

  /**
   * Holds every main session whose folder is in `folder` or holds it (its agent can edit it there),
   * loaded or not, and any made there meanwhile (a checkpoint restore changing a repo's files): as
   * `hold`. Refused while one of them is working.
   */
  holdFolder(folder: string, why: string): () => void {
    const root = realOf(folder);
    if (this.heldFolders.has(root)) throw new Error(this.heldFolders.get(root));
    const inside = (s: Session) => !s.summary.parentSessionId && overlaps(realOf(s.summary.projectPath), root);
    for (const s of this.core.sessions.values()) {
      if (inside(s) && (s.state.status !== "idle" || s.sending || s.starting)) throw new Error(`“${s.summary.title || AGENT_NAMES[s.summary.harness]}” is working.`);
    }
    this.heldFolders.set(root, why);
    return () => {
      if (this.heldFolders.get(root) !== why) return;
      this.heldFolders.delete(root);
      for (const s of this.core.sessions.values()) if (inside(s)) this.queue.later(s.id);
    };
  }

  hold(id: string, why: string): () => void {
    const s = this.core.sessions.get(id);
    if (s && (s.state.status !== "idle" || s.sending || s.starting)) throw new Error(`${AGENT_NAMES[s.summary.harness]} is working.`);
    if (this.holds.has(id)) throw new Error(this.holds.get(id));
    this.holds.set(id, why);
    return () => {
      if (this.holds.get(id) !== why) return;
      this.holds.delete(id);
      this.queue.later(id);
    };
  }

  async interrupt(id: string) {
    const s = await this.core.open(id);
    if (s.retry) this.cancelRetrySession(s, { due: "stopped" });
    this.cancelFallbackTimer(id);
    const hop = s.provisionalHop;
    if (this.fallingBack.has(s) || hop) s.retrySuppressed = true;
    if (hop) {
      hop.abort("cancelled");
      if (hop.successor) await this.interrupt(hop.successor.id).catch(() => {});
      // Stopped during provisional startup while idle: leave original session state untouched (R1''').
      if (s.state.status === "idle" && !s.sending && !s.summary.parentSessionId) return;
    }
    const parentId = s.summary.parentSessionId;
    if (parentId) {
      // A subagent: stop just it (SPEC §6a). Its main session's process runs it, however deep it is nested.
      this.desk.cancel((r) => r.sessionId === id);
      const parent = this.rootOf(s);
      if (!s.childRunning || !parent?.driver?.stopSubagent) return;
      await parent.driver.stopSubagent(s.summary.nativeId);
      return;
    }
    // The TUI drives: Tether runs nothing to stop there (Esc in the terminal does).
    if (s.state.mode === "terminal") return;
    // Whatever it asked is moot now (the harness stops waiting too).
    this.desk.stop(id);
    // Stop keeps the queue, held, until you send (SPEC §9).
    this.queue.hold(s, "stopped");
    if (s.state.status !== "idle" || s.sending) s.stopped = true;
    // Saved now: a restart before the stop takes effect must not continue a turn you stopped.
    if (this.core.o.prefs.get(id).running || this.core.o.prefs.get(id).continues) {
      this.core.o.prefs.set(id, { running: undefined, continues: undefined, restartWait: undefined });
      this.core.o.prefs.flush();
    }
    // Stopped before the harness has the message (it may still be starting): it never goes out.
    if (s.sending && (!s.driver || s.sentOut !== s.sending)) {
      // Free at once: a send right after this goes ahead (on the same start).
      s.cancelSend = s.sending;
      s.sending = undefined;
      return this.status(s, "idle");
    }
    await s.driver?.interrupt();
  }

  /**
   * A model from the menu or typed (SPEC §10 "Other model or deployment…"). Refused: the chat says
   * why and the model stays as it was. While a source change waits for the next message, the pick is
   * for the new source: held (`nextModel`) for the thread the change starts, never sent to the source
   * being left (a deployment name to the ChatGPT daemon, or a model id to an Azure process).
   */
  async setModel(id: string, model: string) {
    const parsed = parseSessionId(id);
    // From a page that still lists it.
    if (model === "default" && parsed) model = this.core.adapter(parsed.harness).unset?.model ?? model;
    try {
      const problem = modelIdProblem(model);
      if (problem) throw new Error(`That model name won't do. ${problem}`);
      const next = this.core.o.prefs.get(id).nextSource;
      if (next) return await this.holdNextModel(id, next, model);
      await this.setting(id, { model }, (d) => d.setModel(model));
    } catch (e) {
      const s = await this.core.open(id).catch(() => undefined);
      if (s && !s.summary.parentSessionId) {
        await this.core.load(s).catch(() => {});
        s.apply({ type: "msg", msg: notice(redact((e as Error)?.message ?? String(e)), "error") });
      }
      throw e;
    }
  }

  /** A model for the source a pending change goes to: its new thread starts on it. */
  private async holdNextModel(id: string, source: BillingSource, model: string) {
    const s = await this.core.open(id);
    if (s.summary.parentSessionId) throw new Error("Change settings on the main session. A subagent keeps the settings it started with.");
    if (hasSourceModels(source) && model !== "default" && !this.sourceModels(s.summary.harness, source).some((d) => d.name === model)) throw new Error(source === "azure" ? `${model} isn't a deployment in Settings, Azure. The model is unchanged.` : "Choose a configured model in Settings, Bedrock.");
    // A source with configured models keeps the pick in nextDeployment.
    const picked = model === "default" ? undefined : model;
    const patch = hasSourceModels(source) ? { nextDeployment: picked } : { nextModel: picked };
    this.core.o.prefs.set(id, patch);
    this.core.o.prefs.flush();
    s.setState(patch);
  }

  async setEffort(id: string, effort: string) {
    await this.setting(id, { effort }, (d) => d.setEffort?.(effort) ?? Promise.resolve());
  }

  async setPermissionMode(id: string, mode: string) {
    // A side chat (SPEC §16a) stays in its harness's read-only mode.
    if (this.core.o.prefs.get(id).sideOf) {
      const s = await this.core.open(id);
      if (mode !== s.capabilities.readOnlyMode) throw new Error(SIDE_STAYS);
    }
    await this.setting(id, { permissionMode: mode }, (d) => d.setPermissionMode(mode));
  }

  /** A person answers a request (SPEC §7); the first answer wins. */
  async answerRequest(_sessionId: string, requestId: string, a: RequestAnswer) {
    this.desk.answer(requestId, a);
  }

  async listModels(harness: HarnessId, sessionId?: string): Promise<ModelList> {
    const s = sessionId ? this.core.sessions.get(sessionId) : undefined;
    return this.core.adapter(s?.summary.harness ?? harness).listModels(s?.driver);
  }

  /**
   * At start: sessions whose harness kept their turn going while the runner was away
   * (capabilities.persistent) are joined again, so their requests and status reach Tether.
   */
  async rejoin() {
    // Cut off before its first message reached a store: there's no turn to go on with.
    for (const id of this.core.o.prefs.running()) if (this.core.o.prefs.get(id).blank) this.core.o.prefs.set(id, { running: undefined });
    const persistent = (id: string) => {
      const harness = parseSessionId(id)?.harness;
      return !!harness && !!this.core.o.adapters.find((a) => a.id === harness)?.capabilities.persistent;
    };
    // Turns that were running, and sessions with requests saved from before the restart.
    // A turn a restart cut off (its harness didn't keep it going): on Home, for you to pick up.
    // Recorded once: `running` becomes `cutOff` (the session's notice still goes in when it's read),
    // so a later restart doesn't bring it back after you marked it read.
    // A turn a restart cut off goes on by itself (SPEC §4): Tether resumes the session with a short
    // message of its own, again after each restart that cuts the continued turn off too. Not for a
    // session waiting on you (its saved request is asked again), nor when it looks like a crash loop:
    // a restart within AUTO_CONTINUE_GUARD_MS of the last automatic continue, or a turn continued
    // AUTO_CONTINUE_MAX times without ending. Those fall back to Failed on Home and a held queue.
    const waiting = new Set(this.desk.broker.sessions(true));
    const continuing: string[] = [];
    for (const id of this.core.o.prefs.running())
      if (!persistent(id) && parseSessionId(id) && !this.core.o.prefs.get(id).retry) {
        const p = this.core.o.prefs.get(id);
        const why = waiting.has(id)
          ? "it's waiting for you"
          : p.autoContinuedAt && this.core.now() - p.autoContinuedAt < AUTO_CONTINUE_GUARD_MS
            ? `it was continued ${Math.round((this.core.now() - p.autoContinuedAt) / 1000)}s ago`
            : (p.continues ?? 0) >= AUTO_CONTINUE_MAX
              ? `its turn was already continued ${p.continues} times`
              : undefined;
        if (!why) {
          // `running` stays until the wait resolves: a restart meanwhile comes back here.
          this.core.o.prefs.set(id, { cutOff: undefined, restartWait: p.restartWait ?? this.core.now() });
          this.restartWaits.add(id);
          this.queue.notCutOff(id);
          continuing.push(id);
          continue;
        }
        this.core.log(`${id}: not continuing the turn the restart cut off: ${why}`);
        this.read.set(id, { failure: "The runner restarted mid-turn." });
        this.core.o.prefs.set(id, { running: undefined, cutOff: true, restartWait: undefined, liveSubagents: undefined });
      }
    this.core.o.prefs.flush();

    const ids = [...new Set([...this.core.o.prefs.running(), ...this.desk.broker.sessions(true)])].filter(persistent);
    // Awaited (the queue is restored after this): a queued message never jumps ahead of the continue.
    await Promise.all([...ids.map((id) => this.rejoinOne(id)), ...continuing.map((id) => this.autoContinue(id))]);
  }

  /**
   * Continues a turn a runner restart cut off: Tether's notice in the transcript, then Tether's own
   * message (marked, so it reads as Tether's) asking the agent to carry on. The session's settings go
   * with it as with any send. If it can't, the session falls back to Failed and a held queue.
   */
  private async autoContinue(id: string) {
    let s: Session | undefined;
    try {
      s = await this.core.open(id);
      this.core.pin(s);
      if (this.storeQuiet(s)) return await this.continueOnceQuiet(s);
      await this.core.load(s);
      // Still being written: the rest happens in the background once it's quiet (rejoin, and the
      // queues it restores, don't wait for this session). The same notice after another restart.
      if (this.restartWaits.has(id)) {
        s.apply({ type: "msg", msg: { ...notice(waitingText(s.summary.harness)), id: `n-wait-${id}-${this.core.o.prefs.get(id).restartWait}` } });
        s.setState({ restartWait: true });
        this.queue.hold(s, "restart");
      }
      void this.continueOnceQuiet(s);
    } catch (e) {
      this.continueFailed(id, s, e);
      if (s) this.core.unpin(s);
    }
  }

  /**
   * Waits for the session's store, then ends the wait one way or another: Claude Code from before
   * the restart may still be running the turn (the runner crashed and left it behind), so it waits
   * until the store has been quiet a while, so two processes never drive one session. A process
   * silent longer than that (a long tool call) can still overlap: production's systemd unit ends
   * leftover children on a restart anyway.
   */
  private async continueOnceQuiet(s: Session) {
    const id = s.id;
    const on = () => this.restartWaits.has(id);
    try {
      const quiet = await this.waitQuiet(s);
      // Stopping: `running` stays saved, and the next start waits on.
      if (this.stopping || !on()) return;
      if (!quiet) {
        this.read.set(id, { failure: `Couldn't tell whether ${AGENT_NAMES[s.summary.harness]} from before the restart was still working.` });
        s.apply({ type: "msg", msg: notice(`Couldn't tell whether ${AGENT_NAMES[s.summary.harness]} from before the restart was still working. Send a message to carry on.`, "warning") });
        this.queue.hold(s, "restart", { due: "restart" });
        return this.endWait(s);
      }
      await this.terminal?.settled(s);
      await this.core.syncFromStore(s);
      await this.core.load(s);
      if (!on()) return;
      // The turn finished after all (the store has its answer after the last prompt), or you pressed
      // Stop meanwhile: nothing to continue, and what waited for the store goes on.
      const lost = this.core.o.prefs.get(id).liveSubagents ?? [];
      const finished = turnFinished(s.transcript?.messages ?? []);
      if (!this.core.o.prefs.get(id).running || (finished && !lost.length)) {
        this.endWait(s);
        if (s.state.queueHeldBy === "restart") this.queue.release(s);
        this.core.log(`${id}: the cut-off turn had finished or was stopped; not continued`);
        return this.queue.later(id);
      }
      this.core.o.prefs.set(id, { liveSubagents: undefined });
      if (lost.length) this.core.log(`${id}: the restart stopped ${lost.length} subagent(s); asking for them again`);
      await this.send(id, restartText(lost, !finished), [], { tether: true, continued: true });
    } catch (e) {
      this.continueFailed(id, s, e);
    } finally {
      this.core.unpin(s);
    }
  }

  /** The wait is over. `running` stays saved only for a turn that goes on from here. */
  private endWait(s: Session, turnGoesOn = false) {
    this.restartWaits.delete(s.id);
    s.setState({ restartWait: undefined });
    this.core.o.prefs.set(s.id, { restartWait: undefined, liveSubagents: undefined, ...(turnGoesOn ? {} : { running: undefined }) });
    this.core.o.prefs.flush();
    this.core.touch(s);
  }

  private continueFailed(id: string, s: Session | undefined, e: any) {
    const why = String(e?.message ?? e).replace(/[.\s]+$/, "");
    this.core.log(`${id}: couldn't continue after the restart: ${why}`);
    // You pressed Stop as it went out, or a turn got there first: nothing went wrong.
    if (e instanceof SendCancelled || /still working/i.test(why)) {
      if (s && this.restartWaits.has(id)) {
        this.endWait(s, true);
        if (s.state.queueHeldBy === "restart") this.queue.release(s);
      }
      return;
    }
    this.restartWaits.delete(id);
    this.core.o.prefs.set(id, { running: undefined, restartWait: undefined, liveSubagents: undefined });
    this.core.o.prefs.flush();
    s?.setState({ restartWait: undefined });
    this.read.set(id, { failure: `Couldn't continue after the restart: ${why}.` });
    if (s) {
      // One notice: a failed start already said why in the transcript.
      if (!s.state.error) s.apply({ type: "msg", msg: notice(`Couldn't continue after the restart: ${why}. Send a message to continue.`, "warning") });
      this.queue.hold(s, "restart", { due: "restart" });
      this.core.touch(s);
    }
  }

  /** The session's store hasn't changed for `quiet.quietMs` (or the harness can't say). */
  private storeQuiet(s: Session): boolean {
    const at = this.core.adapter(s.summary.harness).storeChangedAt?.(s.summary.nativeId, s.summary.projectPath);
    return at === undefined || this.core.now() - at >= this.quiet.quietMs;
  }

  /**
   * Waits, checking every `quiet.pollMs`, until the store is quiet: false `quiet.maxMs` after the wait
   * began (across restarts). Gives up looking if the wait ends or the runner stops.
   */
  private async waitQuiet(s: Session): Promise<boolean> {
    const until = (this.core.o.prefs.get(s.id).restartWait ?? this.core.now()) + this.quiet.maxMs;
    while (!this.storeQuiet(s)) {
      if (this.core.now() >= until) return false;
      if (this.stopping || !this.restartWaits.has(s.id)) return true;
      await Bun.sleep(this.quiet.pollMs);
    }
    return true;
  }

  /** Rejoins one session, trying again a few times (the harness's daemon may be slow or restarting). */
  private async rejoinOne(id: string) {
    for (let attempt = 0; ; attempt++) {
      try {
        const s = await this.core.open(id);
        await this.core.load(s);
        // A session that was live before the restart is never refused by the live-session limit.
        await this.ensureDriver(s, !!this.opts.credentials, false);
        this.core.log(`rejoined ${id}`);
        // It finished while the runner was away.
        if (s.state.status === "idle" && !s.driver?.busy()) this.core.o.prefs.set(id, { running: undefined });
        break;
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        if (attempt >= this.rejoinRetries.length || /isn't on this runner|isn't a session id/.test(msg)) {
          // Not rejoined: its saved requests stay as they are (nothing says they were answered).
          this.core.log(`couldn't rejoin ${id}: ${msg}`);
          this.core.o.prefs.set(id, { running: undefined });
          return;
        }
        this.core.log(`couldn't rejoin ${id} yet (${msg}); trying again`);
        await Bun.sleep(this.rejoinRetries[attempt]!);
      }
    }
    // The harness asks again what it still waits on, right after the rejoin. A saved request it
    // doesn't ask again was answered elsewhere (its own TUI) while Tether was away; an answer given
    // here for one it never asks again is dropped too.
    await Bun.sleep(this.reaskMs);
    let n = 0;
    this.desk.cancel((_r, chain, restored) => restored && chain.at(-1) === id && ++n > 0, "elsewhere");
    this.desk.broker.forgetPredecided(id);
    if (n) {
      const s = this.core.sessions.get(id);
      if (s) {
        await this.core.load(s).catch(() => {});
        s.apply({ type: "msg", msg: notice(n === 1 ? "A request was answered elsewhere while Tether was away." : `${n} requests were answered elsewhere while Tether was away.`) });
      }
    }
  }

  /** Pauses between rejoin attempts. */
  rejoinRetries = [5_000, 20_000, 60_000, 180_000];

  /** How long a rejoined harness has to ask again what it still waits on. */
  reaskMs = 5000;

  /** Closes every live session (runner shutdown): their harnesses flush their stores. */
  async closeAll() {
    // What's open now is asked again after the restart: it stays saved.
    this.stopping = true;
    this.retries.stop();
    for (const timer of this.fallbackTimers.values()) clearTimeout(timer);
    this.fallbackTimers.clear();
    this.queue.stop();
    this.desk.broker.freeze();
    await Promise.all([...this.core.sessions.values()].filter((s) => s.driver).map((s) => this.close(s)));
  }

  // ---------------- lifecycle ----------------

  private async setting(id: string, patch: StartOpts, apply: (d: Driver) => Promise<void>) {
    const s = await this.core.open(id);
    if (s.retry) this.cancelRetrySession(s);
    if (s.summary.parentSessionId) throw new Error("Change settings on the main session. A subagent keeps the settings it started with.");
    // A handoff TUI drives (SPEC §8), or is being started: it takes no settings from Tether, so a
    // change here would only pretend.
    if ((s.state.mode === "terminal" || this.terminal?.blocked(s)) && s.capabilities.terminal === "handoff") {
      const hint = this.core.adapter(s.summary.harness).terminalSettingsHint;
      throw new Error(`${HARNESS_LABELS[s.summary.harness]}'s terminal is driving. Change it there${hint ? ` (${hint})` : ""}.`);
    }
    // One change at a time per session: each waits for the harness to take it (or not) before the next.
    const run = (s.settingChain ?? Promise.resolve()).catch(() => {}).then(() => this.applySetting(s, patch, apply));
    s.settingChain = run;
    return run;
  }

  private async applySetting(s: Session, patch: StartOpts, apply: (d: Driver) => Promise<void>) {
    const id = s.id;
    const before = this.core.o.prefs.get(id);
    const source = this.sourceOf(s);
    const providerModel = patch.model !== undefined && hasSourceModels(source);
    if (providerModel) {
      const deployment = this.sourceModels(s.summary.harness, source).find((d) => d.name === patch.model);
      if (!deployment) throw new Error(source === "azure" ? `${patch.model} isn't a deployment in Settings, Azure. The model is unchanged.` : "Choose a configured model in Settings, Bedrock.");
      if (s.state.terminal || s.state.mode === "terminal") throw new Error(source === "azure" ? "Close the terminal before changing the Azure deployment." : "Close the terminal before changing the Bedrock model.");
      // Its process is priced for the deployment it started on: a turn running there keeps it, and
      // the new one waits for the next send, which restarts the process priced for that one.
      if (this.turnBusy(s) || (source === "bedrock" && s.driver)) return this.holdDeployment(s, patch.model!);
      this.holdDeployment(s, undefined);
    }
    const shown: StartOpts = Object.fromEntries(Object.keys(patch).map((k) => [k, (s.state as any)[k]]));
    this.core.o.prefs.set(id, { projectPath: s.summary.projectPath, ...patch, ...(providerModel ? { deployment: patch.model } : {}) });
    s.rolledBack = undefined;
    this.noteTurnSettings(s, patch);
    if (patch.permissionMode) this.notePlanEntry(s, patch.permissionMode);
    s.setState(patch);
    // Starting with the old settings right now: applied as soon as it's up.
    const d = s.driver ?? (s.starting ? await s.starting.catch(() => undefined) : undefined);
    if (!d) return patch.permissionMode ? this.lookForRunning(s) : undefined;
    try {
      await withTimeout(apply(d), this.settingMs, "didn't answer");
      // A harness that confirms settings itself (capabilities.persistent): shown as applied only
      // once it reports them (the report clears the pref, see the sink).
      if (s.capabilities.persistent) {
        const keys = Object.keys(patch) as ("model" | "effort" | "permissionMode")[];
        const until = this.core.now() + this.confirmMs;
        while (keys.some((k) => this.core.o.prefs.get(id)[k] !== undefined) && this.core.now() < until) await Bun.sleep(50);
        if (keys.some((k) => this.core.o.prefs.get(id)[k] !== undefined)) throw new Error("it didn't confirm the change");
      }
    } catch (e: any) {
      // Not applied: what every device shows, and what the next start sends, go back to how they
      // were, so nothing runs with settings other than those shown. A late confirmation still
      // counts (the sink says so).
      const undo = Object.fromEntries(Object.keys(patch).map((k) => [k, (before as any)[k]]));
      this.core.o.prefs.set(id, { ...undo, ...(providerModel ? { deployment: before.deployment } : {}) });
      s.rolledBack = patch;
      this.rollBackTurnSettings(s, shown);
      s.setState(shown);
      throw new Error(`${HARNESS_LABELS[s.summary.harness]} didn't take that setting (${e?.message ?? e}). It's unchanged.`);
    }
  }

  /** A turn runs, or is being started: its process and settings are in use. */
  private turnBusy(s: Session): boolean {
    return !!(s.sending || s.starting || s.carrying || s.state.status !== "idle" || s.driver?.turnRunning?.());
  }

  /**
   * A source model picked while a turn ran, kept (across restarts too) until the next send
   * applies it. The one it runs on now, or undefined, cancels it.
   */
  private holdDeployment(s: Session, deployment: string | undefined) {
    const next = deployment && deployment !== this.deploymentOf(s) ? deployment : undefined;
    if (next === this.core.o.prefs.get(s.id).nextDeployment) return;
    this.core.o.prefs.set(s.id, { nextDeployment: next });
    this.core.o.prefs.flush();
    s.setState({ nextDeployment: next });
  }

  /**
   * At a send, before the process is checked: a held deployment becomes the session's deployment and
   * model. Its credential revision differs, so ensureDriver restarts the idle process priced for it.
   */
  private applyNextDeployment(s: Session) {
    const next = this.core.o.prefs.get(s.id).nextDeployment;
    if (!next) return;
    const go = hasSourceModels(this.sourceOf(s)) ? { deployment: next, model: next } : {};
    this.core.o.prefs.set(s.id, { ...go, nextDeployment: undefined });
    this.core.o.prefs.flush();
    s.setState({ ...(go.model ? { model: go.model } : {}), nextDeployment: undefined });
  }

  /**
   * The mode of a stored session changed: what it left running (a command in a background terminal)
   * keeps its old settings, so the session joins again to say so, with no turn started. The join
   * applies the mode too. Nothing left running: it stays stored, and the change waits for the next
   * send. A join that fails leaves it at that.
   */
  private async lookForRunning(s: Session) {
    const a = this.core.adapter(s.summary.harness);
    if (s.fresh || !(await a.backgroundRuns?.(s.summary.nativeId).catch(() => false))) return;
    await this.core.load(s);
    await this.ensureDriver(s).catch(() => {});
  }

  /**
   * A setting changes while a turn runs on a harness where that counts from the next turn
   * (capabilities.settingsApply "nextTurn"): the turn's own value is kept beside it, so it shows
   * honestly ("Read only from the next turn") until the turn ends. Only for a turn that really runs
   * (not a send still starting one), and only when the harness doesn't report the running turn's
   * settings itself (capabilities.persistent: it does, as `turnSettings`, knowing them exactly).
   */
  private noteTurnSettings(s: Session, patch: StartOpts) {
    if (s.capabilities.settingsApply !== "nextTurn" || s.capabilities.persistent || s.state.status === "idle" || (s.sending && s.sentOut !== s.sending) || s.summary.parentSessionId) return;
    const turn = { ...s.state.turnSettings };
    for (const k of ["model", "effort", "permissionMode"] as const) {
      const v = patch[k];
      if (v === undefined || v === s.state[k]) continue;
      if (!(k in turn) && s.state[k] !== undefined) turn[k] = s.state[k];
      // Changed back to what the turn runs with: nothing differs any more.
      if (turn[k] === v) delete turn[k];
    }
    s.setState({ turnSettings: Object.keys(turn).length ? turn : undefined });
  }

  /** A change rolled back: the turn's own values are what shows again. */
  private rollBackTurnSettings(s: Session, shown: StartOpts) {
    // A harness that reports the turn's settings itself keeps them right.
    if (!s.state.turnSettings || s.capabilities.persistent) return;
    const turn = { ...s.state.turnSettings };
    for (const k of Object.keys(shown) as ("model" | "effort" | "permissionMode")[]) if (turn[k] === shown[k]) delete turn[k];
    s.setState({ turnSettings: Object.keys(turn).length ? turn : undefined });
  }

  /** How long a live setting change may take before it counts as failed (and is rolled back). */
  settingMs = 30_000;
  /** How long a send waits for the harness to confirm a setting it hasn't confirmed yet. */
  confirmMs = 10_000;

  /**
   * Before a live send, on a harness that confirms settings itself (capabilities.persistent): a
   * setting made in Tether that it hasn't confirmed yet (its pref is still pending) is applied again
   * and waited for. A turn never runs with settings other than those shown: if it can't be
   * confirmed, the change is dropped, the session shows what the harness last confirmed, and this
   * send fails saying so (the next one goes out on the confirmed settings).
   */
  private async confirmSettings(s: Session, d: Driver) {
    if (!s.capabilities.persistent) return;
    const pending = () => {
      const p = this.core.o.prefs.get(s.id);
      return (["model", "effort", "permissionMode"] as const).filter((k) => p[k] !== undefined);
    };
    const keys = pending();
    if (!keys.length) return;
    const p = this.core.o.prefs.get(s.id);
    try {
      for (const k of keys) {
        const v = p[k]!;
        await withTimeout(k === "model" ? d.setModel(v) : k === "effort" ? (d.setEffort?.(v) ?? Promise.resolve()) : d.setPermissionMode(v), this.settingMs, "didn't answer");
      }
      const until = this.core.now() + this.confirmMs;
      while (pending().length && this.core.now() < until) await Bun.sleep(50);
    } catch {}
    const left = pending();
    if (!left.length) return;
    // Given up on: it goes, and the session shows what the harness last confirmed.
    const back: StartOpts = Object.fromEntries(left.map((k) => [k, s.confirmed?.[k]]));
    this.core.o.prefs.set(s.id, Object.fromEntries(left.map((k) => [k, undefined])));
    s.rolledBack = Object.fromEntries(left.map((k) => [k, p[k]]));
    const label = (k: (typeof left)[number]) => (k === "permissionMode" ? "mode" : k);
    const was = left.map((k) => `${label(k)} ${back[k] ?? "as it was"}`).join(", ");
    if (Object.values(back).some((v) => v !== undefined)) s.setState(Object.fromEntries(Object.entries(back).filter(([, v]) => v !== undefined)));
    throw new Error(`${HARNESS_LABELS[s.summary.harness]} didn't confirm your new ${left.map(label).join(" and ")}, so it's back to ${was} and nothing was sent. Send again to go ahead with that, or change it again.`);
  }

  /**
   * Hands a live session over (to its TUI, SPEC §8 handoff): the driver closes so the harness
   * flushes its store, its open requests are cancelled (the TUI asks again) and its subagents end.
   * The mode is left to the caller.
   */
  async release(s: Session, retire = false) {
    await this.waitForHop(s);
    if (!this.stopping && s.retry) this.cancelRetrySession(s);
    const d = s.driver ?? (s.starting ? await s.starting.catch(() => undefined) : undefined);
    clearTimeout(s.idleTimer);
    this.desk.cancel((_r, chain) => chain.at(-1) === s.id);
    for (const c of this.core.sessions.values()) if (c !== s && c.summary.parentSessionId && c.childRunning && this.rootOf(c) === s) this.childEnded(c);
    if (!d) return;
    // Its exit isn't news: onExit checks that it's still the session's driver.
    if (s.driver === d) s.driver = undefined;
    try {
      await d.close();
    } catch {}
    if (retire) await d.retire?.();
  }

  /** Live again on the same session (Back to Tether, SPEC §8). */
  resumeLive(s: Session): Promise<Driver> {
    return this.ensureDriver(s, !!this.opts.credentials && !!s.state.terminal && !!s.capabilities.persistent);
  }

  /**
   * Why this session may not go live now (the runner's live-session limit is reached), or
   * undefined. Subagents don't count and are never refused.
   */
  private overLiveLimit(s: Session): string | undefined {
    const max = this.opts.maxLive ?? 0;
    if (max <= 0 || this.exemptFromLimit(s)) return undefined;
    let live = 0;
    for (const x of this.core.sessions.values()) if (x !== s && (x.driver || x.starting) && !this.exemptFromLimit(x)) live++;
    if (live < max) return undefined;
    return `This runner already has ${live} live sessions, its limit (TETHER_MAX_LIVE_SESSIONS=${max}). Stop one, or wait for one to go idle (${Math.round(this.idleMs / 60_000)} min after its turn ends), then send again.`;
  }

  private exemptFromLimit(s: Session): boolean {
    return !!s.summary.parentSessionId;
  }

  /** The session's driver, starting or resuming the harness when it isn't live. */
  private async ensureDriver(s: Session, observe = false, limited = true, hopId?: symbol): Promise<Driver> {
    if (this.hasHopLock(s, hopId)) await this.waitForHop(s, hopId);
    if (s.driver) {
      if (observe) return s.driver;
      if (this.revisionOf(s) === s.credentialRevision) return s.driver;
      // A running turn finishes on its original process and source. No new message can go to it
      // after a change; idle processes are closed before starting again, on the session's source
      // with its key as it is now. With its key unset that start stops, saying so.
      if (s.driver.busy() || s.driver.turnRunning?.() || s.state.terminal) throw new Error("Credentials changed. Wait for this process to finish and close its terminal before sending.");
      s.starting ??= this.release(s, true).then(() => this.startDriver(s)).finally(() => { s.starting = undefined; this.core.scheduleEvict(s); });
      return s.starting;
    }
    // Two processes must never drive one session (SPEC §8 handoff).
    const blocked = this.terminal?.blocked(s);
    if (blocked) throw new Error(blocked);
    const full = s.starting || observe || !limited ? undefined : this.overLiveLimit(s);
    if (full) throw new Error(full);
    s.starting ??= this.startDriver(s, observe).finally(() => {
      s.starting = undefined;
      this.core.scheduleEvict(s);
      // A queue let go while it started (a worktree's setup ended, Resume), or a scheduled message
      // that came due meanwhile, couldn't drain then (drain decides what may go).
      if (s.state.queue.length) this.queue.later(s.id);
    });
    return s.starting;
  }

  /**
   * What you set in Tether. The rest is the harness's own (its config, or the session's settings it
   * keeps itself), never overwritten by what Tether merely showed.
   */
  chosen(s: Session, observe = false): StartOpts {
    const credential = observe ? undefined : this.credentialFor(s.summary.harness, this.sourceOf(s), this.deploymentOf(s));
    const prefs = this.core.o.prefs.get(s.id);
    return { ...chosenOf(this.core.adapter(s.summary.harness), prefs), ...(credential?.source === "bedrock" ? { model: credential.deployment } : {}), ...(prefs.sideOf ? { readOnly: true } : {}), ...(credential ? { credential } : {}) };
  }

  /**
   * What a session draws from: what's saved with it, else what its harness has on record, which is
   * then saved. A subagent draws from its main session. Keys set later never change the answer.
   */
  sourceOf(s: Session): BillingSource {
    const main = s.summary.parentSessionId;
    const id = main ?? s.id;
    const saved = this.core.o.prefs.get(id).source;
    if (saved) return saved;
    const nativeId = main ? parseSessionId(main)?.nativeId : s.summary.nativeId;
    const recorded = (nativeId ? this.core.adapter(s.summary.harness).billing?.recorded?.(nativeId, s.summary.projectPath) : undefined) ?? "subscription";
    this.core.o.prefs.set(id, { source: recorded });
    return recorded;
  }

  /**
   * The provider model saved with the session. Older sessions use a configured match or the first entry.
   * A removed pinned model stops the session at its next send.
   */
  deploymentOf(s: Session): string | undefined {
    const source = this.sourceOf(s);
    if (!this.opts.credentials || !hasSourceModels(source)) return undefined;
    const id = s.summary.parentSessionId ?? s.id;
    const prefs = this.core.o.prefs.get(id);
    if (prefs.deployment) return prefs.deployment;
    const deployment = this.pickSourceModel(s.summary.harness, source, prefs.model ?? s.state.model);
    if (deployment) this.core.o.prefs.set(id, { deployment, ...(source === "bedrock" ? { model: deployment } : {}) });
    return deployment;
  }

  private sourceModels(harness: HarnessId, source: BillingSource): NonNullable<SourceOption["deployments"]> {
    if (source === "azure") return this.opts.credentials?.azure().deployments.map((d) => ({ name: d.name, ...(d.model ? { model: d.model } : {}) })) ?? [];
    if (source === "bedrock") return this.opts.credentials?.bedrock()?.models.filter((m) => m.harness === harness).map((m) => ({ name: m.id, ...(m.alias ? { model: m.alias } : {}) })) ?? [];
    return [];
  }

  private pickSourceModel(harness: HarnessId, source: BillingSource, model?: string): string | undefined {
    const list = this.sourceModels(harness, source);
    const selected = source === "bedrock" ? resolveSourceModel(list, model) : list.find((d) => d.name === model)?.name;
    return selected ?? list[0]?.name;
  }

  forSource(harness: HarnessId, source: BillingSource, opts: StartOpts): StartOpts {
    if (!hasSourceModels(source) || !this.opts.credentials) return opts;
    const model = opts.sourceModel ?? this.pickSourceModel(harness, source, opts.model);
    return { ...opts, model };
  }

  private subscriptionScope(harness: HarnessId, source: BillingSource) {
    return `${harness}:${source}`;
  }

  private subscriptionRevision(harness: HarnessId, source: BillingSource) {
    return this.subscriptionRevisions.get(this.subscriptionScope(harness, source)) ?? source;
  }

  /** What a session's process must have been started with to be current. */
  private revisionOf(s: Session): string | undefined {
    const source = this.sourceOf(s);
    if (isAccountSource(source)) {
      const accounts = this.opts.claudeAccounts;
      return accounts?.read(source) && !accounts.signingIn.has(source) ? this.subscriptionRevision(s.summary.harness, source) : undefined;
    }
    return (source === "subscription" ? this.subscriptionRevisions.get(this.subscriptionScope(s.summary.harness, source)) : undefined)
      ?? this.opts.credentials?.snapshot(source, this.deploymentOf(s))?.revision;
  }

  private labelOf(harness: HarnessId, source: BillingSource): string {
    const adapter = this.core.o.adapters.find((a) => a.id === harness);
    return adapter?.billing?.label(source).label ?? (isAccountSource(source) ? `Claude plan · ${source.slice(8, 16)}` : source);
  }

  /** The source as it is now: a missing key stops here, naming the source. Nothing stands in for it. */
  credentialFor(harness: HarnessId, source: BillingSource, deployment?: string): CredentialSnapshot | undefined {
    const store = this.opts.credentials;
    if (isAccountSource(source)) {
      const accounts = this.opts.claudeAccounts;
      const identity = harness === "claude" ? accounts?.read(source) : undefined;
      if (!store || !accounts || !identity || accounts.signingIn.has(source)) {
        throw new Error("The chosen Claude subscription account is unavailable. Check Accounts or change Source. Nothing was sent.");
      }
      const { accountId, email, organization } = identity;
      return { source, revision: this.subscriptionRevision(harness, source), file: store.file, claudeAccount: { configDir: accounts.configDir(source), accountId, email, organization } };
    }
    if (!store) return undefined;
    if (source === "bedrock" && !this.sourceModels(harness, source).some((m) => m.name === deployment)) {
      throw new Error("This session needs a configured model for its harness in Settings, Bedrock.");
    }
    const credential = store.snapshot(source, hasSourceModels(source) ? deployment ?? "" : undefined);
    if (credential) return credential;
    const change = this.core.adapter(harness).capabilities.sourceSwitch ? "change the session's Source" : "use Move to continue on another source";
    if (source === "azure" && store.snapshot("azure")) {
      if (!deployment) throw new Error("Azure has no deployment. Add one in Settings, Azure. Nothing was sent.");
      throw new Error(`This session's Azure deployment ${deployment} was removed. Add it again in Settings, Azure, or ${change}. Nothing was sent.`);
    }
    if (source === "azure" && store.status().azure.set) throw new Error("Azure has no resource set. Set it in Settings, Azure. Nothing was sent.");
    throw new Error(`This session uses ${this.labelOf(harness, source)}, which isn't set. Set it in ${source === "azure" ? "Settings, Azure" : source === "bedrock" ? "Settings, Bedrock" : "Credentials"}, or ${change}. Nothing was sent.`);
  }

  /** The sources that exist for a harness now: its login, if it reports one, and keys that are set. */
  async sources(harness: HarnessId): Promise<SourceChoices> {
    const billing = this.core.adapter(harness).billing;
    if (!billing || !this.opts.credentials) return { options: [] };
    const status = this.opts.credentials.status();
    const login = await billing.loggedIn().catch(() => false);
    const ready = (source: CredentialSource) => {
      if (source === "bedrock") return !!this.opts.credentials?.snapshot(source) && this.sourceModels(harness, source).length > 0;
      return status[source].set && (source !== "azure" || (!!status.azure.endpoint && !!status.azure.deployments?.length));
    };
    const listedExtras = harness === "claude" ? (this.opts.claudeAccounts?.list() ?? [])
      .filter(({ source }) => !this.opts.claudeAccounts?.signingIn.has(source)) : [];
    const extras = listedExtras.map(({ source }) => source);
    const primary = harness === "claude" && login && listedExtras.length
      ? await billing.primaryIdentity?.().catch(() => undefined)
      : undefined;
    const extraIdentities = new Map(listedExtras.map(({ source, identity }) => [source, identity]));
    const options: SourceOption[] = [...(login ? ["subscription" as const] : []), ...extras, ...billing.keys.filter(ready)].map((source) => {
      const sameAccountAs = primary && isAccountSource(source) && extraIdentities.get(source)?.accountId === primary.accountId
        ? ("subscription" as const)
        : undefined;
      return {
        source,
        billing: billing.label(source),
        ...(hasSourceModels(source) ? { deployments: this.sourceModels(harness, source) } : {}),
        ...(sameAccountAs ? { sameAccountAs } : {}),
      };
    });
    const last = this.core.o.prefs.lastSubscription(harness);
    const fallback = options.find((o) => o.source === last)?.source ?? options[0]?.source;
    return { options, ...(fallback ? { default: fallback } : {}) };
  }

  /**
   * Without an explicit source, use the last selected Claude login or the primary subscription.
   */
  async sourceForNew(harness: HarnessId, asked: unknown): Promise<BillingSource> {
    if (asked === undefined) {
      const last = this.core.o.prefs.lastSubscription(harness);
      return harness === "claude" && isAccountSource(last) && this.opts.claudeAccounts?.read(last) && !this.opts.claudeAccounts.signingIn.has(last) ? last : "subscription";
    }
    if (isAccountSource(asked)) {
      this.credentialFor(harness, asked);
      return asked;
    }
    const a = this.core.adapter(harness);
    if (!isBillingSource(asked) || (asked !== "subscription" && (!isCredentialSource(asked) || !a.billing?.keys.includes(asked)))) throw new Error(`${HARNESS_LABELS[harness]} can't use that source.`);
    return asked;
  }

  /** A new native id on a source: a key's thread is made on its own private process. */
  async newNativeId(harness: HarnessId, folder: string, opts: StartOpts, source: BillingSource): Promise<string> {
    opts = this.forSource(harness, source, opts);
    const credential = this.credentialFor(harness, source, opts.model);
    return this.core.adapter(harness).newId(folder, { ...opts, ...(credential ? { credential } : {}) });
  }

  /** A new session, its source saved with it before anything can start it. */
  async createSession(harness: HarnessId, folder: string, opts: StartOpts, source: BillingSource): Promise<Session> {
    opts = this.forSource(harness, source, opts);
    const s = this.core.create(harness, await this.newNativeId(harness, folder, opts, source), folder, opts);
    const accountBilling = isAccountSource(source) ? this.core.adapter(harness).billing?.label(source) : undefined;
    if (accountBilling) {
      s.setState({ nextBilling: accountBilling, plan: this.core.planFor(harness, source) });
    }
    this.core.o.prefs.set(s.id, { source, ...(accountBilling ? { nextBilling: accountBilling } : {}), ...(hasSourceModels(source) && opts.model ? { deployment: opts.model } : {}) });
    if (accountBilling) this.core.o.prefs.flush();
    if (isSubscriptionSource(source) && harness === "claude") this.core.o.prefs.setLastSubscription(harness, source);
    if (!isSubscriptionSource(source)) s.setState({ retryThrottled: false });
    return s;
  }

  /** Makes the thread a source change goes to, on the move module's export and import. */
  carrier?: (id: string, source: BillingSource, model?: string, settings?: StartOpts) => Promise<string>;
  fallbackMover?: (id: string, harness: HarnessId, source: BillingSource, settings: StartOpts) => Promise<{ sessionId: string; history?: string; after?: string }>;
  fallbackArchive?: (from: string, to: string, after?: string) => Promise<string>;
  private fallingBack = new WeakMap<Session, symbol>();
  /** Per-session and per-native-id lock held from before old-driver teardown through commit or abort cleanup (R6.3'). */
  private hopLocks = new Map<string, { promise: Promise<void>; release: () => void; hopId: symbol }>();

  private hopKeys(s: Session): string[] {
    const nativeKey = `${s.summary.harness}:${s.summary.nativeId}`;
    return s.id === nativeKey ? [s.id] : [s.id, nativeKey];
  }

  private hasHopLock(s: Session, hopId?: symbol): boolean {
    return this.hopKeys(s).some((k) => {
      const lock = this.hopLocks.get(k);
      return !!lock && lock.hopId !== hopId;
    });
  }

  private async waitForHop(s: Session, hopId?: symbol): Promise<void> {
    const keys = this.hopKeys(s);
    while (true) {
      const lock = keys.map((k) => this.hopLocks.get(k)).find((l) => l && l.hopId !== hopId);
      if (!lock) return;
      await lock.promise;
    }
  }

  private async acquireHopLock(keys: string[], hopId: symbol): Promise<() => void> {
    const unique = [...new Set(keys)];
    while (true) {
      const existing = unique.map((k) => this.hopLocks.get(k)).find((l) => l && l.hopId !== hopId);
      if (!existing) break;
      await existing.promise;
    }
    let release!: () => void;
    const promise = new Promise<void>((r) => (release = r));
    const owned: string[] = [];
    for (const k of unique) {
      if (this.hopLocks.get(k)?.hopId === hopId) continue;
      this.hopLocks.set(k, { promise, release, hopId });
      owned.push(k);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const k of owned) {
        if (this.hopLocks.get(k)?.hopId === hopId) this.hopLocks.delete(k);
      }
      release();
    };
  }

  /** A queued source remains pending after its first start fails, across views and runner restarts. */
  private markSourceSwitchFailed(s: Session) {
    if (!s.state.nextBilling || s.state.sourceSwitchFailed) return;
    this.core.o.prefs.set(s.id, { sourceSwitchFailed: true });
    this.core.o.prefs.flush();
    s.setState({ sourceSwitchFailed: true });
  }

  private assertSourceSwitchIdle(s: Session) {
    if (s.state.mode === "terminal" || s.state.terminal || this.terminal?.blocked(s)) throw new Error(sourceSwitchBlockMessage("terminal"));
    const blocker = sourceSwitchBlocker(s.state);
    if (blocker) throw new Error(sourceSwitchBlockMessage(blocker));
    if (s.sending || s.starting || s.carrying) throw new Error(sourceSwitchBlockMessage("turn"));
  }

  /** From the next process start, which confirms it (only with capabilities.sourceSwitch). */
  async setSource(id: string, asked: unknown, sourceModel?: string, fallback?: { chain: FallbackChain; index: number; settings: StartOpts }) {
    const s = await this.core.open(id);
    if (!fallback && this.fallingBack.has(s)) throw new Error("The fallback chain is switching this session.");
    if (s.retry) this.cancelRetrySession(s);
    const harness = s.summary.harness;
    if (s.summary.parentSessionId) throw new Error("A subagent uses its main session's source.");
    if (s.summary.sideOf) throw new Error(SIDE_KEEPS.source);
    if (!s.capabilities.sourceSwitch) throw new Error("Use Move to change this session's source.");
    if (!isBillingSource(asked)) throw new Error("That isn't a source.");
    this.assertSourceSwitchIdle(s);
    const choice = (await this.sources(harness)).options.find((o) => o.source === asked);
    this.assertSourceSwitchIdle(s);
    if (!choice) throw new Error(`${this.labelOf(harness, asked)} isn't available.`);
    if (sourceModel && !choice.deployments?.some(({ name }) => name === sourceModel)) {
      throw new Error(asked === "azure" ? `Azure deployment ${sourceModel} isn't available.` : "That model is unavailable on the requested source.");
    }
    if (!fallback && this.fallingBack.has(s)) throw new Error("The fallback chain is switching this session.");
    const own = this.sourceOf(s);
    const carries = !!s.capabilities.sourceCarry && asked !== own;
    if (fallback) {
      if (s.retrySuppressed || s.state.fallbackChain !== fallback.chain || this.stopping) throw new SendCancelled();
      if (!fallback.settings.permissionMode || !this.fallbackModeAllowed(s, fallback.settings.permissionMode)) {
        throw new FallbackStepProblemError("The fallback step exceeds this session's current permissions.");
      }
    }
    const busy = sourceSwitchBlocker(s.state);
    if (busy || s.sending || s.starting || s.carrying) throw new Error(sourceSwitchBlockMessage(busy ?? "turn"));
    // Manual billing-chip switch clears active fallback step so the next message won't return over the pick (G10).
    const clearedActive = !fallback && s.state.fallbackChain?.active !== undefined
      ? (({ active: _, ...rest }) => rest)(s.state.fallbackChain)
      : undefined;
    const fallbackChain = fallback ? { ...fallback.chain, active: fallback.index } : clearedActive;
    const progress = fallbackChain ? { fallbackChain } : {};
    const lastKey = isCredentialSource(asked) ? asked : isCredentialSource(own) ? own : undefined;
    if (lastKey) {
      this.core.o.prefs.set(id, { lastKey });
      s.setState({ lastKey });
    }
    if (asked === own && !fallback) {
      // Thought better of it: the thread never left.
      if (s.capabilities.sourceCarry) {
        const pendingDeployment = this.core.o.prefs.get(id).nextSource ? { nextDeployment: undefined } : {};
        this.core.o.prefs.set(id, { ...progress, nextSource: undefined, nextFallbackSettings: undefined, nextModel: undefined, nextBilling: undefined, sourceSwitchFailed: undefined, ...pendingDeployment });
        this.core.o.prefs.flush();
        s.setState({ ...progress, nextBilling: undefined, nextModel: undefined, sourceSwitchFailed: undefined, ...pendingDeployment });
      } else if (clearedActive) {
        this.core.o.prefs.set(id, { fallbackChain: clearedActive });
        this.core.o.prefs.flush();
        s.setState({ fallbackChain: clearedActive });
      }
      return;
    }
    // A deployment held for the next send belongs to the source being left.
    if (this.core.o.prefs.get(id).nextDeployment) {
      this.core.o.prefs.set(id, { nextDeployment: undefined });
      s.setState({ nextDeployment: undefined });
    }
    const next = this.core.adapter(harness).billing!.label(asked);
    if (carries) {
      // A model picked for another pending source doesn't go with this one.
      const nextModel = fallback ? (hasSourceModels(asked) ? undefined : fallback.settings.model)
        : this.core.o.prefs.get(id).nextSource === asked ? this.core.o.prefs.get(id).nextModel : undefined;
      const nextFallbackSettings = fallback && { effort: fallback.settings.effort, permissionMode: fallback.settings.permissionMode };
      this.core.o.prefs.set(id, { ...progress, nextSource: asked, nextFallbackSettings, nextModel, nextBilling: next, nextDeployment: sourceModel, sourceSwitchFailed: undefined });
      this.core.o.prefs.flush();
      s.setState({ ...progress, nextBilling: next, nextModel, nextDeployment: sourceModel, sourceSwitchFailed: undefined });
      return this.core.touch(s);
    }
    const confirmed = s.state.billing?.label === next.label && s.state.billing?.source === next.source;
    // Where its API cost starts is decided now, while what it was on until now is still what's confirmed.
    let cost: SessionCost | undefined;
    if (isCredentialSource(asked)) {
      try { cost = this.startCost(s); }
      catch { cost = { estimated: true, complete: false, reasons: ["unsaved"] }; this.core.log("Couldn't save this session's API cost coverage. Its total is unknown."); }
    }
    // A fallback step names its model; a source with its own model list takes the step's model from that list.
    const model = fallback ? (hasSourceModels(asked) ? sourceModel ?? fallback.settings.model : fallback.settings.model)
      : hasSourceModels(asked)
        ? sourceModel ?? this.pickSourceModel(harness, asked, this.core.o.prefs.get(id).model ?? s.state.model)
        : hasSourceModels(own) ? this.core.adapter(harness).unset?.model ?? "default" : undefined;
    const sourceSettings = model ? { model, deployment: hasSourceModels(asked) ? model : undefined } : {};
    const settings = fallback?.settings;
    this.core.o.prefs.set(id, { ...progress, ...settings, source: asked, nextBilling: confirmed ? undefined : next, sourceSwitchFailed: undefined, ...sourceSettings });
    this.core.o.prefs.flush();
    if (!fallback && harness === "claude" && isSubscriptionSource(asked)) this.core.o.prefs.setLastSubscription(harness, asked);
    s.setState({ ...progress, ...settings, ...(isAccountSource(asked) || isAccountSource(own) ? { plan: this.core.planFor(harness, asked) } : {}), nextBilling: confirmed ? undefined : next, sourceSwitchFailed: undefined, retryThrottled: isSubscriptionSource(asked) ? undefined : this.core.o.prefs.get(id).retryThrottled === true, ...(model ? { model, modelResolved: undefined } : {}), ...(cost ? { cost } : {}) });
    if (settings && s.driver && asked === own) s.credentialRevision = undefined;
    this.core.touch(s);
  }

  /**
   * Whether Tether knows what a session spent on an API so far: what the ledger holds, or nothing,
   * because until now its confirmed source was the plan and it never had an entry that's gone since.
   */
  private spendKnown(s: Session, before: Billing | undefined = s.state.billing): boolean {
    if (this.opts.costs?.has(s.id)) return true;
    return !this.core.o.prefs.get(s.id).metered && before?.kind === "plan";
  }

  /**
   * A session's API cost from its first time on a key (SPEC "API session dollars"): whole when its
   * earlier API spend is known (spendKnown, or a new session's nothing), else partial, `earlier-usage`.
   * `before` is the source confirmed until now. Once it has an entry, that stands.
   */
  startCost(s: Session, before: Billing | undefined = s.state.billing): SessionCost | undefined {
    const costs = this.opts.costs;
    if (!costs || s.summary.parentSessionId) return undefined;
    if (costs.has(s.id)) return costs.get(s.id);
    return this.beginCost(s.id, s.fresh || this.spendKnown(s, before));
  }

  /**
   * What a side query spent on the session's key (git actions' generated text, Adapter.ask): added to
   * one running report of its own in the session's API ledger (SPEC "API session dollars"). A query
   * whose spend wasn't reported leaves that report, and so the total, partial.
   */
  async sideCost(id: string, spent: SessionCost) {
    const costs = this.opts.costs;
    if (!costs) return;
    // Looked up now, not when the query started: the session may have been unloaded or reloaded since.
    const s = this.core.sessions.get(id) ?? (await this.core.open(id).catch(() => undefined));
    if (!s) {
      try {
        costs.report(id, "side-queries", addSideCost(costs.reportOf(id, "side-queries"), spent));
      } catch {}
      return;
    }
    if (s.summary.parentSessionId) return;
    try {
      this.startCost(s);
      const cost = costs.report(s.id, "side-queries", addSideCost(costs.reportOf(s.id, "side-queries"), spent));
      s.setState({ cost });
    } catch {
      this.core.log("Couldn't persist a side query's API cost. The session's total is unknown.");
    }
    this.core.touch(s);
  }

  /** A new entry, and a note in the session's prefs that it had one. */
  beginCost(id: string, known: boolean): SessionCost | undefined {
    const cost = this.opts.costs?.begin(id, known);
    if (cost) this.core.o.prefs.set(id, { metered: true });
    return cost;
  }

  private async fallbackSession(id: string) {
    const s = await this.core.open(id);
    if (s.summary.parentSessionId || s.summary.sideOf) throw new Error("Set the fallback chain on the main session.");
    return s;
  }

  async fallbackCatalog(s: Session, harness: HarnessId): Promise<FallbackHarness> {
    const target = this.core.o.adapters.find((a) => a.id === harness);
    if (!target || !await target.available().catch(() => false)) return { harness, sources: [], unavailable: true };
    const [choices, models] = await Promise.all([
      this.sources(harness),
      target.listModels(harness === s.summary.harness ? s.driver : undefined).catch(() => undefined),
    ]);
    const own = this.core.adapter(s.summary.harness);
    const mode = this.core.o.prefs.get(s.id).permissionMode ?? s.state.permissionMode;
    const ceiling = levelOf(own, mode) ?? LEVELS.readOnly;
    const permitted = (models?.permissionModes ?? []).flatMap(({ id }) => {
      const level = levelOf(target, id);
      return level !== undefined && level <= ceiling ? [{ mode: id, level }] : [];
    });
    const defaultMode = permitted.find((entry) => harness === own.id && entry.mode === mode)?.mode ??
      (permitted.length ? mapMode(ceiling, permitted) : undefined);
    const sources = target.billing ? choices.options : [{ source: "subscription" as const, billing: { kind: "plan" as const, label: `${HARNESS_LABELS[harness]} login` } }];
    return { harness, sources, defaultMode, models: models && {
      ...models, permissionModes: models.permissionModes.filter(({ id }) => permitted.some((entry) => entry.mode === id)),
    } };
  }

  async fallbackSetup(id: string): Promise<FallbackSetup> {
    const s = await this.fallbackSession(id);
    const { fallbackPresets, lastFallbackOrder } = this.core.o.prefs.fallbackOrders();
    return {
      chain: s.state.fallbackChain ?? { enabled: false, steps: lastFallbackOrder },
      saved: !!s.state.fallbackChain,
      presets: fallbackPresets,
      harnesses: await Promise.all(this.core.o.adapters.map(({ id }) => this.fallbackCatalog(s, id))),
    };
  }

  async setFallbackChain(id: string, enabled: boolean, steps: FallbackStep[], continueOnReset = false): Promise<FallbackChain> {
    const s = await this.fallbackSession(id);
    const order = this.cleanFallbackSteps(steps);
    if (typeof enabled !== "boolean" || (enabled && !order.length)) throw new Error("Add a step before enabling the fallback chain.");
    const old = s.state.fallbackChain;
    const active = enabled && old?.enabled && JSON.stringify(old.steps) === JSON.stringify(order) ? old.active : undefined;
    const chain = redactValue({ enabled, steps: order, ...(continueOnReset === true ? { continueOnReset: true } : {}), ...(active === undefined ? {} : { active }) });
    if (this.core.o.prefs.get(id).nextFallbackSettings && (!enabled || active === undefined)) {
      const cleared = { nextBilling: undefined, nextModel: undefined, nextDeployment: undefined, sourceSwitchFailed: undefined };
      this.core.o.prefs.set(id, { ...cleared, nextSource: undefined, nextFallbackSettings: undefined });
      s.setState(cleared);
    }
    if (!enabled || !continueOnReset || active === undefined) this.cancelFallbackTimer(id);
    if (!enabled || JSON.stringify(old?.steps) !== JSON.stringify(order)) this.core.o.prefs.set(id, { fallbackProgress: undefined });
    this.core.o.prefs.setFallbackOrder(id, chain);
    s.setState({ fallbackChain: chain });
    // Discard any in-flight provisional hop now that the chain changed (R1''', R6b'').
    if (s.provisionalHop) s.provisionalHop.abort("cancelled");
    return chain;
  }

  editFallbackPreset(edit: FallbackPresetEdit) {
    const { fallbackPresets } = this.core.o.prefs.fallbackOrders();
    if (edit.action !== "save" && edit.action !== "rename" && edit.action !== "delete") throw new Error("Unknown preset action.");
    if (edit.action !== "save" && !fallbackPresets.some(({ id }) => id === edit.id)) throw new Error("Preset unavailable.");
    const name = edit.action === "delete" ? "" : redact(typeof edit.name === "string" ? edit.name.trim().slice(0, 80) : "");
    if (edit.action !== "delete" && !name) throw new Error("Enter a preset name.");
    const next = edit.action === "save"
      ? [...fallbackPresets, { id: randomUUID(), name, steps: redactValue(this.cleanFallbackSteps(edit.steps)) }]
      : edit.action === "delete"
        ? fallbackPresets.filter(({ id }) => id !== edit.id)
        : fallbackPresets.map((preset) => preset.id === edit.id ? { ...preset, name } : preset);
    this.core.o.prefs.setFallbackPresets(next);
    return next;
  }

  private cleanFallbackSteps(steps: FallbackStep[]): FallbackStep[] {
    const text = (value: unknown): value is string => typeof value === "string" && !!value.trim() && value.length <= 200;
    if (!Array.isArray(steps) || steps.length > 50) throw new Error("Choose up to 50 fallback steps.");
    return steps.map((step) => {
      if (!step || !Object.hasOwn(HARNESS_LABELS, step.harness) || !isBillingSource(step.source) || !text(step.model) ||
        (step.effort !== undefined && !text(step.effort)) || (step.permissionMode !== undefined && !text(step.permissionMode))) {
        throw new Error("Each fallback step needs a harness, source and model.");
      }
      const { harness, source, model, effort, permissionMode } = step;
      return { harness, source, model, ...(effort ? { effort } : {}), ...(permissionMode ? { permissionMode } : {}) };
    });
  }

  /**
   * The "Session can text me" box (SPEC §11 Texting): only a ticked session texts the person.
   * Texting hears of it (canTextChanged): unticked, its number is dropped.
   */
  async setCanText(id: string, on: boolean) {
    const s = await this.core.open(id);
    if (s.summary.parentSessionId) throw new Error("A subagent texts as its main session.");
    this.core.o.prefs.set(id, { canText: on || undefined });
    this.core.o.prefs.flush();
    s.setState({ canText: on || undefined });
    this.core.o.bus.emit("canTextChanged", { sessionId: id, canText: on });
  }

  async setRetryThrottled(id: string, on: boolean) {
    const s = await this.core.open(id);
    if (s.summary.parentSessionId || s.summary.sideOf || isSubscriptionSource(this.sourceOf(s))) {
      throw new Error("Extended throttle retries require a main session using an API key.");
    }
    this.core.o.prefs.set(id, { retryThrottled: on || undefined });
    this.core.o.prefs.flush();
    s.setState({ retryThrottled: on });
    if (!on && s.retry?.extended && s.retry.phase === "waiting") this.cancelRetrySession(s);
  }

  /** What a session's successor on another id keeps (a fork's link back too, SPEC §16; its worktree record, SPEC §4). */
  keptPrefs(s: Session) {
    const { canText, retryThrottled, lastKey, fallbackChain, fallbackProgress, forkedFrom, sideOf, worktree } = this.core.o.prefs.get(s.id);
    // A side chat's successor is one too, read-only (SPEC §16a): failing closed.
    // The worktree goes on with the conversation: cleanup counts the successor as its user (the old id, moved on, no more).
    // Not a Keep: that was the person's answer on archiving the old id.
    const withoutKeep = ({ keep: _keep, ...rec }: NonNullable<typeof worktree>) => rec;
    return { ...(canText ? { canText } : {}), ...(retryThrottled === true ? { retryThrottled } : {}), ...(lastKey ? { lastKey } : {}), ...(fallbackChain ? { fallbackChain } : {}), ...(fallbackProgress ? { fallbackProgress } : {}), ...(forkedFrom ? { forkedFrom } : {}), ...(sideOf ? { sideOf } : {}), ...(worktree ? { worktree: withoutKeep(worktree) } : {}) };
  }

  private fallbackModeAllowed(s: Session, mode: string, harness = s.summary.harness): boolean {
    const adapter = this.core.adapter(s.summary.harness);
    const target = levelOf(this.core.adapter(harness), mode);
    const current = this.core.o.prefs.get(s.id).permissionMode ?? s.state.permissionMode;
    return target !== undefined && target <= (levelOf(adapter, current) ?? LEVELS.readOnly);
  }

  /**
   * Starts a provisional driver for a fallback hop (R6): all events go to a BufferedSink and nothing
   * is written to state, prefs or s.driver until enqueued (with resend) or startup ready (no resend).
   * On pre-turn failure or cancellation, discards silently (G3) with R2's cancellation vs step-problem split.
   */
  private async provisionalStart(params: {
    origin: Session;
    target: Session;
    hopId: symbol;
    chain: FallbackChain;
    step: FallbackStep;
    settings: StartOpts;
    sourceModel?: string;
    resume: boolean;
    send?: { text: string; attachments: Attachment[]; tether?: boolean; releaseQueue?: boolean };
    onCommitBeforeReplay: (driver: Driver, opts: StartOpts) => void;
    onCommitAfterReplay?: (driver: Driver) => Promise<void> | void;
    onAbort?: () => Promise<void> | void;
  }): Promise<void> {
    const { origin, target, hopId, chain, step, settings, sourceModel, resume, send, onCommitBeforeReplay, onCommitAfterReplay, onAbort } = params;
    const harness = target.summary.harness;
    const a = this.core.adapter(harness);
    const deployment = hasSourceModels(step.source) ? sourceModel ?? settings.model : undefined;
    let credential: CredentialSnapshot | undefined;
    try {
      credential = this.credentialFor(harness, step.source, deployment);
    } catch (e: any) {
      throw new FallbackStepProblemError(redact(e?.message ?? String(e)));
    }
    const model = hasSourceModels(step.source) ? sourceModel ?? settings.model : settings.model;
    let opts: StartOpts = {
      ...(model ? { model } : {}),
      ...(settings.effort ? { effort: settings.effort } : {}),
      ...(settings.permissionMode ? { permissionMode: settings.permissionMode } : {}),
      ...(this.core.o.prefs.get(target.id).sideOf ? { readOnly: true } : {}),
      ...(credential ? { credential } : {}),
    };
    if (a.unset && (!opts.model || !opts.effort)) {
      const known = await a.defaults(target.summary.projectPath, target.summary.nativeId).catch(() => ({}) as StartOpts);
      opts = {
        model: opts.model ?? known.model ?? a.unset.model,
        effort: opts.effort ?? known.effort ?? a.unset.effort,
        ...opts,
      };
    }

    const sink = new BufferedSink((id) => target.transcript?.get(id));
    let driver: Driver | undefined;
    let aborted: "cancelled" | "permission" | undefined;
    let committed = false;
    let enqueued = false;
    let gateReason: "cancelled" | "permission" | undefined;

    const checkGate = (): "cancelled" | "permission" | undefined => {
      if (aborted === "cancelled" || origin.retrySuppressed || this.stopping || origin.state.fallbackChain !== chain || origin.provisionalHop?.hopId !== hopId) {
        return "cancelled";
      }
      if (aborted === "permission" || !settings.permissionMode || !this.fallbackModeAllowed(origin, settings.permissionMode, step.harness)) {
        return "permission";
      }
      return undefined;
    };

    const abort = (reason: "cancelled" | "permission" = "cancelled") => {
      if (committed || aborted) return;
      aborted = reason;
      sink.discard();
      if (driver) {
        const d = driver;
        driver = undefined;
        void d.close().catch(() => {});
      }
    };

    origin.provisionalHop = { hopId, abort, ...(target !== origin ? { successor: target } : {}) };
    const releaseTargetLock = await this.acquireHopLock(this.hopKeys(target), hopId);

    const failBeforeCommit = async (reason?: "cancelled" | "permission", err?: unknown): Promise<never> => {
      sink.discard();
      const d = driver;
      driver = undefined;
      if (d) await d.close().catch(() => {});
      await onAbort?.();
      const finalReason = reason ?? gateReason ?? checkGate();
      if (finalReason === "cancelled" || (err instanceof SendCancelled && finalReason !== "permission")) {
        throw new SendCancelled();
      }
      if (finalReason === "permission") {
        throw new FallbackStepProblemError("The fallback step exceeds this session's current permissions.");
      }
      throw new FallbackStepProblemError(redact((err as Error)?.message ?? String(err ?? "Provisional start failed.")));
    };

    let commitPromise: Promise<void> | undefined;
    const sendToken = {};
    try {
      const initialGate = checkGate();
      if (initialGate) await failBeforeCommit(initialGate);

      // Teardown target's old driver without mutating target.state (leaves state byte-identical on abort).
      if (target.driver) {
        const oldDriver = target.driver;
        target.driver = undefined;
        clearTimeout(target.idleTimer);
        await oldDriver.close().catch(() => {});
      }

      const postTeardownGate = checkGate();
      if (postTeardownGate) await failBeforeCommit(postTeardownGate);

      try {
        driver = resume
          ? await a.resume(target.summary.nativeId, target.summary.projectPath, opts, sink)
          : await a.start(target.summary.projectPath, target.summary.nativeId, opts, sink);
      } catch (e) {
        await failBeforeCommit(undefined, e);
      }

      if (origin.provisionalHop?.hopId === hopId) origin.provisionalHop.driver = driver;
      const postStartGate = checkGate();
      if (postStartGate) await failBeforeCommit(postStartGate);

      const installDriver = (d: Driver) => {
        target.unwatch?.();
        target.unwatch = undefined;
        const subscriptionRevision = step.source === "subscription" ? this.subscriptionRevisions.get(this.subscriptionScope(harness, "subscription")) : undefined;
        target.driver = d;
        target.credentialRevision = subscriptionRevision ?? d.credentialRevision ?? opts.credential?.revision;
        d.onExit = (error) => {
          if (target.driver !== d) return;
          if (error) target.apply({ type: "msg", msg: notice(error, "error") });
          this.toStored(target, error);
        };
        this.setMode(target, "live", { error: undefined, continuedIn: undefined, starting: undefined });
        this.scheduleIdle(target);
      };

      if (!send) {
        try {
          await driver!.ready?.();
        } catch (e) {
          await failBeforeCommit(undefined, e);
        }
        const readyGate = checkGate();
        if (readyGate) await failBeforeCommit(readyGate);
        committed = true;
        if (origin.provisionalHop?.hopId === hopId) origin.provisionalHop = undefined;
        onCommitBeforeReplay(driver!, opts);
        installDriver(driver!);
        sink.commit(this.sink(target, step.source, () => driver!.accountIdentity, this.subscriptionRevisions.get(this.subscriptionScope(harness, step.source))));
        await onCommitAfterReplay?.(driver!);
        return;
      }

      const shown: StartOpts = {
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.effort ? { effort: opts.effort } : {}),
        ...(opts.permissionMode ? { permissionMode: opts.permissionMode } : {}),
      };
      try {
        await driver!.send(withAttachments(send.text, send.attachments), send.attachments, shown, {
          beforeEnqueue: () => {
            const problem = checkGate();
            if (problem) {
              gateReason = problem;
              return false;
            }
            return true;
          },
          onEnqueued: () => {
            enqueued = true;
            committed = true;
            if (origin.provisionalHop?.hopId === hopId) origin.provisionalHop = undefined;
            if (target !== origin) target.deferTurnEnd = true;
            target.sending = sendToken;
            target.sentOut = sendToken;
            target.lastSend = { text: send.text, attachments: send.attachments, ...(send.tether ? { tether: true } : {}) };
            target.retrySuppressed = false;
            target.turnActed = false;
            target.limitHit = undefined;
            target.rateHit = undefined;
            target.fresh = false;
            if (this.core.o.prefs.get(target.id).blank) this.core.o.prefs.set(target.id, { blank: undefined });
            if (send.releaseQueue && target.state.queueHeldBy !== "terminal") this.queue.release(target);
            onCommitBeforeReplay(driver!, opts);
            installDriver(driver!);
            sink.commit(this.sink(target, step.source, () => driver!.accountIdentity, this.subscriptionRevisions.get(this.subscriptionScope(harness, step.source))));
            commitPromise = Promise.resolve(onCommitAfterReplay?.(driver!));
          },
        });
      } catch (e) {
        if (!enqueued) {
          await failBeforeCommit(undefined, e);
        }
        // Failure AFTER enqueued: never discard and never resend (R1').
        if (commitPromise) await commitPromise;
        if (target.sending === sendToken && !(e instanceof SendCancelled)) {
          this.markSourceSwitchFailed(target);
          target.turnError = redact((e as Error)?.message ?? String(e));
          const hit = (e as { rateLimit?: { retryAt?: number } })?.rateLimit;
          if (hit && typeof hit === "object") target.rateHit = hit;
          target.apply({ type: "msg", msg: notice(target.turnError, "error") });
          target.setState({ error: target.turnError });
          this.status(target, "idle");
        }
        return;
      }
    } finally {
      if (commitPromise) await commitPromise;
      if (enqueued) {
        if (target.sending === sendToken) target.sending = undefined;
        if (target.sentOut === sendToken) target.sentOut = undefined;
        if (target.cancelSend === sendToken) target.cancelSend = undefined;
        if (target.state.status === "idle" && !target.retry) target.lastSend = undefined;
        if (target !== origin && target.deferTurnEnd) {
          target.deferTurnEnd = false;
          const deferred = target.deferredTurnEnds.splice(0);
          for (const fn of deferred) fn();
        }
        this.core.scheduleEvict(target);
      }
      if (origin.provisionalHop?.hopId === hopId) origin.provisionalHop = undefined;
      releaseTargetLock();
    }
  }

  /**
   * Fallback carry hop (R6b', R6b''): keeps answer-gated replacement semantics while registering the
   * successor as provisional from carrier() through replaceWith(), with R2 cancellation/permission split
   * and R6.4 beforeEnqueue gate.
   */
  private async carryFallback(params: {
    origin: Session;
    hopId: symbol;
    chain: FallbackChain;
    index: number;
    step: FallbackStep;
    settings: StartOpts;
    sourceModel?: string;
    progress: FallbackProgress;
    sent: NonNullable<Session["lastSend"]>;
    onCommitted: () => void;
  }): Promise<void> {
    const { origin, hopId, chain, index, step, settings, sourceModel, progress, sent, onCommitted } = params;
    if (!this.carrier) throw new Error("This runner can't change a session's source.");
    let aborted: "cancelled" | "permission" | undefined;
    let successor: Session | undefined;
    let gateReason: "cancelled" | "permission" | undefined;
    let committed = false;

    const checkGate = (): "cancelled" | "permission" | undefined => {
      if (aborted === "cancelled" || origin.retrySuppressed || this.stopping || origin.state.fallbackChain !== chain || origin.provisionalHop?.hopId !== hopId) {
        return "cancelled";
      }
      if (aborted === "permission" || !settings.permissionMode || !this.fallbackModeAllowed(origin, settings.permissionMode, step.harness)) {
        return "permission";
      }
      return undefined;
    };

    const abort = (reason: "cancelled" | "permission" = "cancelled") => {
      if (committed || aborted) return;
      aborted = reason;
      if (successor) void this.interrupt(successor.id).catch(() => {});
    };

    origin.provisionalHop = { hopId, abort };
    let releaseSuccessorLock: (() => void) | undefined;
    try {
      const initialGate = checkGate();
      if (initialGate === "cancelled") throw new SendCancelled();
      if (initialGate === "permission") throw new FallbackStepProblemError("The fallback step exceeds this session's current permissions.");

      const nextModel = hasSourceModels(step.source) ? undefined : settings.model;
      const carrySettings: StartOpts = {
        effort: settings.effort,
        permissionMode: settings.permissionMode,
        ...(hasSourceModels(step.source) && sourceModel ? { sourceModel, model: sourceModel } : {}),
      };
      const id = await this.carrier(origin.id, step.source, nextModel, carrySettings);
      const n = await this.core.open(id);
      successor = n;
      if (origin.provisionalHop?.hopId === hopId) origin.provisionalHop.successor = n;
      releaseSuccessorLock = await this.acquireHopLock(this.hopKeys(n), hopId);
      this.core.pin(n);
      try {
        const postCarrierGate = checkGate();
        if (postCarrierGate) {
          gateReason = postCarrierGate;
          throw new SendCancelled();
        }
        await this.core.load(n);
        const seen = new Set(n.transcript!.messages.map((m) => m.id));
        await this.send(id, sent.text, sent.attachments, {
          tether: true,
          provisional: true,
          hopId,
          beforeEnqueue: () => {
            const p = checkGate();
            if (p) {
              gateReason = p;
              return false;
            }
            return true;
          },
        });
        await this.answered(n, seen, () => !!checkGate());
        // Just before replaceWith(), revalidate (R6b'').
        const preReplaceGate = checkGate();
        if (preReplaceGate) {
          gateReason = preReplaceGate;
          throw new SendCancelled();
        }
      } catch (e) {
        await this.interrupt(n.id).catch(() => {});
        await this.close(n);
        await this.core.adapter(n.summary.harness).move?.discard?.(n.summary.nativeId).catch(() => {});
        this.core.dropFresh(n);
        const finalReason = gateReason ?? checkGate();
        if (finalReason === "cancelled" || (e instanceof SendCancelled && finalReason !== "permission")) throw new SendCancelled();
        if (finalReason === "permission") throw new FallbackStepProblemError("The fallback step exceeds this session's current permissions.");
        throw new FallbackStepProblemError(redact((e as Error)?.message ?? String(e)));
      } finally {
        this.core.unpin(n);
      }

      committed = true;
      if (origin.provisionalHop?.hopId === hopId) origin.provisionalHop = undefined;
      delete progress.steps[index]?.retryAt;
      delete progress.steps[index]?.why;
      const lastKey = isCredentialSource(step.source) ? step.source : isCredentialSource(this.sourceOf(origin)) ? this.sourceOf(origin) : undefined;
      this.core.o.prefs.set(origin.id, {
        fallbackChain: { ...chain, active: index },
        fallbackProgress: progress,
        ...(lastKey ? { lastKey } : {}),
      });
      this.core.o.prefs.flush();
      origin.setState({ fallbackChain: { ...chain, active: index }, ...(lastKey ? { lastKey } : {}) });
      if (!sent.tether && origin.state.queueHeldBy !== "terminal") this.queue.release(origin);
      onCommitted();
      await this.replaceWith(origin, n);
    } finally {
      if (origin.provisionalHop?.hopId === hopId) origin.provisionalHop = undefined;
      releaseSuccessorLock?.();
    }
  }

  private async returnToFallback(params: {
    origin: Session;
    hopId: symbol;
    chain: FallbackChain;
    index: number;
    step: FallbackStep;
    settings: StartOpts;
    progress: FallbackProgress;
    sourceModel?: string;
    sent: Session["lastSend"];
    acted: boolean;
    waking: boolean;
    returning: boolean;
    onSay: (text: string) => void;
    onCommitted: () => void;
  }): Promise<boolean> {
    const { origin: s, hopId, chain, index, step, settings, progress, sourceModel, sent, acted, waking, returning, onSay, onCommitted } = params;
    const previous = progress.steps[index];
    if (!previous?.sessionId || previous.sessionId === s.id || !this.fallbackArchive) return false;
    const prefs = this.core.o.prefs;
    const old = await this.core.open(previous.sessionId).catch(() => undefined);
    if (!old || old.summary.harness !== step.harness || this.sourceOf(old) !== step.source ||
      old.state.status !== "idle" || old.state.terminal || old.driver?.busy() || !old.movedTo) return false;
    if (s.retrySuppressed || this.stopping || s.state.fallbackChain !== chain) throw new SendCancelled();
    if (!settings.permissionMode || !this.fallbackModeAllowed(s, settings.permissionMode, step.harness)) {
      throw new FallbackStepProblemError("The fallback step exceeds this session's current permissions.");
    }
    if (await this.core.adapter(old.summary.harness).noStore?.(old.summary.nativeId).catch(() => true)) return false;
    // In the returning thread's own moved folder: the only one its agent may read without asking.
    const file = await this.fallbackArchive(s.id, old.id, previous.after).catch(() => undefined);
    if (!file) return false;
    if (s.retrySuppressed || this.stopping || s.state.fallbackChain !== chain) throw new SendCancelled();
    const model = hasSourceModels(step.source) ? sourceModel ?? settings.model : settings.model;
    const note = `Another agent worked on this; read ${file} and continue.`;
    const prompt = sent && !acted ? `${note}\n\n${sent.text}` : undefined;
    const wasRebuilt = old.rebuilt;
    this.core.pin(old);
    try {
      await this.provisionalStart({
        origin: s,
        target: old,
        hopId,
        chain,
        step,
        settings,
        sourceModel,
        resume: true,
        send: prompt ? { text: prompt, attachments: sent!.attachments, tether: true } : undefined,
        onCommitBeforeReplay: () => {
          // Prepare historical session settings and flags only at commit (R6a).
          prefs.set(old.id, { ...settings, model, ...(hasSourceModels(step.source) && model ? { deployment: model } : {}) });
          old.setState({ ...settings, model });
          old.fresh = old.rebuilt = false;
          if (wasRebuilt) old.transcript = null;
        },
        onCommitAfterReplay: async () => {
          delete progress.steps[index]?.retryAt;
          delete progress.steps[index]?.why;
          prefs.set(s.id, { fallbackChain: { ...chain, active: index }, fallbackProgress: progress });
          onSay(`Returned to ${this.labelOf(step.harness, step.source)}.`);
          await this.replaceWith(s, old);
          old.apply({ type: "msg", msg: notice(note) });
          if (waking) this.core.o.bus.emit("fallbackStatus", { sessionId: old.id, status: "resumed" });
          onCommitted();
          if (old.deferTurnEnd) {
            old.deferTurnEnd = false;
            const deferred = old.deferredTurnEnds.splice(0);
            for (const fn of deferred) fn();
          }
          if (!prompt && !returning) this.core.o.bus.emit("fallbackStatus", { sessionId: old.id, status: "waiting" });
        },
      });
      return true;
    } finally {
      this.core.unpin(old);
    }
  }

  private fallbackTimers = new Map<string, ReturnType<typeof setTimeout>>();
  fallbackResetDelay = 60_000;
  /** Cap for waiting on background work during a fallback handoff (B5). */
  fallbackHandoffMaxMs = 30 * 60_000;

  restoreFallbackTimers() {
    for (const id of this.core.o.prefs.ids((p) => p.fallbackResumeAt !== undefined && !!p.fallbackChain?.enabled &&
      !!p.fallbackChain.continueOnReset && !p.movedTo && !p.archived)) this.armFallbackTimer(id);
  }

  private cancelFallbackTimer(id: string) {
    clearTimeout(this.fallbackTimers.get(id));
    this.fallbackTimers.delete(id);
    const prefs = this.core.o.prefs;
    if (prefs.get(id).fallbackResumeAt === undefined) return;
    prefs.set(id, { fallbackResumeAt: undefined });
    prefs.flush();
  }

  private scheduleFallbackTimer(id: string, at: number) {
    this.core.o.prefs.set(id, { fallbackResumeAt: at });
    this.core.o.prefs.flush();
    this.armFallbackTimer(id);
  }

  private armFallbackTimer(id: string) {
    clearTimeout(this.fallbackTimers.get(id));
    const at = this.core.o.prefs.get(id).fallbackResumeAt;
    if (this.stopping || at === undefined) return;
    const timer = setTimeout(() => void this.wakeFallback(id, at).catch((e) => this.core.log(
      `${id}: couldn't continue the fallback chain: ${redact((e as Error).message)}`)), Math.min(2 ** 31 - 1, Math.max(0, at - this.core.now())));
    timer.unref?.();
    this.fallbackTimers.set(id, timer);
  }

  private async wakeFallback(id: string, at: number) {
    const prefs = this.core.o.prefs;
    if (this.stopping || prefs.get(id).fallbackResumeAt !== at) return;
    if (this.core.now() < at) return this.armFallbackTimer(id);
    const s = await this.core.open(id).catch(() => undefined);
    if (this.stopping || prefs.get(id).fallbackResumeAt !== at) return;
    if (!s || s.movedTo || prefs.get(id).archived || !s.state.fallbackChain?.continueOnReset) return this.cancelFallbackTimer(id);
    if (sourceSwitchBlocker(s.state) || s.sending || s.starting || s.driver?.busy() || s.retry || this.heldWhy(id)) {
      this.scheduleFallbackTimer(id, this.core.now() + this.fallbackResetDelay);
      return;
    }
    this.cancelFallbackTimer(id);
    s.retrySuppressed = false;
    const continued = await this.advanceFallback(s, undefined, { text: "continue", attachments: [], tether: true }, false, true, true);
    if (!continued && !s.retrySuppressed && !s.movedTo && s.state.fallbackChain?.continueOnReset) {
      this.scheduleFallbackTimer(id, this.core.now() + FALLBACK_BACKOFF_MS + this.fallbackResetDelay);
    }
  }

  private fallbackExhausted(s: Session, chain: FallbackChain, progress: FallbackProgress) {
    const times: number[] = [];
    const entries = chain.steps.map((step, index) => {
      const retryAt = progress.steps[index]?.retryAt;
      if (retryAt && retryAt > this.core.now()) times.push(retryAt);
      const label = this.labelOf(step.harness, step.source);
      return `${index + 1}. ${HARNESS_LABELS[step.harness]} · ${label} · ${step.model} — ${retryAt ? `retry after ${new Date(retryAt).toISOString()}` : "no reset known"}`;
    });
    this.core.o.prefs.set(s.id, { fallbackProgress: progress });
    this.core.o.prefs.flush();
    const text = "Used every available source.";
    s.apply({ type: "msg", msg: notice([text, ...entries].join("\n"), "warning") });
    s.setState({ error: text });
    // The turn's own end (with fallbackPending) was already reported: no second turnEnded.
    this.core.o.bus.emit("fallbackStatus", { sessionId: s.id, status: "exhausted" });
    if (chain.continueOnReset && times.length) this.scheduleFallbackTimer(s.id, Math.min(...times) + this.fallbackResetDelay);
  }

  private canAdvanceFallback(s: Session, hit?: { resetsAt?: number }) {
    const prefs = this.core.o.prefs.get(s.id);
    return !!s.state.fallbackChain?.enabled && (!!s.capabilities.sourceSwitch || !!this.fallbackMover && !!s.capabilities.move) && !prefs.nextSource && !s.summary.parentSessionId &&
      !prefs.sideOf && !this.fallingBack.has(s) && (!hit || isSubscriptionSource(this.sourceOf(s)));
  }

  private hasBackgroundWork(s: Session): boolean {
    const blocker = sourceSwitchBlocker(s.state);
    return blocker === "background" || !!s.state.backgroundSubagents || s.shellsRunning > 0 || !!s.driver?.busy();
  }

  private async probeAccount(source: AccountSource): Promise<HarnessLoginStatus> {
    if (this.opts.probeClaudeAccount) return this.opts.probeClaudeAccount(source);
    if (!this.opts.claudeAccounts) return { state: "signedOut" };
    return probeClaudeAccount(this.opts.claudeAccounts, source);
  }

  private async claudeIdentityFor(source: BillingSource): Promise<PlanIdentity | undefined> {
    if (isAccountSource(source)) {
      const id = this.opts.claudeAccounts?.read(source);
      return id ? { accountId: id.accountId, email: id.email, organization: id.organization } : undefined;
    }
    if (source === "subscription") {
      return this.core.o.adapters.find((a) => a.id === "claude")?.billing?.primaryIdentity?.().catch(() => undefined);
    }
    return undefined;
  }

  /** Identity-matched Claude plan usage for B1 skip decisions (R5', G4). Untagged windows are ignored. */
  private async claudePlanForSkip(source: BillingSource): Promise<PlanUsage | undefined> {
    const targetIdentity = await this.claudeIdentityFor(source);
    if (!targetIdentity) return undefined;
    const direct = this.core.planEntryFor("claude", source);
    if (direct?.identity && samePlanIdentity(direct.identity, targetIdentity)) return direct.plan;
    // Share a full window across two source IDs only when accountId, email, and normalized org all match (R5').
    for (const entry of this.core.allPlanEntries("claude")) {
      if (entry.identity && samePlanIdentity(entry.identity, targetIdentity)) return entry.plan;
    }
    return undefined;
  }

  private async waitForFallbackHandoff(s: Session, chain: FallbackChain) {
    const adapter = this.core.adapter(s.summary.harness);
    const deadline = this.core.now() + this.fallbackHandoffMaxMs;
    const initialQueueIds = new Set(s.state.queue.map((m) => m.id));
    s.setState({ fallbackWaiting: true });
    try {
      while (!s.retrySuppressed && !this.stopping && s.state.fallbackChain === chain) {
        if (s.state.mode === "terminal" || s.state.terminal || this.terminal?.blocked(s)) throw new Error("Close the terminal first.");
        // Ignore queue entries added by a waited-on `!` shell (shellRuns.ts:454, G10).
        const blocker = sourceSwitchBlocker({ ...s.state, queue: s.state.queue.filter((m) => !m.shell || initialQueueIds.has(m.id)) });
        if (blocker === "terminal") throw new Error("Close the terminal first.");
        if (!blocker && !s.sending && !s.starting && !s.carrying && !s.state.requests.length && s.state.status === "idle" &&
          !s.driver?.busy() && !s.state.backgroundSubagents && !s.shellsRunning &&
          !await adapter.backgroundRuns?.(s.summary.nativeId).catch(() => true)) return;
        if (this.core.now() >= deadline) throw new FallbackHandoffTimeoutError();
        await Bun.sleep(250);
      }
      throw new SendCancelled();
    } finally {
      s.setState({ fallbackWaiting: undefined });
    }
  }

  private async moveFallback(params: {
    origin: Session;
    hopId: symbol;
    chain: FallbackChain;
    start: number;
    index: number;
    step: FallbackStep;
    settings: StartOpts;
    sourceModel?: string;
    progress: FallbackProgress;
    resetsAt?: number;
    sent: Session["lastSend"];
    waking: boolean;
    onCommitted: () => void;
  }): Promise<void> {
    const { origin: s, hopId, chain, start, index, step, settings, sourceModel, progress, resetsAt, sent, waking, onCommitted } = params;
    if (!this.fallbackMover) throw new Error("The Move module is unavailable on this runner.");
    if (s.retrySuppressed || this.stopping || s.state.fallbackChain !== chain) throw new SendCancelled();
    if (!settings.permissionMode || !this.fallbackModeAllowed(s, settings.permissionMode, step.harness)) {
      throw new FallbackStepProblemError("The fallback step exceeds this session's current permissions.");
    }
    let mover: { sessionId: string; history?: string; after?: string };
    try {
      mover = await this.fallbackMover(s.id, step.harness, step.source, settings);
    } catch (e) {
      if (e instanceof SendCancelled || s.retrySuppressed || this.stopping || s.state.fallbackChain !== chain) throw new SendCancelled();
      throw new FallbackStepProblemError(redact((e as Error)?.message ?? String(e)));
    }
    const next = await this.core.open(mover.sessionId);
    const discardSuccessor = async () => {
      await this.close(next, true);
      await this.core.adapter(step.harness).move?.discard?.(next.summary.nativeId).catch(() => {});
      this.core.dropFresh(next);
    };
    if (s.retrySuppressed || this.stopping || s.state.fallbackChain !== chain) {
      await discardSuccessor();
      throw new SendCancelled();
    }
    if (!settings.permissionMode || !this.fallbackModeAllowed(s, settings.permissionMode, step.harness)) {
      await discardSuccessor();
      throw new FallbackStepProblemError("The fallback step exceeds this session's current permissions.");
    }
    const last = progress.lastUserText;
    const note = mover.history ? `Read the conversation and work history at ${mover.history}.` : undefined;
    const opening = [
      "Continue the task where it stopped.",
      note,
      last ? "Last user message:\n" + last.split("\n").map((line) => "> " + line).join("\n") : undefined,
    ].filter(Boolean).join("\n\n").slice(0, MESSAGE_TEXT_MAX);

    this.core.pin(next);
    try {
      await this.provisionalStart({
        origin: s,
        target: next,
        hopId,
        chain,
        step,
        settings,
        sourceModel,
        resume: !next.fresh,
        send: { text: opening, attachments: sent?.attachments ?? [], tether: true },
        onCommitBeforeReplay: () => {},
        onCommitAfterReplay: async () => {
          delete progress.steps[index]?.retryAt;
          delete progress.steps[index]?.why;
          if (progress.steps[start] && mover.after) progress.steps[start]!.after = mover.after;
          this.core.o.prefs.set(s.id, { fallbackChain: { ...chain, active: index }, fallbackProgress: progress });
          const from = this.labelOf(s.summary.harness, this.sourceOf(s));
          const when = resetsAt ? `, resets ${new Date(resetsAt).toISOString()}` : "";
          const link = (text: string, sessionId: string): Msg => ({ ...notice(text), link: { sessionId, label: "Open session" } });
          s.apply({ type: "msg", msg: { ...link(`Moved to this ${HARNESS_LABELS[step.harness]} session · ${from} hit a usage limit${when}.`, next.id), ...(resetsAt ? { resetsAt } : {}) } });
          next.apply({ type: "msg", msg: link(`Continued from this ${HARNESS_LABELS[s.summary.harness]} session.`, s.id) });
          await this.replaceWith(s, next);
          if (waking) this.core.o.bus.emit("fallbackStatus", { sessionId: next.id, status: "resumed" });
          onCommitted();
          if (next.deferTurnEnd) {
            next.deferTurnEnd = false;
            const deferred = next.deferredTurnEnds.splice(0);
            for (const fn of deferred) fn();
          }
        },
        onAbort: discardSuccessor,
      });
    } finally {
      this.core.unpin(next);
    }
  }

  /** Advance in order after an exhausted plan or the end of rate-limit recovery. */
  /** `ended`: why the turn ended, told to the person when the chain stops and waits on them. */
  private async advanceFallback(s: Session, hit: { resetsAt?: number } | undefined, sent: Session["lastSend"], acted: boolean, returning = false, waking = false, ended?: string): Promise<boolean> {
    const prefs = this.core.o.prefs.get(s.id);
    const chain = s.state.fallbackChain;
    const harness = s.summary.harness;
    if (!chain || !this.canAdvanceFallback(s, hit)) return false;
    const source = this.sourceOf(s);
    const matchesCurrent = (step: FallbackStep) => step.harness === harness && step.source === source &&
      step.model === s.state.model && (!step.effort || step.effort === s.state.effort) &&
      (!step.permissionMode || step.permissionMode === s.state.permissionMode);
    const start = chain.active ?? chain.steps.findIndex(matchesCurrent);
    const cause = waking ? "Fallback chain resumed." : returning ? "Higher-priority source available." : hit ? "Plan limit reached." : "Rate limit retries exhausted.";
    let resetsAt: number | undefined;
    const say = (text: string, level: Msg["level"] = "info") => s.apply({
      type: "msg", msg: { ...notice(`${cause} ${text}`, level), ...(resetsAt ? { resetsAt } : {}) },
    });
    const sayRaw = (text: string, level: Msg["level"] = "info") => s.apply({
      type: "msg", msg: { ...notice(text, level), ...(resetsAt ? { resetsAt } : {}) },
    });
    const hopNoticeText = (index: number, label: string, verb: string, tail: string) => {
      const target = `step ${index + 1} · ${label}`;
      if (waking) return `Fallback chain resumed. ${verb} ${target}.${tail}`;
      if (returning) return `Higher-priority source available. ${verb} ${target}.${tail}`;
      if (hit) return `${start >= 0 ? `Step ${start + 1} hit` : "Hit"} its limit. ${verb} ${target}.${tail}`;
      return `Rate limit retries exhausted${start >= 0 ? ` on step ${start + 1}` : ""}. ${verb} ${target}.${tail}`;
    };
    // The turn end before this carried fallbackPending, so push waits for this instead.
    const waiting = (error = ended) => {
      if (!returning) this.core.o.bus.emit("fallbackStatus", { sessionId: s.id, status: "waiting", ...(error ? { error } : {}) });
    };
    const reservation = Symbol();
    this.fallingBack.set(s, reservation);
    this.core.pin(s);
    let releaseHopLock: (() => void) | undefined;
    let switchedSource = false;
    try {
      // A turn can end before its send has returned.
      const until = this.core.now() + 5000;
      while ((s.sending || s.starting) && this.core.now() < until) await Bun.sleep(20);
      if (hit) resetsAt = await this.planReset(harness, s, hit);
      if (s.state.fallbackChain !== chain || this.sourceOf(s) !== source || s.retrySuppressed || this.stopping) {
        if (!waking && !s.retrySuppressed && !this.stopping) waiting();
        return false;
      }
      const progress: FallbackProgress = { ...prefs.fallbackProgress, steps: { ...prefs.fallbackProgress?.steps } };
      if (sent && !sent.tether) progress.lastUserText = sent.text;
      if (returning && !waking && start >= 0) {
        progress.steps[start] = { sessionId: s.id, after: s.transcript?.messages.at(-1)?.id };
      }
      if (!returning) {
        const retryAt = hit ? (resetsAt ?? this.core.now() + FALLBACK_BACKOFF_MS) : this.core.now() + FALLBACK_BACKOFF_MS;
        const why = hit ? (resetsAt ? "limit" as const : "limit-unknown-reset" as const) : "error" as const;
        let touched = false;
        if (start >= 0) {
          progress.steps[start] = { ...progress.steps[start], retryAt, why, sessionId: s.id, after: s.transcript?.messages.at(-1)?.id };
          touched = true;
        }
        // B2 + G10: share backoff on a plan-limit hit with sibling steps on the same (harness, source, model), even when start === -1.
        if (hit) {
          const currentModel = s.state.model;
          for (let i = 0; i < chain.steps.length; i++) {
            if (i === start) continue;
            const other = chain.steps[i]!;
            if (other.harness === harness && other.source === source && other.model === currentModel) {
              progress.steps[i] = { ...progress.steps[i], retryAt, why };
              touched = true;
            }
          }
        }
        if (touched) {
          this.core.o.prefs.set(s.id, { fallbackProgress: progress });
          this.core.o.prefs.flush();
        }
      }
      const indexes = fallbackOrder(chain.steps.length, waking ? -1 : start, progress, this.core.now(), returning && !waking)
        .filter((index) => waking ? progress.steps[index]?.retryAt !== undefined : index > start || progress.steps[index]?.retryAt !== undefined);
      const catalogs = new Map<HarnessId, FallbackHarness>();
      const plans = new Map<string, PlanUsage | undefined>();
      for (const index of indexes) {
        const step = chain.steps[index]!;
        const cross = step.harness !== harness || !s.capabilities.sourceSwitch;
        const catalog = catalogs.get(step.harness) ?? await this.fallbackCatalog(s, step.harness);
        catalogs.set(step.harness, catalog);
        if (s.state.fallbackChain !== chain || this.sourceOf(s) !== source || s.retrySuppressed || this.stopping) {
          if (!waking && !s.retrySuppressed && !this.stopping) waiting();
          return false;
        }
        if (fallbackStepProblem(step, catalog)) {
          // G10: back off unavailable steps even when returning so probes don't run on every message.
          progress.steps[index] = { ...progress.steps[index], retryAt: this.core.now() + FALLBACK_BACKOFF_MS, why: "error" };
          this.core.o.prefs.set(s.id, { fallbackProgress: progress });
          this.core.o.prefs.flush();
          continue;
        }
        if (isSubscriptionSource(step.source)) {
          const planKey = `${step.harness}\0${step.source}`;
          if (!plans.has(planKey)) {
            if (step.harness === "claude") plans.set(planKey, await this.claudePlanForSkip(step.source));
            else if (step.source === "subscription") plans.set(planKey, await this.core.refreshPlan(step.harness));
            else plans.set(planKey, this.core.planFor(step.harness, step.source));
          }
          const now = this.core.now();
          const resets = this.planWindows(step.harness, step.model, plans.get(planKey)).flatMap((w) =>
            w?.resetsAt && w.resetsAt > now && w.resetsAt < 8.64e15 ? [w.resetsAt] : []);
          if (resets.length) {
            progress.steps[index] = { ...progress.steps[index], retryAt: Math.max(...resets), why: "limit" };
            this.core.o.prefs.set(s.id, { fallbackProgress: progress });
            this.core.o.prefs.flush();
            continue;
          }
        }
        // R2: compare step.harness too so another harness with the same source & model ID isn't skipped.
        if (!waking && step.harness === harness && step.source === source && step.model === s.state.model && (!step.effort || step.effort === s.state.effort) &&
          (!step.permissionMode || step.permissionMode === s.state.permissionMode)) continue;
        // Azure steps name a deployment; a Bedrock step's model resolves to one of its configured models.
        const sourceModel = step.source === "azure" ? step.model
          : step.source === "bedrock" ? resolveSourceModel(this.sourceModels(step.harness, "bedrock"), step.model) : undefined;
        if (step.source === "bedrock" && !sourceModel) {
          progress.steps[index] = { ...progress.steps[index], retryAt: this.core.now() + FALLBACK_BACKOFF_MS, why: "error" };
          this.core.o.prefs.set(s.id, { fallbackProgress: progress });
          this.core.o.prefs.flush();
          continue;
        }
        if (s.state.fallbackChain !== chain || this.sourceOf(s) !== source || s.retrySuppressed || this.stopping) {
          if (!waking && !s.retrySuppressed && !this.stopping) waiting();
          return false;
        }
        // B8 + R1 + G10: probe extra Claude account sign-in before committing or closing old driver.
        if (step.harness === "claude" && isAccountSource(step.source)) {
          const status = await this.probeAccount(step.source).catch((): HarnessLoginStatus => ({ state: "unknown" }));
          if (s.state.fallbackChain !== chain || this.sourceOf(s) !== source || s.retrySuppressed || this.stopping) {
            if (!waking && !s.retrySuppressed && !this.stopping) waiting();
            return false;
          }
          if (status.state === "signedOut") {
            progress.steps[index] = { ...progress.steps[index], retryAt: this.core.now() + FALLBACK_BACKOFF_MS, why: "error" };
            this.core.o.prefs.set(s.id, { fallbackProgress: progress });
            this.core.o.prefs.flush();
            continue;
          }
        }
        const settings = { model: step.model, effort: step.effort, permissionMode: step.permissionMode ?? catalog.defaultMode };
        const needsReturn = index < start && progress.steps[index]?.sessionId !== s.id && !!progress.steps[index]?.sessionId;
        if (cross || needsReturn || this.hasBackgroundWork(s)) await this.waitForFallbackHandoff(s, chain);
        if (index < start) {
          releaseHopLock ??= await this.acquireHopLock(this.hopKeys(s), reservation);
          try {
            const returned = await this.returnToFallback({
              origin: s,
              hopId: reservation,
              chain,
              index,
              step,
              settings,
              progress,
              sourceModel,
              sent,
              acted,
              waking,
              returning,
              onSay: () => sayRaw(hopNoticeText(index, this.labelOf(step.harness, step.source), "Returned to", "")),
              onCommitted: () => {
                switchedSource = true;
                if (this.fallingBack.get(s) === reservation) this.fallingBack.delete(s);
                releaseHopLock?.();
                releaseHopLock = undefined;
              },
            });
            if (returned) return true;
          } catch (e) {
            if (e instanceof FallbackStepProblemError) {
              progress.steps[index] = { ...progress.steps[index], retryAt: this.core.now() + FALLBACK_BACKOFF_MS, why: "error" };
              this.core.o.prefs.set(s.id, { fallbackProgress: progress });
              this.core.o.prefs.flush();
              continue;
            }
            throw e;
          }
        }
        if (cross) {
          if (!this.fallbackMover) {
            if (returning) continue;
            say("The Move module is unavailable on this runner.", "warning");
            waiting();
            return true;
          }
          const moveSettings = sourceModel ? { ...settings, model: sourceModel } : settings;
          releaseHopLock ??= await this.acquireHopLock(this.hopKeys(s), reservation);
          try {
            await this.moveFallback({
              origin: s,
              hopId: reservation,
              chain,
              start,
              index,
              step,
              settings: moveSettings,
              sourceModel,
              progress,
              resetsAt,
              sent,
              waking,
              onCommitted: () => {
                switchedSource = true;
                if (this.fallingBack.get(s) === reservation) this.fallingBack.delete(s);
                releaseHopLock?.();
                releaseHopLock = undefined;
              },
            });
            return true;
          } catch (e) {
            if (e instanceof FallbackStepProblemError && !s.movedTo && !this.core.o.prefs.get(s.id).movedTo) {
              progress.steps[index] = { ...progress.steps[index], retryAt: this.core.now() + FALLBACK_BACKOFF_MS, why: "error" };
              this.core.o.prefs.set(s.id, { fallbackProgress: progress });
              this.core.o.prefs.flush();
              continue;
            }
            throw e;
          }
        }
        const label = this.labelOf(harness, step.source);
        if (s.state.mode === "terminal" || s.state.terminal || this.terminal?.blocked(s)) throw new Error(sourceSwitchBlockMessage("terminal"));
        const carries = !!s.capabilities.sourceCarry && step.source !== source;
        const verb = carries ? "Next source:" : "Switched to";
        if (carries && (!sent || acted)) {
          // Hops with no resend on a carry harness keep pending-source behaviour (R6b').
          try {
            await this.setSource(s.id, step.source, sourceModel, { chain, index, settings });
          } catch (e) {
            if (e instanceof FallbackStepProblemError) {
              progress.steps[index] = { ...progress.steps[index], retryAt: this.core.now() + FALLBACK_BACKOFF_MS, why: "error" };
              this.core.o.prefs.set(s.id, { fallbackProgress: progress });
              this.core.o.prefs.flush();
              continue;
            }
            throw e;
          }
          switchedSource = true;
          if (waking) this.core.o.bus.emit("fallbackStatus", { sessionId: s.id, status: "resumed" });
          delete progress.steps[index]?.retryAt;
          delete progress.steps[index]?.why;
          this.core.o.prefs.set(s.id, { fallbackProgress: progress });
          this.core.o.prefs.flush();
          sayRaw(hopNoticeText(index, label, verb, ` ${acted ? "The turn already acted. " : ""}Send a message to continue.`));
          waiting();
          return true;
        }
        releaseHopLock ??= await this.acquireHopLock(this.hopKeys(s), reservation);
        if (carries && sent && !acted) {
          try {
            await this.carryFallback({
              origin: s,
              hopId: reservation,
              chain,
              index,
              step,
              settings,
              sourceModel,
              progress,
              sent,
              onCommitted: () => {
                switchedSource = true;
                if (waking) this.core.o.bus.emit("fallbackStatus", { sessionId: s.id, status: "resumed" });
                sayRaw(hopNoticeText(index, label, verb, " Resending your message."));
                if (this.fallingBack.get(s) === reservation) this.fallingBack.delete(s);
                releaseHopLock?.();
                releaseHopLock = undefined;
              },
            });
            return true;
          } catch (e) {
            if (e instanceof FallbackStepProblemError) {
              progress.steps[index] = { ...progress.steps[index], retryAt: this.core.now() + FALLBACK_BACKOFF_MS, why: "error" };
              this.core.o.prefs.set(s.id, { fallbackProgress: progress });
              this.core.o.prefs.flush();
              continue;
            }
            throw e;
          }
        }
        // Same-session non-carry hop via provisionalStart (R1''', R6, G3).
        const nextBilling = this.core.adapter(harness).billing!.label(step.source);
        const confirmed = s.state.billing?.label === nextBilling.label && s.state.billing?.source === nextBilling.source;
        const lastKey = isCredentialSource(step.source) ? step.source : isCredentialSource(source) ? source : undefined;
        const model = hasSourceModels(step.source) ? sourceModel ?? settings.model : settings.model;
        const deployment = hasSourceModels(step.source) ? model : undefined;
        try {
          await this.provisionalStart({
            origin: s,
            target: s,
            hopId: reservation,
            chain,
            step,
            settings,
            sourceModel,
            resume: !s.fresh,
            send: sent && !acted ? { text: sent.text, attachments: sent.attachments, tether: sent.tether, releaseQueue: !sent.tether } : undefined,
            onCommitBeforeReplay: () => {
              let cost: SessionCost | undefined;
              if (isCredentialSource(step.source)) {
                try { cost = this.startCost(s); }
                catch { cost = { estimated: true, complete: false, reasons: ["unsaved"] }; this.core.log("Couldn't save this session's API cost coverage. Its total is unknown."); }
              }
              delete progress.steps[index]?.retryAt;
              delete progress.steps[index]?.why;
              const nextChain = { ...chain, active: index };
              const sourceSettings = model ? { model, deployment } : {};
              this.core.o.prefs.set(s.id, {
                fallbackChain: nextChain,
                fallbackProgress: progress,
                ...settings,
                ...sourceSettings,
                source: step.source,
                ...(lastKey ? { lastKey } : {}),
                nextBilling: undefined,
                nextDeployment: undefined,
                sourceSwitchFailed: undefined,
              });
              this.core.o.prefs.flush();
              s.setState({
                fallbackChain: nextChain,
                ...settings,
                ...(lastKey ? { lastKey } : {}),
                ...(isAccountSource(step.source) || isAccountSource(source) ? { plan: this.core.planFor(harness, step.source) } : {}),
                nextBilling: confirmed ? undefined : undefined,
                nextDeployment: undefined,
                sourceSwitchFailed: undefined,
                retryThrottled: isSubscriptionSource(step.source) ? undefined : this.core.o.prefs.get(s.id).retryThrottled === true,
                ...(model ? { model, modelResolved: undefined } : {}),
                ...(cost ? { cost } : {}),
              });
              this.core.touch(s);
              switchedSource = true;
              if (waking) this.core.o.bus.emit("fallbackStatus", { sessionId: s.id, status: "resumed" });
              if (!sent || acted) {
                sayRaw(hopNoticeText(index, label, verb, ` ${acted ? "The turn already acted. " : ""}Send a message to continue.`));
              } else {
                sayRaw(hopNoticeText(index, label, verb, " Resending your message."));
              }
            },
            onCommitAfterReplay: () => {
              if (this.fallingBack.get(s) === reservation) this.fallingBack.delete(s);
              releaseHopLock?.();
              releaseHopLock = undefined;
              if (!sent || acted) waiting();
            },
          });
          return true;
        } catch (e) {
          if (e instanceof FallbackStepProblemError) {
            progress.steps[index] = { ...progress.steps[index], retryAt: this.core.now() + FALLBACK_BACKOFF_MS, why: "error" };
            this.core.o.prefs.set(s.id, { fallbackProgress: progress });
            this.core.o.prefs.flush();
            continue;
          }
          throw e;
        }
      }
      if (returning) return false;
      this.fallbackExhausted(s, chain, progress);
      return true;
    } catch (e) {
      if (e instanceof FallbackHandoffTimeoutError) {
        sayRaw(e.message, "warning");
        if (!switchedSource) waiting(e.message);
      } else if (!(e instanceof SendCancelled)) {
        const error = redact((e as Error)?.message ?? String(e));
        say(error, "warning");
        if (!switchedSource) waiting(error);
      } else if (returning && s.retrySuppressed) {
        throw e;
      }
      return !returning || switchedSource;
    } finally {
      if (this.fallingBack.get(s) === reservation) this.fallingBack.delete(s);
      releaseHopLock?.();
      this.core.unpin(s);
    }
  }

  private planWindows(harness: HarnessId, model: string | undefined, plan: PlanUsage | undefined) {
    const pool = harness === "antigravity" && plan?.pools?.length
      ? plan.pools.find((p) => (p.id === "gemini") === /gemini/i.test(model ?? "")) : plan;
    return [pool?.fiveHour, pool?.week].filter((w) => w && (w.exhausted || w.percent >= 100));
  }

  /** The limit signal takes priority over a cached or separately polled usage report. */
  private async planReset(harness: HarnessId, s: Session, hit: { resetsAt?: number }) {
    const now = this.core.now();
    if (hit.resetsAt && hit.resetsAt > now && hit.resetsAt < 8.64e15) return hit.resetsAt;
    await this.core.refreshPlan(harness);
    const full = this.planWindows(harness, s.state.model, s.state.plan)
      .flatMap((w) => w?.resetsAt && w.resetsAt > now && w.resetsAt < 8.64e15 ? [w.resetsAt] : []);
    return full.length ? Math.max(...full) : undefined;
  }

  /**
   * What a harness starts with, from Tether or in its TUI: `chosen`, and for one Tether always tells
   * its model and effort (Adapter.unset) what the session's store says now, else `unset`. The session
   * shows it; a setting changed while this looked stands. The permission mode isn't filled in.
   */
  async startOpts(s: Session, observe = false): Promise<StartOpts> {
    const a = this.core.adapter(s.summary.harness);
    if (!a.unset) return this.chosen(s, observe);
    const opts = this.chosen(s, observe);
    const known = await a.defaults(s.summary.projectPath, s.summary.nativeId).catch(() => ({}) as StartOpts);
    const filled = { model: known.model ?? a.unset.model, effort: known.effort ?? a.unset.effort };
    s.setState({ ...(opts.model ? {} : { model: filled.model }), ...(opts.effort ? {} : { effort: filled.effort }) });
    return { ...filled, ...opts };
  }

  private checkCredential(s: Session) {
    if (this.revisionOf(s) !== s.credentialRevision) throw new Error(`${this.labelOf(s.summary.harness, this.sourceOf(s))} changed while the process was starting. Send again. Nothing was sent.`);
  }

  private async startDriver(s: Session, observe = false): Promise<Driver> {
    const a = this.core.adapter(s.summary.harness);
    // Live from here: its own events, not the store, update the transcript.
    s.unwatch?.();
    s.unwatch = undefined;
    const processSource = this.sourceOf(s);
    const subscriptionRevision = isSubscriptionSource(processSource) ? this.subscriptionRevisions.get(this.subscriptionScope(s.summary.harness, processSource)) : undefined;
    let processDriver: Driver | undefined;
    const sink = this.sink(s, processSource, () => processDriver?.accountIdentity, subscriptionRevision);
    let d: Driver;
    let opts: StartOpts;
    s.setState({ starting: s.fresh ? "start" : "resume" });
    try {
      opts = await this.startOpts(s, observe);
      if (observe) opts.observe = true;
      d = s.fresh ? await a.start(s.summary.projectPath, s.summary.nativeId, opts, sink) : await a.resume(s.summary.nativeId, s.summary.projectPath, opts, sink);
      processDriver = d;
    } catch (e: any) {
      const error = redact(e?.message ?? String(e));
      this.markSourceSwitchFailed(s);
      s.rebuilt = s.fresh;
      s.apply({ type: "msg", msg: notice(`Couldn't start ${HARNESS_LABELS[s.summary.harness]}: ${error}`, "error") });
      // Not live after all: stored, tailing its store if someone watches it, and evictable. A send
      // that was starting it ends its turn as failed (send's catch).
      // (A Back to Tether that failed: modeChanged pauses what waited for the terminal, with Resume.)
      this.setMode(s, "stored", { error, starting: undefined, ...(s.sending ? {} : { status: "idle" as const }) });
      if (!observe && !s.summary.parentSessionId && isSubscriptionSource(this.sourceOf(s)) && needsHarnessLogin(error)) {
        this.read.set(s.id, { failure: error });
      }
      this.core.tail(s);
      this.core.scheduleEvict(s);
      throw e;
    }
    s.driver = d;
    s.credentialRevision = subscriptionRevision ?? d.credentialRevision ?? opts.credential?.revision;
    // Waiting for a new thread to confirm it (carry), not this one.
    if (s.state.nextBilling && !this.core.o.prefs.get(s.id).nextSource) {
      this.core.o.prefs.set(s.id, { nextBilling: undefined, sourceSwitchFailed: undefined });
      s.setState({ nextBilling: undefined, sourceSwitchFailed: undefined });
    }
    d.onExit = (error) => {
      if (s.driver !== d) return;
      if (error) s.apply({ type: "msg", msg: notice(error, "error") });
      this.toStored(s, error);
    };
    this.setMode(s, "live", { error: undefined, continuedIn: undefined, starting: undefined });
    this.scheduleIdle(s);
    return d;
  }

  private async close(s: Session, retire = false) {
    const d = s.driver;
    if (!d) return;
    try {
      await d.close();
      if (retire) await d.retire?.();
    } catch {}
    if (s.driver === d) this.toStored(s);
  }

  private toStored(s: Session, error?: string) {
    s.driver = undefined;
    // Calls still running died with the process: failed, not spinning (as the store reads, notices.ts settleStopped).
    for (const m of s.transcript?.messages ?? [])
      for (const p of m.parts) if (p.type === "tool" && p.status === "running") s.apply({ type: "tool", msgId: m.id, toolId: p.id, patch: { status: "error" } });
    // Nobody waits on its requests any more (restored ones stay until answered or stopped).
    if (!this.stopping) this.desk.cancel((_r, chain, restored) => !restored && chain.at(-1) === s.id);
    clearTimeout(s.idleTimer);
    // Its subagents ran in its process: they're done too.
    for (const c of this.core.sessions.values()) if (c !== s && c.summary.parentSessionId && c.childRunning && this.rootOf(c) === s) this.childEnded(c);
    // Messages to its subagents that the main agent never passed on won't be now.
    for (const r of [...(this.relays.get(s.id) ?? [])]) this.relayDone(s.id, r, "failed");
    const before = s.state.status;
    // What's reported as running came from the driver: with it gone nothing can be stopped from here,
    // and joining again says what still runs.
    // Its watchers (background tasks, scheduled wakeups) ran in its process too.
    this.setMode(s, "stored", { turnSettings: undefined, watching: undefined, ...(error ? { error } : {}) });
    // A turn the process took down with it ended (failed when it says why): Home, the queue and
    // notifications hear, as for any turn end. Not at shutdown: the turn is cut off, not over.
    if (before !== "idle" && !this.stopping) {
      if (error) s.turnError = error;
      this.status(s, "idle");
    } else if (before !== "idle") s.setState({ status: "idle" });
    if (s.fresh) {
      // Never got a message: nothing of it is in any store.
      this.core.dropFresh(s);
      return;
    }
    this.core.tail(s);
    this.core.scheduleEvict(s);
  }

  setMode(s: Session, mode: LiveState["mode"], extra: Partial<LiveState> = {}) {
    const from = s.state.mode;
    // Out of the terminal: what said so ("Going back to Tether…") goes with the mode, in one step.
    s.setState({ mode, ...(from === "terminal" && mode !== "terminal" ? { terminal: undefined } : {}), ...extra });
    this.core.touch(s);
    if (from !== mode) this.core.o.bus.emit("modeChanged", { sessionId: s.id, from, to: mode });
  }

  private scheduleIdle(s: Session) {
    clearTimeout(s.idleTimer);
    s.idleTimer = setTimeout(() => {
      if (!s.driver) return;
      // Not while a turn, a subagent or a background task runs, nor while the harness's own TUI
      // shares the session (it would lose what Tether relays): look again later.
      if (s.state.status !== "idle" || s.driver.busy() || s.state.terminal || s.retry) return this.scheduleIdle(s);
      void this.close(s, true);
    }, this.idleMs);
    s.idleTimer.unref?.();
  }

  // ---------------- sinks ----------------

  /** Where a session's driver reports. */
  private sink(s: Session, processSource: BillingSource, getIdentity?: () => PlanIdentity | undefined, processSubRev?: string): Sink {
    const core = this.core;
    const bus = core.o.bus;
    return {
      cost: (report) => {
        if (!this.opts.costs || s.summary.parentSessionId) return;
        const billing = s.state.billing;
        if (billing?.kind !== "apiKey" && billing?.kind !== "provider") return;
        try {
          this.startCost(s);
          const cost = this.opts.costs.report(s.id, report.id, { usd: report.usd, estimated: report.estimated, complete: report.complete, reasons: report.reasons, notes: report.notes });
          s.setState({ cost });
        } catch { s.setState({ cost: { ...(s.state.cost?.usd !== undefined ? { usd: s.state.cost.usd } : {}), estimated: true, complete: false, reasons: ["unsaved"] } }); core.log("Couldn't persist this session's API cost. Its total is unknown."); }
        core.touch(s);
      },
      event: (e) => {
        e = redactValue(e);
        const out = s.apply(e);
        if (e.type === "tool" || (e.type === "msg" && e.msg.role === "assistant" && e.msg.parts.some((p) => p.type === "tool"))) s.turnActed = true;
        if (e.type === "msg") {
          // The turn failed: its turnEnded says why (Home and notifications show it), also when
          // the error repeats the row above it and adds none.
          const m = e.msg;
          const failed = m.error ?? (m.role === "notice" && m.level === "error" ? m.parts.map((p) => (p.type === "text" ? p.text : "")).join(" ") : undefined);
          if (failed && s.state.status !== "idle") s.turnError = failed;
        }
        if (out?.type === "msg") bus.emit("message", { sessionId: s.id, msg: out.msg });
        if (out?.type === "tool") {
          const tool = s.transcript?.get(e.type === "tool" ? e.msgId : "")?.parts.find((p) => p.type === "tool" && p.id === (e as any).toolId);
          if (tool?.type === "tool") bus.emit("toolCall", { sessionId: s.id, msgId: (e as any).msgId, tool });
        }
      },
      message: (id) => s.transcript?.get(id),
      mainFree: () => this.queue.later(s.id),
      mainChanged: () => this.countBackground(s),
      state: (patch) => {
        patch = redactValue(patch);
        if (s.retry?.phase === "waiting" && patch.status !== undefined && patch.status !== "idle") this.cancelRetrySession(s);
        if (this.opts.costs && (patch.billing?.kind === "apiKey" || patch.billing?.kind === "provider") && !s.summary.parentSessionId) {
          // What it was on until now: the billing this patch replaces.
          try { patch.cost = this.startCost(s, s.state.billing); }
          catch { patch.cost = { estimated: true, complete: false, reasons: ["unsaved"] }; }
        }
        const before = s.state.status;
        // A harness that keeps the session's settings itself (capabilities.persistent) reports them.
        // A setting made in Tether is kept (and sent at each start) until the harness reports it
        // applied: then it isn't sent again, where it could undo a change made elsewhere since.
        if (s.capabilities.persistent && !s.summary.parentSessionId) {
          const reported = { ...(patch.model ?? patch.modelResolved ? { model: patch.model ?? patch.modelResolved } : {}), ...(patch.effort ? { effort: patch.effort } : {}), ...(patch.permissionMode ? { permissionMode: patch.permissionMode } : {}) };
          s.confirmed = { ...s.confirmed, ...reported };
          // A change Tether had given up on (rolled back) that the harness applied after all.
          const late = (Object.keys(reported) as ("model" | "effort" | "permissionMode")[]).filter((k) => s.rolledBack?.[k] !== undefined && s.rolledBack[k] === reported[k]);
          if (late.length) {
            s.rolledBack = undefined;
            s.apply({ type: "msg", msg: notice(`${HARNESS_LABELS[s.summary.harness]} applied your earlier change to the ${late.map((k) => (k === "permissionMode" ? "mode" : k)).join(" and ")} after all.`) });
          }
          const p = core.o.prefs.get(s.id);
          const done = {
            ...(p.model !== undefined && (patch.model ?? patch.modelResolved) === p.model ? { model: undefined } : {}),
            ...(p.effort !== undefined && patch.effort === p.effort ? { effort: undefined } : {}),
            ...(p.permissionMode !== undefined && patch.permissionMode === p.permissionMode ? { permissionMode: undefined } : {}),
          };
          if (Object.keys(done).length) core.o.prefs.set(s.id, done);
        }
        const wasBackground = s.state.turnSettings?.who === "background";
        if (patch.permissionMode) this.notePlanEntry(s, patch.permissionMode);
        const changed = s.setState(patch);
        if (!changed) return;
        // Commands with more access than shown: a restart joins the session again to say so.
        const background = s.state.turnSettings?.who === "background";
        if (background && !wasBackground) core.o.prefs.set(s.id, { projectPath: s.summary.projectPath, running: true });
        else if (wasBackground && !background && s.state.status === "idle" && !s.driver?.busy()) core.o.prefs.set(s.id, { running: undefined });
        if (changed.status && changed.status !== before) this.statusChanged(s, before);
        else if (changed.model || changed.modelResolved || changed.permissionMode || changed.billing || "watching" in changed) core.touch(s);
        // The harness changed its own mode (a plan approved): kept, so the next start uses it.
        if (changed.permissionMode && !s.summary.parentSessionId && !s.capabilities.persistent) core.o.prefs.set(s.id, { projectPath: s.summary.projectPath, permissionMode: changed.permissionMode });
      },
      request: (r, signal) => this.desk.ask(s, redactValue(r), signal),
      // The account's, reported by what runs on its login: a key's process says nothing of the plan.
      plan: (p, reportIdentity) => {
        const source = processSource;
        if (!isSubscriptionSource(source)) return;
        // R5': drop late reports from a process started under an old login revision or mismatched identity.
        const currentSubRev = this.subscriptionRevisions.get(this.subscriptionScope(s.summary.harness, source));
        if (currentSubRev !== processSubRev) return;
        const identity = reportIdentity ?? getIdentity?.();
        if (s.summary.harness === "claude" && isAccountSource(source)) {
          const expected = this.opts.claudeAccounts?.read(source);
          if (!expected || (identity && !samePlanIdentity(identity, expected))) return;
        }
        core.notePlan(s.summary.harness, reportedAt(p), source, identity);
      },
      limitReached: (hit) => {
        s.limitHit = hit;
      },
      rateLimited: (hit) => { s.rateHit = hit; },
      nativeId: (id) => {
        if (id !== s.summary.nativeId) core.log(`${s.id}: the harness calls it ${id}`);
      },
      subagent: (start) => this.child(s, start),
      relayed: (nativeId) => this.relayed(s.id, nativeId),
      ended: () => {},
    };
  }

  /** Saves which subagents run now under a main session, for the next start after a restart. */
  private noteSubagents(root: Session) {
    if (root.summary.parentSessionId || root.capabilities.persistent) return;
    const list = [...this.core.sessions.values()]
      .filter((c) => c !== root && c.childRunning && this.rootOf(c) === root)
      .map((c) => ({ title: c.summary.title || "Subagent", ...(c.summary.agentType ? { agentType: c.summary.agentType } : {}) }));
    const had = this.core.o.prefs.get(root.id).liveSubagents;
    if (!list.length && !had) return;
    this.core.o.prefs.set(root.id, { liveSubagents: list.length ? list : undefined });
  }

  /** How many subagents still run with the main agent free (SPEC §6a): running ones only, counted afresh. */
  private countBackground(s: Session) {
    if (s.summary.parentSessionId) return;
    const free = s.state.status === "idle" || !!s.driver?.onlyBackground?.();
    let n = 0;
    if (free) for (const c of this.core.sessions.values()) if (c !== s && c.childRunning && this.rootOf(c) === s) n++;
    if (n === (s.state.backgroundSubagents ?? 0)) return;
    s.setState({ backgroundSubagents: n || undefined });
    this.core.touch(s);
  }

  private statusChanged(s: Session, before: LiveState["status"]) {
    this.countBackground(s);
    const bus = this.core.o.bus;
    const now = s.state.status;
    // Kept in runner.json, so a turn cut off by a restart is reported when the session reopens.
    // Not cleared while its subagents still run (busy): a restart must find them again (persistent harnesses rejoin).
    if (!s.summary.parentSessionId && s.state.mode !== "terminal" && (now === "idle") !== (before === "idle") && !(now === "idle" && s.driver?.busy()))
    {
      this.core.o.prefs.set(s.id, { projectPath: s.summary.projectPath, running: now === "idle" ? undefined : true, ...(now === "idle" ? { continues: undefined } : {}) });
      // At once, not after the usual short delay: a crash right after a turn ends mustn't look mid-turn.
      this.core.o.prefs.flush();
    }
    if (now === "running" && before !== "running") bus.emit("turnStarted", { sessionId: s.id, from: before });
    if (now === "idle") {
      if (s.deferTurnEnd) {
        s.deferredTurnEnds.push(() => this.handleIdle(s));
        this.core.touch(s, { updatedAt: this.core.now() });
        return;
      }
      this.handleIdle(s);
    }
    this.core.touch(s, { updatedAt: this.core.now() });
  }

  private handleIdle(s: Session) {
    const bus = this.core.o.bus;
    // The next turn runs with the settings as shown; not while its subagents still run on the old
    // ones. A harness that reports what still runs (persistent) keeps this itself.
    if (s.state.turnSettings && !s.driver?.busy() && !s.capabilities.persistent) s.setState({ turnSettings: undefined });
    const stopped = s.stopped;
    s.stopped = false;
    const { limitHit, lastSend, turnActed } = s;
    const rateHit = s.rateHit;
    const error = s.turnError ?? s.state.error;
    const provisional = !!s.sending && s.retry?.phase === "sending" && !lastSend;
    const retry = !provisional && rateHit && !stopped && this.retries.recover(s, rateHit, lastSend, error ?? "Rate limited.");
    const recovering = provisional || retry === true;
    if (rateHit && !recovering && !stopped && lastSend) {
      const why = turnActed ? "Tools ran or a message was steered in this turn, so it wasn't resent automatically. Send a message to continue." : s.retry ? "Automatic rate limit retries stopped after reaching the attempt or time limit. Send a message to continue." : undefined;
      if (why) s.apply({ type: "msg", msg: notice(why, "warning") });
    }
    s.rateHit = undefined;
    if (!recovering && s.retry && (!s.sending || lastSend)) this.retries.clear(s);
    s.limitHit = undefined;
    // A process start can report idle before the turn: the send isn't over.
    if (limitHit || !s.sending) s.lastSend = undefined;
    const fallbackPending = !stopped && (limitHit || retry === "exhausted") && this.canAdvanceFallback(s, limitHit);
    bus.emit("turnEnded", { sessionId: s.id, error, ...(stopped ? { stopped } : {}), ...(recovering ? { recovering } : {}), ...(fallbackPending ? { fallbackPending: true } : {}) });
    s.turnError = undefined;
    if (fallbackPending) void this.advanceFallback(s, limitHit, lastSend, turnActed, false, false, error);
    this.scheduleIdle(s);
    void this.refreshTitle(s);
  }

  /** The harness names sessions itself (Claude writes a title after the first turn). */
  private async refreshTitle(s: Session) {
    if (s.summary.parentSessionId) return;
    const info = await this.core.adapter(s.summary.harness).sessionInfo(s.summary.nativeId, s.summary.projectPath).catch(() => undefined);
    if (info?.title && info.title !== s.summary.title) this.core.touch(s, { title: info.title });
  }

  /** A subagent started: it becomes a session of its own, live while it runs (SPEC §6a). */
  private child(parent: Session, start: SubagentStart): Sink {
    const id = makeId(parent.summary.harness, start.nativeId);
    let c = this.core.sessions.get(id);
    const now = this.core.now();
    if (!c) {
      c = new Session(
        {
          id,
          harness: parent.summary.harness,
          nativeId: start.nativeId,
          projectPath: parent.summary.projectPath,
          title: start.title || "Subagent",
          mode: "live",
          status: "running",
          updatedAt: now,
          parentSessionId: parent.id,
          parentToolId: start.parentToolId,
          ...(start.agentType ? { agentType: start.agentType } : {}),
        },
        { mode: "live", status: "running", requests: [], queue: [], model: parent.state.model, permissionMode: parent.state.permissionMode },
        parent.capabilities,
        this.core.out,
      );
      this.core.add(c);
    }
    const first: Msg[] = start.prompt ? [{ id: `${start.nativeId}:prompt`, role: "user", ts: now, parts: [{ type: "text", text: start.prompt }] }] : [];
    if (!c.transcript || c.transcript.length === 0) c.transcript = new Transcript(first);
    c.childRunning = true;
    // Kept here: a middle subagent can end, and leave memory, before one it spawned.
    c.rootId = parent.rootId ?? parent.id;
    c.setState({ mode: "live", status: "running", billing: parent.state.billing });
    this.core.touch(c, { updatedAt: now });
    this.countBackground(this.rootOf(c) ?? parent);
    this.noteSubagents(this.rootOf(c) ?? parent);
    // The parent's tool card links to it.
    const at = parent.transcript?.findTool(start.parentToolId);
    if (at) parent.apply({ type: "tool", msgId: at.msg.id, toolId: start.parentToolId, patch: { childSessionId: id } });
    const child = c;
    const sink = this.sink(child, this.sourceOf(parent));
    return {
      ...sink,
      // A subagent's status follows its task, not turns.
      state: (patch) => {
        const { status: _, ...rest } = patch;
        if (Object.keys(rest).length) child.setState(rest);
      },
      ended: () => this.childEnded(child),
    };
  }

  private childEnded(c: Session) {
    if (!c.childRunning) return;
    c.childRunning = false;
    if (!this.stopping) this.desk.cancel((r, _chain, restored) => !restored && r.sessionId === c.id);
    c.setState({ mode: "stored", status: "idle" });
    this.core.touch(c, { updatedAt: this.core.now() });
    this.core.o.bus.emit("turnEnded", { sessionId: c.id });
    this.core.scheduleEvict(c);
    // The last subagent of a finished turn: nothing runs on the turn's settings any more.
    const parent = this.rootOf(c);
    if (parent && parent !== c) this.countBackground(parent);
    // Not while the runner stops: the list is what the next start tells the agent it lost.
    if (parent && parent !== c && !this.stopping) this.noteSubagents(parent);
    // Only for a subagent that ended by itself: one ended because the runner stops (or the process
    // went away) may well go on in a harness that keeps it (persistent), and must be found again.
    if (parent && parent !== c && parent.driver && !this.stopping && parent.state.status === "idle" && !parent.driver.busy()) {
      // A harness that reports what still runs (persistent) says so itself.
      if (parent.state.turnSettings && !parent.capabilities.persistent) parent.setState({ turnSettings: undefined });
      this.core.o.prefs.set(parent.id, { running: undefined });
    }
  }
}

/** A promise that fails with `what` when it takes longer than `ms`. */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<never>((_, rej) => (t = setTimeout(() => rej(new Error(what)), ms)))]).finally(() => clearTimeout(t));
}

/** A folder's real path (symlinks resolved), or the path itself when it isn't there. */
function realOf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** One folder is the other or inside it, either way round. */
function overlaps(a: string, b: string): boolean {
  const under = (x: string, y: string) => x === y || x.startsWith(y.endsWith("/") ? y : `${y}/`);
  return under(a, b) || under(b, a);
}
