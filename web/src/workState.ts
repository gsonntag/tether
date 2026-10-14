// Whether a session is working, and how: its main agent's turn, or only the subagents, shells,
// monitors and workflows it left running. Pure, so it's unit tested (workState.test.ts); the
// sidebar, Home and the session's Activity button all read it, so they agree.

import { ACTIVITY_KINDS, type ActivityKind, type RunStatus, type SessionPulse, type SessionSummary } from "./shared/protocol";

/**
 * working: the main agent's turn is running.
 * waiting: the turn waits (usage limit, retry).
 * background: the turn is over but subagents, shells, monitors or workflows are still running.
 * scheduled: nothing is running, but a wakeup or cron job is armed.
 * idle: a live process with nothing going (shown like closed: nothing to look at). closed: no process.
 */
export type WorkState = "working" | "waiting" | "background" | "scheduled" | "idle" | "closed";

export interface WorkInput {
  live: boolean;
  status: RunStatus;
  /** activity items running now, by kind */
  running?: Partial<Record<ActivityKind, number>>;
  /** armed wakeups and cron jobs */
  armed?: number;
  /** its goal (/goal) is active: between the goal's turns it is still working */
  goalActive?: boolean;
  /** its soonest Tether loop or schedule run (/loop, /schedule), which runs even when it's closed */
  nextRunAt?: number;
}

const total = (r?: Partial<Record<ActivityKind, number>>) => Object.values(r ?? {}).reduce((n, x) => n + (x ?? 0), 0);

export function workState(w: WorkInput): WorkState {
  // Tether opens a closed session when one of its loops or schedules is due.
  if (!w.live) return w.nextRunAt ? "scheduled" : "closed";
  if (w.status === "running" || (w.status === "idle" && w.goalActive)) return "working";
  if (w.status === "waiting") return "waiting";
  if (total(w.running) > 0) return "background";
  if ((w.armed ?? 0) > 0 || w.nextRunAt) return "scheduled";
  return "idle";
}

const tetherWork = (s: SessionSummary): Pick<WorkInput, "goalActive" | "nextRunAt"> => ({
  ...(s.goalActive ? { goalActive: true } : {}),
  ...(s.nextRunAt ? { nextRunAt: s.nextRunAt } : {}),
});

/** From a sidebar summary: `activeCount` is running + armed, `runningKinds` the running ones. */
export function summaryWork(s: SessionSummary): WorkInput {
  const active = s.activeCount ?? 0;
  // An older runner sends only the counts: count what it says works (else all of it) as running.
  const working = s.workingCount ?? active;
  const running = s.runningKinds ?? (working ? { other: working } : undefined);
  return { live: s.live, status: s.status, running, armed: Math.max(0, active - total(running)), ...tetherWork(s) };
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
  const t = tetherWork(p.session);
  const nextRunAt = p.nextRun?.at ?? t.nextRunAt;
  return { live: p.session.live, status: p.session.status, running: p.activity, armed: p.armed, ...t, ...(nextRunAt ? { nextRunAt } : {}) };
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
      return { state, label: "Working", tooltip: w.status === "running" ? "Main agent is working" : "Working on its goal" };
    case "waiting":
      return { state, label: "Waiting", tooltip: "Waiting (usage limit or retry)" };
    case "background": {
      const what = runningLine(w.running);
      return { state, label: "Working in background", tooltip: `Main agent is idle · ${what ? `${what} still running` : "background work still running"}` };
    }
    case "scheduled":
      if (!w.armed) return { state, label: "Scheduled", tooltip: "Waiting for its next loop or scheduled run" };
      return { state, label: "Scheduled", tooltip: w.armed === 1 ? "Waiting for a scheduled wakeup" : `Waiting for ${w.armed} scheduled wakeups` };
    default:
      return { state, label: "", tooltip: "" };
  }
}
