import { useState } from "react";
import type { RetryState } from "../../../shared/transcript";
import { Button } from "@astryxdesign/core/Button";
import { useNow } from "./useNow";

/** The server sends absolute instants; ceil keeps a positive second visible until it elapses. */
export function retryCountdown(retry: RetryState, now: number): number {
  return Math.max(0, Math.ceil((retry.nextAt - now) / 1000));
}

export function RateLimitRetry({ retry, onRetryNow, onCancel, onFailed, offline }: {
  retry: RetryState;
  onRetryNow: () => Promise<unknown>;
  onCancel: () => Promise<unknown>;
  onFailed: (message: string) => void;
  offline?: string;
}) {
  const now = useNow(1000);
  const [busy, setBusy] = useState(false);
  const control = (action: () => Promise<unknown>) => {
    setBusy(true);
    void action()
      .catch((error) => onFailed((error as Error).message))
      .finally(() => setBusy(false));
  };
  const seconds = retryCountdown(retry, now);
  const time = new Date(retry.nextAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return (
    <div className="t-retry-status" role="group" aria-label="Rate limit retry">
      <span className="t-sr-only" role="status" aria-live="polite" aria-atomic="true">
        {retry.extended ? `Throttled. Automatic retry scheduled for ${time}.` : `Rate limited. Automatic retry scheduled, attempt ${retry.attempt} of ${retry.maxAttempts}.`}
      </span>
      <span aria-live="off">
        {retry.extended ? (seconds ? `Throttled; retrying at ${time}` : "Throttled; retrying now") : `Rate limited · ${seconds ? `retrying in ${seconds}s` : "retrying now"} · attempt ${retry.attempt}/${retry.maxAttempts}`}
      </span>
      <div className="t-retry-actions">
        <Button label="Retry now" size="sm" variant="secondary" isDisabled={busy || !!offline} onClick={() => control(onRetryNow)} />
        <Button label={retry.extended ? "Stop" : "Cancel"} size="sm" variant="ghost" isDisabled={busy || !!offline} onClick={() => control(onCancel)} />
      </div>
    </div>
  );
}
