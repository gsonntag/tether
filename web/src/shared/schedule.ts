// How a session's loops and schedules (/loop, /schedule, runner/src/schedule.ts) read: shared by
// the runner's notices and the schedule list under the goal line.

import type { SessionSchedule } from "./protocol";

const two = (n: number) => String(n).padStart(2, "0");
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "14:20", "Tomorrow 09:00", "Mon 09:00" (within a week), "Oct 20 09:00", in local time. */
export function fmtWhen(at: number, now = Date.now()): string {
  const d = new Date(at);
  const time = `${two(d.getHours())}:${two(d.getMinutes())}`;
  const day = (t: number) => {
    const x = new Date(t);
    return new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  };
  const days = Math.round((day(at) - day(now)) / 86_400_000);
  if (days <= 0) return time;
  if (days === 1) return `Tomorrow ${time}`;
  if (days < 7) return `${DAYS[d.getDay()]} ${time}`;
  return `${MONTHS[d.getMonth()]} ${d.getDate()} ${time}`;
}

/** "Loop", "Schedule" or "Once" */
export function kindLabel(s: Pick<SessionSchedule, "kind">): string {
  return s.kind === "loop" ? "Loop" : s.kind === "cron" ? "Schedule" : "Once";
}

/** Soonest first. */
export function bySoonest(a: SessionSchedule, b: SessionSchedule): number {
  return a.nextAt - b.nextAt || a.createdAt - b.createdAt;
}
