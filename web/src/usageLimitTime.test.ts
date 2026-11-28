import { expect, test } from "bun:test";
import { localizeUsageLimitRetry } from "./usageLimitTime";

const message = "You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at Nov 1st, 2026 2:33 AM.";

test("localizes a retry instant across the UTC date boundary", () => {
  expect(localizeUsageLimitRetry(message, "America/Los_Angeles")).toBe(
    "You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at Oct 31, 2026, 7:33 PM PDT.",
  );
});

test("uses the timezone offset and label in effect at the retry instant across DST", () => {
  const afterFallback = message.replace("2:33 AM", "6:33 AM");
  expect(localizeUsageLimitRetry(afterFallback, "America/New_York")).toContain("Nov 1, 2026, 1:33 AM EST");
});

test("leaves normal text and usage errors without a retry date unchanged", () => {
  const ordinary = "Please retry at Nov 1st, 2026 2:33 AM.";
  const noDate = "You’ve hit your usage limit. Upgrade to Pro.";
  const ordinaryResets = "The cache resets 8:40am (UTC) every morning.";
  expect(localizeUsageLimitRetry(ordinary, "America/Los_Angeles")).toBe(ordinary);
  expect(localizeUsageLimitRetry(noDate, "America/Los_Angeles")).toBe(noDate);
  expect(localizeUsageLimitRetry(ordinaryResets, "America/Los_Angeles", Date.UTC(2026, 10, 1, 6, 0))).toBe(ordinaryResets);
});

test("a retry time without a date is the next such UTC time after the message", () => {
  const timeOnly = message.replace("Nov 1st, 2026 2:33 AM", "3:56 AM");
  const at = Date.UTC(2026, 10, 1, 1, 15);
  expect(localizeUsageLimitRetry(timeOnly, "America/Los_Angeles", at)).toContain("try again at Oct 31, 2026, 8:56 PM PDT.");
  // Past that time today: it means tomorrow.
  expect(localizeUsageLimitRetry(timeOnly, "UTC", Date.UTC(2026, 10, 1, 5, 0))).toContain("try again at Nov 2, 2026, 3:56 AM UTC.");
  // With no anchor it stays as written, and the timestamp isn't invented.
  expect(localizeUsageLimitRetry(timeOnly, "America/Los_Angeles")).toBe(timeOnly);
});

test("normalizes Codex retry times from a non-UTC runner timezone into browser local time", () => {
  // 2026-11-01 2:33 AM EST (UTC-5) = 2026-11-01T07:33Z = 2026-11-01 12:33 AM PDT (UTC-7, before LA falls back)
  expect(localizeUsageLimitRetry(message, "America/Los_Angeles", undefined, "America/New_York")).toContain(
    "try again at Nov 1, 2026, 12:33 AM PDT.",
  );
  // Time-only anchored in runner's non-UTC timezone: 2026-11-01 11:00Z = 06:00 AM EST; 8:00 AM EST = 13:00Z = 5:00 AM PST
  const timeOnly = message.replace("Nov 1st, 2026 2:33 AM", "8:00 AM");
  expect(localizeUsageLimitRetry(timeOnly, "America/Los_Angeles", Date.UTC(2026, 10, 1, 11, 0), "America/New_York")).toContain(
    "try again at Nov 1, 2026, 5:00 AM PST.",
  );
});

test("normalizes Claude Code session and weekly limit messages from UTC to browser local time", () => {
  const at = Date.UTC(2026, 10, 1, 6, 0); // 2026-11-01T06:00:00Z
  // 08:40 UTC is before LA's 09:00Z DST fall-back (1:40 AM PDT); 09:40 UTC is after (1:40 AM PST).
  expect(localizeUsageLimitRetry("You've hit your session limit · resets 8:40am (UTC)", "America/Los_Angeles", at)).toBe(
    "You've hit your session limit · resets Nov 1, 1:40 AM PDT",
  );
  expect(localizeUsageLimitRetry("You've hit your session limit · resets 9:40am (UTC)", "America/Los_Angeles", at)).toBe(
    "You've hit your session limit · resets Nov 1, 1:40 AM PST",
  );
  expect(localizeUsageLimitRetry("You've hit your weekly limit · resets 6pm (UTC)", "America/Los_Angeles", at)).toBe(
    "You've hit your weekly limit · resets Nov 1, 10:00 AM PST",
  );
  expect(localizeUsageLimitRetry("You've hit your limit · resets 8pm (Etc/UTC)", "Europe/Berlin", at)).toBe(
    "You've hit your limit · resets Nov 1, 9:00 PM GMT+1",
  );
  // Month + day without year
  expect(localizeUsageLimitRetry("You've hit your weekly limit · resets Nov 5, 6pm (UTC)", "America/Los_Angeles", at)).toBe(
    "You've hit your weekly limit · resets Nov 5, 10:00 AM PST",
  );
  expect(localizeUsageLimitRetry("You've hit your limit · resets Nov 5 at 6:30am (UTC)", "America/Los_Angeles", at)).toBe(
    "You've hit your limit · resets Nov 4, 10:30 PM PST",
  );
  // Year rollover (Dec -> Jan) includes the year
  const decAt = Date.UTC(2026, 11, 29, 12, 0);
  expect(localizeUsageLimitRetry("You've hit your weekly limit · resets Jan 2, 6pm (UTC)", "America/Los_Angeles", decAt)).toBe(
    "You've hit your weekly limit · resets Jan 2, 2027, 10:00 AM PST",
  );
  // Explicit non-UTC timezone in parentheses overrides runner timezone
  expect(localizeUsageLimitRetry("You've hit your limit · resets Nov 5, 6pm (America/New_York)", "America/Los_Angeles", at, "UTC")).toBe(
    "You've hit your limit · resets Nov 5, 3:00 PM PST",
  );
  // Without an anchor, time-only and yearless dates are left untouched
  expect(localizeUsageLimitRetry("You've hit your session limit · resets 8:40am (UTC)", "America/Los_Angeles")).toBe(
    "You've hit your session limit · resets 8:40am (UTC)",
  );
  // Unknown timezone in parentheses is left untouched
  expect(localizeUsageLimitRetry("You've hit your session limit · resets 8:40am (Not/AZone)", "America/Los_Angeles", at)).toBe(
    "You've hit your session limit · resets 8:40am (Not/AZone)",
  );
});

test("normalizes Tether fallback exhaustion and legacy move notices from UTC ISO to browser local time", () => {
  const at = Date.UTC(2026, 10, 28, 10, 0);
  const exhausted = [
    "Used every available source.",
    "1. Claude · subscription · opus — retry after 2026-11-28T14:00:00.000Z",
    "2. Codex · subscription · gpt-5 — retry after 2026-11-29T01:30:00.000Z",
    "3. Antigravity · subscription · gemini — no reset known",
  ].join("\n");
  expect(localizeUsageLimitRetry(exhausted, "America/Los_Angeles", at)).toBe(
    [
      "Used every available source.",
      "1. Claude · subscription · opus — retry after Nov 28, 6:00 AM PST",
      "2. Codex · subscription · gpt-5 — retry after Nov 28, 5:30 PM PST",
      "3. Antigravity · subscription · gemini — no reset known",
    ].join("\n"),
  );

  const legacyMoved = "Moved to this Codex session · Claude plan hit a usage limit, resets 2026-11-28T14:00:00.000Z.";
  expect(localizeUsageLimitRetry(legacyMoved, "America/Los_Angeles", at)).toBe(
    "Moved to this Codex session · Claude plan hit a usage limit, resets Nov 28, 6:00 AM PST.",
  );
});
