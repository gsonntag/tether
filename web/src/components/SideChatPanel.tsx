// A side chat beside its session (SPEC §16a): its own transcript, requests and message box, in a
// panel where the terminal panel goes (beside the transcript; over it, full screen, on a phone).
// Bring back asks it for a summary and puts that in the session's own box. Close archives it; the
// session's Side chats chip opens it again.

import { useEffect, useMemo, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { DropdownMenu, DropdownMenuItem } from "@astryxdesign/core/DropdownMenu";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Spinner } from "@astryxdesign/core/Spinner";
import { XMarkIcon } from "@heroicons/react/24/solid";
import { AGENT_NAMES } from "../../../shared/transcript";
import { rpc } from "../connection";
import { mergeRows, shownStatus, sideChatsOf, type Row } from "../sessionList";
import { billingForDisplay } from "../sourceMenu";
import { failedSend, loadOlder, openView, sendPending, useStore, viewKey } from "../store";
import { Composer } from "./Composer";
import { PendingSends, usePending } from "./PendingSends";
import { RequestDock } from "./RequestDock";
import { dropRows, SessionCtx } from "./sessionContext";
import { StatusDot } from "./SessionRow";
import { Transcript } from "./Transcript";

/** What the panel shows: a side chat being made (its question), or one by id. */
export type SideState = { opening: true; question: string } | { id: string };

/**
 * A session's side chats: live ones from the broadcast summaries, the rest (archived ones too) from
 * the runner (`listSessions {sideOf}`), fetched again when the live set changes.
 */
