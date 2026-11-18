// Scheduled sends (SPEC §9): a queued message with a time (`QueuedMessage.at`). It sits in the same
// queue (runner.json, every device sees and changes it), but apart from the rest: it goes at its
// time whether or not the other messages are held, and it never holds them (SPEC §9).

import type { QueuedMessage } from "./transcript";

/** The runner was off this long after a message's time: it waits for you instead of going late. */
export const SCHEDULE_LATE_MAX_MS = 24 * 60 * 60 * 1000;
/** Sent at least this late: a notice says when it was scheduled for. */
export const SCHEDULE_LATE_NOTE_MS = 2 * 60 * 1000;
/** How far ahead a message can be scheduled. */
export const SCHEDULE_AHEAD_MAX_MS = 366 * 24 * 60 * 60 * 1000;
/** A time this far in the past still counts as now (a picker's "now", clocks a little apart). */
export const SCHEDULE_PAST_SLACK_MS = 60 * 1000;

export const isScheduled = (m: QueuedMessage) => typeof m.at === "number";
/** The messages that go one per turn, in order (not the scheduled ones). */
export const unscheduled = (q: QueuedMessage[]) => q.filter((m) => !isScheduled(m));
/** Scheduled messages, soonest first. */
export const scheduled = (q: QueuedMessage[]) => q.filter(isScheduled).sort((a, b) => a.at! - b.at!);
/** The next scheduled message's time that will go by itself (not one waiting for you). */
export const nextScheduled = (q: QueuedMessage[]) => scheduled(q).find((m) => !m.held)?.at;

/** Why a time can't be scheduled, or undefined. */
export function badScheduleTime(at: unknown, now: number): string | undefined {
  if (typeof at !== "number" || !Number.isFinite(at)) return "Pick a time to send it.";
  if (at < now - SCHEDULE_PAST_SLACK_MS) return "That time has passed. Pick a later one.";
  if (at > now + SCHEDULE_AHEAD_MAX_MS) return "Pick a time within a year.";
  return undefined;
}

/** Messages that go before one queued now: the unscheduled ones, and scheduled ones already due. */
export const waitingNow = (q: QueuedMessage[], now: number) => q.some((m) => !isScheduled(m) || (!m.held && m.at! <= now));
