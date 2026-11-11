// Home's chat with the Home agent (runner/src/modules/homeAgent): say what should get done, and it
// starts a session in the right project with a full brief, then keeps it going until it's done.
// The chat is a session like any other, shown here instead of in the lists.

import { useEffect, useMemo, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Spinner } from "@astryxdesign/core/Spinner";
import { rpc } from "../connection";
import { setHomeChat } from "../presence";
import { failedSend, loadOlder, openView, useStore, viewKey } from "../store";
import { billingForDisplay } from "../sourceMenu";
import { Composer } from "./Composer";
import { QueueList } from "./QueueList";
import { RequestDock } from "./RequestDock";
import { SessionCtx } from "./sessionContext";
import { Transcript } from "./Transcript";

const PLACEHOLDER = "What should get done? e.g. “In tether, make the sidebar remember its width”";

export function HomeChat() {
  const runners = useStore((s) => s.runners);
  const linkOpen = useStore((s) => s.link === "open");
  const runner = runners.find((r) => r.online && r.homeFolder);
  const rid = runner?.id;
  const conn = `${rid}:${runner?.connectedAt}:${linkOpen}`;
  /** the current chat: undefined while asking, null when there's none yet */
  const [chat, setChat] = useState<{ runnerId: string; sessionId: string | null }>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!rid || !linkOpen) return;
    let gone = false;
    rpc(rid, "homeAgent", {})
      .then((r) => !gone && setChat({ runnerId: rid, sessionId: r.sessionId ?? null }))
      .catch((e) => !gone && setError((e as Error).message));
    return () => {
      gone = true;
    };
  }, [conn]);

  const current = chat && chat.runnerId === rid ? chat.sessionId : undefined;
  const newChat = async () => {
    const { sessionId } = await rpc(rid!, "homeAgentNew", {});
    setChat({ runnerId: rid!, sessionId });
    return sessionId;
  };

  if (!runner) return null;
  return (
    <section className="t-home-chat" aria-label="Home agent">
      {current && (
        <div className="t-home-chat-head">
          <Button label="New chat" size="sm" variant="ghost" clickAction={() => newChat().then(() => {})} />
        </div>
      )}
      {error && <div className="t-form-error">{error}</div>}
      {current ? (
        <ChatView key={current} runnerId={rid!} sessionId={current} />
      ) : (
        <Composer
          draftKey={`home:${rid}`}
          running={false}
          disabled={!linkOpen ? "Reconnecting…" : current === undefined && !error ? "Connecting…" : undefined}
          placeholder={PLACEHOLDER}
          onSend={async (_kind, text) => {
            const sessionId = await newChat();
            await rpc(rid!, "send", { sessionId, text });
          }}
          onStop={async () => {}}
          onFailed={(message) => setError(message)}
        />
      )}
    </section>
  );
}

function ChatView({ runnerId, sessionId }: { runnerId: string; sessionId: string }) {
  const k = viewKey(runnerId, sessionId);
  useEffect(() => openView(runnerId, sessionId), [runnerId, sessionId]);
  useEffect(() => {
    setHomeChat({ runnerId, sessionId });
    return () => setHomeChat(undefined);
  }, [runnerId, sessionId]);
  const view = useStore((s) => s.views[k]);
  const linkOpen = useStore((s) => s.link === "open");
  const ctx = useMemo(() => ({ runnerId, sessionId, projectPath: view?.session?.projectPath }), [runnerId, sessionId, view?.session?.projectPath]);
  if (!view?.window || !view.state) {
    return <div className="t-inline-status">{view?.error ?? <Spinner size="sm" label="Opening…" />}</div>;
  }
  const state = view.state;
  const waiting = state.requests.length > 0;
  const running = state.status === "running" || state.status === "waiting" || waiting;
  return (
    <SessionCtx.Provider value={ctx}>
      <div className="t-session t-home-chat-box">
        <Transcript
          key={k}
          window={view.window}
          onOlder={() => loadOlder(runnerId, sessionId)}
          footer={
            running && !waiting ? (
              <div className="t-inline-status" style={{ padding: "8px 0 12px" }}>
                <Spinner size="sm" /> Working…
              </div>
            ) : undefined
          }
        />
        <RequestDock runnerId={runnerId} sessionId={sessionId} requests={state.requests} root={view.session?.projectPath} />
        <QueueList runnerId={runnerId} sessionId={sessionId} state={state} messages={view.window.messages} />
        <Composer
          draftKey={k}
          billing={billingForDisplay(state)}
          running={running}
          waiting={waiting && state.status !== "running"}
          canSteer={!!view.capabilities?.canSteer}
          disabled={linkOpen ? undefined : "Reconnecting…"}
          placeholder="Reply, or ask for something else"
          uploadTo={{ runnerId, sessionId }}
          onSend={async (kind, text, list) => {
            const attachments = list.length ? { attachments: list } : {};
            if (kind === "steer") await rpc(runnerId, "steer", { sessionId, text, ...attachments });
            else if (kind === "queue") await rpc(runnerId, "queue", { sessionId, text, ...attachments });
            else await rpc(runnerId, "send", { sessionId, text, ...attachments, ...(kind === "stopSend" ? { stop: true } : {}) });
          }}
          onStop={async () => {
            await rpc(runnerId, "interrupt", { sessionId });
          }}
          onFailed={(message) => failedSend(runnerId, sessionId, message)}
        />
      </div>
    </SessionCtx.Provider>
  );
}
