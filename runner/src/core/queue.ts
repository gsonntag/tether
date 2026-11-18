// The message queue (SPEC §9): messages waiting to go out after the running turn, in order, one per
// turn. It is held on the runner (in runner.json, so it survives a restart) and every device sees
// and changes the same one: edit, reorder, cancel.
//
// The queue waits (held) while the harness's TUI drives a handed-off session (released by Back to
// Tether), after Stop, after a failed turn, and after a turn cut off by a runner restart. Sending a
// message yourself, or Resume, releases it; nothing is ever sent on your behalf while it is held.
// During the quiet wait after a restart (live.ts autoContinue) it stays held whatever you do: the
// wait's end releases it.
// A transient rate limit recovery blocks draining until the original message recovers or fails.
//
// Scheduled messages (`at`, SPEC §9 Scheduled sends) wait in the same queue for their time, apart
// from the rest: holds are about the unscheduled messages, and a due one goes next whatever holds
// those (it's a message you sent for then), but never while the TUI drives, during the quiet wait
// after a restart, behind a rate limit retry or the running turn. One that came due more than a day
// ago (the runner was off), or whose send failed, waits for you instead (`held`).

import { randomUUID } from "node:crypto";
import type { Attachment } from "../../../shared/attachments";
import { formatSize } from "../../../shared/attachments";
import { jsonBytes, MESSAGE_TEXT_MAX, QUEUE_BYTES_MAX, QUEUE_MAX, queuedBytes, stripControls } from "../../../shared/limits";

/** Bytes a queue takes in a frame (JSON escapes included; a `!` command's command too). */
export const queueBytes = (q: QueuedMessage[]) => q.reduce((n, m) => n + queuedBytes(m), 0);
import type { LiveState, Msg, QueuedMessage } from "../../../shared/transcript";
import { badScheduleTime, isScheduled, nextScheduled, SCHEDULE_LATE_MAX_MS, SCHEDULE_LATE_NOTE_MS, scheduled, unscheduled } from "../../../shared/schedule";
import { Scheduler } from "./scheduler";
import type { Session } from "./session";
import type { SessionCore } from "./sessions";

export type HeldBy = NonNullable<LiveState["queueHeldBy"]>;

export interface QueueHost {
  /** sends a waiting message as the person would */
  send(sessionId: string, text: string, attachments: Attachment[]): Promise<void>;
  /** the session is in the quiet wait after a restart: nothing may go out yet */
  waiting(sessionId: string): boolean;
}

export class MessageQueue {
  /**
   * A waiting message left the queue: it went out to the harness, or was cancelled (a `!` command's
   * card says so, core/shellRuns.ts).
   */
  gone?: (s: Session, m: QueuedMessage, how: "sent" | "cancelled") => void;
  /** sessions whose next message is going out */
  private draining = new Set<string>();
  /** the message going out, by session: still in runner.json until the harness has it */
  private going = new Map<string, QueuedMessage>();
  /** messages cancelled while going out: dropped if they don't get there */
  private cancelledGoing = new Set<string>();
  /** how often each session's queue was released (you sent something): a Stop older than that doesn't hold */
  private releases = new Map<string, number>();
  /** sessions whose turn was running when the runner last stopped (read before anything loads them) */
  private cutOff: Set<string>;
  /** the one timer for every scheduled message */
  readonly scheduler: Scheduler;

  constructor(
    private core: SessionCore,
    private host: QueueHost,
  ) {
    this.cutOff = new Set(core.o.prefs.running());
    this.scheduler = new Scheduler({ now: () => core.now(), next: () => this.nextDue(), fire: () => this.due() });
    const bus = core.o.bus;
    bus.on("turnEnded", ({ sessionId, error, stopped, recovering }) => {
      const s = core.sessions.get(sessionId);
      if (!s || s.summary.parentSessionId || !s.state.queue.length || recovering) return;
      // A failed turn holds what waits: the next message would most likely fail the same way.
      // (A scheduled message due meanwhile still goes: holds are about the rest.)
      if (error && !stopped) this.hold(s, "failed");
      this.later(sessionId);
    });
    // Back to Tether: what waited for the terminal goes on (SPEC §8).
    bus.on("modeChanged", ({ sessionId, from, to }) => {
      const s = core.sessions.get(sessionId);
      if (!s || from !== "terminal" || !s.state.queue.length) return;
      if (to === "live") this.later(sessionId);
      if (s.state.queueHeldBy !== "terminal") return;
      if (to === "live") {
        this.release(s);
        this.later(sessionId);
      } else this.save(s, s.state.queue, "stopped"); // the TUI exited by itself: it waits for you to send
    });
  }

