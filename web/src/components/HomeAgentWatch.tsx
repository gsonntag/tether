// "Watch all sessions" (runner/src/modules/homeAgent watch): whether the Home agent hears when
// sessions it didn't start finish a turn, fail or wait for the person. On unless turned off; it
// applies at once, apart from the form's Apply.

import { useEffect, useState } from "react";
import { rpc } from "../connection";

export function WatchAllToggle({ runnerId }: { runnerId: string }) {
  const [on, setOn] = useState<boolean>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let gone = false;
    rpc(runnerId, "homeAgentWatch", {})
      .then((r) => !gone && setOn(r.watchAll))
      .catch(() => !gone && setOn(undefined));
    return () => void (gone = true);
  }, [runnerId]);
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
            rpc(runnerId, "homeAgentWatch", { on: next })
              .then((r) => setOn(r.watchAll))
              .catch((err) => {
                setOn(!next);
                setError((err as Error).message);
              });
          }}
        />
        <span>Watch all sessions</span>
      </label>
      {error && <div className="t-form-error">{error}</div>}
    </>
  );
}
