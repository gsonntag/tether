import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Spinner } from "@astryxdesign/core/Spinner";
import { AGENT_NAMES, HARNESS_LABELS } from "../../../shared/transcript";
import { rpc } from "../connection";
import { openSession } from "../route";
import { loadModels, loadOlder, modelListKey, openView, useStore, viewKey } from "../store";
import { handoffPrompt } from "../terminal";
import { Composer, type ComposerHandle } from "./Composer";
import { QueueList } from "./QueueList";
import { backQuestion, SHELL_TAB, TerminalPanel, type PanelState } from "./TerminalPanel";
import { RequestDock } from "./RequestDock";
import { dropRows, SessionCtx } from "./sessionContext";
import { SessionHeader } from "./SessionHeader";
import { Transcript } from "./Transcript";
import { useChildren } from "./useChildren";
import { useFitViewport } from "./useFitViewport";
import { PanelHandle } from "./WidthHandle";

/** A session to focus the composer of once it opens (a new session just created). */
let focusNext: string | undefined;
export const focusComposerOf = (runnerId: string, sessionId: string) => (focusNext = viewKey(runnerId, sessionId));
/** A session to open with its terminal panel showing (a new session started in the terminal). */
let terminalNext: string | undefined;
export const openTerminalOf = (runnerId: string, sessionId: string) => (terminalNext = viewKey(runnerId, sessionId));

