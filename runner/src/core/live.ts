// Live mode (SPEC §4): driving a session through its harness's programmatic interface. A session
// goes live when you send it something (or create it), and back to stored after 5 idle minutes
// (never while its subagents or background tasks still run) or when its process ends.
//
// Each live session's driver reports through a Sink made here: transcript events go into the
// session's transcript and out with the next seq, status changes become turnStarted/turnEnded,
// permission requests go to the request desk (core/requests.ts), and subagents become child
// sessions (SPEC §6a).

import { randomUUID } from "node:crypto";
import { withAttachments, type Attachment } from "../../../shared/attachments";
import { FROM_TETHER } from "../../../shared/fromTether";
import { sessionId as makeId, parseSessionId } from "../../../shared/ids";
import { MESSAGE_TEXT_MAX } from "../../../shared/limits";
import { AGENT_NAMES, HARNESS_LABELS, type HarnessId, type LiveState, type ModelList, type Msg, type RequestAnswer } from "../../../shared/transcript";
import type { Driver, Sink, StartOpts, SubagentStart } from "./adapter";
import { AttachmentStore } from "./attachments";
import type { RequestBroker } from "./broker";
import { ReadState } from "./inbox";
import { MessageQueue } from "./queue";
import { RequestDesk } from "./requests";
import { Session } from "./session";
import type { SessionCore } from "./sessions";
import { Transcript } from "./transcript";

/** Idle this long, a live session's process closes. */
export const IDLE_CLOSE_MS = 5 * 60_000;

const notice = (text: string, level: Msg["level"] = "info"): Msg => ({ id: `n-${randomUUID()}`, role: "notice", level, ts: Date.now(), parts: [{ type: "text", text }] });

/**
 * What terminal mode lends live control (terminal/control.ts sets it): in terminal mode a message is
 * typed into the TUI and Stop presses Esc there (SPEC §8, §9); a new session can start in the TUI.
 */
export interface TerminalSeam {
  send(s: Session, text: string): Promise<void>;
  interrupt(s: Session): Promise<void>;
  startIn(s: Session): Promise<void>;
  /** a handoff to the TUI, or Back to Tether, under way finishes (whichever way) */
  settled(s: Session): Promise<void> | undefined;
  /** why the SDK may not drive the session now (its TUI drives, or is taking over) */
  blocked(s: Session): string | undefined;
}

export class LiveControl {
  private readonly idleMs: number;
  terminal?: TerminalSeam;
  readonly desk: RequestDesk;
  readonly queue: MessageQueue;
  readonly read: ReadState;
  readonly attachments: AttachmentStore;
  /** shutting down: drivers close, but their open requests stay saved for the next start */
  private stopping = false;
  /** messages to subagents the main agent was asked to pass on (via-parent), by main session */
  private relays = new Map<string, { childId: string; nativeId: string; msgId: string; text: string }[]>();

  constructor(
    private core: SessionCore,
    broker: RequestBroker,
    opts: { idleMs?: number; attachmentsDir?: string } = {},
  ) {
    this.idleMs = opts.idleMs ?? IDLE_CLOSE_MS;
    this.desk = new RequestDesk(core, broker, { send: (id, text) => this.send(id, text, [], { tether: true }), setPermissionMode: (id, mode) => this.setPermissionMode(id, mode) });
    this.queue = new MessageQueue(core, { send: (id, text, attachments) => this.send(id, text, attachments, { queued: true }) });
    this.read = new ReadState(core);
    this.attachments = new AttachmentStore(opts.attachmentsDir ?? "/nonexistent-tether-attachments");
    AttachmentStore.current = this.attachments;
    const bus = core.o.bus;
    bus.on("message", ({ sessionId, msg }) => this.relayCheck(sessionId, msg.parts));
    bus.on("toolCall", ({ sessionId, tool }) => this.relayCheck(sessionId, [tool]));
    bus.on("turnEnded", ({ sessionId }) => this.relayTurnEnded(sessionId));
  }

  // ---------------- ops ----------------

