// Home's chat with the Home agent (runner/src/modules/homeAgent): say what should get done, and it
// starts a session in the right project with a full brief, then keeps it going until it's done.
// Each chat is a session like any other, shown here instead of in the lists, as a tab: several can
// be open and run at once; + starts another, and closing a tab (or `/new` / `/clear` in it) archives
// that chat. Which chats are open is the runner's, on every device at once; which tab shows is this
// device's (homeTabs.ts).
// Expand puts it over the whole window (Escape or Collapse brings it back), remembered per device.

import { useEffect, useMemo, useRef, useState } from "react";
import { HOME_COMMANDS, isHomeReset } from "../../../shared/commands";
import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { ArrowsPointingInIcon, ArrowsPointingOutIcon, PlusIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { Spinner } from "@astryxdesign/core/Spinner";
import { rpc } from "../connection";
import { setHomeChat } from "../presence";
import { failedSend, loadOlder, noteHomeChat, openView, useStore, viewKey } from "../store";
import { billingForDisplay } from "../sourceMenu";
import { escapeCollapses, loadExpanded, saveExpanded } from "../homeExpand";
import { afterClose, loadTab, NEW, pickTab, saveTab, tabLabel, tabMark, tabsOf } from "../homeTabs";
import type { HomeAgentSettings } from "../../../shared/protocol";
import type { HarnessId } from "../../../shared/transcript";
import { Composer } from "./Composer";
import { HomeAgentPickers } from "./HomeAgentSettings";
import { QueueList } from "./QueueList";
import { RateLimitRetry } from "./RateLimitRetry";
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
  /** the tabs and current chat (kept in sync across devices by the runner's homeChat broadcasts): undefined while asking */
  const known = useStore((s) => (rid ? s.homeChats[rid] : undefined));
  const [error, setError] = useState<string>();
  /** what it runs on; absent from a runner from before it could change */
  const [agent, setAgent] = useState<{ runnerId: string; settings: HomeAgentSettings; harnesses: HarnessId[] }>();
  const [expanded, setExpanded] = useState(loadExpanded);
  const expand = (on: boolean) => {
    setExpanded(on);
    saveExpanded(on);
  };
  /** the tab this device picked, per runner */
  const [picked, setPicked] = useState<{ runnerId?: string; tab?: string }>({});
  if (picked.runnerId !== rid) setPicked({ runnerId: rid, tab: rid ? loadTab(rid) : undefined });

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
        noteHomeChat(rid, { sessionId: r.sessionId, rev: r.rev ?? 0, ...(r.chats ? { chats: r.chats } : {}) });
        setAgent(r.settings ? { runnerId: rid, settings: r.settings, harnesses: r.harnesses ?? [r.settings.harness] } : undefined);
      })
      .catch((e) => !gone && setError((e as Error).message));
    return () => {
      gone = true;
    };
  }, [conn]);

  const chats = tabsOf(known);
  /** a runner from before tabs: one chat, which New chat clears */
  const oldRunner = !!known && !known.chats;
  const tab = known ? pickTab(chats, picked.tab, known.sessionId) : undefined;
  const current = tab && tab !== NEW ? tab : known ? null : undefined;
  const show = (t: string) => {
    setPicked({ runnerId: rid, tab: t });
    saveTab(rid!, t);
    setError(undefined);
  };
  const newChat = async () => {
    const r = await rpc(rid!, "homeAgentNew", {});
    noteHomeChat(rid!, { ...r, chats: oldRunner ? undefined : [...chats.filter((c) => c !== r.sessionId), r.sessionId] });
    show(r.sessionId);
    return r.sessionId;
  };
  /** closes a tab (archives its chat); `/new` and `/clear` in a tab close it for a fresh one */
  const close = async (id: string, next = afterClose(chats, id)) => {
    if (oldRunner) noteHomeChat(rid!, await rpc(rid!, "homeAgentClear", {}));
    else {
      const { rev } = await rpc(rid!, "homeAgentClose", { sessionId: id });
      const left = chats.filter((c) => c !== id);
      noteHomeChat(rid!, { rev, chats: left, ...(known?.sessionId && known.sessionId !== id ? { sessionId: known.sessionId } : left.length ? { sessionId: left.at(-1)! } : {}) });
    }
    if (tab === id) show(next);
  };
  const fail = (e: unknown) => setError((e as Error).message);

  if (!runner) return null;
  return (
    <section className={expanded ? "t-home-chat expanded" : "t-home-chat"} aria-label="Home agent">
      <div className="t-home-chat-head">
        {expanded && <span className="t-home-chat-title">Home agent</span>}
        {agent && agent.runnerId === rid && (
          <HomeAgentPickers
            runnerId={rid!}
            sessionId={current ?? undefined}
            settings={agent.settings}
            harnesses={agent.harnesses}
            onChanged={(r) => {
              setAgent({ ...agent, settings: r.settings });
              // A move: the tab in view is the chat it went on in.
              if (r.sessionId && current && r.sessionId !== current) {
                noteHomeChat(rid!, { sessionId: r.sessionId, rev: r.rev, ...(oldRunner ? {} : { chats: chats.map((c) => (c === current ? r.sessionId! : c)) }) });
                show(r.sessionId);
              }
            }}
            onError={setError}
          />
        )}
        <div className="t-home-chat-actions">
          {oldRunner && current && <Button label="New chat" size="sm" variant="ghost" clickAction={() => close(current, NEW).catch(fail)} />}
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
      {known && !oldRunner && <HomeTabs runnerId={rid!} chats={chats} tab={tab!} onShow={show} onClose={(id) => close(id).catch(fail)} />}
      {error && <div className="t-form-error">{error}</div>}
      {current ? (
        <ChatView key={current} runnerId={rid!} sessionId={current} onReset={() => close(current, NEW)} />
      ) : (
        <Composer
          draftKey={`home:${rid}`}
          running={false}
          disabled={!linkOpen ? "Reconnecting…" : current === undefined && !error ? "Connecting…" : undefined}
          placeholder={PLACEHOLDER}
          loadCommands={loadCommands}
          onSend={async (_kind, text) => {
            if (isHomeReset(text)) return;
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

/**
 * The tab strip: a tab per open chat, named by its title (double-click to rename), with a pulsing dot
 * while it works and a dot for a reply nobody read; a "New chat" tab while one is being started;
 * + for another, always in reach: the tabs scroll sideways when they don't fit (a phone).
 */
const MARK_LABELS = { running: "Working", waiting: "Needs you", failed: "Failed", unread: "New reply" } as const;

function HomeTabs({ runnerId, chats, tab, onShow, onClose }: { runnerId: string; chats: string[]; tab: string; onShow: (t: string) => void; onClose: (id: string) => void }) {
  const sessions = useStore((s) => s.summaries[runnerId]?.sessions);
  const [editing, setEditing] = useState<string>();
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    strip.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [tab, chats.length]);
  const rename = (id: string, title: string) => {
    setEditing(undefined);
    const t = title.trim();
    if (t && t !== sessions?.[id]?.title) void rpc(runnerId, "renameSession", { sessionId: id, title: t }).catch(() => {});
  };
  const marker = (m: ReturnType<typeof tabMark>) =>
    m ? <span className={`t-home-tab-mark ${m}`} role="img" aria-label={MARK_LABELS[m]} title={MARK_LABELS[m]} /> : null;
  return (
    <div className="t-home-tabbar">
      <div className="t-home-tabs" role="tablist" aria-label="Home agent chats" ref={strip}>
        {chats.map((id) => {
          const s = sessions?.[id];
          const label = tabLabel(s?.title);
          const on = id === tab;
          return (
            <div key={id} className={on ? "t-home-tab on" : "t-home-tab"} data-session={id}>
              {editing === id ? (
                <input
                  className="t-home-tab-edit"
                  aria-label="Chat name"
                  defaultValue={s?.title && label !== "New chat" ? label : ""}
                  autoFocus
                  maxLength={120}
                  onBlur={(e) => rename(id, e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") rename(id, e.currentTarget.value);
                    else if (e.key === "Escape") {
                      e.preventDefault();
                      e.stopPropagation();
                      setEditing(undefined);
                    }
                  }}
                />
              ) : (
                <button type="button" role="tab" aria-selected={on} className="t-home-tab-main" title={on ? `${label} (double-click to rename)` : label} onClick={() => onShow(id)} onDoubleClick={() => setEditing(id)}>
                  {marker(tabMark(s, on))}
                  <span className="t-home-tab-label">{label}</span>
                </button>
              )}
              <button type="button" className="t-home-tab-close" aria-label={`Close ${label}`} title="Close (archives the chat)" onClick={() => onClose(id)}>
                <XMarkIcon aria-hidden />
              </button>
            </div>
          );
        })}
        {tab === NEW && (
          <div className="t-home-tab on">
            <button type="button" role="tab" aria-selected className="t-home-tab-main">
              <span className="t-home-tab-label">New chat</span>
            </button>
            {chats.length > 0 && (
              <button type="button" className="t-home-tab-close" aria-label="Close New chat" title="Close" onClick={() => onShow(chats.at(-1)!)}>
                <XMarkIcon aria-hidden />
              </button>
            )}
          </div>
        )}
      </div>
      <button type="button" className="t-home-tab-new" aria-label="New chat" title="New chat" disabled={tab === NEW} onClick={() => onShow(NEW)}>
        <PlusIcon aria-hidden />
      </button>
    </div>
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
        {state.retry && (
          <RateLimitRetry
            retry={state.retry}
            offline={linkOpen ? undefined : "Reconnecting…"}
            onRetryNow={() => rpc(runnerId, "retryNow", { sessionId })}
            onCancel={() => rpc(runnerId, "cancelRetry", { sessionId })}
            onFailed={(message) => failedSend(runnerId, sessionId, message)}
          />
        )}
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
