import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { RetryState } from "../../../shared/transcript";
import { RateLimitRetry, retryCountdown } from "./RateLimitRetry";

const retry: RetryState = { attempt: 2, maxAttempts: 5, nextAt: 28_000, deadline: 600_000, error: "429" };

test("retry countdown rounds up and reaches zero at its scheduled instant", () => {
  expect(retryCountdown(retry, 1)).toBe(28);
  expect(retryCountdown(retry, 27_001)).toBe(1);
  expect(retryCountdown(retry, 28_000)).toBe(0);
  expect(retryCountdown(retry, 29_000)).toBe(0);
});

test("retry controls render an announced wait without making the ticking countdown live", () => {
  const realNow = Date.now;
  Date.now = () => 0;
  try {
    const html = renderToStaticMarkup(
      <RateLimitRetry
        retry={retry}
        onRetryNow={() => Promise.resolve()}
        onCancel={() => Promise.resolve()}
        onFailed={() => {}}
      />,
    );
    expect(html).toContain('role="status"');
    expect(html).toContain("Automatic retry scheduled, attempt 2 of 5.");
    expect(html).toContain('aria-live="off"');
    expect(html).toContain("Rate limited · retrying in 28s · attempt 2/5");
    expect(html).toContain("Retry now");
    expect(html).toContain("Cancel");
  } finally {
    Date.now = realNow;
  }
});