  /** This session's cut-off turn is being continued (live.ts autoContinue): its queue isn't held. */
  notCutOff(id: string) {
    this.cutOff.delete(id);
  }

  /** What a session opened from runner.json starts with. */
  static saved(prefs: { queue?: QueuedMessage[]; queueHeldBy?: HeldBy }): Partial<LiveState> {
    const queue = Array.isArray(prefs.queue) ? prefs.queue : [];
    return { queue, ...(unscheduled(queue).length && prefs.queueHeldBy ? { queueHeld: true, queueHeldBy: prefs.queueHeldBy } : {}) };
  }

  // ---------------- ops ----------------

  async add(id: string, text: string, attachments: Attachment[], o: { shell?: QueuedMessage["shell"]; at?: number } = {}): Promise<{ id: string }> {
    const s = await this.root(id);
    const later = o.at !== undefined;
    if (later) {
      const bad = badScheduleTime(o.at, this.core.now());
      if (bad) throw new Error(bad);
    }
    // Control characters (a command's raw output) never wait: they'd take 6 bytes each in a frame.
    text = stripControls(text);
    if (!text.trim() && !attachments.length) throw new Error("Type a message first.");
    if (text.length > MESSAGE_TEXT_MAX) throw new Error("That message is too long.");
    // The message going out still counts (it comes back if it doesn't get there).
    const all = this.withGoing(s);
    if (all.length >= QUEUE_MAX) throw new Error(`At most ${QUEUE_MAX} messages can wait. Send or cancel some first.`);
    this.roomFor(all, text, o.shell ? jsonBytes(o.shell.command) : 0);
    const m: QueuedMessage = { id: randomUUID(), text, ...(attachments.length ? { attachments } : {}), ...(o.shell ? { shell: o.shell } : {}), queuedAt: this.core.now(), ...(later ? { at: Math.round(o.at!) } : {}) };
    // Queued while the TUI drives: it waits for Back to Tether. During the quiet wait: for its end.
    // (A scheduled message holds nothing: it waits for its time.)
    const by = s.state.queueHeld || later ? undefined : s.state.mode === "terminal" ? "terminal" : this.host.waiting(s.id) ? "restart" : undefined;
    this.save(s, [...s.state.queue, m], by);
    this.later(s.id);
    return { id: m.id };
  }

  async edit(id: string, msgId: string, text: string) {
    const s = await this.root(id);
    text = stripControls(text);
    if (text.length > MESSAGE_TEXT_MAX) throw new Error("That message is too long.");
    const m = this.find(s, msgId);
    if (m.shell) throw new Error("A command's output can't be edited. Cancel it instead.");
    if (!text.trim() && !m.attachments?.length) return this.cancel(id, msgId);
    this.roomFor(this.withGoing(s).filter((x) => x.id !== msgId), text);
    this.save(s, s.state.queue.map((x) => (x.id === msgId ? { ...x, text } : x)));
  }

  async cancel(id: string, msgId: string) {
    const s = await this.root(id);
    // The message going out right now: cancelled if it doesn't get there (it's never put back), and
    // out of runner.json now. Once the harness has it, it can't be taken back.
    const going = this.going.get(s.id);
    if (going?.id === msgId) {
      this.cancelledGoing.add(msgId);
      this.persist(s);
      return;
    }
    const m = s.state.queue.find((x) => x.id === msgId);
    this.save(s, s.state.queue.filter((x) => x.id !== msgId));
    if (m) this.left(s, m, "cancelled");
  }

