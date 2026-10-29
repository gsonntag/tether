// One session as the core holds it: its summary, live state, transcript and event numbering
// (SPEC §4, §5). It doesn't decide anything: the registry and the live module drive it, and
// every change goes out through `emit` with the next seq.

import type { HarnessCapabilities, LiveState, Msg, SessionEvent, SessionSnapshot, SessionSummary } from "../../../shared/transcript";
import type { Driver, TranscriptEvent } from "./adapter";
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
  /** a subagent that is still running in its parent's process */
  childRunning = false;
  /** a new session that hasn't had a message yet: nothing of it is in any store */
  fresh = false;

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
    const out = this.transcript.apply(e);
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
    return { session: this.summary, capabilities: this.capabilities, messages: page.messages, hasOlder: page.hasOlder, state: this.state, seq: this.seq };
  }
}
