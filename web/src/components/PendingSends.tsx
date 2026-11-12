// The chat's pending copies of messages sent from this page (pendingSends.ts), after its messages,
// and the row under them while the harness starts.

import { Spinner } from "@astryxdesign/core/Spinner";
import { PaperClipIcon } from "@heroicons/react/24/outline";
import type { PendingSend, StartRow } from "../pendingSends";
import { dropPending, retrySend, useStore, viewKey } from "../store";
import { putDraft } from "./Composer";

const NONE: PendingSend[] = [];

export const usePending = (runnerId: string, sessionId: string) => useStore((s) => s.pending[viewKey(runnerId, sessionId)] ?? NONE);

export function PendingSends({ runnerId, sessionId, list }: { runnerId: string; sessionId: string; list: PendingSend[] }) {
  if (!list.length) return null;
  return (
    <>
      {list.map((p) => (
        <div key={p.clientId} className={`t-msg user t-pending ${p.status}`} data-pending={p.clientId}>
          {p.text && <div className="t-bubble">{p.text}</div>}
          {p.attachments.length > 0 && (
            <div className="t-msg-files">
              {p.attachments.map((f) => (
                <span key={f.path} className="t-file" title={f.path}>
                  <PaperClipIcon className="t-file-icon" aria-hidden />
                  <span className="t-file-name">{f.name}</span>
                </span>
              ))}
            </div>
          )}
          {p.status === "failed" && (
            <div className="t-relay failed t-pending-actions" role="group" aria-label="Not sent">
              <span>Not sent.</span>
              <button type="button" className="t-link-btn" onClick={() => retrySend(runnerId, sessionId, p.clientId)}>
                Retry
              </button>
              <button
                type="button"
                className="t-link-btn"
                onClick={() => {
                  dropPending(runnerId, sessionId, p.clientId);
                  putDraft(viewKey(runnerId, sessionId), p.text);
                }}
              >
                Edit
              </button>
            </div>
          )}
        </div>
      ))}
    </>
  );
}

/** The starting row, in the running row's style; an error in the error's. */
export function StartStatus({ row }: { row: StartRow }) {
  if (row.kind === "error")
    return (
      <div className="t-inline-status t-start-error" role="alert" style={{ padding: "8px 0 12px" }}>
        {row.text}
      </div>
    );
  return (
    <div className="t-inline-status" role="status" style={{ padding: "8px 0 12px" }}>
      <Spinner size="sm" /> {row.text}
    </div>
  );
}
