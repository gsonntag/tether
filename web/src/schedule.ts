// Send later (SPEC §9 Scheduled sends): the composer's preset times and how a scheduled time reads,
// in this browser's time zone. The runner only ever sees absolute times (ms, UTC).

export interface Preset {
  key: "hour" | "tonight" | "morning" | "tomorrow";
  label: string;
  at: number;
}

const HOUR = 60 * 60 * 1000;

/** A local wall-clock time on `base`'s day plus `days` (DST-safe: the Date fields do the calendar). */
const wall = (base: Date, days: number, hour: number) => new Date(base.getFullYear(), base.getMonth(), base.getDate() + days, hour, 0, 0, 0);

/** "9:00 PM" (or "21:00": the browser's locale says). */
export const clock = (at: number, locale?: string) => new Date(at).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });

/**
 * The presets for `now`: in 1 hour; tonight at 9 PM (while that's more than a few minutes off);
 * tomorrow at 9 AM, or this morning at 9 AM in the small hours (before 5 AM, "tomorrow morning"
 * means today).
 */
export function presets(now: Date, locale?: string): Preset[] {
  const out: Preset[] = [{ key: "hour", label: "In 1 hour", at: now.getTime() + HOUR }];
  const tonight = wall(now, 0, 21).getTime();
  if (tonight - now.getTime() > 10 * 60 * 1000) out.push({ key: "tonight", label: `Tonight ${clock(tonight, locale)}`, at: tonight });
  if (now.getHours() < 5) {
    const morning = wall(now, 0, 9).getTime();
    out.push({ key: "morning", label: `This morning ${clock(morning, locale)}`, at: morning });
  } else {
    const tomorrow = wall(now, 1, 9).getTime();
    out.push({ key: "tomorrow", label: `Tomorrow ${clock(tomorrow, locale)}`, at: tomorrow });
  }
  return out;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** A time as a `datetime-local` input's value ("2026-11-18T21:00"), in local time. */
export function toLocalInput(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A `datetime-local` input's value as a time (local wall clock), or undefined. */
export function fromLocalInput(v: string): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(v);
  if (!m) return undefined;
  const t = new Date(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!).getTime();
  return Number.isFinite(t) ? t : undefined;
}

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/**
 * When a scheduled message goes, as the queue shows it: "at 9:00 PM" (today), "tomorrow at 9:00
 * AM", "Mon at 9:00 AM" (this week), "Nov 30 at 9:00 AM", with the year when it isn't this one.
 */
export function whenLabel(at: number, now: number, locale?: string): string {
  const d = new Date(at);
  const n = new Date(now);
  const t = clock(at, locale);
  if (sameDay(d, n)) return `at ${t}`;
  if (sameDay(d, wall(n, 1, 12))) return `tomorrow at ${t}`;
  if (sameDay(d, wall(n, -1, 12))) return `yesterday at ${t}`;
  if (at > now && at - now < 6 * 24 * HOUR) return `${d.toLocaleDateString(locale, { weekday: "short" })} at ${t}`;
  const day = d.toLocaleDateString(locale, { month: "short", day: "numeric", ...(d.getFullYear() !== n.getFullYear() ? { year: "numeric" } : {}) });
  return `${day} at ${t}`;
}
