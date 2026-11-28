/** Localize reset/retry instants in usage-limit errors and fallback notices for display only. */

const codexLimitPrefix = /^You[’']ve hit your usage limit\./;
const claudeLimitPrefix = /^You[’']ve (?:hit|reached) your\b.*\blimit\b/;
const fallbackExhaustedPrefix = /^Used every available source\./;
const fallbackMovedPrefix = /^Moved to this .+ session · .+ hit a usage limit/;

const codexRetry =
  /\btry again at (?:([A-Z][a-z]{2}) (\d{1,2})(?:st|nd|rd|th)?(?:, (\d{4}))?(?:,| at)? )?(\d{1,2})(?::(\d{2}))? (AM|PM)\b(?: \(([^)\s]+)\))?/i;
const claudeReset =
  /\b(resets) (?:(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)|(?:([A-Z][a-z]{2}) (\d{1,2})(?:st|nd|rd|th)?(?:, (\d{4}))?(?:,| at)? )?(\d{1,2})(?::(\d{2}))?\s?(am|pm)\b(?: \(([^)\s]+)\))?)/i;
const fallbackRetryIso = /\bretry after (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\b/g;
const fallbackResetIso = /\bresets (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\b/;

const months: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

function resolveTimeZone(tz: string | undefined): string | undefined {
  if (!tz || tz.length > 64) return undefined;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: tz }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

function calendarDateInZone(ms: number, timeZone: string): { year: number; monthIndex: number; day: number } {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const parts: Record<string, number> = {};
  for (const p of fmt.formatToParts(ms)) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  return { year: parts.year!, monthIndex: parts.month! - 1, day: parts.day! };
}

function zonedWallTimeToDate(
  year: number,
  monthIndex: number,
  day: number,
  hour: number,
  minute: number,
  sourceZone: string,
): Date | undefined {
  const check = new Date(Date.UTC(year, monthIndex, day, hour, minute));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== monthIndex ||
    check.getUTCDate() !== day ||
    check.getUTCHours() !== hour ||
    check.getUTCMinutes() !== minute
  ) {
    return undefined;
  }
  if (sourceZone === "UTC" || sourceZone === "Etc/UTC" || sourceZone === "GMT") return check;
  const targetUtcMs = check.getTime();
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: sourceZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const wallAsUtcMs = (ms: number) => {
    const parts: Record<string, number> = {};
    for (const p of fmt.formatToParts(ms)) {
      if (p.type !== "literal") parts[p.type] = Number(p.value);
    }
    return Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour! % 24, parts.minute!);
  };
  let guess = targetUtcMs - (wallAsUtcMs(targetUtcMs) - targetUtcMs);
  const diff = wallAsUtcMs(guess) - targetUtcMs;
  if (diff !== 0) guess -= diff;
  return new Date(guess);
}

function parseClock(hourText: string, minuteText: string | undefined, meridiem: string): { hour: number; minute: number } | undefined {
  const hour12 = Number(hourText);
  const minute = minuteText === undefined ? 0 : Number(minuteText);
  if (hour12 < 1 || hour12 > 12 || minute < 0 || minute > 59) return undefined;
  const isPm = meridiem.toUpperCase() === "PM";
  return { hour: (hour12 % 12) + (isPm ? 12 : 0), minute };
}

function resolveInstant(
  monthText: string | undefined,
  dayText: string | undefined,
  yearText: string | undefined,
  hourText: string,
  minuteText: string | undefined,
  meridiem: string,
  sourceZone: string,
  at: number | undefined,
): Date | undefined {
  const clock = parseClock(hourText, minuteText, meridiem);
  if (!clock) return undefined;
  if (monthText !== undefined && dayText !== undefined) {
    const monthIndex = months[monthText.toLowerCase()];
    if (monthIndex === undefined) return undefined;
    const day = Number(dayText);
    if (yearText !== undefined) {
      return zonedWallTimeToDate(Number(yearText), monthIndex, day, clock.hour, clock.minute, sourceZone);
    }
    if (at === undefined) return undefined;
    const base = calendarDateInZone(at, sourceZone);
    let instant = zonedWallTimeToDate(base.year, monthIndex, day, clock.hour, clock.minute, sourceZone);
    // Roll into the next year if invalid this year (e.g. Feb 29) or clearly before `at` (Dec -> Jan).
    if (!instant || instant.getTime() < at - 86_400_000) {
      instant = zonedWallTimeToDate(base.year + 1, monthIndex, day, clock.hour, clock.minute, sourceZone);
    }
    return instant;
  }
  if (at === undefined) return undefined;
  const base = calendarDateInZone(at, sourceZone);
  let instant = zonedWallTimeToDate(base.year, base.monthIndex, base.day, clock.hour, clock.minute, sourceZone);
  if (!instant || instant.getTime() < at) {
    const next = new Date(Date.UTC(base.year, base.monthIndex, base.day + 1));
    instant = zonedWallTimeToDate(next.getUTCFullYear(), next.getUTCMonth(), next.getUTCDate(), clock.hour, clock.minute, sourceZone);
  }
  return instant;
}

