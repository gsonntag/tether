// "Archive done sessions" on Home: the Home agent's check-in (runner/src/modules/homeAgent,
// homeAgentCheckIn) at a press. It asks every idle recent session whether it's done and merged,
// archives the ones git agrees are, and the result shows under Sessions until it's dismissed. While
// one runs (from here, another device, or the Home agent's chat) the button says so and waits.

import { useEffect, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Spinner } from "@astryxdesign/core/Spinner";
import { XMarkIcon } from "@heroicons/react/24/outline";
import type { CheckInStatus } from "../../../shared/protocol";
import { archiveDoneLabel, RESULT_LABELS, resultHeadline, resultRows } from "../archiveDone";
import { rpc } from "../connection";
import { openSession } from "../route";
import { folderName } from "../sessionList";
import { useStore } from "../store";

/** How often a running check-in is asked how it's going. */
const POLL_MS = 3000;

/** The runner with the Home agent, as Home's chat picks it. */
export function useHomeRunner() {
  const runner = useStore((s) => s.runners.find((r) => r.online && r.homeFolder));
  const linkOpen = useStore((s) => s.link === "open");
  return linkOpen ? runner : undefined;
}

export function useArchiveDone(runnerId: string | undefined, connectedAt: unknown) {
  const [status, setStatus] = useState<CheckInStatus>();
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string>();
  const ask = (args: { start?: boolean; dismiss?: boolean }) => rpc(runnerId!, "homeAgentCheckIn", args);

  useEffect(() => {
    setStatus(undefined);
    if (!runnerId) return;
    let gone = false;
    // A runner from before the op: no button.
    ask({})
      .then((s) => !gone && setStatus(s))
      .catch(() => {});
    return () => void (gone = true);
  }, [runnerId, connectedAt]);

  const runningId = status?.running?.id;
  useEffect(() => {
    if (!runnerId || !runningId) return;
    let gone = false;
    let t: ReturnType<typeof setTimeout>;
    const tick = () => {
      t = setTimeout(() => {
        ask({})
          .then((s) => !gone && setStatus(s))
          .catch(() => {})
          .finally(() => !gone && tick());
      }, POLL_MS);
    };
    tick();
    return () => {
      gone = true;
      clearTimeout(t);
    };
  }, [runnerId, runningId]);

  const start = async () => {
    if (starting || status?.running) return;
    setStarting(true);
    setError(undefined);
    try {
      setStatus(await ask({ start: true }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStarting(false);
    }
  };
  const dismiss = () => {
    setStatus((s) => (s ? { ...s, last: undefined } : s));
    ask({ dismiss: true })
      .then(setStatus)
      .catch(() => {});
  };
  return { status, starting, error, start, dismiss };
}

export type ArchiveDone = ReturnType<typeof useArchiveDone>;

export function ArchiveDoneButton({ a }: { a: ArchiveDone }) {
  if (!a.status) return null;
  const busy = a.starting || !!a.status.running;
  return (
    <Button
      label={archiveDoneLabel(a.status, a.starting)}
      size="sm"
      variant="ghost"
      isDisabled={busy}
      icon={busy ? <Spinner size="sm" /> : undefined}
      onClick={() => void a.start()}
    />
  );
}

export function ArchiveDoneResult({ a, runnerId }: { a: ArchiveDone; runnerId: string }) {
  const last = a.status?.last;
  if (a.error) return <div className="t-form-error">{a.error}</div>;
  if (!last || a.status?.running) return null;
  const rows = resultRows(last);
  return (
    <div className="t-checkin" role="status" aria-label="Archive done sessions result">
      <div className="t-checkin-head">
        <span>{resultHeadline(last)}</span>
        <IconButton label="Dismiss" tooltip="Dismiss" size="sm" variant="ghost" icon={<Icon icon={XMarkIcon} />} onClick={a.dismiss} />
      </div>
      {rows.length > 0 && (
        <ul className="t-checkin-rows">
          {rows.map((r) => (
            <li key={r.id} className={`t-checkin-row ${r.kind}`}>
              <span className="t-checkin-kind">{RESULT_LABELS[r.kind]}</span>
              <button type="button" className="t-link" onClick={() => openSession(runnerId, r.id)}>
                {r.title || "Untitled"}
              </button>
              <span className="t-proj">· {folderName(r.project)}</span>
              {r.reason && <span className="t-checkin-why">— {r.reason}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