  async newSession(args: { harness: HarnessId; projectPath: string; terminal?: boolean } & StartOpts): Promise<{ sessionId: string }> {
    const a = this.core.adapter(args.harness);
    const folder = this.core.folder(args.projectPath);
    if (args.terminal && !this.terminal) throw new Error("This runner has no terminal support (is tmux installed?).");
    const opts: StartOpts = { model: args.model, effort: args.effort, permissionMode: args.permissionMode };
    const s = this.core.create(args.harness, await a.newId(folder, opts), folder, opts);
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
    // already in the session's state; the session still opens.
    await this.ensureDriver(s).catch(() => {});
    return { sessionId: s.id };
  }

  /**
   * Starts a turn. `stop`: Stop and send now (SPEC §9). A message you send releases a queue held
   * after Stop or a failed turn: it goes on after this turn (`queued`: the queue's own sends;
   * `tether`: sent on your behalf, which releases nothing).
   */
  async send(id: string, text: string, attachments: Attachment[] = [], o: { stop?: boolean; queued?: boolean; tether?: boolean } = {}) {
    if (!text?.trim() && !attachments.length) throw new Error("Type a message first.");
    if (text.length > MESSAGE_TEXT_MAX) throw new Error("That message is too long.");
    const s = await this.core.open(id);
    // A subagent the harness lets you message: into its running turn (SPEC §6a).
    if (s.summary.parentSessionId) return this.steer(id, text, attachments);
    // Moving to or from the terminal: the message goes wherever the session ends up, never to an
    // SDK process started beside a TUI, nor to a TUI that is quitting.
    const moving = this.terminal?.settled(s);
    if (moving) await moving;
    // The TUI drives: the message is typed there (SPEC §9).
    if (s.state.mode === "terminal" && this.terminal) return this.terminal.send(s, withAttachments(text, attachments));
    if (o.stop && (s.state.status !== "idle" || s.sending)) {
      await this.interrupt(id);
      const until = this.core.now() + 15_000;
      while ((s.state.status !== "idle" || s.sending) && this.core.now() < until) await Bun.sleep(100);
    }
    // Checked and claimed with no await in between, so two sends can't both start a turn.
    if (s.state.status !== "idle" || s.sending) throw new Error(`${AGENT_NAMES[s.summary.harness]} is still working. Stop it first, or wait for it to finish.`);
    if (!o.queued && !o.tether && s.state.queueHeldBy !== "terminal") this.queue.release(s);
    const me = {};
    s.sending = me;
    // Running from now: starting Claude can take seconds, and Stop works meanwhile (cancelSend).
    this.status(s, "running");
    try {
      await this.core.load(s);
      const d = await this.ensureDriver(s);
      // Stopped before the message went out (interrupt already set idle and freed the session).
      if (s.cancelSend === me) return;
      await this.confirmSettings(s, d);
      if (s.cancelSend === me) return;
      this.core.touch(s, { updatedAt: this.core.now() });
      await d.send(withAttachments(text, attachments), attachments);
      s.fresh = false;
    } catch (e) {
      if (s.sending === me) {
        s.turnError = (e as Error)?.message ?? String(e);
        this.status(s, "idle");
      }
      throw e;
    } finally {
      if (s.sending === me) s.sending = undefined;
      if (s.cancelSend === me) s.cancelSend = undefined;
    }
  }

