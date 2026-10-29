// Messages waiting to go out after the running turn (SPEC §9), shared by every device: each can be
// edited, moved up or cancelled. A held queue says why and offers Resume (or waits for Back to
// Tether while the terminal drives).

import { useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { ArrowUpIcon, PencilIcon, XMarkIcon } from "@heroicons/react/24/outline";
import type { LiveState, QueuedMessage } from "../../../shared/transcript";
import { rpc } from "../connection";

const coarse = () => typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

const HELD: Record<NonNullable<LiveState["queueHeldBy"]>, string> = {
  terminal: "Waiting until you're back from the terminal.",
  stopped: "Paused after Stop. Send something, or resume.",
  failed: "Paused after a failed turn.",
  restart: "Paused: the runner restarted mid-turn.",
};

export function QueueList({ runnerId, sessionId, state }: { runnerId: string; sessionId: string; state: LiveState }) {
  const [editing, setEditing] = useState<string>();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string>();
  if (!state.queue.length) return null;
  const call = async (f: () => Promise<unknown>) => {
    setError(undefined);
    try {
      await f();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const save = (m: QueuedMessage) =>
    call(async () => {
      await rpc(runnerId, "editQueued", { sessionId, id: m.id, text: draft });
      setEditing(undefined);
    });
  const held = state.queueHeld && state.queueHeldBy ? HELD[state.queueHeldBy] : state.queueHeld ? "Paused." : undefined;
  return (
    <div className="t-queue" aria-label="Queued messages">
      <div className="t-queue-head">
        <span>{state.queue.length === 1 ? "1 message waits" : `${state.queue.length} messages wait`}{held ? ` · ${held}` : " for this turn to end."}</span>
        {held && state.queueHeldBy !== "terminal" && <Button label="Resume" size="sm" variant="secondary" onClick={() => void call(() => rpc(runnerId, "resumeQueue", { sessionId }))} />}
      </div>
      {error && <div className="t-inline-status error">{error}</div>}
      <ol className="t-queue-list">
        {state.queue.map((m, i) => (
          <li key={m.id} className="t-queued">
            {editing === m.id ? (
              <div className="t-queued-edit">
                <textarea
                  className="t-input"
                  value={draft}
                  aria-label="Edit the queued message"
                  autoFocus
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    // As in the composer: on a phone Enter is a newline and Save saves.
                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && !coarse()) {
                      e.preventDefault();
                      void save(m);
                    } else if (e.key === "Escape") setEditing(undefined);
                  }}
                />
                <Button label="Save" size="sm" variant="primary" onClick={() => void save(m)} />
                <Button label="Cancel" size="sm" variant="ghost" onClick={() => setEditing(undefined)} />
              </div>
            ) : (
              <>
                <span className="t-queued-text">
                  {m.shell ? (
                    <>
                      Output of <code className="t-queued-cmd">$ {m.shell.command}</code>
                    </>
                  ) : (
                    m.text || <em>No text</em>
                  )}
                  {m.truncated && !m.shell ? "…" : null}
                  {m.attachments?.length ? <span className="t-queued-files"> · {m.attachments.length === 1 ? m.attachments[0]!.name : `${m.attachments.length} files`}</span> : null}
                </span>
                <span className="t-queued-tools">
                  {i > 0 && (
                    <button type="button" className="t-icon-btn" aria-label="Move up" title="Move up" onClick={() => void call(() => rpc(runnerId, "moveQueued", { sessionId, id: m.id, to: i - 1 }))}>
                      <ArrowUpIcon aria-hidden />
                    </button>
                  )}
                  {!m.truncated && !m.shell && <button
                    type="button"
                    className="t-icon-btn"
                    aria-label="Edit"
                    title="Edit"
                    onClick={() => {
                      setDraft(m.text);
                      setEditing(m.id);
                    }}
                  >
                    <PencilIcon aria-hidden />
                  </button>}
                  <button type="button" className="t-icon-btn" aria-label="Cancel this message" title="Cancel" onClick={() => void call(() => rpc(runnerId, "cancelQueued", { sessionId, id: m.id }))}>
                    <XMarkIcon aria-hidden />
                  </button>
                </span>
              </>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
