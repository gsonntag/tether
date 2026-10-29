// The message queue (SPEC §9): messages waiting to go out after the running turn, in order, one per
// turn. It is held on the runner (in runner.json, so it survives a restart) and every device sees
// and changes the same one: edit, reorder, cancel.
//
// The queue waits (held) while the harness's TUI drives a handed-off session (released by Back to
// Tether), after Stop, after a failed turn, and after a turn cut off by a runner restart. Sending a
// message yourself, or Resume, releases it; nothing is ever sent on your behalf while it is held.

import { randomUUID } from "node:crypto";
import type { Attachment } from "../../../shared/attachments";
import { MESSAGE_TEXT_MAX, QUEUE_MAX } from "../../../shared/limits";
import type { LiveState, QueuedMessage } from "../../../shared/transcript";
import type { Session } from "./session";
import type { SessionCore } from "./sessions";

export type HeldBy = NonNullable<LiveState["queueHeldBy"]>;

export interface QueueHost {
  /** sends a waiting message as the person would */
  send(sessionId: string, text: string, attachments: Attachment[]): Promise<void>;
}

export class MessageQueue {
  /** sessions whose next message is going out */
  private draining = new Set<string>();

  constructor(
    private core: SessionCore,
    private host: QueueHost,
  ) {
    const bus = core.o.bus;
    bus.on("turnEnded", ({ sessionId, error, stopped }) => {
      const s = core.sessions.get(sessionId);
      if (!s || s.summary.parentSessionId || !s.state.queue.length) return;
      // A failed turn holds what waits: the next message would most likely fail the same way.
      if (error && !stopped) return this.hold(s, "failed");
      this.later(sessionId);
    });
    // Back to Tether: what waited for the terminal goes on (SPEC §8).
    bus.on("modeChanged", ({ sessionId, from, to }) => {
      const s = core.sessions.get(sessionId);
      if (!s || from !== "terminal" || !s.state.queue.length) return;
      if (s.state.queueHeldBy !== "terminal") return;
      if (to === "live") {
        this.release(s);
        this.later(sessionId);
      } else this.save(s, s.state.queue, "stopped"); // the TUI exited by itself: it waits for you to send
    });
  }

  /** What a session opened from runner.json starts with. */
  static saved(prefs: { queue?: QueuedMessage[]; queueHeldBy?: HeldBy }): Partial<LiveState> {
    const queue = Array.isArray(prefs.queue) ? prefs.queue : [];
    return { queue, ...(queue.length && prefs.queueHeldBy ? { queueHeld: true, queueHeldBy: prefs.queueHeldBy } : {}) };
  }

  // ---------------- ops ----------------

  async add(id: string, text: string, attachments: Attachment[]): Promise<{ id: string }> {
    const s = await this.root(id);
    if (!text.trim() && !attachments.length) throw new Error("Type a message first.");
    if (text.length > MESSAGE_TEXT_MAX) throw new Error("That message is too long.");
    if (s.state.queue.length >= QUEUE_MAX) throw new Error(`At most ${QUEUE_MAX} messages can wait. Send or cancel some first.`);
    const m: QueuedMessage = { id: randomUUID(), text, ...(attachments.length ? { attachments } : {}), queuedAt: this.core.now() };
    // Queued while the TUI drives: it waits for Back to Tether.
    this.save(s, [...s.state.queue, m], !s.state.queueHeld && s.state.mode === "terminal" ? "terminal" : undefined);
    this.later(s.id);
    return { id: m.id };
  }

  async edit(id: string, msgId: string, text: string) {
    const s = await this.root(id);
    if (text.length > MESSAGE_TEXT_MAX) throw new Error("That message is too long.");
    const m = this.find(s, msgId);
    if (!text.trim() && !m.attachments?.length) return this.cancel(id, msgId);
    this.save(s, s.state.queue.map((x) => (x.id === msgId ? { ...x, text } : x)));
  }

