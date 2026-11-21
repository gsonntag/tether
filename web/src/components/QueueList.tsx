// Messages waiting to go out after the running turn (SPEC §9), shared by every device: each can be
// edited, moved up or cancelled. A held queue says why and offers Resume (or waits for Back to
// Tether while the terminal drives).
//
// An edit in progress is kept per session (navigating away keeps it). If its message leaves the
// queue before the edit is saved, the edit stays: the message went out (its text is now in the
// transcript), or was removed on another device; and if the message comes back (stopped before it
// got there) the edit attaches to it again, so nothing is ever sent twice.
//
// Scheduled messages (SPEC §9 Scheduled sends) are a group of their own below, soonest first, each
// with its time: edit (text and time), send now, or cancel. They neither wait for the rest nor
// hold it, so the head's count and pause are about the others.

import { FROM_TETHER, parseSessionMessage, tetherPurpose, undefang } from "../../../shared/fromTether";
import { homeReport } from "../../../shared/homeReport";
import { useEffect, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { ArrowUpIcon, PaperAirplaneIcon, PencilIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { agentOf, type LiveState, type Msg, type QueuedMessage } from "../../../shared/transcript";
import { rpc } from "../connection";
import { viewKey } from "../store";
import { putDraft } from "./Composer";
import { useSessionCtx } from "./sessionContext";
import { lostEdit, UNKNOWN_MS } from "../queueEdit";
import { scheduled, unscheduled } from "../../../shared/schedule";
import { fromLocalInput, toLocalInput, whenLabel } from "../schedule";
import { useNow } from "./useNow";

const coarse = () => typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

/** Another session's message (SPEC §9a): shown by who sent it, and only cancelled, never edited. */
const peerOf = (text: string) => parseSessionMessage(text);

const HELD: Record<NonNullable<LiveState["queueHeldBy"]>, string> = {
  terminal: "Waiting until you're back from the terminal.",
  stopped: "Paused after Stop. Send something, or resume.",
  failed: "Paused after a failed turn.",
  restart: "Paused: the runner restarted mid-turn.",
  setup: "Held: the worktree's setup failed. Fix it, or send it anyway.",
};

/** An edit in progress: the message it's for, its text before, and the edited text (and time). */
interface Edit {
  id: string;
  original: string;
  draft: string;
  /** a scheduled message: its time as the date/time field has it */
  when?: string;
  whenOriginal?: string;
}

/** Why a scheduled message that came due waits for you. */
const STUCK: Record<NonNullable<QueuedMessage["held"]>, string> = {
  late: "Not sent: the runner was off for more than a day after its time.",
  failed: "Not sent: the send failed or the turn before it failed.",
  stopped: "Not sent: you pressed Stop while it was due.",
  restart: "Not sent: the runner restarted mid-turn and didn't continue that turn.",
  retry: "Not sent: the rate limit retry it waited behind was cancelled.",
};

/**
 * Edits by session, kept across navigation and reload (this browser's storage: an edit is yours on
 * this device until you save, send or discard it).
 */
const EDIT_KEY = (k: string) => `tether.queueEdit.${k}`;
const edits = {
  get(k: string): Edit | undefined {
    try {
      const v = JSON.parse(localStorage.getItem(EDIT_KEY(k)) ?? "null");
      return v && typeof v.id === "string" && typeof v.draft === "string" ? v : undefined;
    } catch {
      return undefined;
    }
  },
  set(k: string, e: Edit) {
    try {
      localStorage.setItem(EDIT_KEY(k), JSON.stringify(e));
    } catch {}
  },
  delete(k: string) {
    try {
      localStorage.removeItem(EDIT_KEY(k));
    } catch {}
  },
};

/** The phone's visible height is short (the keyboard is up): the queue folds to one line. */
function useShort(): boolean {
  const read = () => coarse() && (globalThis.visualViewport?.height ?? globalThis.innerHeight ?? 1000) < 500;
  const [short, setShort] = useState(read);
  useEffect(() => {
    const vv = globalThis.visualViewport;
    const f = () => setShort(read());
    vv?.addEventListener("resize", f);
    globalThis.addEventListener?.("resize", f);
    return () => {
      vv?.removeEventListener("resize", f);
      globalThis.removeEventListener?.("resize", f);
    };
  }, []);
  return short;
}

export function QueueList({ runnerId, sessionId, state, messages }: { runnerId: string; sessionId: string; state: LiveState; messages?: Msg[] }) {
  const key = viewKey(runnerId, sessionId);
  /** the Home agent's chat: Tether's reports waiting in its queue read as one line (shared/homeReport.ts) */
  const { home } = useSessionCtx();
  const [edit, setEditState] = useState<Edit | undefined>(() => edits.get(key));
  const [error, setError] = useState<string>();
  const setEdit = (e: Edit | undefined) => {
    if (e) edits.set(key, e);
    else edits.delete(key);
    setEditState(e);
  };
  const call = async (f: () => Promise<unknown>) => {
    setError(undefined);
    try {
      await f();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  // The message being edited left the queue (went out, or removed elsewhere): the edit stays, here.
  // If it comes back (stopped before it got there), the edit is attached to it again.
  // When the edited message was first seen out of the queue (to give up waiting for word after a while).
  const [outSince, setOutSince] = useState<number>();
  const out = !!edit && !state.queue.some((m) => m.id === edit.id);
  if (out && outSince === undefined) setOutSince(Date.now());
  if (!out && outSince !== undefined) setOutSince(undefined);
  const lost = edit ? lostEdit({ id: edit.id, queue: state.queue, gone: state.queueGone, outForMs: outSince === undefined ? 0 : Date.now() - outSince }) : { show: false as const };
  const gone = lost.show;
  const kind = lost.show ? lost.kind : undefined;
  const ready = lost.show && lost.ready;
  // Re-render when the wait for word runs out.
  useEffect(() => {
    if (!out || ready) return;
    const t = setTimeout(() => setOutSince((x) => (x === undefined ? x : x - 1)), UNKNOWN_MS);
    return () => clearTimeout(t);
  }, [out, ready]);
  const short = useShort();
  const now = useNow(30_000);
  const [open, setOpen] = useState(false);
  const pausedHint = state.queueHeld ? " It'll wait with the paused queue." : state.queue.length ? " It'll go after the messages waiting." : "";
  const lostPanel = edit && gone && (
    <div className="t-queue-lost" role="status">
      <div className="t-inline-status">
        {kind === "sent"
          ? "It went out before your edit was saved."
          : kind === "cancelled"
            ? "It was cancelled before your edit was saved."
            : ready
              ? "It left the queue before your edit was saved."
              : "Checking whether it went out…"}
      </div>
      <div className="t-queued-edit">
        <textarea className="t-input" value={edit.draft} aria-label="Your unsaved edit" onChange={(e) => setEdit({ ...edit, draft: e.target.value })} />
        <span className="t-edit-actions">
        <Button
          label="Send as a new message"
          size="sm"
          variant="primary"
          isDisabled={!ready}
          onClick={() =>
            void call(async () => {
              // Queued: it goes now if nothing runs and nothing waits; else in turn (never steered).
              await rpc(runnerId, "queue", { sessionId, text: edit.draft });
              setEdit(undefined);
            })
          }
        />
        <Button
          label="Copy to the message box"
          size="sm"
          variant="secondary"
          isDisabled={!ready}
          onClick={() => {
            putDraft(key, edit.draft);
            setEdit(undefined);
          }}
        />
        <Button label="Discard" size="sm" variant="ghost" onClick={() => setEdit(undefined)} />
        </span>
      </div>
      {pausedHint && <div className="t-inline-status">{pausedHint.trim()}</div>}
    </div>
  );
  if (!state.queue.length)
    return lostPanel ? (
      <div className="t-queue" aria-label="Queued messages">
        {error && <div className="t-inline-status error">{error}</div>}
        {lostPanel}
      </div>
    ) : null;
  const editable = (m: QueuedMessage) => !m.truncated && !m.shell && !peerOf(m.text);
  const save = (m: QueuedMessage) =>
    call(async () => {
      const text = edit?.draft ?? m.text;
      // Saving it empty cancels it: that's what you asked for, not an edit to keep.
      if (!text.trim()) setEdit(undefined);
      try {
        // Text and a new time in one change (a time refused keeps the edit open, nothing changed).
        // An unchanged time stays as it was (a held message stays held).
        const newTime = edit?.when !== undefined && edit.when !== edit.whenOriginal && !!text.trim();
        const at = newTime ? fromLocalInput(edit!.when!) : undefined;
        if (newTime && at === undefined) throw new Error("Pick a date and time.");
        if (newTime || (editable(m) && (text !== m.text || !text.trim()))) await rpc(runnerId, "editQueued", { sessionId, id: m.id, text: editable(m) ? text : m.text, ...(at !== undefined ? { at } : {}) });
        setEdit(undefined);
      } catch (e) {
        // It left the queue just now: the panel above keeps the edit.
        if (!/isn't waiting any more/.test((e as Error).message)) throw e;
      }
    });
  // The quiet wait after a restart (SPEC §4): nothing can release it, so no Resume.
  // A new worktree's setup runs (SPEC §4): what waits goes when it's done, so no Resume yet.
  const settingUp = state.setup === "running";
  const held = state.restartWait ? `Waiting for ${agentOf(sessionId)} from before the restart.` : settingUp ? "Waiting for the worktree's setup to finish." : state.queueHeld && state.queueHeldBy ? HELD[state.queueHeldBy] : state.queueHeld ? "Paused." : undefined;
  const plain = unscheduled(state.queue);
  const timed = scheduled(state.queue);
  const body = (m: QueuedMessage) => (
    <span className="t-queued-text">
      {m.shell ? (
        <>
          Output of <code className="t-queued-cmd">$ {m.shell.command}</code>
        </>
      ) : tetherPurpose(m.text) === "checkIn" ? (
        <span className="t-queued-from">↳ Home agent check-in</span>
      ) : home && m.text.startsWith(FROM_TETHER) ? (
        <span className="t-queued-from">↳ {homeReport(m.text)?.summary}</span>
      ) : peerOf(m.text) ? (
        <>
          <span className="t-queued-from">From “{peerOf(m.text)!.title}”{peerOf(m.text)!.all ? " · to all" : ""}:</span> {peerOf(m.text)!.text}
        </>
      ) : (
        undefang(m.text) || <em>No text</em>
      )}
      {m.truncated && !m.shell ? "…" : null}
      {m.attachments?.length ? <span className="t-queued-files"> · {m.attachments.length === 1 ? m.attachments[0]!.name : `${m.attachments.length} files`}</span> : null}
    </span>
  );
  const editor = (m: QueuedMessage) =>
    edit && (
      <div className="t-queued-edit">
        {!editable(m) ? body(m) : <textarea
          className="t-input"
          value={edit.draft}
          aria-label="Edit the queued message"
          autoFocus
          onChange={(e) => setEdit({ ...edit, draft: e.target.value })}
          onKeyDown={(e) => {
            // As in the composer: on a phone Enter is a newline and Save saves.
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && !coarse()) {
              e.preventDefault();
              void save(m);
            } else if (e.key === "Escape") setEdit(undefined);
          }}
        />}
        {edit.when !== undefined && (
          <input
            type="datetime-local"
            className="t-input t-send-later-input"
            aria-label="Send at"
            value={edit.when}
            onChange={(e) => setEdit({ ...edit, when: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void save(m);
              } else if (e.key === "Escape") setEdit(undefined);
            }}
          />
        )}
        <span className="t-edit-actions">
          <Button label="Save" size="sm" variant="primary" onClick={() => void save(m)} />
          <Button label="Cancel" size="sm" variant="ghost" onClick={() => setEdit(undefined)} />
        </span>
      </div>
    );
  const cancelBtn = (m: QueuedMessage) => (
    <button type="button" className="t-icon-btn" aria-label="Cancel this message" title="Cancel" onClick={() => void call(() => rpc(runnerId, "cancelQueued", { sessionId, id: m.id }))}>
      <XMarkIcon aria-hidden />
    </button>
  );
  const folded = short && !open && !edit;
  return (
    <div className="t-queue" aria-label="Queued messages">
      {plain.length > 0 && (
        <div className="t-queue-head">
          <span>{plain.length === 1 ? "1 message waits" : `${plain.length} messages wait`}{held ? ` · ${held}` : " for this turn to end."}</span>
          {held && state.queueHeldBy !== "terminal" && !state.restartWait && !settingUp && <Button label={state.queueHeldBy === "setup" ? "Send anyway" : "Resume"} size="sm" variant="secondary" onClick={() => void call(() => rpc(runnerId, "resumeQueue", { sessionId }))} />}
        </div>
      )}
      {error && <div className="t-inline-status error">{error}</div>}
      {lostPanel}
      {folded ? (
        <button type="button" className="t-queue-fold" aria-expanded={false} onClick={() => setOpen(true)}>
          Show the {state.queue.length === 1 ? "message" : `${state.queue.length} messages`}{timed.length ? ` (${timed.length} scheduled)` : ""} ⌄
        </button>
      ) : (
        <>
          {plain.length > 0 && (
            <ol className="t-queue-list">
              {plain.map((m, i) => (
                <li key={m.id} className="t-queued">
                  {edit?.id === m.id ? (
                    editor(m)
                  ) : (
                    <>
                      {body(m)}
                      <span className="t-queued-tools">
                        {i > 0 && (
                          <button type="button" className="t-icon-btn" aria-label="Move up" title="Move up" onClick={() => void call(() => rpc(runnerId, "moveQueued", { sessionId, id: m.id, to: i - 1 }))}>
                            <ArrowUpIcon aria-hidden />
                          </button>
                        )}
                        {editable(m) && (
                          <button type="button" className="t-icon-btn" aria-label="Edit" title="Edit" onClick={() => setEdit({ id: m.id, original: m.text, draft: m.text })}>
                            <PencilIcon aria-hidden />
                          </button>
                        )}
                        {cancelBtn(m)}
                      </span>
                    </>
                  )}
                </li>
              ))}
            </ol>
          )}
          {timed.length > 0 && (
            <>
              <div className="t-queue-head">
                <span>Scheduled</span>
              </div>
              <ol className="t-queue-list" aria-label="Scheduled messages">
                {timed.map((m) => (
                  <li key={m.id} className={`t-queued t-scheduled${m.held ? " stuck" : ""}`}>
                    {edit?.id === m.id ? (
                      editor(m)
                    ) : (
                      <>
                        <span className="t-scheduled-main">
                          <span className="t-scheduled-when">
                            {m.held ? `${STUCK[m.held]} It was for ${whenLabel(m.at!, now)}.` : m.asap ? "Sending now: goes when the session is free." : m.at! <= now ? `Due ${whenLabel(m.at!, now)}: goes when the session is free.` : `Sends ${whenLabel(m.at!, now)}`}
                          </span>
                          {body(m)}
                        </span>
                        <span className="t-queued-tools">
                          <button type="button" className="t-icon-btn" aria-label="Send now" title="Send now" onClick={() => void call(() => rpc(runnerId, "scheduleQueued", { sessionId, id: m.id, at: null }))}>
                            <PaperAirplaneIcon aria-hidden />
                          </button>
                          <button
                            type="button"
                            className="t-icon-btn"
                            aria-label="Edit"
                            title={editable(m) ? "Edit the message or its time" : "Change its time"}
                            onClick={() => {
                              // The field starts at its time: saved unchanged, the time stays (a held one stays held).
                              const when = toLocalInput(m.at!);
                              setEdit({ id: m.id, original: m.text, draft: m.text, when, whenOriginal: when });
                            }}
                          >
                            <PencilIcon aria-hidden />
                          </button>
                          {cancelBtn(m)}
                        </span>
                      </>
                    )}
                  </li>
                ))}
              </ol>
            </>
          )}
        </>
      )}
    </div>
  );
}