  /**
   * A message into the running turn (capabilities.canSteer), or into a subagent's own turn
   * (capabilities.subagents.steer "direct"). It can't be taken back once the harness has it.
   */
  async steer(id: string, text: string, attachments: Attachment[] = []) {
    if (!text?.trim() && !attachments.length) throw new Error("Type a message first.");
    if (text.length > MESSAGE_TEXT_MAX) throw new Error("That message is too long.");
    const s = await this.core.open(id);
    const parentId = s.summary.parentSessionId;
    if (parentId) {
      const how = s.capabilities.subagents.steer;
      if (!how) throw new Error("Subagents can't take messages here. Message the main session instead.");
      const parent = this.core.sessions.get(parentId);
      if (!s.childRunning || !parent?.driver) throw new Error("This subagent has finished. Message the main session instead.");
      if (how === "via-parent") return this.relay(parent, s, withAttachments(text, attachments));
      if (!parent.driver.steerSubagent) throw new Error("Subagents can't take messages here. Message the main session instead.");
      return parent.driver.steerSubagent(s.summary.nativeId, withAttachments(text, attachments), attachments);
    }
    if (!s.capabilities.canSteer) throw new Error(`${AGENT_NAMES[s.summary.harness]} can't take a message while it works. Wait for it to finish.`);
    if (s.state.mode === "terminal" && this.terminal) return this.terminal.send(s, withAttachments(text, attachments));
    if (s.state.status === "idle" || !s.driver?.steer) throw new Error("Nothing is running to steer. Send it as a new message instead.");
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
    if (!d.relayMessage || !d.relayedBy) throw new Error("Subagents can't take messages here. Message the main session instead.");
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

  async interrupt(id: string) {
    const s = await this.core.open(id);
    const parentId = s.summary.parentSessionId;
    if (parentId) {
      // A subagent: stop just it (SPEC §6a). Its parent's process runs it.
      this.desk.cancel((r) => r.sessionId === id);
      const parent = this.core.sessions.get(parentId);
      if (!s.childRunning || !parent?.driver?.stopSubagent) return;
      await parent.driver.stopSubagent(s.summary.nativeId);
      return;
    }
    if (s.state.mode === "terminal" && this.terminal) return this.terminal.interrupt(s);
    // Whatever it asked is moot now (the harness stops waiting too).
    this.desk.stop(id);
    // Stop keeps the queue, held, until you send (SPEC §9).
    this.queue.hold(s, "stopped");
    if (s.state.status !== "idle" || s.sending) s.stopped = true;
    // Stopped while Claude is still starting: the message never goes out.
    if (s.sending && !s.driver) {
      // Free at once: a send right after this goes ahead (on the same start).
      s.cancelSend = s.sending;
      s.sending = undefined;
      return this.status(s, "idle");
    }
    await s.driver?.interrupt();
  }

  async setModel(id: string, model: string) {
    await this.setting(id, { model }, (d) => d.setModel(model));
  }

  async setEffort(id: string, effort: string) {
    await this.setting(id, { effort }, (d) => d.setEffort?.(effort) ?? Promise.resolve());
  }

  async setPermissionMode(id: string, mode: string) {
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
    const persistent = (id: string) => {
      const harness = parseSessionId(id)?.harness;
      return !!harness && !!this.core.o.adapters.find((a) => a.id === harness)?.capabilities.persistent;
    };
    // Turns that were running, and sessions with requests saved from before the restart.
    const ids = [...new Set([...this.core.o.prefs.running(), ...this.desk.broker.sessions(true)])].filter(persistent);
    await Promise.all(ids.map((id) => this.rejoinOne(id)));
  }

  /** Rejoins one session, trying again a few times (the harness's daemon may be slow or restarting). */
  private async rejoinOne(id: string) {
    for (let attempt = 0; ; attempt++) {
      try {
        const s = await this.core.open(id);
        await this.core.load(s);
        await this.ensureDriver(s);
        this.core.log(`rejoined ${id}`);
        // It finished while the runner was away.
        if (s.state.status === "idle") this.core.o.prefs.set(id, { running: undefined });
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
    this.desk.broker.freeze();
    await Promise.all([...this.core.sessions.values()].filter((s) => s.driver).map((s) => this.close(s)));
  }

  // ---------------- lifecycle ----------------

  private async setting(id: string, patch: StartOpts, apply: (d: Driver) => Promise<void>) {
    const s = await this.core.open(id);
    if (s.summary.parentSessionId) throw new Error("A subagent runs with its parent's settings.");
    // A handoff TUI drives (SPEC §8): it was launched with its settings and takes no others from
    // Tether, so a change here would only pretend.
    if (s.state.mode === "terminal" && s.capabilities.terminal === "handoff") {
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
    const shown: StartOpts = Object.fromEntries(Object.keys(patch).map((k) => [k, (s.state as any)[k]]));
    this.core.o.prefs.set(id, { projectPath: s.summary.projectPath, ...patch });
    s.rolledBack = undefined;
    this.noteTurnSettings(s, patch);
    s.setState(patch);
    // Starting with the old settings right now: applied as soon as it's up.
    const d = s.driver ?? (s.starting ? await s.starting.catch(() => undefined) : undefined);
    if (!d) return;
    try {
      await withTimeout(apply(d), this.settingMs, "didn't answer");
      // A harness that confirms settings itself (capabilities.persistent): shown as applied only
      // once it reports them (the report clears the pref, see the sink).
      if (s.capabilities.persistent) {
        const keys = Object.keys(patch) as (keyof StartOpts)[];
        const until = this.core.now() + this.confirmMs;
        while (keys.some((k) => this.core.o.prefs.get(id)[k] !== undefined) && this.core.now() < until) await Bun.sleep(50);
        if (keys.some((k) => this.core.o.prefs.get(id)[k] !== undefined)) throw new Error("it didn't confirm the change");
      }
    } catch (e: any) {
      // Not applied: what every device shows, and what the next start sends, go back to how they
      // were, so nothing runs with settings other than those shown. A late confirmation still
      // counts (the sink says so).
      const undo = Object.fromEntries(Object.keys(patch).map((k) => [k, (before as any)[k]]));
      this.core.o.prefs.set(id, undo);
      s.rolledBack = patch;
      this.rollBackTurnSettings(s, shown);
      s.setState(shown);
      throw new Error(`${HARNESS_LABELS[s.summary.harness]} didn't take that setting (${e?.message ?? e}). It's unchanged.`);
    }
  }

  /**
   * A setting changes while a turn runs on a harness where that counts from the next turn
   * (capabilities.settingsApply "nextTurn"): the turn's own value is kept beside it, so it shows
   * honestly ("Read only from the next turn") until the turn ends.
   */
  private noteTurnSettings(s: Session, patch: StartOpts) {
    if (s.capabilities.settingsApply !== "nextTurn" || s.state.status === "idle" || s.summary.parentSessionId) return;
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
    if (!s.state.turnSettings) return;
    const turn = { ...s.state.turnSettings };
    for (const k of Object.keys(shown) as (keyof StartOpts)[]) if (turn[k] === shown[k]) delete turn[k];
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
  async release(s: Session) {
    const d = s.driver ?? (s.starting ? await s.starting.catch(() => undefined) : undefined);
    clearTimeout(s.idleTimer);
    this.desk.cancel((_r, chain) => chain.at(-1) === s.id);
    for (const c of this.core.sessions.values()) if (c.summary.parentSessionId === s.id && c.childRunning) this.childEnded(c);
    if (!d) return;
    // Its exit isn't news: onExit checks that it's still the session's driver.
    if (s.driver === d) s.driver = undefined;
    try {
      await d.close();
    } catch {}
  }

  /** Live again on the same session (Back to Tether, SPEC §8). */
  resumeLive(s: Session): Promise<Driver> {
    return this.ensureDriver(s);
  }

  /** The session's driver, starting or resuming the harness when it isn't live. */
  private ensureDriver(s: Session): Promise<Driver> {
    if (s.driver) return Promise.resolve(s.driver);
    // Two processes must never drive one session (SPEC §8 handoff).
    const blocked = this.terminal?.blocked(s);
    if (blocked) return Promise.reject(new Error(blocked));
    s.starting ??= this.startDriver(s).finally(() => (s.starting = undefined));
    return s.starting;
  }

  private async startDriver(s: Session): Promise<Driver> {
    const a = this.core.adapter(s.summary.harness);
    // Only what you set in Tether: the rest is the harness's own (its config, or the session's
    // settings it keeps itself), never overwritten by what Tether merely showed.
    const p = this.core.o.prefs.get(s.id);
    const opts: StartOpts = { ...(p.model ? { model: p.model } : {}), ...(p.effort ? { effort: p.effort } : {}), ...(p.permissionMode ? { permissionMode: p.permissionMode } : {}) };
    // Live from here: its own events, not the store, update the transcript.
    s.unwatch?.();
    s.unwatch = undefined;
    const sink = this.sink(s);
    let d: Driver;
    try {
      d = s.fresh ? await a.start(s.summary.projectPath, s.summary.nativeId, opts, sink) : await a.resume(s.summary.nativeId, s.summary.projectPath, opts, sink);
    } catch (e: any) {
      const error = e?.message ?? String(e);
      s.apply({ type: "msg", msg: notice(`Couldn't start ${HARNESS_LABELS[s.summary.harness]}: ${error}`, "error") });
      // Not live after all: stored, tailing its store if someone watches it, and evictable. A send
      // that was starting it ends its turn as failed (send's catch).
      s.setState({ error, mode: "stored", ...(s.sending ? {} : { status: "idle" as const }) });
      this.core.touch(s);
      this.core.tail(s);
      this.core.scheduleEvict(s);
      throw e;
    }
    s.driver = d;
    d.onExit = (error) => {
      if (s.driver !== d) return;
      if (error) s.apply({ type: "msg", msg: notice(error, "error") });
      this.toStored(s, error);
    };
    this.setMode(s, "live", { error: undefined, continuedIn: undefined });
    this.scheduleIdle(s);
    return d;
  }

  private async close(s: Session) {
    const d = s.driver;
    if (!d) return;
    try {
      await d.close();
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
    for (const c of this.core.sessions.values()) if (c.summary.parentSessionId === s.id && c.childRunning) this.childEnded(c);
    // Messages to its subagents that the main agent never passed on won't be now.
    for (const r of [...(this.relays.get(s.id) ?? [])]) this.relayDone(s.id, r, "failed");
    const before = s.state.status;
    this.setMode(s, "stored", { ...(error ? { error } : {}) });
    // A turn the process took down with it ended (failed when it says why): Home, the queue and
    // notifications hear, as for any turn end. Not at shutdown: the turn is cut off, not over.
    if (before !== "idle" && !this.stopping) {
      if (error) s.turnError = error;
      this.status(s, "idle");
    } else if (before !== "idle") s.setState({ status: "idle" });
    if (s.fresh) {
      // Never got a message: nothing of it is in any store.
      this.core.book.remove([s.id]);
      this.core.sessions.delete(s.id);
      return;
    }
    this.core.tail(s);
    this.core.scheduleEvict(s);
  }

  setMode(s: Session, mode: LiveState["mode"], extra: Partial<LiveState> = {}) {
    const from = s.state.mode;
    s.setState({ mode, ...extra });
    this.core.touch(s);
    if (from !== mode) this.core.o.bus.emit("modeChanged", { sessionId: s.id, from, to: mode });
  }

  private scheduleIdle(s: Session) {
    clearTimeout(s.idleTimer);
    s.idleTimer = setTimeout(() => {
      if (!s.driver) return;
      // Not while a turn, a subagent or a background task runs, nor while the harness's own TUI
      // shares the session (it would lose what Tether relays): look again later.
      if (s.state.status !== "idle" || s.driver.busy() || s.state.terminal) return this.scheduleIdle(s);
      void this.close(s);
    }, this.idleMs);
    s.idleTimer.unref?.();
  }

  // ---------------- sinks ----------------

  /** Where a session's driver reports. */
  private sink(s: Session): Sink {
    const core = this.core;
    const bus = core.o.bus;
    return {
      event: (e) => {
        const out = s.apply(e);
        if (out?.type === "msg") {
          // The turn failed: its turnEnded says why (Home and notifications show it).
          const m = out.msg;
          const failed = m.error ?? (m.role === "notice" && m.level === "error" ? m.parts.map((p) => (p.type === "text" ? p.text : "")).join(" ") : undefined);
          if (failed && s.state.status !== "idle") s.turnError = failed;
          bus.emit("message", { sessionId: s.id, msg: m });
        }
        if (out?.type === "tool") {
          const tool = s.transcript?.get(e.type === "tool" ? e.msgId : "")?.parts.find((p) => p.type === "tool" && p.id === (e as any).toolId);
          if (tool?.type === "tool") bus.emit("toolCall", { sessionId: s.id, msgId: (e as any).msgId, tool });
        }
      },
      message: (id) => s.transcript?.get(id),
      state: (patch) => {
        const before = s.state.status;
        // A harness that keeps the session's settings itself (capabilities.persistent) reports them.
        // A setting made in Tether is kept (and sent at each start) until the harness reports it
        // applied: then it isn't sent again, where it could undo a change made elsewhere since.
        if (s.capabilities.persistent && !s.summary.parentSessionId) {
          const reported = { ...(patch.model ?? patch.modelResolved ? { model: patch.model ?? patch.modelResolved } : {}), ...(patch.effort ? { effort: patch.effort } : {}), ...(patch.permissionMode ? { permissionMode: patch.permissionMode } : {}) };
          s.confirmed = { ...s.confirmed, ...reported };
          // A change Tether had given up on (rolled back) that the harness applied after all.
          const late = (Object.keys(reported) as (keyof StartOpts)[]).filter((k) => s.rolledBack?.[k] !== undefined && s.rolledBack[k] === reported[k]);
          if (late.length) {
            s.rolledBack = undefined;
            s.apply({ type: "msg", msg: notice(`${HARNESS_LABELS[s.summary.harness]} applied your earlier change to the ${late.map((k) => (k === "permissionMode" ? "mode" : k)).join(" and ")} after all.`) });
          }
          // Changed elsewhere (Codex's TUI) mid-turn: the running turn still has its old values.
          this.noteTurnSettings(s, reported);
          const p = core.o.prefs.get(s.id);
          const done = {
            ...(p.model !== undefined && (patch.model ?? patch.modelResolved) === p.model ? { model: undefined } : {}),
            ...(p.effort !== undefined && patch.effort === p.effort ? { effort: undefined } : {}),
            ...(p.permissionMode !== undefined && patch.permissionMode === p.permissionMode ? { permissionMode: undefined } : {}),
          };
          if (Object.keys(done).length) core.o.prefs.set(s.id, done);
        }
        const changed = s.setState(patch);
        if (!changed) return;
        if (changed.status && changed.status !== before) this.statusChanged(s, before);
        else if (changed.model || changed.modelResolved || changed.permissionMode) core.touch(s);
        // The harness changed its own mode (a plan approved): kept, so the next start uses it.
        if (changed.permissionMode && !s.summary.parentSessionId && !s.capabilities.persistent) core.o.prefs.set(s.id, { projectPath: s.summary.projectPath, permissionMode: changed.permissionMode });
      },
      request: (r, signal) => this.desk.ask(s, r, signal),
      nativeId: (id) => {
        if (id !== s.summary.nativeId) core.log(`${s.id}: the harness calls it ${id}`);
      },
      subagent: (start) => this.child(s, start),
      ended: () => {},
    };
  }

  private statusChanged(s: Session, before: LiveState["status"]) {
    const bus = this.core.o.bus;
    const now = s.state.status;
    // Kept in runner.json, so a turn cut off by a restart is reported when the session reopens.
    if (!s.summary.parentSessionId && s.state.mode !== "terminal" && (now === "idle") !== (before === "idle")) this.core.o.prefs.set(s.id, { projectPath: s.summary.projectPath, running: now === "idle" ? undefined : true });
    if (now === "running" && before !== "running") bus.emit("turnStarted", { sessionId: s.id });
    if (now === "idle") {
      // The next turn runs with the settings as shown.
      if (s.state.turnSettings) s.setState({ turnSettings: undefined });
      const stopped = s.stopped;
      s.stopped = false;
      bus.emit("turnEnded", { sessionId: s.id, error: s.state.error ?? s.turnError, ...(stopped ? { stopped } : {}) });
      s.turnError = undefined;
      this.scheduleIdle(s);
      void this.refreshTitle(s);
    }
    this.core.touch(s, { updatedAt: this.core.now() });
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
    c.setState({ mode: "live", status: "running" });
    this.core.touch(c, { updatedAt: now });
    // The parent's tool card links to it.
    const at = parent.transcript?.findTool(start.parentToolId);
    if (at) parent.apply({ type: "tool", msgId: at.msg.id, toolId: start.parentToolId, patch: { childSessionId: id } });
    const child = c;
    const sink = this.sink(child);
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
  }
}

/** A promise that fails with `what` when it takes longer than `ms`. */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<never>((_, rej) => (t = setTimeout(() => rej(new Error(what)), ms)))]).finally(() => clearTimeout(t));
}
