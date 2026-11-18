// Send later (SPEC §9 Scheduled sends): the composer's time picker, inline above the box (no
// dialog). A preset schedules at once; a custom time takes the date/time field and Schedule. Times
// are this browser's (its time zone); the runner gets them as absolute times.

import { useEffect, useRef, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { fromLocalInput, presets, toLocalInput } from "../schedule";

export function SendLater({ onPick, onClose, busy }: { onPick: (at: number) => void; onClose: () => void; busy?: boolean }) {
  const [now] = useState(() => new Date());
  const list = presets(now);
  const [custom, setCustom] = useState(() => toLocalInput(now.getTime() + 60 * 60 * 1000));
  const [error, setError] = useState<string>();
  const first = useRef<HTMLDivElement>(null);
  useEffect(() => first.current?.querySelector("button")?.focus(), []);
  const pickCustom = () => {
    const at = fromLocalInput(custom);
    if (at === undefined) return setError("Pick a date and time.");
    if (at < Date.now() - 60_000) return setError("That time has passed. Pick a later one.");
    setError(undefined);
    onPick(at);
  };
  return (
    <div
      className="t-send-later"
      role="group"
      aria-label="Send later"
      ref={first}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <span className="t-send-later-title">Send later</span>
      <span className="t-send-later-presets">
        {list.map((p) => (
          // Computed again on the click: a picker left open a while still means "in 1 hour" from now.
          <Button key={p.key} label={p.label} size="sm" variant="secondary" isDisabled={busy} onClick={() => onPick(presets(new Date()).find((x) => x.key === p.key)?.at ?? p.at)} />
        ))}
      </span>
      <span className="t-send-later-custom">
        <input
          type="datetime-local"
          className="t-input t-send-later-input"
          aria-label="Send at"
          value={custom}
          min={toLocalInput(now.getTime())}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              pickCustom();
            }
          }}
        />
        <Button label="Schedule" size="sm" variant="primary" isDisabled={busy} onClick={pickCustom} />
        <Button label="Cancel" size="sm" variant="ghost" onClick={onClose} />
      </span>
      {error && (
        <span className="t-inline-status error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
