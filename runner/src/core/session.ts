// One session as the core holds it: its summary, live state, transcript and event numbering
// (SPEC §4, §5). It doesn't decide anything: the registry and the live module drive it, and
// every change goes out through `emit` with the next seq.

import type { HarnessCapabilities, LiveState, Msg, SessionEvent, SessionSnapshot, SessionSummary } from "../../../shared/transcript";
import type { Driver, StartOpts, TranscriptEvent } from "./adapter";
import type { OverlayNotice } from "./notices";
import { capState } from "../../../shared/limits";
import { Transcript } from "./transcript";

export type Emit = (sessionId: string, seq: number, event: SessionEvent) => void;

export class Session {
  readonly id: string;
  summary: SessionSummary;
  state: LiveState;
  /** null until the transcript is read (stored sessions load on first subscribe) */
  transcript: Transcript | null = null;
  seq: number;
  driver?: Driver;
  /** starting or resuming the driver */
  starting?: Promise<Driver>;
  /** stops tailing the store (stored mode, while watched) */
  unwatch?: () => void;
  /** loading the transcript */
  loading?: Promise<Transcript>;
  idleTimer?: ReturnType<typeof setTimeout>;
  /** setting changes, one at a time (each waits for the harness to take it) */
  settingChain?: Promise<unknown>;
  /** settings Tether rolled back because the harness didn't take them in time: a late report says so */
  rolledBack?: StartOpts;
  /** the settings the harness last reported (capabilities.persistent): what a failed change goes back to */
  confirmed?: StartOpts;
  /** a subagent that is still running in its parent's process */
  childRunning = false;
  /** a new session that hasn't had a message yet: nothing of it is in any store */
  fresh = false;
  /** the send that is starting the harness or handing it the message (a token per send) */
  sending?: object;
  /** the send Stop cancelled before its message went out */
  cancelSend?: object;
  /** the person stopped the running turn (its turnEnded says so) */
  stopped = false;
  /** the running turn's error, as the harness reported it (for turnEnded) */
  turnError?: string;
  /** `!` commands running in its folder (core/shellRuns.ts): it stays in memory meanwhile */
  shellsRunning = 0;
  /**
   * Messages only Tether has (its notices: denials, errors, a turn cut off; ids "n-…"), each
   * after the message it followed. The store doesn't have them, so they're laid over every
   * transcript read from it instead of being diffed away.
   */
  overlay: OverlayNotice[] = [];
  /** a notice joined the overlay (the core keeps them in notices.json) */
  noticeAdded?: (n: OverlayNotice) => void;

  constructor(
    summary: SessionSummary,
    state: LiveState,
    readonly capabilities: HarnessCapabilities,
    private out: Emit,
    seq = 0,
  ) {
    this.id = summary.id;
    this.summary = summary;
    this.state = state;
    this.seq = seq;
  }

  get live() {
    return this.state.mode === "live";
  }

  /** Numbers an event and sends it on. */
  emit(event: SessionEvent) {
    this.out(this.id, ++this.seq, event);
  }

  /** Applies a transcript event (when the transcript is loaded) and sends it on. */
  apply(e: TranscriptEvent): SessionEvent | null {
    if (!this.transcript) {
      // Not loaded (nobody has opened it): the store has it when someone does.
      return null;
    }
    // A notice is anchored to the message before it that the store has: not to another notice of
    // Tether's, which no store read has, so it would be pruned.
    const last = this.transcript.messages.findLast((m) => !isTetherNotice(m))?.id;
    const out = this.transcript.apply(e);
    if (out?.type === "msg" && out.isNew && isTetherNotice(out.msg)) {
      const n = { msg: out.msg, after: last };
      this.overlay.push(n);
      this.noticeAdded?.(n);
    }
    if (out) this.emit(out);
    return out;
  }

  /** Patches live state; only real changes go out. */
  setState(patch: Partial<LiveState>): Partial<LiveState> | null {
    const changed: Partial<LiveState> = {};
    for (const [k, v] of Object.entries(patch) as [keyof LiveState, unknown][]) {
      if (JSON.stringify(this.state[k]) === JSON.stringify(v)) continue;
      (changed as any)[k] = v;
    }
    if (!Object.keys(changed).length) return null;
    this.state = { ...this.state, ...changed };
    for (const k of Object.keys(changed) as (keyof LiveState)[]) if (this.state[k] === undefined) delete this.state[k];
    // undefined doesn't survive JSON: a cleared field travels as null and the browser drops it.
    const wire = Object.fromEntries(Object.entries(changed).map(([k, v]) => [k, v === undefined ? null : v]));
    this.emit({ type: "state", state: wire as Partial<LiveState> });
    return changed;
  }

  snapshot(limit: number): SessionSnapshot {
    const page = this.transcript ? this.transcript.newest(limit) : { messages: [] as Msg[], hasOlder: false };
    return { session: this.summary, capabilities: this.capabilities, messages: page.messages, hasOlder: page.hasOlder, state: capState(this.state), seq: this.seq };
  }
}

/** A message only Tether has (not in the harness's store): its notices, and `!` command cards. */
export const isTetherNotice = (m: Msg) => m.id.startsWith("n-") && (m.role === "notice" || !!m.shell);

