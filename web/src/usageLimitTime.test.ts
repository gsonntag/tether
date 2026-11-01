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
  expect(localizeUsageLimitRetry(ordinary, "America/Los_Angeles")).toBe(ordinary);
  expect(localizeUsageLimitRetry(noDate, "America/Los_Angeles")).toBe(noDate);
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
