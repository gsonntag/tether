// Whether a session is working, and how: its main agent's turn, or only the subagents, shells,
// monitors and workflows it left running. Pure, so it's unit tested (workState.test.ts); the
// sidebar, Home and the session's Activity button all read it, so they agree.

import { ACTIVITY_KINDS, type ActivityKind, type RunStatus, type SessionPulse, type SessionSummary } from "./shared/protocol";

/**
 * working: the main agent's turn is running.
 * waiting: the turn waits (usage limit, retry).
 * background: the turn is over but subagents, shells, monitors or workflows are still running.
 * scheduled: nothing is running, but a wakeup or cron job is armed.
 * idle: a live process with nothing going. closed: no process.
 */
export type WorkState = "working" | "waiting" | "background" | "scheduled" | "idle" | "closed";

export interface WorkInput {
  live: boolean;
  status: RunStatus;
  /** activity items running now, by kind */
  running?: Partial<Record<ActivityKind, number>>;
  /** armed wakeups and cron jobs */
  armed?: number;
}

const total = (r?: Partial<Record<ActivityKind, number>>) => Object.values(r ?? {}).reduce((n, x) => n + (x ?? 0), 0);

export function workState(w: WorkInput): WorkState {
  if (!w.live) return "closed";
  if (w.status === "running") return "working";
  if (w.status === "waiting") return "waiting";
  if (total(w.running) > 0) return "background";
  if ((w.armed ?? 0) > 0) return "scheduled";
  return "idle";
}

/** From a sidebar summary: `activeCount` is running + armed, `runningKinds` the running ones. */
export function summaryWork(s: SessionSummary): WorkInput {
  const active = s.activeCount ?? 0;
  // An older runner sends only the count: count it all as running, the safer reading.
  const running = s.runningKinds ?? (active ? { other: active } : undefined);
  return { live: s.live, status: s.status, running, armed: Math.max(0, active - total(running)) };
}

/**
 * Whether a "Finished" notice is an earlier turn's while this one's subagents or shells still
 * run. The runner holds a turn's "Finished" until its work is done, except that shells and
 * monitors alone (a dev server) hold it SHELL_WAIT_MS at most: that one is newer than the
 * session's last message, so it stays.
 */
export function staleFinished(s: SessionSummary, noticeTs: number): boolean {
  return workState(summaryWork(s)) === "background" && noticeTs < s.updatedAt;
}

/** From a Home pulse. */
export function pulseWork(p: SessionPulse): WorkInput {
  return { live: p.session.live, status: p.session.status, running: p.activity, armed: p.armed };
}

/** "2 agents, 1 shell": running items, by kind. */
export function runningLine(running?: Partial<Record<ActivityKind, number>>): string {
  return ACTIVITY_KINDS.filter((k) => running?.[k.id])
    .map((k) => {
      const n = running![k.id]!;
      return `${n} ${n === 1 ? k.label : k.plural}`;
    })
    .join(", ");
}

/** The label and tooltip for a state, as the sidebar and Home show them. */
export function workLabel(w: WorkInput): { state: WorkState; label: string; tooltip: string } {
  const state = workState(w);
  switch (state) {
    case "working":
      return { state, label: "Working", tooltip: "Main agent is working" };
    case "waiting":
      return { state, label: "Waiting", tooltip: "Waiting (usage limit or retry)" };
    case "background": {
      const what = runningLine(w.running);
      return { state, label: "Working in background", tooltip: `Main agent is idle · ${what ? `${what} still running` : "background work still running"}` };
    }
    case "scheduled":
      return { state, label: "Scheduled", tooltip: w.armed === 1 ? "Waiting for a scheduled wakeup" : `Waiting for ${w.armed} scheduled wakeups` };
    case "idle":
      return { state, label: "Live", tooltip: "Live" };
    default:
      return { state, label: "", tooltip: "" };
  }
}