  /** Moves among the unscheduled messages (`to`: 0 goes next); a scheduled one goes at its time. */
  async move(id: string, msgId: string, to: number) {
    const s = await this.root(id);
    const m = this.find(s, msgId);
    if (isScheduled(m)) throw new Error("A scheduled message goes at its time. Change its time instead.");
    const rest = unscheduled(s.state.queue).filter((x) => x.id !== msgId);
    const at = Math.max(0, Math.min(rest.length, Math.floor(Number(to) || 0)));
    rest.splice(at, 0, m);
    this.save(s, [...rest, ...s.state.queue.filter(isScheduled)]);
  }

  /**
   * A waiting message's time (SPEC §9 Scheduled sends): `at` schedules it, or gives it a new time;
   * null sends it now (next, as soon as the session is free, whatever holds the rest).
   */
  async schedule(id: string, msgId: string, at: number | null) {
    const s = await this.root(id);
    const m = this.find(s, msgId);
    const now = this.core.now();
    if (at !== null) {
      const bad = badScheduleTime(at, now);
      if (bad) throw new Error(bad);
    }
    const { held: _, ...rest } = m;
    const next: QueuedMessage = { ...rest, at: at === null ? now : Math.round(at) };
    this.save(s, s.state.queue.map((x) => (x.id === msgId ? next : x)));
    this.later(s.id);
  }

  /** Resume: the queue goes on (now, when the session is idle). */
  async resume(id: string) {
    const s = await this.root(id);
    if (s.state.mode === "terminal") throw new Error("The terminal is driving. Go back to Tether to send what waits.");
    if (this.host.waiting(s.id)) throw new Error("Claude Code from before the restart may still be working. What waits goes on once it's finished.");
    if (s.retry) throw new Error("A rate limit retry is waiting. Cancel it or wait for it to finish.");
    this.release(s);
    this.later(s.id);
  }

  // ---------------- holding ----------------

  /** The queue waits (Stop, a handoff, a failed turn, a restart). */
  hold(s: Session, by: HeldBy, o: { over?: boolean } = {}) {
    if (!unscheduled(s.state.queue).length || (s.state.queueHeld && s.state.queueHeldBy === by)) return;
    // A queue you paused stays paused through a terminal round trip (Back to Tether releases only
    // what the terminal held); `over`: the hold being replaced is the handoff's own Stop.
    if (by === "terminal" && s.state.queueHeld && !o.over) return;
    this.save(s, s.state.queue, by);
  }

  /** You sent something yourself: a queue held after Stop or a failure goes on after it. */
  release(s: Session) {
    this.releases.set(s.id, (this.releases.get(s.id) ?? 0) + 1);
    if (!s.state.queueHeld && !s.state.queueHeldBy) return;
    this.save(s, s.state.queue, null);
  }

  /** At start: saved queues show again; one whose turn a restart cut off waits for you. */
  async restore() {
    for (const id of this.core.o.prefs.queued()) {
      const s = await this.core.open(id).catch((e) => {
        // Not known (yet): a new session whose first start a restart cut short isn't in any store.
        // Its queue stays, held, for when it is; only a long-forgotten one goes.
        const p = this.core.o.prefs.get(id);
        if (/isn't a session id|can't drive/i.test(String(e?.message)) || this.core.now() - (p.at ?? 0) > 30 * 24 * 60 * 60 * 1000) this.core.o.prefs.set(id, { queue: undefined, queueHeldBy: undefined });
        else if (p.queueHeldBy !== "restart") {
          this.core.o.prefs.set(id, { queueHeldBy: "restart" });
          this.core.o.prefs.flush();
        }
        this.core.log(`${id}: its queue waits; the session isn't known yet (${e?.message ?? e})`);
        return undefined;
      });
      if (!s) continue;
      // Held for a terminal that is gone (it exited while the runner was away, or the runner stopped
      // during Back to Tether): nothing would ever release that hold, so it waits for Resume.
      if (s.state.queueHeldBy === "terminal" && s.state.mode !== "terminal") this.save(s, s.state.queue, "restart");
      if (this.cutOff.has(id) && !s.capabilities.persistent) this.hold(s, "restart");
      this.core.touch(s);
      this.later(id);
    }
    // Scheduled messages whose time passed while the runner was off: sent now, or held when long past.
    this.scheduler.tick();
  }