export function SessionView({ runnerId, sessionId }: { runnerId: string; sessionId: string }) {
  const k = viewKey(runnerId, sessionId);
  useEffect(() => openView(runnerId, sessionId), [runnerId, sessionId]);
  useEffect(() => () => dropRows(runnerId, sessionId), [runnerId, sessionId]);
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
  const [panel, setPanel] = useState<PanelState | null>(() => {
    if (terminalNext !== k) return null;
    terminalNext = undefined;
    return { tab: "tui", wantTui: true, nonce: 1 };
  });
  /** the question before handing a busy session to the terminal (SPEC §8) */
  const [ask, setAsk] = useState<{ text: string; confirm: string } | null>(null);
  /** Back to Tether from the banner (panel closed): asked first, as from the panel */
  const [askBack, setAskBack] = useState(false);
  // Asked while the TUI drove: moot once it doesn't (another device went back, it exited).
  const drives = view?.state?.mode === "terminal";
  useEffect(() => {
    if (!drives) setAskBack(false);
  }, [drives]);
  // The TUI moved on to another session (/clear, /resume): follow it there, panel and all.
  // Only a move seen while open: one from before (in the first snapshot) is left to the notice.
  const loaded = !!view?.state;
  const continuedIn = view?.state?.continuedIn;
  const seenContinued = useRef<string | undefined | null>(null);
  useEffect(() => {
    if (!loaded) return;
    if (seenContinued.current === null) return void (seenContinued.current = continuedIn);
    if (!continuedIn || continuedIn === seenContinued.current) return;
    seenContinued.current = continuedIn;
    if (panel) openTerminalOf(runnerId, continuedIn);
    openSession(runnerId, continuedIn);
  }, [loaded, continuedIn]);

  // The TUI went away (Back to Tether, or it exited), whichever tab was in front: opening it again
  // is a new handoff, asked first when busy, never a reattach to what was (SPEC §8).
  // The handoff question belongs to the agent's tab: going to a shell dismisses it.
  const panelTab = panel?.tab;
  useEffect(() => {
    if (panelTab && panelTab !== "tui") setAsk(null);
  }, [panelTab]);
  const tuiRunsNow = !!view?.state && (view.state.mode === "terminal" || !!view.state.terminal);
  const tuiRan = useRef(tuiRunsNow);
  useEffect(() => {
    if (tuiRan.current && !tuiRunsNow) setPanel((p) => (p?.wantTui ? { ...p, wantTui: false, stop: false } : p));
    tuiRan.current = tuiRunsNow;
  }, [tuiRunsNow]);

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
  const inTerminal = state.mode === "terminal";
  const agent = AGENT_NAMES[summary.harness];
  // "waiting" (Claude waits on a request, in the dock above the composer) is busy too: Stop, not Send.
  const waiting = state.requests.length > 0;
  // Requests open with no turn running (they came back after a runner restart) are busy too:
  // Stop (Esc) closes them and leaves the session idle. In the terminal the TUI takes what you type
  // whenever: never busy for the composer (SPEC §9).
  const running = !inTerminal && (state.status === "running" || state.status === "waiting" || waiting);

  const shared = view.capabilities?.terminal === "shared";
  /**
   * The agent's terminal: its TUI tab, asking first when the session is busy (SPEC §8). From the
   * panel's own tab, the question shows in the panel and the panel stays open on that tab.
   */
  const openTerminal = (stop = false) => {
    setAsk(null);
    const handsOff = !shared && !inTerminal && !state.terminal;
    const q = handsOff && !stop ? handoffPrompt(state.status !== "idle" || waiting, state.queue.length, !!state.queueHeld && state.queueHeldBy !== "terminal") : null;
    if (q) {
      setPanel((p) => (p ? { ...p, tab: "tui", hidden: false } : p));
      return setAsk(q);
    }
    setPanel((p) => ({ tab: "tui", wantTui: true, stop, nonce: (p?.nonce ?? 0) + 1 }));
  };
  /** A project shell beside the chat (SPEC §8): the session stays live in Tether, nothing is handed over. */
  const openShell = () => {
    setAsk(null);
    setPanel((p) => ({ tab: SHELL_TAB, wantTui: !!p?.wantTui, nonce: (p?.nonce ?? 0) + 1 }));
  };
  const panelShown = !!panel && !panel.hidden;
  // ❯_ opens a project shell beside the chat (SPEC §8); nothing is handed over. Open, it closes the
  // panel (or, on a phone where the panel is tucked behind the chat, shows it again).
  const terminalChip = !summary.parentSessionId && (
    <button
      type="button"
      className="t-chip t-chip-term"
      aria-label="Terminal"
      aria-pressed={panelShown}
      title={panel ? undefined : `A shell in this folder, beside the chat. ${agent} stays driven from here.`}
      onClick={() => (panel ? setPanel(panelShown ? null : { ...panel, hidden: false }) : openShell())}
    >
      <span aria-hidden>❯_</span>
      <span>Terminal</span>
    </button>
  );
  const isChild = !!summary.parentSessionId;
  const offline = !linkOpen ? "Reconnecting…" : runnerOnline === false ? "The runner is offline." : undefined;
  const empty = !running && view.window.messages.length === 0 && !view.window.hasOlder && (
    <div className="t-inline-status" style={{ padding: "16px 0" }}>
      {isChild ? "Nothing here yet." : `No messages yet. What should ${agent} do?`}
    </div>
  );
  const working = (running || (isChild && waiting)) && (
    <div className="t-inline-status" style={{ padding: "8px 0 12px" }}>
      {waiting ? (
        <>Waiting for you below.</>
      ) : (
        <>
          <Spinner size="sm" /> {isChild ? "Working…" : `${agent} is working…`}
        </>
      )}
    </div>
  );

  const terminalBar = inTerminal && (
    <div className={`t-term-banner${state.status === "waiting" ? " waiting" : ""}`} role="status">
      <span className="t-term-banner-text">
        {state.terminal?.returning
          ? "Going back to Tether…"
          : state.status === "waiting"
            ? `Needs you in the terminal${state.terminal?.attention ? `: ${state.terminal.attention}` : "."}`
            : "Driving in the terminal"}
      </span>
      {!panel && !state.terminal?.returning && <Button label={`Open ${HARNESS_LABELS[summary.harness]}`} size="sm" variant="secondary" onClick={() => openTerminal()} />}
      {/* A phone with the panel tucked behind the chat: the banner is the way back too. */}
      {(!panel || panel.hidden) && !state.terminal?.returning && (
        <Button label="Back to Tether" size="sm" variant="secondary" onClick={() => setAskBack(true)} />
      )}
      {(!panel || panel.hidden) && askBack && !state.terminal?.returning && (
        <div className="t-term-ask" role="group" aria-label="Back to Tether">
          <span>{backQuestion(HARNESS_LABELS[summary.harness])}</span>
          <Button
            label="Close and go back"
            size="sm"
            variant="primary"
            onClick={() => {
              setAskBack(false);
              void rpc(runnerId, "endTerminal", { sessionId }).catch(() => {});
            }}
          />
          <Button label="Stay" size="sm" variant="ghost" onClick={() => setAskBack(false)} />
        </div>
      )}
    </div>
  );

  return (
    <SessionCtx.Provider value={ctx}>
      <div className={`t-session-split${panel ? " with-terminal" : ""}`} ref={root}>
      <div className="t-session">
        <SessionHeader runnerId={runnerId} session={summary} state={state} models={models} children={children} extra={terminalChip} capabilities={view.capabilities} />
        {ask && !panelShown && (
          <div className="t-term-ask" role="group" aria-label="Open the terminal">
            <span>{ask.text}</span>
            <Button label={ask.confirm} size="sm" variant="primary" onClick={() => openTerminal(true)} />
            <Button label="Keep working" size="sm" variant="secondary" onClick={() => setAsk(null)} />
          </div>
        )}
        <Transcript key={k} window={view.window} onOlder={() => loadOlder(runnerId, sessionId)} footer={inTerminal ? empty : working || empty} />
        {terminalBar}
        {panel?.hidden && (
          // A phone, the shell tucked behind the chat: one tap back to it.
          <button type="button" className="t-term-return" onClick={() => setPanel({ ...panel, hidden: false })}>
            <span aria-hidden>❯_</span> {panel.tab === "tui" ? `Back to ${HARNESS_LABELS[summary.harness]}` : "Back to the shell"}
          </button>
        )}
        <RequestDock runnerId={runnerId} sessionId={sessionId} requests={state.requests} root={summary.projectPath} />
        {!isChild && <QueueList runnerId={runnerId} sessionId={sessionId} state={state} messages={view.window.messages} />}
        {isChild && view.capabilities?.subagents.steer && state.mode === "live" ? (
          // A running subagent you can message (SPEC §6a): directly into its turn, or passed on by the
          // main agent ("via-parent"); either way it shows here as yours.
          <Composer
            ref={composer}
            draftKey={k}
            running
            steerOnly
            agent="The subagent"
            disabled={offline}
            uploadTo={{ runnerId, sessionId }}
            onSend={async (_kind, text, attachments) => {
              await rpc(runnerId, "steer", { sessionId, text, ...(attachments.length ? { attachments } : {}) });
            }}
            onStop={async () => {
              await rpc(runnerId, "interrupt", { sessionId });
            }}
          />
        ) : isChild ? (
          <div className="t-composer">
            <div className="t-composer-inner t-inline-status">A subagent's transcript. It takes its instructions from the main session.</div>
          </div>
        ) : (
          <Composer
            ref={composer}
            draftKey={k}
            running={running}
            waiting={waiting && state.status !== "running"}
            canSteer={!!view.capabilities?.canSteer}
            inTerminal={inTerminal}
            disabled={
              offline ??
              (state.terminal?.returning ? "Going back to Tether…" : undefined)
            }
            // While the TUI drives, a message waits in the queue for Back to Tether (SPEC §8).
            placeholder={inTerminal ? (state.queueHeld && state.queueHeldBy !== "terminal" ? `Joins the paused queue: it goes when you resume it, after Back to Tether` : `${agent} gets this when you go Back to Tether`) : undefined}
            agent={agent}
            uploadTo={{ runnerId, sessionId }}
            shell={{ folder: summary.projectPath, heldBy: state.queueHeld ? state.queueHeldBy : undefined }}
            status={state.error ? <div className="t-inline-status error">{state.error}</div> : undefined}
            onSend={async (kind, text, list) => {
              const attachments = list.length ? { attachments: list } : {};
              // A `!` command: runs now, whatever the agent does (SPEC §9 Shell commands).
              if (kind === "shell") await rpc(runnerId, "runShell", { sessionId, command: text });
              else if (kind === "steer") await rpc(runnerId, "steer", { sessionId, text, ...attachments });
              else if (kind === "queue") await rpc(runnerId, "queue", { sessionId, text, ...attachments });
              else await rpc(runnerId, "send", { sessionId, text, ...attachments, ...(kind === "stopSend" ? { stop: true } : {}) });
            }}
            onStop={async () => {
              await rpc(runnerId, "interrupt", { sessionId });
            }}
          />
        )}
      </div>
      {panel && <PanelHandle />}
      {panel && (
        <TerminalPanel
          runnerId={runnerId}
          session={summary}
          state={state}
          panel={panel}
          setPanel={setPanel}
          shared={shared}
          onOpenTui={() => openTerminal()}
          onClose={() => {
            setAsk(null);
            setPanel(null);
          }}
          ask={
            ask && (
              <div className="t-term-ask" role="group" aria-label="Open the terminal">
                <span>{ask.text}</span>
                <Button label={ask.confirm} size="sm" variant="primary" onClick={() => openTerminal(true)} />
                <Button label="Keep working" size="sm" variant="secondary" onClick={() => setAsk(null)} />
              </div>
            )
          }
        />
      )}
      </div>
    </SessionCtx.Provider>
  );
}
