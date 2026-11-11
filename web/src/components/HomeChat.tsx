// Home's chat with the Home agent (runner/src/modules/homeAgent): say what should get done, and it
// starts a session in the right project with a full brief, then keeps it going until it's done.
// The chat is a session like any other, shown here instead of in the lists. `/new` or `/clear`
// (or New chat) drops it: the next message starts a fresh chat, on every device at once.
// Expand puts it over the whole window (Escape or Collapse brings it back), remembered per device.

import { useEffect, useMemo, useState } from "react";
import { HOME_COMMANDS, isHomeReset } from "../../../shared/commands";
import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { ArrowsPointingInIcon, ArrowsPointingOutIcon } from "@heroicons/react/24/outline";
import { Spinner } from "@astryxdesign/core/Spinner";
import { rpc } from "../connection";
import { setHomeChat } from "../presence";
import { failedSend, loadOlder, noteHomeChat, openView, useStore, viewKey } from "../store";
import { billingForDisplay } from "../sourceMenu";
import { escapeCollapses, loadExpanded, saveExpanded } from "../homeExpand";
import type { HomeAgentSettings } from "../../../shared/protocol";
import type { HarnessId } from "../../../shared/transcript";
import { Composer } from "./Composer";
import { HomeAgentPickers } from "./HomeAgentSettings";
import { QueueList } from "./QueueList";
import { RequestDock } from "./RequestDock";
import { SessionCtx } from "./sessionContext";
import { HomeWaiting } from "./HomeWaiting";
import { Transcript } from "./Transcript";

const PLACEHOLDER = "What should get done? e.g. “In tether, make the sidebar remember its width”";
const loadCommands = async () => HOME_COMMANDS;

/** Whether a popover or dialog is open over the page. */
function openLayer(): boolean {
  try {
    return !!document.querySelector('.t-home-chat-head [aria-expanded="true"], :popover-open [role="dialog"], [role="dialog"]:popover-open, :popover-open [role="menu"], [role="menu"]:popover-open, dialog[open]');
  } catch {
    // no :popover-open
    return !!document.querySelector('.t-home-chat-head [aria-expanded="true"], dialog[open]');
  }
}

export function HomeChat() {
  const runners = useStore((s) => s.runners);
  const linkOpen = useStore((s) => s.link === "open");
  const runner = runners.find((r) => r.online && r.homeFolder);
  const rid = runner?.id;
  const conn = `${rid}:${runner?.connectedAt}:${linkOpen}`;
  /** the current chat (kept in sync across devices by the runner's homeChat broadcasts): undefined while asking, null when there's none yet */
  const known = useStore((s) => (rid ? s.homeChats[rid] : undefined));
  const [error, setError] = useState<string>();
  /** what it runs on; absent from a runner from before it could change */
  const [agent, setAgent] = useState<{ runnerId: string; settings: HomeAgentSettings; harnesses: HarnessId[] }>();
  const [expanded, setExpanded] = useState(loadExpanded);
  const expand = (on: boolean) => {
    setExpanded(on);
    saveExpanded(on);
  };

  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      // Not while a picker's menu (or any dialog) is open over it: Escape closes that first.
      // (A popover's dialog stays in the page while closed: only an open one counts.)
      const layerOpen = openLayer();
      const onOwnButton = e.target instanceof Element && !!e.target.closest(".t-home-chat-actions");
      if (escapeCollapses(e, layerOpen, onOwnButton)) expand(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  useEffect(() => {
    if (!rid || !linkOpen) return;
    let gone = false;
    rpc(rid, "homeAgent", {})
      .then((r) => {
        if (gone) return;
        noteHomeChat(rid, { sessionId: r.sessionId, rev: r.rev ?? 0 });
        setAgent(r.settings ? { runnerId: rid, settings: r.settings, harnesses: r.harnesses ?? [r.settings.harness] } : undefined);
      })
      .catch((e) => !gone && setError((e as Error).message));
    return () => {
      gone = true;
    };
  }, [conn]);

  const current = known ? (known.sessionId ?? null) : undefined;
  const newChat = async () => {
    const r = await rpc(rid!, "homeAgentNew", {});
    noteHomeChat(rid!, r);
    return r.sessionId;
  };
  /** `/new`, `/clear`, New chat: the next message starts a fresh chat */
  const clear = async () => {
    noteHomeChat(rid!, await rpc(rid!, "homeAgentClear", {}));
    setError(undefined);
  };

  if (!runner) return null;
  return (
    <section className={expanded ? "t-home-chat expanded" : "t-home-chat"} aria-label="Home agent">
      <div className="t-home-chat-head">
        {expanded && <span className="t-home-chat-title">Home agent</span>}
        {agent && agent.runnerId === rid && (
          <HomeAgentPickers
            runnerId={rid!}
            settings={agent.settings}
            harnesses={agent.harnesses}
            onChanged={(r) => {
              setAgent({ ...agent, settings: r.settings });
              if (r.sessionId) noteHomeChat(rid!, { sessionId: r.sessionId, rev: r.rev });
            }}
            onError={setError}
          />
        )}
        <div className="t-home-chat-actions">
          {current && <Button label="New chat" size="sm" variant="ghost" clickAction={() => clear().catch((e) => setError((e as Error).message))} />}
          <IconButton
            label={expanded ? "Collapse the Home agent" : "Expand the Home agent"}
            tooltip={expanded ? "Collapse (Esc)" : "Expand"}
            size="sm"
            variant="ghost"
            icon={<Icon icon={expanded ? ArrowsPointingInIcon : ArrowsPointingOutIcon} />}
            onClick={() => expand(!expanded)}
          />
        </div>
      </div>
      {error && <div className="t-form-error">{error}</div>}
      {current ? (
        <ChatView key={current} runnerId={rid!} sessionId={current} onReset={clear} />
      ) : (
        <Composer
          draftKey={`home:${rid}`}
          running={false}
          disabled={!linkOpen ? "Reconnecting…" : current === undefined && !error ? "Connecting…" : undefined}
          placeholder={PLACEHOLDER}
          loadCommands={loadCommands}
          onSend={async (_kind, text) => {
            if (isHomeReset(text)) return clear();
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

function ChatView({ runnerId, sessionId, onReset }: { runnerId: string; sessionId: string; onReset: () => Promise<void> }) {
  const k = viewKey(runnerId, sessionId);
  useEffect(() => openView(runnerId, sessionId), [runnerId, sessionId]);
  useEffect(() => {
    setHomeChat({ runnerId, sessionId });
    return () => setHomeChat(undefined);
  }, [runnerId, sessionId]);
  const view = useStore((s) => s.views[k]);
  const linkOpen = useStore((s) => s.link === "open");
  const ctx = useMemo(() => ({ runnerId, sessionId, projectPath: view?.session?.projectPath, home: true }), [runnerId, sessionId, view?.session?.projectPath]);
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
            ) : running ? undefined : (
              <HomeWaiting runnerId={runnerId} />
            )
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
          loadCommands={loadCommands}
          onSend={async (kind, text, list) => {
            if (isHomeReset(text)) return onReset();
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