  // ---------------- scheduled ----------------

  /** The soonest scheduled time in any session (one due but not gone yet: earlier than now). */
  private nextDue(): number | undefined {
    let next: number | undefined;
    for (const s of this.core.sessions.values()) {
      const at = nextScheduled(s.state.queue);
      if (at !== undefined && (next === undefined || at < next)) next = at;
    }
    return next;
  }

  /** The scheduler's tick: what's due goes (each session in turn); what's long past waits for you. */
  private due() {
    const now = this.core.now();
    for (const s of this.core.sessions.values()) {
      if (!s.state.queue.some((m) => isScheduled(m) && !m.held && m.at! <= now)) continue;
      const late = (m: QueuedMessage) => isScheduled(m) && !m.held && now - m.at! > SCHEDULE_LATE_MAX_MS && this.going.get(s.id)?.id !== m.id;
      if (s.state.queue.some(late)) {
        this.save(s, s.state.queue.map((m) => (late(m) ? { ...m, held: "late" as const } : m)));
        this.core.log(`${s.id}: a scheduled message is more than a day late; it waits for the person`);
      }
      this.later(s.id);
    }
  }

  /** What goes next: a scheduled message that's due (whatever holds the rest), else the queue's next. */
  private next(s: Session): QueuedMessage | undefined {
    const now = this.core.now();
    const due = scheduled(s.state.queue).find((m) => !m.held && m.at! <= now);
    if (due) return due;
    return s.state.queueHeld ? undefined : unscheduled(s.state.queue)[0];
  }

  /** stops the timer (the runner stops) */
  stop() {
    this.scheduler.halt();
  }

  // ---------------- sending ----------------

  /** Sends the next message soon, if the session is free (after whatever else a turn end does). */
  later(id: string) {
    setTimeout(() => void this.drain(id), 50);
  }

  private async drain(id: string) {
    const s = this.core.sessions.get(id);
    if (!s || this.draining.has(id) || !s.state.queue.length || s.retry || this.core.o.prefs.get(id).retry) return;
    // Background work doesn't hold it: this waits for the turn, and the main agent's is over.
    const busy = s.state.status !== "idle" && !s.driver?.onlyBackground?.();
    if (s.state.mode === "terminal" || busy || s.sending || s.starting || this.host.waiting(id)) return;
    const next = this.next(s);
    if (!next) return;
    const rest = s.state.queue.filter((m) => m !== next);
    const timed = isScheduled(next);
    this.draining.add(id);
    // Out of the shown queue at once (every device sees it go), but out of runner.json only once
    // the harness has it: a runner killed in between still has it waiting.
    this.going.set(id, next!);
    const released = this.releases.get(id) ?? 0;
    this.save(s, rest, undefined, { persist: false });
    try {
      await this.host.send(id, next!.text, next!.attachments ?? []);
      this.going.delete(id);
      this.cancelledGoing.delete(next!.id);
      this.persist(s);
      // Sent late (the runner was off, or the session busy, at its time): the chat says when it was for.
      const now = this.core.now();
      if (timed && now - next.at! >= SCHEDULE_LATE_NOTE_MS)
        s.apply({ type: "msg", msg: { id: `n-late-${next.id}`, role: "notice", level: "info", ts: now, scheduledFor: next.at!, parts: [{ type: "text", text: "Scheduled message sent late." }] } satisfies Msg });
      this.left(s, next!, "sent");
    } catch (e: any) {
      this.going.delete(id);
      const cancelled = this.cancelledGoing.delete(next!.id);
      // Back at the front (unless you cancelled it meanwhile). Stopped while the harness started:
      // held, as after any Stop, unless you sent something since (Stop and send now): then it
      // follows that message. A turn that started meanwhile just means later; anything else holds
      // the queue: whatever stopped it would stop the rest too.
      const busy = s.state.status !== "idle" || !!s.sending;
      const stoppedHere = e?.name === "SendCancelled" || e?.message === "Stopped before it went out.";
      // A handoff got there first: it waits for Back to Tether.
      const mode: string = s.state.mode;
      const how: HeldBy | undefined = mode === "terminal" ? "terminal" : stoppedHere ? ((this.releases.get(id) ?? 0) !== released ? undefined : "stopped") : busy ? undefined : "failed";
      if (cancelled) {
        this.persist(s);
        this.left(s, next!, "cancelled");
      } else if (timed) {
        // Back as it was, to go once the session is free (the turn, the terminal); anything else
        // waits for you, and holds nothing else.
        const held = how === "stopped" ? "stopped" : how === "failed" ? "failed" : undefined;
        this.save(s, [held ? { ...next, held } : next, ...s.state.queue]);
      } else this.save(s, [next!, ...s.state.queue], how);
      if (how === undefined) this.later(id);
    } finally {
      this.going.delete(id);
      this.draining.delete(id);
    }
  }

