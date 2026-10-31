// One open session as the browser holds it (SPEC §5, sync): the loaded window of its transcript,
// its live state, and the seq it is current to. A snapshot replaces all of it but the older pages
// already loaded, and when it doesn't reach them (`gapBefore`) the store pages the gap in. Events
// apply only in order. Pure (no network): the store feeds it and
// does what it asks (`"refresh"`: subscribe again for a fresh snapshot).

import { afterSnapshot, checkSeq } from "../../shared/sync";
import type { HarnessCapabilities, LiveState, Msg, SessionEvent, SessionSnapshot, SessionSummary } from "../../shared/transcript";
import { applyToWindow, joinPage, prependPage, type TranscriptWindow } from "../../shared/window";

/** Events kept to fold onto a snapshot that is on its way. */
const RING = 500;
/** History pages fetched to close a gap before giving up what was loaded behind it. */
const GAP_PAGES = 10;

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
  /** the first message after a gap in the window, and the pages fetched so far to close it */
  private gap?: { first: string; pages: number };

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
    const page = { messages: s.messages, hasOlder: s.hasOlder };
    const loaded = this.beforeGap();
    this.gap = undefined;
    let window = loaded ? joinPage(loaded, page) : page;
    if (!window) {
      // More came than a page holds: the two stand with a gap between, which the store closes.
      window = { messages: [...loaded!.messages, ...page.messages], hasOlder: loaded!.hasOlder };
      this.gap = { first: page.messages[0]!.id, pages: 0 };
    }
    this.view = { window, state: s.state, session: s.session, capabilities: s.capabilities };
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

  /** The message to fetch `history` before, while a gap is open. */
  get gapBefore(): string | undefined {
    return this.gap?.first;
  }

  /** A page for the gap. `undefined`: it couldn't be fetched, so what's behind the gap goes. */
  fillGap(before: string, page?: TranscriptWindow) {
    const w = this.view.window;
    const gap = this.gap;
    if (!w || gap?.first !== before) return;
    const at = w.messages.findIndex((m) => m.id === before);
    const after = at < 0 ? [] : w.messages.slice(at);
    const chain = { messages: [...(page?.messages ?? []), ...after], hasOlder: page?.hasOlder ?? true };
    const behind = this.beforeGap()!;
    let next = page && page.messages.length ? joinPage(behind, chain) : undefined;
    gap.pages++;
    if (next) this.gap = undefined;
    else if (!page || !page.messages.length || gap.pages >= GAP_PAGES) {
      next = chain;
      this.gap = undefined;
    } else {
      next = { messages: [...behind.messages, ...chain.messages], hasOlder: behind.hasOlder };
      gap.first = page.messages[0]!.id;
    }
    this.view = { ...this.view, window: next };
  }

  /** The newest summary for this session (the sidebar's broadcast copy is fresher than the snapshot's). */
  setSummary(s: SessionSummary) {
    this.view = { ...this.view, session: s };
  }

  /** What's loaded, without what stands after a gap. */
  private beforeGap(): TranscriptWindow | undefined {
    const w = this.view.window;
    if (!w || !this.gap) return w;
    const at = w.messages.findIndex((m) => m.id === this.gap!.first);
    return at < 0 ? w : { ...w, messages: w.messages.slice(0, at) };
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
    if (event.type === "reset") this.gap = undefined;
    this.view = { ...this.view, window: applyToWindow(this.view.window!, event) };
    return "ok";
  }
}
