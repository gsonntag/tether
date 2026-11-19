// The Home agent's switches (runner/src/modules/homeAgent), each on unless turned off and applied at
// once, apart from the form's Apply:
// - "Watch all sessions" (watch): whether it hears when sessions it didn't start finish a turn, fail
//   or wait for the person.
// - "Reply by text" (replyByText): whether its Texts tab answers the person's iMessages, and reports
//   on the work they texted for, by text. Paused (only their own texts answered) after they tell it
//   to stop texting, until they text again or press Resume.

import { useCallback, useEffect, useState } from "react";
import { rpc } from "../connection";
import { noteHomeWatch } from "../store";

function Toggle({ label, read, write }: { label: string; read: () => Promise<boolean>; write: (on: boolean) => Promise<boolean> }) {
  const [on, setOn] = useState<boolean>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let gone = false;
    read()
      .then((v) => !gone && setOn(v))
      .catch(() => !gone && setOn(undefined));
    return () => void (gone = true);
  }, [read]);
  if (on === undefined) return null;
  return (
    <>
      <label className="t-check">
        <input
          type="checkbox"
          checked={on}
          onChange={(e) => {
            const next = e.target.checked;
            setOn(next);
            setError(undefined);
            write(next)
              .then(setOn)
              .catch((err) => {
                setOn(!next);
                setError((err as Error).message);
              });
          }}
        />
        <span>{label}</span>
      </label>
      {error && <div className="t-form-error">{error}</div>}
    </>
  );
}

export function WatchAllToggle({ runnerId }: { runnerId: string }) {
  const read = useCallback(() => rpc(runnerId, "homeAgentWatch", {}).then((r) => (noteHomeWatch(runnerId, r), r.watchAll)), [runnerId]);
  return (
    <Toggle
      label="Watch all sessions"
      read={read}
      write={(on) => rpc(runnerId, "homeAgentWatch", { on }).then((r) => (noteHomeWatch(runnerId, r), r.watchAll))}
    />
  );
}

export function ReplyByTextToggle({ runnerId }: { runnerId: string }) {
  const [paused, setPaused] = useState(false);
  const read = useCallback(() => rpc(runnerId, "homeAgentReplyByText", {}).then((r) => (setPaused(!!r.paused), r.replyByText)), [runnerId]);
  const write = (on: boolean) => rpc(runnerId, "homeAgentReplyByText", { on }).then((r) => (setPaused(!!r.paused), r.replyByText));
  return (
    <>
      <Toggle label="Reply by text" read={read} write={write} />
      {paused && (
        <div className="t-settings-note">
          Paused: you asked Home to stop texting, so it only answers your texts until you text it again.{" "}
          <button type="button" className="t-link" onClick={() => void write(true).catch(() => {})}>
            Resume
          </button>
        </div>
      )}
    </>
  );
}