  // ---------------- state ----------------

  private async root(id: string): Promise<Session> {
    const s = await this.core.open(id);
    if (s.summary.parentSessionId) throw new Error("A subagent has no queue. Message the main session instead.");
    return s;
  }

  /**
   * A message left the queue for good: every device hears how (`queueGone`), so an edit that missed
   * it can say whether it went out or was cancelled; then the `gone` hook (a `!` card).
   */
  private left(s: Session, m: QueuedMessage, how: "sent" | "cancelled") {
    const recent = [...(s.state.queueGone ?? []).filter((g) => g.id !== m.id), { id: m.id, how }].slice(-10);
    s.setState({ queueGone: recent });
    this.gone?.(s, m, how);
    this.core.o.bus.emit("queueGone", { sessionId: s.id, msgId: m.id, how, text: m.text });
  }

  /** The queue with the message going out (until the harness has it). */
  private withGoing(s: Session): QueuedMessage[] {
    const g = this.going.get(s.id);
    return g && !this.cancelledGoing.has(g.id) ? [g, ...s.state.queue] : s.state.queue;
  }

  /** Refuses text that would take the queue past QUEUE_BYTES_MAX (its state must always travel). */
  private roomFor(others: QueuedMessage[], text: string, extra = 0) {
    if (queueBytes(others) + jsonBytes(text) + extra > QUEUE_BYTES_MAX)
      throw new Error(`The waiting messages can be at most ${formatSize(QUEUE_BYTES_MAX)} of text together. Send or cancel some first, or attach long text as a file.`);
  }

  private find(s: Session, msgId: string): QueuedMessage {
    const m = s.state.queue.find((x) => x.id === msgId);
    if (!m) throw new Error("That message isn't waiting any more.");
    return m;
  }

  /**
   * The queue (and its hold: undefined keeps it, null clears it) into state, the row and
   * runner.json, written at once (`persist: false`: state only, for a message going out).
   */
  private save(s: Session, queue: QueuedMessage[], by?: HeldBy | null, o: { persist?: boolean } = {}) {
    const heldBy = by === undefined ? s.state.queueHeldBy : (by ?? undefined);
    const held = !!heldBy && unscheduled(queue).length > 0;
    s.setState({ queue, queueHeld: held || undefined, queueHeldBy: held ? heldBy : undefined });
    if (o.persist !== false) this.persist(s);
    this.core.touch(s);
    this.scheduler.arm();
  }

  /** The session's queue as its state has it, into runner.json now. */
  private persist(s: Session) {
    // A message going out stays saved (at the front) until the harness has it, whatever else changes.
    const going = this.going.get(s.id);
    const q = going && !this.cancelledGoing.has(going.id) ? [going, ...s.state.queue] : s.state.queue;
    this.core.o.prefs.set(s.id, { projectPath: s.summary.projectPath, queue: q.length ? q : undefined, queueHeldBy: unscheduled(s.state.queue).length ? s.state.queueHeldBy : undefined });
    this.core.o.prefs.flush();
  }
}