export function useSideChats(runnerId: string, sessionId: string, enabled: boolean): Row[] {
  const summaries = useStore((s) => s.summaries);
  const linkOpen = useStore((s) => s.link === "open");
  const live = useMemo(() => sideChatsOf(summaries, runnerId, sessionId), [summaries, runnerId, sessionId]);
  const [stored, setStored] = useState<{ for: string; rows: Row[] }>({ for: "", rows: [] });
  const k = `${runnerId}\u0000${sessionId}`;
  const liveKey = live.map((r) => `${r.id}:${r.archived ? 1 : 0}`).join(",");
  useEffect(() => {
    if (!enabled || !linkOpen) return;
    let gone = false;
    rpc(runnerId, "listSessions", { sideOf: sessionId })
      .then((r) => !gone && setStored({ for: k, rows: r.sessions.map((x) => ({ ...x, runnerId })) }))
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, [k, liveKey, enabled, linkOpen]);
  return useMemo(() => mergeRows(stored.for === k ? stored.rows : [], live), [stored, live, k]);
}

/** The session's side chats in its header: open ones first; picking one opens it in the panel. */
export function SideChatChips({ chats, onOpen }: { chats: Row[]; onOpen: (id: string) => void }) {
  if (!chats.length) return null;
  const open = chats.filter((c) => !c.archived);
  const sorted = [...open, ...chats.filter((c) => c.archived)];
  const running = open.filter((c) => shownStatus(c) !== "idle").length;
  return (
    <DropdownMenu
      renderTrigger={(p) => (
        <button type="button" className="t-chip t-side-chip" {...p} aria-label={`Side chats: ${chats.length}`}>
          {running > 0 && <StatusDot status="running" />}
          <span className="t-chip-key">Side chats</span>
          <span>{chats.length}</span>
        </button>
      )}
    >
      {sorted.map((c) => (
        <DropdownMenuItem key={c.id} label={`${c.title || "Side chat"}${c.archived ? " (closed)" : ""}`} onClick={() => onOpen(c.id)} />
      ))}
    </DropdownMenu>
  );
}

export function SideChatPanel({
  runnerId,
  side,
  onBringBack,
  onClose,
}: {
  runnerId: string;
  side: SideState;
  /** the summary, for the session's box */
  onBringBack: (text: string) => void;
  onClose: (id: string | undefined) => void;
}) {
  const id = "id" in side ? side.id : undefined;
  return (
    <aside className="t-side-chat" aria-label="Side chat">
      {id ? (
        <SideChat key={id} runnerId={runnerId} sessionId={id} onBringBack={onBringBack} onClose={() => onClose(id)} />
      ) : (
        <>
          <div className="t-side-head">
            <span className="t-side-title">Side chat</span>
            <span className="t-chip t-chip-info t-side-ro">Read only</span>
            <div className="t-side-actions">
              <IconButton label="Close side chat" size="sm" variant="ghost" icon={<Icon icon={XMarkIcon} />} onClick={() => onClose(undefined)} />
            </div>
          </div>
          <div className="t-side-opening">
            <Spinner size="sm" /> Opening a read-only fork{"question" in side && side.question ? " to ask it…" : "…"}
          </div>
        </>
      )}
    </aside>
  );
}

function SideChat({ runnerId, sessionId, onBringBack, onClose }: { runnerId: string; sessionId: string; onBringBack: (text: string) => void; onClose: () => void }) {
  const k = viewKey(runnerId, sessionId);
  useEffect(() => openView(runnerId, sessionId), [runnerId, sessionId]);
  useEffect(() => () => dropRows(runnerId, sessionId), [runnerId, sessionId]);
  const view = useStore((s) => s.views[k]);
  const summary = useStore((s) => s.summaries[runnerId]?.sessions[sessionId]) ?? view?.session;
  const linkOpen = useStore((s) => s.link === "open");
  const pending = usePending(runnerId, sessionId);
  const [bringing, setBringing] = useState(false);
  const [error, setError] = useState<string>();
  const ctx = useMemo(() => ({ runnerId, sessionId, projectPath: summary?.projectPath }), [runnerId, sessionId, summary?.projectPath]);
  const state = view?.state;
  const agent = summary ? AGENT_NAMES[summary.harness] : "The agent";
  const waiting = !!state && state.requests.length > 0;
  const running = !!state && (state.status === "running" || state.status === "waiting" || waiting || pending.some((p) => p.status === "sending"));

  const bringBack = async () => {
    setError(undefined);
    setBringing(true);
    try {
      const r = await rpc(runnerId, "bringBack", { sessionId });
      onBringBack(r.text);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBringing(false);
    }
  };

  return (
    <SessionCtx.Provider value={ctx}>
      <div className="t-side-head">
        <StatusDot status={state ? state.status : "idle"} requests={state?.requests.length} />
        <span className="t-side-title" title={summary?.title}>
          {summary?.title || "Side chat"}
        </span>
        <span className="t-chip t-chip-info t-side-ro" title={`A fork of the session in ${agent}'s read-only mode: it can read, not change anything.`}>
          Read only
        </span>
        <div className="t-side-actions">
          <Button
            label={bringing ? "Bringing back…" : "Bring back"}
            size="sm"
            variant="secondary"
            isDisabled={bringing || running || !linkOpen}
            onClick={() => void bringBack()}
            tooltip="Ask it for a short summary and put that in the session's message box"
          />
          <IconButton label="Close side chat" tooltip="Close (archives it; Side chats opens it again)" size="sm" variant="ghost" icon={<Icon icon={XMarkIcon} />} onClick={onClose} />
        </div>
      </div>
      {error && <div className="t-inline-status error t-side-error">{error}</div>}
      {!view?.window || !state ? (
        <div className="t-side-opening">{view?.error ?? <Spinner size="sm" label="Opening…" />}</div>
      ) : (
        <>
          <Transcript
            key={k}
            window={view.window}
            onOlder={() => loadOlder(runnerId, sessionId)}
            footer={
              <>
                <PendingSends runnerId={runnerId} sessionId={sessionId} list={pending} />
                {(running || bringing) && (
                  <div className="t-inline-status" style={{ padding: "8px 0 12px" }}>
                    {waiting ? "Waiting for you below." : <><Spinner size="sm" /> {bringing ? "Writing a summary…" : `${agent} is answering…`}</>}
                  </div>
                )}
              </>
            }
          />
          <RequestDock runnerId={runnerId} sessionId={sessionId} requests={state.requests} root={summary?.projectPath} />
          <Composer
            draftKey={k}
            billing={billingForDisplay(state)}
            running={running}
            waiting={waiting && state.status !== "running"}
            canSteer={!!view.capabilities?.canSteer}
            agent={agent}
            placeholder="Ask on the side (read only)"
            disabled={!linkOpen ? "Reconnecting…" : undefined}
            uploadTo={{ runnerId, sessionId }}
            onSend={async (kind, text, list) => {
              const attachments = list.length ? { attachments: list } : {};
              if (kind === "steer") await rpc(runnerId, "steer", { sessionId, text, ...attachments });
              else if (kind === "queue") await rpc(runnerId, "queue", { sessionId, text, ...attachments });
              else if (kind === "shell") throw new Error("A side chat is read-only: run commands in the session.");
              else await rpc(runnerId, "send", { sessionId, text, ...attachments, ...(kind === "stopSend" ? { stop: true } : {}) });
            }}
            sendNow={(kind, text, list) => void sendPending(runnerId, sessionId, text, list, { stop: kind === "stopSend" })}
            onStop={async () => {
              await rpc(runnerId, "interrupt", { sessionId });
            }}
            onFailed={(message) => failedSend(runnerId, sessionId, message)}
          />
        </>
      )}
    </SessionCtx.Provider>
  );
}
