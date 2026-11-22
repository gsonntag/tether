// Read state for Home's inbox (SPEC §10): a main session whose turn ended while nobody looked is
// unread, "finished" or "failed", until a device looks at it (presence: the page shows it) or the
// person marks it read. It is kept in runner.json, so every device sees the same, and it rides on
// the session's summary row (`unread`, `failure`).

import { needsHarnessLogin } from "../../../shared/harnessLogin";
import { isApiBilling } from "../../../shared/labels";
import type { SessionSummary } from "../../../shared/transcript";
import type { SessionCore } from "./sessions";

export class ReadState {
  /** which devices look at which sessions now (from the app) */
  private viewers: Record<string, string[]> = {};

  constructor(private core: SessionCore) {
    const bus = core.o.bus;
    core.book.decorate = (s) => this.decorate(s);
    bus.on("viewers", ({ sessions }) => {
      this.viewers = sessions;
      // Looking at a subagent is looking at its main session too (as notifications count it).
      const seen = new Set(Object.keys(sessions));
      for (const id of Object.keys(sessions)) {
        const parent = this.core.sessions.get(id)?.summary.parentSessionId;
        if (parent) seen.add(parent);
      }
      for (const id of seen) if (this.core.o.prefs.get(id).unread) this.set(id, false);
    });
    bus.on("disconnected", () => (this.viewers = {}));
    bus.on("turnStarted", ({ sessionId }) => {
      if (this.core.o.prefs.get(sessionId).unread) this.set(sessionId, false);
    });
    bus.on("turnEnded", ({ sessionId, error, stopped, recovering }) => {
      const s = core.sessions.get(sessionId);
      if (!s || s.summary.parentSessionId) return;
      // Sign-in failures need an inbox action even if the session was open when it stopped.
      const login = error && !isApiBilling(s.state.billing ?? s.summary.billing) && needsHarnessLogin(error);
      if (stopped || recovering || (!login && this.viewed(sessionId))) return;
      this.set(sessionId, error ? { failure: error } : true);
    });
  }

  /** Devices looking at this session (or one of its subagents) right now. */
  viewersOf(sessionId: string): string[] {
    const out = new Set(this.viewers[sessionId] ?? []);
    for (const [id, devices] of Object.entries(this.viewers)) if (this.core.sessions.get(id)?.summary.parentSessionId === sessionId) devices.forEach((d) => out.add(d));
    return [...out];
  }

  viewed(sessionId: string) {
    return this.viewersOf(sessionId).length > 0;
  }

  /** true: unread (finished); { failure }: unread (failed); false: read. */
  set(sessionId: string, unread: boolean | { failure: string }) {
    const p = this.core.o.prefs.get(sessionId);
    const next = unread === false ? undefined : unread === true ? "finished" : "failed";
    const failure = typeof unread === "object" ? unread.failure.slice(0, 500) : undefined;
    if (p.unread === next && p.failure === failure) return;
    const s = this.core.sessions.get(sessionId);
    this.core.o.prefs.set(sessionId, { ...(s ? { projectPath: s.summary.projectPath } : {}), unread: next, failure });
    if (s) this.core.touch(s);
    this.core.book.redecorate([sessionId]);
  }

  decorate(s: SessionSummary): SessionSummary {
    const p = this.core.o.prefs.get(s.id);
    const live = this.core.sessions.get(s.id);
    const cost = live ? live.state.cost : (this.core.o.costs && (this.core.o.costs.has(s.id) || p.metered) ? this.core.o.costs.get(s.id) : undefined);
    s = { ...s, ...(p.title ? { title: p.title } : {}), ...(p.archived ? { archived: true } : { archived: undefined }), pinned: p.pinned || undefined, ...(live?.state.billing ? { billing: live.state.billing } : {}), ...(cost ? { cost } : {}) };
    if (!p.unread && !s.unread && !s.failure) return s;
    const { unread: _, failure: __, ...rest } = s;
    return { ...rest, ...(p.unread ? { unread: p.unread } : {}), ...(p.unread === "failed" && p.failure ? { failure: p.failure } : {}) };
  }
}
