// The terminal panel (SPEC §8, §10): the session's TUI, then the project's shells, as tabs. Beside
// the transcript on desktop, full screen on a phone, where a key bar and an input line stand in for
// the keys and the long typing a phone keyboard is bad at.

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Icon } from "@astryxdesign/core/Icon";
import { ArrowUpIcon, PlusIcon, XMarkIcon } from "@heroicons/react/24/solid";
import type { ShellInfo } from "../../../shared/protocol";
import { HARNESS_LABELS, type LiveState, type SessionSummary } from "../../../shared/transcript";
import { rpc } from "../connection";
import { useStore } from "../store";
import { KEYS, type TermStatus } from "../terminal";
import { TermView, type TermViewHandle } from "./TermView";
import { useFitViewport } from "./useFitViewport";

export type PanelTab = "tui" | string;

export interface PanelState {
  tab: PanelTab;
  /** mount the TUI's view: it hands the session over on its first attach */
  wantTui: boolean;
  /** stop a running turn on that first attach */
  stop?: boolean;
  /** bumped to mount a fresh TUI view */
  nonce: number;
}

const touch = () => typeof matchMedia === "function" && (matchMedia("(pointer: coarse)").matches || matchMedia("(max-width: 767px)").matches);

export function TerminalPanel({
  runnerId,
  session,
  state,
  panel,
  setPanel,
  onOpenTui,
  onClose,
}: {
  runnerId: string;
  session: SessionSummary;
  state: LiveState;
  panel: PanelState;
  setPanel: (p: PanelState | null) => void;
  /** opens the TUI tab the way the Terminal button does (asking first while a turn runs) */
  onOpenTui: () => void;
  onClose: () => void;
}) {
  const [shells, setShells] = useState<ShellInfo[]>([]);
  const [error, setError] = useState<string>();
  const [askBack, setAskBack] = useState(false);
  const [line, setLine] = useState("");
  const view = useRef<TermViewHandle>(null);
  const root = useRef<HTMLDivElement>(null);
  // On a phone the panel covers the screen: its key bar and line stay above the keyboard.
  useFitViewport(root);
  const linkOpen = useStore((s) => s.link === "open");
  const tuiRuns = state.mode === "terminal" || !!state.terminal;
  const handoff = state.mode === "terminal";
  const harness = HARNESS_LABELS[session.harness];
  const showKeys = touch();

  const loadShells = useCallback(async () => {
    try {
      const { shells } = await rpc(runnerId, "listShells", { projectPath: session.projectPath });
      setShells(shells);
    } catch {}
  }, [runnerId, session.projectPath]);

  // Shells come and go on other devices too: looked at again every few seconds while open.
  useEffect(() => {
    if (!linkOpen) return;
    void loadShells();
    const t = setInterval(() => void loadShells(), 5000);
    return () => clearInterval(t);
  }, [loadShells, linkOpen]);

  const tab = panel.tab;
  const shell = tab === "tui" ? undefined : shells.find((s) => s.id === tab);
  const call = async (p: Promise<unknown>) => {
    setError(undefined);
    try {
      await p;
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const newShell = () =>
    call(
      rpc(runnerId, "newShell", { projectPath: session.projectPath }).then((sh) => {
        setShells((list) => [...list.filter((x) => x.id !== sh.id), sh]);
        setPanel({ ...panel, tab: sh.id });
      }),
    );
  const closeShell = (id: string) =>
    call(
      rpc(runnerId, "closeShell", { shellId: id }).then(() => {
        setShells((list) => list.filter((x) => x.id !== id));
        if (panel.tab === id) setPanel({ ...panel, tab: "tui" });
      }),
    );
  const back = (whenIdle: boolean) => {
    setAskBack(false);
    void call(
      rpc(runnerId, "endTerminal", { sessionId: session.id, whenIdle }).then(() => {
        // Back in Tether: the transcript is where to look (unless a shell is in front).
        if (!whenIdle && panel.tab === "tui") onClose();
      }),
    );
  };
  const onTuiStatus = (s: TermStatus) => {
    if (s === "ended") setPanel({ ...panel, wantTui: false, stop: false });
  };
  const sendLine = async () => {
    const text = line.trim() ? line : "";
    // An empty line is just Enter (confirming a choice in the TUI).
    if (!text) return view.current?.input("\r");
    setLine("");
    // The TUI gets it like the composer's text (tmux types it, then Enter); a shell as keys.
    if (tab === "tui") await call(rpc(runnerId, "send", { sessionId: session.id, text }));
    else view.current?.input(`${text}\r`);
  };

  const returning = !!state.terminal?.returning;
  const waitingBack = !!state.terminal?.returnWhenIdle;

  return (
    <div className="t-term-panel" role="region" aria-label="Terminal" ref={root}>
      <div className="t-term-head">
        <div className="t-term-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === "tui"} className="t-term-tab" onClick={() => setPanel({ ...panel, tab: "tui" })}>
            {harness}
            {state.terminal?.attention && <span className="t-dot waiting" aria-label="Needs you" />}
          </button>
          {shells.map((s) => (
            <span key={s.id} className="t-term-tab-wrap">
              <button type="button" role="tab" aria-selected={tab === s.id} className="t-term-tab" title={s.command} onClick={() => setPanel({ ...panel, tab: s.id })}>
                Shell {s.n}
                {s.command && !/^(ba|z|fi|da|k)?sh$/.test(s.command) && <span className="t-term-cmd">{s.command}</span>}
              </button>
              <button type="button" className="t-term-x" aria-label={`Close shell ${s.n}`} title="Close this shell" onClick={() => void closeShell(s.id)}>
                ×
              </button>
            </span>
          ))}
          <button type="button" className="t-term-tab t-term-new" aria-label="New shell" title="New shell in this project" onClick={() => void newShell()}>
            <Icon icon={PlusIcon} size="sm" />
          </button>
        </div>
        <div className="t-term-actions">
          {handoff && (
            <Button
              label={returning ? "Going back…" : waitingBack ? "Back when done…" : "Back to Tether"}
              size="sm"
              variant="secondary"
              isDisabled={returning || waitingBack}
              onClick={() => (state.status === "idle" ? back(false) : setAskBack(true))}
            />
          )}
          {!handoff && state.terminal?.kind === "shared" && (
            // A shared TUI (SPEC §8): quitting it leaves Tether driving, as it was all along.
            <Button label={returning ? "Quitting…" : `Quit ${harness}`} size="sm" variant="secondary" isDisabled={returning} onClick={() => back(false)} />
          )}
          <IconButton label="Close terminal panel" tooltip="Close (the terminal keeps running)" size="sm" variant="ghost" icon={<Icon icon={XMarkIcon} />} onClick={onClose} />
        </div>
      </div>
      {askBack && (
        <div className="t-term-ask" role="group" aria-label="Back to Tether">
          <span>{harness} is still working in the terminal.</span>
          <Button label="Go back when it's done" size="sm" variant="primary" onClick={() => back(true)} />
          <Button label="Stop and go back now" size="sm" variant="secondary" onClick={() => back(false)} />
          <Button label="Stay" size="sm" variant="ghost" onClick={() => setAskBack(false)} />
        </div>
      )}
      {error && <div className="t-inline-status error t-term-error">{error}</div>}
      <div className="t-term-body">
        {tab === "tui" ? (
          tuiRuns || panel.wantTui ? (
            <TermView
              key={`tui-${panel.nonce}`}
              ref={view}
              runnerId={runnerId}
              target={{ sessionId: session.id }}
              stop={panel.stop}
              onStatus={onTuiStatus}
              onError={(m) => {
                setError(m);
                setPanel({ ...panel, wantTui: false, stop: false });
              }}
            />
          ) : (
            <div className="t-term-empty">
              <span>{harness} isn't open in the terminal.</span>
              <Button label={`Open ${harness} here`} variant="primary" onClick={onOpenTui} />
            </div>
          )
        ) : shell ? (
          <TermView key={shell.id} ref={view} runnerId={runnerId} target={{ shellId: shell.id }} />
        ) : (
          <div className="t-term-empty">
            <span>That shell has closed.</span>
          </div>
        )}
      </div>
      {showKeys && (
        <div className="t-term-phone">
          <div className="t-keybar" role="toolbar" aria-label="Keys">
            {KEYS.map((k) => (
              <button
                key={k.aria}
                type="button"
                className="t-key"
                aria-label={k.aria}
                // Keeps the keyboard up: the terminal keeps focus.
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => view.current?.input(k.data)}
              >
                {k.label}
              </button>
            ))}
          </div>
          <div className="t-term-line">
            <input
              className="t-input"
              aria-label="Type a line"
              placeholder={tab === "tui" ? `Message ${harness} in the terminal` : "A command for this shell"}
              value={line}
              enterKeyHint="send"
              autoCapitalize="off"
              autoCorrect="off"
              onChange={(e) => setLine(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void sendLine();
                }
              }}
            />
            <IconButton label="Send line" variant="primary" icon={<Icon icon={ArrowUpIcon} />} onClick={() => void sendLine()} />
          </div>
        </div>
      )}
    </div>
  );
}
