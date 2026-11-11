// The Home chat's "Waiting for N sessions to finish…": its agent's turn is over, but sessions it
// hears about (every session when it watches all of them, else the ones it follows) are still going,
// so the chat isn't done. Live from the session list; opened, it lists them with a link to each. It
// doesn't hold the composer: you can type meanwhile.

import { useEffect, useMemo } from "react";
import { ChevronRightIcon } from "@heroicons/react/24/outline";
import { Spinner } from "@astryxdesign/core/Spinner";
import { rpc } from "../connection";
import { openSession } from "../route";
import { awaitedSessions, folderName, needsPerson, waitingLine } from "../sessionList";
import { noteHomeWatch, useStore } from "../store";
import { useRowState } from "./sessionContext";

export function HomeWaiting({ runnerId }: { runnerId: string }) {
  const summaries = useStore((s) => s.summaries);
  // A runner that hasn't said yet: it watches all sessions (the default).
  const watching = useStore((s) => s.homeWatch[runnerId]) ?? { watchAll: true };
  const { rows, needs } = useMemo(() => awaitedSessions(summaries, runnerId, watching), [summaries, runnerId, watching]);
  // Which sessions it follows changes as they start and stop: asked again whenever the active ones change.
  const active = useMemo(() => {
    const s = summaries[runnerId]?.sessions ?? {};
    return Object.values(s)
      .filter((x) => x.status !== "idle" || (x.requests ?? 0) > 0)
      .map((x) => x.id)
      .sort()
      .join(" ");
  }, [summaries, runnerId]);
  useEffect(() => {
    let gone = false;
    rpc(runnerId, "homeAgentWatch", {})
      .then((r) => !gone && noteHomeWatch(runnerId, r))
      .catch(() => {});
    return () => void (gone = true);
  }, [runnerId, active]);
  const [open, setOpen] = useRowState("home-waiting", false);
  if (!rows.length) return null;
  return (
    <div className="t-home-waiting">
      <button type="button" className="t-home-waiting-line" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Spinner size="sm" />
        <span>{waitingLine(rows.length)}</span>
        {needs > 0 && <span className="t-home-waiting-needs">{needs} need{needs === 1 ? "s" : ""} you</span>}
        <ChevronRightIcon className="t-home-report-chev" aria-hidden />
      </button>
      {open && (
        <ul className="t-home-waiting-list">
          {rows.map((r) => (
            <li key={r.id}>
              <button type="button" className="t-link" onClick={() => openSession(runnerId, r.id)}>
                {r.title || "Untitled"}
              </button>
              <span className="t-home-waiting-meta">
                {" "}
                · {folderName(r.projectPath)}
                {needsPerson(r) ? <span className="t-home-waiting-needs"> · needs you</span> : " · working"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
