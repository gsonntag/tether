// Session pulses: what the Home dashboard shows for each session (status, current action, activity
// counts, context, waiting approvals, last line). The runner pushes them to every browser as
// sessions change, throttled per session, so the dashboard is live without polling.

import { isActive, type ActivityKind, type LiveState, type Msg, type SessionPulse, type SessionSummary, type UiRequest } from "../../web/src/shared/protocol";
import { describeTool } from "./adapters/activity";
import { redactSecrets } from "./context/handoff";

/**
 * One line of at most `n` chars, credentials redacted: pulses reach every browser, and Home is the
 * page a phone opens on. Redacted before clipping, so a clipped key can't leak its first characters;
 * only a bounded prefix is scanned.
 */
const clip = (s: string, n: number) => {
  const line = redactSecrets(s.slice(0, Math.max(4 * n, 2_000)))
    .replace(/\s+/g, " ")
    .trim();
  return line.length > n ? line.slice(0, n - 1) + "…" : line;
};

/** The last non-empty line of the newest assistant text. */
export function lastLine(messages: Msg[], max = 160): string | undefined {
  for (let i = messages.length - 1, seen = 0; i >= 0 && seen < 20; i--, seen++) {
    const m = messages[i]!;
    if (m.role !== "assistant") continue;
    const text = m.parts.map((p) => (p.type === "text" ? p.text : "")).join("\n");
    const line = text
      .split("\n")
      .map((l) => l.replace(/^[#>*\-\s`]+/, "").trim())
      .filter(Boolean)
      .pop();
    if (line) return clip(line, max);
  }
  return undefined;
}

/** What the agent is doing right now, in a few words. */
export function currentAction(state: LiveState, messages: Msg[]): string | undefined {
  if (state.pendingUi.length) {
    const r = state.pendingUi[0]!;
    if (r.kind === "permission") return `Waiting for approval: ${r.tool?.name ?? r.title}`;
    if (r.kind === "plan") return "Waiting for plan review";
    return "Waiting for your answer";
  }
  if (state.status === "waiting") return state.waitingReason ?? "Waiting";
  if (state.status === "running") {
    // The newest tool call still running in the last few messages (a subagent's own calls count).
    for (let i = messages.length - 1; i >= Math.max(0, messages.length - 6); i--) {
      const parts = messages[i]!.parts;
      for (let j = parts.length - 1; j >= 0; j--) {
        const p = parts[j]!;
        if (p.type === "tool" && p.status === "running") return p.judging ? `Checking ${p.name} with the guard` : describeTool(p.name, p.input);
      }
    }
    const last = messages[messages.length - 1];
    if (last?.role === "assistant" && last.streaming) {
      const part = last.parts[last.parts.length - 1];
      if (part?.type === "thinking") return "Thinking";
      if (part?.type === "text") return "Writing";
    }
    return "Working";
  }
  // Idle with work still going: the newest running item's latest step.
  const running = (state.activity ?? []).filter((a) => a.status === "running").sort((a, b) => b.startedAt - a.startedAt);
  if (running.length) return running[0]!.latest ?? running[0]!.title;
  return undefined;
}

/** Permission prompts and questions without large payloads (a Write's whole file, a long plan). */
export function compactUi(r: UiRequest): UiRequest {
  const out: UiRequest = { ...r };
  if (r.message) out.message = clip(r.message, 400);
  if (r.tool) {
    const i = r.tool.input as any;
    // `truncated`: the dashboard doesn't offer one-tap approval of a call you can't read in full.
    const cut = (s: string, key: "command" | "summary") => {
      const v = clip(s, 400);
      return { [key]: v, ...(s.replace(/\s+/g, " ").trim().length > 400 ? { truncated: true } : {}) };
    };
    const summary =
      i && typeof i === "object"
        ? typeof i.command === "string"
          ? cut(i.command, "command")
          : i.file_path || i.path
            ? { file_path: clip(String(i.file_path ?? i.path), 400) }
            : cut(JSON.stringify(i), "summary")
        : cut(String(i ?? ""), "summary");
    out.tool = { name: r.tool.name, input: summary };
  }
  return out;
}

export function buildPulse(p: { session: SessionSummary; state: LiveState; messages: Msg[]; turnStartedAt?: number; finishedAt?: number }): SessionPulse {
  const { session, state, messages } = p;
  const counts: Partial<Record<ActivityKind, number>> = {};
  let armed = 0;
  for (const a of state.activity ?? []) {
    if (!isActive(a)) continue;
    if (a.status === "waiting") armed++;
    else counts[a.kind] = (counts[a.kind] ?? 0) + 1;
  }
  const c = state.context;
  const live = session.live;
  const action = live ? currentAction(state, messages) : undefined;
  return {
    session,
    ...(state.model ? { model: state.model } : {}),
    ...(live ? { action: action && clip(action, 200) } : {}),
    ...(live && session.status !== "idle" && p.turnStartedAt ? { turnStartedAt: p.turnStartedAt } : {}),
    ...(live && Object.keys(counts).length ? { activity: counts } : {}),
    ...(live && armed ? { armed } : {}),
    ...(c && (c.used !== undefined || c.max !== undefined) ? { context: { used: c.used, max: c.max } } : {}),
    ...(live && state.pendingUi.length ? { pendingUi: state.pendingUi.map(compactUi) } : {}),
    lastText: lastLine(messages),
    ...(state.diffStat ? { diffStat: state.diffStat } : {}),
    ...(p.finishedAt ? { finishedAt: p.finishedAt } : {}),
  };
}

/** Compares pulses ignoring `updatedAt`, which moves with every streamed token. */
export function pulseKey(p: SessionPulse): string {
  return JSON.stringify({ ...p, session: { ...p.session, updatedAt: 0 } });
}

/** When each session's turn started and when its last one ended, from its status changes. */
export class TurnClock {
  private status = new Map<string, string>();
  private started = new Map<string, number>();
  private finished = new Map<string, number>();

  constructor(private now: () => number = Date.now) {}

  /** A status change (or the same status again, which changes nothing). */
  update(id: string, status: string) {
    const prev = this.status.get(id);
    if (prev === status) return;
    this.status.set(id, status);
    if (status === "running" && prev !== "waiting") this.started.set(id, this.now());
    if (status === "idle" && prev !== undefined) {
      this.finished.set(id, this.now());
      this.started.delete(id);
    }
  }

  turnStartedAt(id: string) {
    return this.started.get(id);
  }

  finishedAt(id: string) {
    return this.finished.get(id);
  }

  forget(id: string) {
    this.status.delete(id);
    this.started.delete(id);
    this.finished.delete(id);
  }
}

export interface ThrottleOptions {
  /** at most one pulse per session this often */
  intervalMs?: number;
  /** the session's pulse now; undefined when it's gone */
  build: (id: string) => SessionPulse | undefined;
  send: (pulses: SessionPulse[]) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

/**
 * Coalesces session changes into pulses: a session that changes sends at once if it hasn't sent
 * for `intervalMs`, else once that interval is up (with its state as of then). A burst of events
 * in one tick sends once; a pulse equal to the last one sent (but for updatedAt) isn't sent.
 * Pulses due together go out in one message. Building a pulse happens only when it's sent, so
 * streaming sessions cost a Map write per event and one build per interval.
 */
export class PulseThrottle {
  private interval: number;
  private dirty = new Set<string>();
  private lastSent = new Map<string, number>();
  private lastKey = new Map<string, string>();
  private timer: unknown;
  private timerAt = Infinity;
  private now: () => number;
  private setTimer: (fn: () => void, ms: number) => unknown;
  private clearTimer: (t: unknown) => void;

  constructor(private o: ThrottleOptions) {
    this.interval = o.intervalMs ?? 1_000;
    this.now = o.now ?? Date.now;
    this.setTimer = o.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = o.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  }

  /** The session changed. */
  touch(id: string) {
    this.dirty.add(id);
    this.schedule(this.dueAt(id));
  }

  private dueAt(id: string) {
    const last = this.lastSent.get(id);
    return last === undefined ? this.now() : Math.max(this.now(), last + this.interval);
  }

  private schedule(at: number) {
    if (at >= this.timerAt) return;
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.timerAt = at;
    this.timer = this.setTimer(() => this.flush(), Math.max(0, at - this.now()));
  }

  /** Sends every pulse that's due; reschedules for the rest. */
  flush() {
    this.timer = undefined;
    this.timerAt = Infinity;
    const now = this.now();
    const out: SessionPulse[] = [];
    let next = Infinity;
    for (const id of [...this.dirty]) {
      const due = this.dueAt(id);
      if (due > now) {
        next = Math.min(next, due);
        continue;
      }
      this.dirty.delete(id);
      const p = this.o.build(id);
      if (!p) continue;
      const key = pulseKey(p);
      if (key === this.lastKey.get(id)) continue;
      this.lastKey.set(id, key);
      this.lastSent.set(id, now);
      out.push(p);
    }
    if (out.length) this.o.send(out);
    if (next < Infinity) this.schedule(next);
  }

  /** Forget a session entirely (its next change sends at once). */
  forget(id: string) {
    this.dirty.delete(id);
    this.lastSent.delete(id);
    this.lastKey.delete(id);
  }

  /** After a reconnect: browsers may have missed pulses, so the next ones go out even if unchanged. */
  resetSent() {
    this.lastKey.clear();
  }
}

/** Sessions whose agent process closed: their last pulse, so "Recently finished" still lists them. */
export class ClosedPulses {
  private map = new Map<string, SessionPulse>();
  /** `onEvict`: a session pushed out by newer ones (forget its other per-session state too) */
  constructor(
    private max = 20,
    private onEvict?: (id: string) => void,
  ) {}
  put(p: SessionPulse) {
    this.map.delete(p.session.id);
    this.map.set(p.session.id, p);
    while (this.map.size > this.max) {
      const id = this.map.keys().next().value!;
      this.map.delete(id);
      this.onEvict?.(id);
    }
  }
  get(id: string) {
    return this.map.get(id);
  }
  delete(id: string) {
    this.map.delete(id);
  }
  list() {
    return [...this.map.values()];
  }
}
