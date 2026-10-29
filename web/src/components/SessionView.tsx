import { useEffect, useMemo, useRef } from "react";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Spinner } from "@astryxdesign/core/Spinner";
import { rpc } from "../connection";
import { loadModels, loadOlder, modelListKey, openView, useStore, viewKey } from "../store";
import { Composer, type ComposerHandle } from "./Composer";
import { RequestDock } from "./RequestDock";
import { SessionCtx } from "./sessionContext";
import { SessionHeader } from "./SessionHeader";
import { Transcript } from "./Transcript";
import { useChildren } from "./useChildren";
import { useFitViewport } from "./useFitViewport";

/** A session to focus the composer of once it opens (a new session just created). */
let focusNext: string | undefined;
export const focusComposerOf = (runnerId: string, sessionId: string) => (focusNext = viewKey(runnerId, sessionId));

export function SessionView({ runnerId, sessionId }: { runnerId: string; sessionId: string }) {
  const k = viewKey(runnerId, sessionId);
  useEffect(() => openView(runnerId, sessionId), [runnerId, sessionId]);
  const view = useStore((s) => s.views[k]);
  // The broadcast summary is fresher than the snapshot's copy.
  const summary = useStore((s) => s.summaries[runnerId]?.sessions[sessionId]) ?? view?.session;
  const harness = summary?.harness;
  const models = useStore((s) => (harness ? s.modelLists[modelListKey(runnerId, harness)] : undefined));
  const linkOpen = useStore((s) => s.link === "open");
  const runnerOnline = useStore((s) => s.runners.find((r) => r.id === runnerId)?.online);
  const children = useChildren(runnerId, sessionId);
  const composer = useRef<ComposerHandle>(null);
  const root = useRef<HTMLDivElement>(null);
  useFitViewport(root);

  useEffect(() => {
    if (harness && !models && linkOpen) void loadModels(runnerId, harness, sessionId);
  }, [harness, runnerId, linkOpen]);

  const ready = !!view?.window;
  useEffect(() => {
    if (ready && focusNext === k) {
      focusNext = undefined;
      composer.current?.focus();
    }
  }, [ready, k]);

  const ctx = useMemo(() => ({ runnerId, sessionId, projectPath: summary?.projectPath }), [runnerId, sessionId, summary?.projectPath]);

  if (!view?.window || !view.state || !summary) {
    if (view?.error)
      return (
        <EmptyState
          title="Can't open this session"
          description={runnerOnline === false ? "Its runner is offline. It opens here as soon as the runner is back." : view.error}
        />
      );
    return (
      <div className="t-session" style={{ alignItems: "center", justifyContent: "center" }}>
        <Spinner size="lg" label={runnerOnline === false ? "Waiting for the runner…" : "Opening…"} />
      </div>
    );
  }

  const state = view.state;
  // "waiting" (Claude waits on a request, in the dock above the composer) is busy too: Stop, not Send.
  const waiting = state.requests.length > 0;
  // Requests open with no turn running (they came back after a runner restart) are busy too:
  // Stop (Esc) closes them and leaves the session idle.
  const running = state.status === "running" || state.status === "waiting" || waiting;
  const isChild = !!summary.parentSessionId;
  const offline = !linkOpen ? "Reconnecting…" : runnerOnline === false ? "The runner is offline." : undefined;
  const empty = !running && view.window.messages.length === 0 && !view.window.hasOlder && (
    <div className="t-inline-status" style={{ padding: "16px 0" }}>
      {isChild ? "Nothing here yet." : "No messages yet. What should Claude do?"}
    </div>
  );
  const working = (running || (isChild && waiting)) && (
    <div className="t-inline-status" style={{ padding: "8px 0 12px" }}>
      {waiting ? (
        <>Waiting for you below.</>
      ) : (
        <>
          <Spinner size="sm" /> {isChild ? "Working…" : "Claude is working…"}
        </>
      )}
    </div>
  );

  return (
    <SessionCtx.Provider value={ctx}>
      <div className="t-session" ref={root}>
        <SessionHeader runnerId={runnerId} session={summary} state={state} models={models} children={children} />
        <Transcript key={k} window={view.window} onOlder={() => loadOlder(runnerId, sessionId)} footer={working || empty} />
        <RequestDock runnerId={runnerId} sessionId={sessionId} requests={state.requests} root={summary.projectPath} />
        {isChild ? (
          <div className="t-composer">
            <div className="t-composer-inner t-inline-status">A subagent's transcript. It takes its instructions from the main session.</div>
          </div>
        ) : (
          <Composer
            ref={composer}
            draftKey={k}
            running={running}
            waiting={waiting && state.status !== "running"}
            disabled={offline}
            status={state.error ? <div className="t-inline-status error">{state.error}</div> : undefined}
            onSend={async (text) => {
              await rpc(runnerId, "send", { sessionId, text });
            }}
            onStop={async () => {
              await rpc(runnerId, "interrupt", { sessionId });
            }}
          />
        )}
      </div>
    </SessionCtx.Provider>
  );
}
