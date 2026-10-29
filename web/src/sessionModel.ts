// One open session as the browser holds it (SPEC §5, sync): the loaded window of its transcript,
// its live state, and the seq it is current to. Snapshots replace everything; events apply only
// in order. Pure (no network): the store feeds it and does what it asks (`"refresh"`: subscribe
// again for a fresh snapshot).

import { afterSnapshot, checkSeq } from "../../shared/sync";
import type { HarnessCapabilities, LiveState, Msg, SessionEvent, SessionSnapshot, SessionSummary } from "../../shared/transcript";
import { applyToWindow, prependPage, type TranscriptWindow } from "../../shared/window";

/** Events kept to fold onto a snapshot that is on its way. */
const RING = 500;

export type Verdict = "ok" | "refresh";

export interface SessionView {
  /** undefined until the first snapshot */
  window?: TranscriptWindow;
  state?: LiveState;
  session?: SessionSummary;
  capabilities?: HarnessCapabilities;
  /** the last subscribe failed and nothing is loaded */
  error?: string;
}

export class SessionModel {
  view: SessionView = {};
  /** the seq the view is current to; -1 before the first snapshot */
  seq = -1;
  private ready = false;
  private ring: { seq: number; event: SessionEvent }[] = [];

  /** A subscribe is going out: events from here on belong with the snapshot it brings. */
  subscribing() {
    // Older ones may come from a runner process that has since restarted (its seq started over).
    this.ring = [];
  }

  onEvent(seq: number, event: SessionEvent): Verdict {
    this.ring.push({ seq, event });
    if (this.ring.length > RING) this.ring.shift();
    if (!this.ready) return "ok";
    const v = checkSeq(this.seq, seq);
    if (v === "stale") return "ok";
    if (v === "gap") return this.lost();
    return this.apply(seq, event);
  }

  onSnapshot(s: SessionSnapshot): Verdict {
    this.view = { window: { messages: s.messages, hasOlder: s.hasOlder }, state: s.state, session: s.session, capabilities: s.capabilities };
    this.seq = s.seq;
    this.ready = true;
    const after = afterSnapshot(s.seq, this.ring);
    if (after === "gap") return this.lost();
    for (const e of after) if (this.apply(e.seq, e.event) === "refresh") return "refresh";
    return "ok";
  }

  onError(e: Error) {
    if (!this.view.window) this.view = { ...this.view, error: e.message };
  }

  /** An older page, fetched with `history`, goes in front. */
  prepend(page: { messages: Msg[]; hasOlder: boolean }) {
    if (!this.view.window) return;
    this.view = { ...this.view, window: prependPage(this.view.window, page) };
  }

  /** The newest summary for this session (the sidebar's broadcast copy is fresher than the snapshot's). */
  setSummary(s: SessionSummary) {
    this.view = { ...this.view, session: s };
  }

  private lost(): Verdict {
    // Keep showing what we have until the fresh snapshot lands; nothing applies until then.
    this.ready = false;
    return "refresh";
  }

  private apply(seq: number, event: SessionEvent): Verdict {
    this.seq = seq;
    if (event.type === "resync") return this.lost();
    if (event.type === "state") {
      // A field that was cleared travels as null (undefined doesn't survive JSON): drop it.
      const next: Record<string, unknown> = { ...this.view.state!, ...event.state };
      for (const k of Object.keys(event.state)) if (next[k] === null) delete next[k];
      this.view = { ...this.view, state: next as unknown as LiveState };
      return "ok";
    }
    this.view = { ...this.view, window: applyToWindow(this.view.window!, event) };
    return "ok";
  }
}
