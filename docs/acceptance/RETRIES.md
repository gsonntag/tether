# Temporary model throttling

Use an isolated dev runner. Do not repeatedly consume production quota to manufacture a limit;
the automated fake harness tests cover repeated failures and recovery deterministically.

1. Feed Codex a failed main turn containing the reported token-limit text or a structured
   `rateLimitExceeded` error. Check the countdown appears on two browsers; reloading preserves
   the same next attempt, budget and deadline. Closing the browsers does not stop recovery.
2. Check **Retry now** skips Tether's wait when there is no provider hint; with a future retry
   hint it keeps that minimum. **Cancel** removes the wait on both devices. Stop, changing the
   model/source/credential, a direct message and opening the agent terminal cancel it too.
3. Queue a follow-up during the wait. It stays queued while the original message retries, then
   follows a successful answer. If retries exhaust, it stays paused and exactly one final failure
   notification appears. Intermediate failures produce no failure push or inbox entry.
4. Replay a failed turn after a tool call or steer. Check it is not resent and its notice explains
   how to continue. Plan exhaustion still uses its separate opt-in API fallback behavior.
5. Restart during a waiting countdown. Check the original budget and deadline survive and only
   one retry occurs. Restart with a saved dispatch in progress: it is not sent again. A native
   turn or terminal found on startup also prevents an automatic resend. Change a Claude session
   through its native TUI while the runner is down: the changed history prevents restoring its retry.
6. Use two sessions with the same credential and model/deployment. Check recovery dispatches
   are spaced. Check a different model/deployment can recover independently.

Automated coverage: `runner/src/core/retry.test.ts`, `retryPolicy.test.ts`,
`runner/src/rateLimit.test.ts`, adapter stream/private-host tests, and
`web/src/components/RateLimitRetry.test.tsx`.
