/** Localize the retry instant in the provider's usage-limit error for display only. */
const usageLimitPrefix = /^You[’']ve hit your usage limit\./;
const retryDate = /\btry again at ([A-Z][a-z]{2}) (\d{1,2})(?:st|nd|rd|th), (\d{4}) (\d{1,2}):(\d{2}) (AM|PM)\b/;
const months: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

/**
 * Converts only the known usage-limit retry timestamp from its UTC display form. Returns all
 * other text byte-for-byte unchanged. `timeZone` is exposed to make timezone behavior testable;
 * callers should omit it so the browser's local timezone is used.
 */
export function localizeUsageLimitRetry(text: string, timeZone?: string): string {
  if (!usageLimitPrefix.test(text)) return text;
  return text.replace(retryDate, (whole, month: string, dayText: string, yearText: string, hourText: string, minute: string, meridiem: string) => {
    const monthIndex = months[month];
    if (monthIndex === undefined) return whole;
    const year = Number(yearText);
    const day = Number(dayText);
    const hour12 = Number(hourText);
    const minuteNumber = Number(minute);
    if (hour12 < 1 || hour12 > 12 || minuteNumber > 59) return whole;
    const hour = (hour12 % 12) + (meridiem === "PM" ? 12 : 0);
    // The provider emits UTC. Validate components so malformed dates stay untouched.
    const instant = new Date(Date.UTC(year, monthIndex, day, hour, minuteNumber));
    if (instant.getUTCFullYear() !== year || instant.getUTCMonth() !== monthIndex || instant.getUTCDate() !== day) return whole;
    try {
      const options: Intl.DateTimeFormatOptions = {
        month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
      };
      if (timeZone) options.timeZone = timeZone;
      return `try again at ${new Intl.DateTimeFormat("en-US", options).format(instant)}`;
    } catch {
      return whole;
    }
  });
}
