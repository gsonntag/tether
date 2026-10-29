import { useEffect, useMemo, useRef } from "react";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Spinner } from "@astryxdesign/core/Spinner";
import { rpc } from "../connection";
import { loadModels, loadOlder, modelListKey, openView, useStore, viewKey } from "../store";
import { Composer, type ComposerHandle } from "./Composer";
import { SessionCtx } from "./sessionContext";
import { SessionHeader } from "./SessionHeader";
import { Transcript } from "./Transcript";
import { useChildren } from "./useChildren";

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
  const running = state.status === "running";
  const isChild = !!summary.parentSessionId;
  const offline = !linkOpen ? "Reconnecting…" : runnerOnline === false ? "The runner is offline." : undefined;
  const empty = !running && view.window.messages.length === 0 && !view.window.hasOlder && (
    <div className="t-inline-status" style={{ padding: "16px 0" }}>
      {isChild ? "Nothing here yet." : "No messages yet. What should Claude do?"}
    </div>
  );
  const working = running && (
    <div className="t-inline-status" style={{ padding: "8px 0 12px" }}>
      <Spinner size="sm" /> {isChild ? "Working…" : "Claude is working…"}
    </div>
  );

  return (
    <SessionCtx.Provider value={ctx}>
      <div className="t-session">
        <SessionHeader runnerId={runnerId} session={summary} state={state} models={models} children={children} />
        <Transcript key={k} window={view.window} onOlder={() => loadOlder(runnerId, sessionId)} footer={working || empty} />
        {isChild ? (
          <div className="t-composer">
            <div className="t-composer-inner t-inline-status">A subagent's transcript. It takes its instructions from the main session.</div>
          </div>
        ) : (
          <Composer
            ref={composer}
            draftKey={k}
            running={running}
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