function formatInstant(instant: Date, timeZone: string | undefined, includeYear: boolean): string | undefined {
  try {
    const options: Intl.DateTimeFormatOptions = {
      month: "short",
      day: "numeric",
      ...(includeYear ? { year: "numeric" } : {}),
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    };
    if (timeZone) options.timeZone = timeZone;
    return new Intl.DateTimeFormat("en-US", options).format(instant);
  } catch {
    return undefined;
  }
}

function sameLocalYear(a: number, b: number, timeZone: string | undefined): boolean {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", { year: "numeric", ...(timeZone ? { timeZone } : {}) });
    return fmt.format(a) === fmt.format(b);
  } catch {
    return false;
  }
}

/**
 * Converts known usage-limit retry/reset timestamps (from Codex, Claude Code, and Tether fallback
 * notices) from their explicit timezone or the runner's timezone (`sourceTimeZone`, default UTC)
 * into the browser's local timezone. Returns all other text byte-for-byte unchanged.
 *
 * `timeZone` is exposed to make timezone behavior testable; callers should omit it so the
 * browser's local timezone is used. When the provider omits the date or year, `at` (when the
 * message was made) anchors it to the next matching instant in the source timezone; without `at`,
 * the text is left alone rather than guessing a date.
 */
export function localizeUsageLimitRetry(
  text: string,
  timeZone?: string,
  at?: number,
  sourceTimeZone = "UTC",
): string {
  const defaultSourceZone = resolveTimeZone(sourceTimeZone) ?? "UTC";

  if (codexLimitPrefix.test(text)) {
    return text.replace(
      codexRetry,
      (whole, monthText: string | undefined, dayText: string | undefined, yearText: string | undefined, hourText: string, minuteText: string | undefined, meridiem: string, tzText: string | undefined) => {
        const zone = tzText ? resolveTimeZone(tzText) : defaultSourceZone;
        if (!zone) return whole;
        const instant = resolveInstant(monthText, dayText, yearText, hourText, minuteText, meridiem, zone, at);
        if (!instant) return whole;
        const formatted = formatInstant(instant, timeZone, true);
        return formatted ? `try again at ${formatted}` : whole;
      },
    );
  }

  if (claudeLimitPrefix.test(text)) {
    return text.replace(
      claudeReset,
      (whole, word: string, iso: string | undefined, monthText: string | undefined, dayText: string | undefined, yearText: string | undefined, hourText: string | undefined, minuteText: string | undefined, meridiem: string | undefined, tzText: string | undefined) => {
        let instant: Date | undefined;
        let includeYear = yearText !== undefined;
        if (iso) {
          const ms = Date.parse(iso);
          if (!Number.isFinite(ms)) return whole;
          instant = new Date(ms);
          includeYear = at === undefined || !sameLocalYear(ms, at, timeZone);
        } else if (hourText && meridiem) {
          const zone = tzText ? resolveTimeZone(tzText) : defaultSourceZone;
          if (!zone) return whole;
          instant = resolveInstant(monthText, dayText, yearText, hourText, minuteText, meridiem, zone, at);
          if (instant && !includeYear && at !== undefined) {
            includeYear = !sameLocalYear(instant.getTime(), at, timeZone);
          }
        }
        if (!instant) return whole;
        const formatted = formatInstant(instant, timeZone, includeYear);
        return formatted ? `${word} ${formatted}` : whole;
      },
    );
  }

  if (fallbackExhaustedPrefix.test(text)) {
    return text.replace(fallbackRetryIso, (whole, iso: string) => {
      const ms = Date.parse(iso);
      if (!Number.isFinite(ms)) return whole;
      const includeYear = at === undefined || !sameLocalYear(ms, at, timeZone);
      const formatted = formatInstant(new Date(ms), timeZone, includeYear);
      return formatted ? `retry after ${formatted}` : whole;
    });
  }

  if (fallbackMovedPrefix.test(text)) {
    return text.replace(fallbackResetIso, (whole, iso: string) => {
      const ms = Date.parse(iso);
      if (!Number.isFinite(ms)) return whole;
      const includeYear = at === undefined || !sameLocalYear(ms, at, timeZone);
      const formatted = formatInstant(new Date(ms), timeZone, includeYear);
      return formatted ? `resets ${formatted}` : whole;
    });
  }

  return text;
}