  async cancel(id: string, msgId: string) {
    const s = await this.root(id);
    this.save(s, s.state.queue.filter((x) => x.id !== msgId));
  }

  async move(id: string, msgId: string, to: number) {
    const s = await this.root(id);
    const m = this.find(s, msgId);
    const rest = s.state.queue.filter((x) => x.id !== msgId);
    const at = Math.max(0, Math.min(rest.length, Math.floor(Number(to) || 0)));
    rest.splice(at, 0, m);
    this.save(s, rest);
  }

  /** Resume: the queue goes on (now, when the session is idle). */
  async resume(id: string) {
    const s = await this.root(id);
    if (s.state.mode === "terminal") throw new Error("The terminal is driving. Go back to Tether to send what waits.");
    this.release(s);
    this.later(s.id);
  }

  // ---------------- holding ----------------

  /** The queue waits (Stop, a handoff, a failed turn, a restart). */
  hold(s: Session, by: HeldBy) {
    if (!s.state.queue.length || (s.state.queueHeld && s.state.queueHeldBy === by)) return;
    this.save(s, s.state.queue, by);
  }

  /** You sent something yourself: a queue held after Stop or a failure goes on after it. */
  release(s: Session) {
    if (!s.state.queueHeld && !s.state.queueHeldBy) return;
    this.save(s, s.state.queue, null);
  }

  /** At start: saved queues show again; one whose turn a restart cut off waits for you. */
  async restore() {
    for (const id of this.core.o.prefs.queued()) {
      const s = await this.core.open(id).catch(() => undefined);
      if (!s) continue;
      if (this.core.o.prefs.get(id).running && !s.capabilities.persistent) this.hold(s, "restart");
      this.core.touch(s);
      this.later(id);
    }
  }

  // ---------------- sending ----------------

  /** Sends the next message soon, if the session is free (after whatever else a turn end does). */
  later(id: string) {
    setTimeout(() => void this.drain(id), 50);
  }

  private async drain(id: string) {
    const s = this.core.sessions.get(id);
    if (!s || this.draining.has(id) || !s.state.queue.length || s.state.queueHeld) return;
    if (s.state.mode === "terminal" || s.state.status !== "idle" || s.sending || s.starting) return;
    const [next, ...rest] = s.state.queue;
    this.draining.add(id);
    // Out of the queue first: a second device sees it go, and a failure puts it back.
    this.save(s, rest);
    try {
      await this.host.send(id, next!.text, next!.attachments ?? []);
    } catch (e: any) {
      // Back at the front, and the queue waits: whatever stopped it would stop the rest too.
      this.save(s, [next!, ...s.state.queue], "failed");
      this.core.log(`${id}: a queued message didn't go out: ${e?.message ?? e}`);
    } finally {
      this.draining.delete(id);
    }
  }

  // ---------------- state ----------------

  private async root(id: string): Promise<Session> {
    const s = await this.core.open(id);
    if (s.summary.parentSessionId) throw new Error("A subagent has no queue. Message the main session instead.");
    return s;
  }

  private find(s: Session, msgId: string): QueuedMessage {
    const m = s.state.queue.find((x) => x.id === msgId);
    if (!m) throw new Error("That message isn't waiting any more.");
    return m;
  }

  /** The queue (and its hold: undefined keeps it, null clears it) into state, the row and runner.json. */
  private save(s: Session, queue: QueuedMessage[], by?: HeldBy | null) {
    const heldBy = by === undefined ? s.state.queueHeldBy : (by ?? undefined);
    const held = !!heldBy && queue.length > 0;
    s.setState({ queue, queueHeld: held || undefined, queueHeldBy: held ? heldBy : undefined });
    this.core.o.prefs.set(s.id, { projectPath: s.summary.projectPath, queue: queue.length ? queue : undefined, queueHeldBy: held ? heldBy : undefined });
    this.core.touch(s);
  }
}
