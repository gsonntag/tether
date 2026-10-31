// The terminal panel (SPEC §8, §10). ❯_ opens it on a project shell: a plain shell beside the chat,
// which keeps driving the agent. A list on the left (a row on a phone) holds the project's shells,
// + New shell, and an entry named after the agent ("Claude Code", "Codex"): only clicking that entry
// drives the agent from its own terminal UI (Claude: a handoff, asked first when busy; Codex: its
// TUI joins). Beside the transcript when there's room (useTermCover); else full screen over it, as
// on a phone, where Chat tucks the panel away (still attached). On touch a key bar and an input line
// stand in for the keys a phone keyboard lacks. Copy shows a terminal's text, scrollback included, where it can be selected natively.
//
// Which surface drives the agent shows on its entry ("Claude Code · driving", "Codex · joined") and,
// for a handoff, in the transcript's banner; a shell needs no words.

import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { Button } from "@astryxdesign/core/Button";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Icon } from "@astryxdesign/core/Icon";
import { ArrowUpIcon, ChatBubbleLeftRightIcon, DocumentDuplicateIcon, PlusIcon, XMarkIcon } from "@heroicons/react/24/solid";
import type { ShellInfo } from "../../../shared/protocol";
import { AGENT_NAMES, HARNESS_LABELS, type LiveState, type SessionSummary } from "../../../shared/transcript";
import { rpc } from "../connection";
import { useStore } from "../store";
import { KEYS, SHELL_TAB, shellOpened, type TermStatus } from "../terminal";
import { TermView, type TermViewHandle } from "./TermView";
import { useFitViewport } from "./useFitViewport";

export type PanelTab = "tui" | typeof SHELL_TAB | string;

export { SHELL_TAB };

export interface PanelState {
  tab: PanelTab;
  /** a phone showed the chat instead (Chat): the panel stays mounted, its terminals attached */
  hidden?: boolean;
  /** mount the TUI's view: it hands the session over on its first attach */
  wantTui: boolean;
  /** stop a running turn on that first attach */
  stop?: boolean;
  /** bumped to mount a fresh TUI view */
  nonce: number;
}

const narrow = () => typeof matchMedia === "function" && matchMedia("(max-width: 767px)").matches;
const touch = () => typeof matchMedia === "function" && (matchMedia("(pointer: coarse)").matches || matchMedia("(max-width: 767px)").matches);

/**
 * Back to Tether, asked every time (SPEC §8): Tether doesn't follow the TUI's turns, so it can't
 * tell whether one is still running.
 */
export const backQuestion = (harness: string, background?: boolean) => `Close ${harness} in the terminal? If it's still working, that turn stops and anything in its own input queue is lost.${background ? " Background shells stop too." : ""}`;

export function TerminalPanel({
  runnerId,
  session,
  state,
  panel,
  setPanel,
  cover,
  onOpenTui,
  onClose,
  ask,
  shared,
}: {
  runnerId: string;
  session: SessionSummary;
  state: LiveState;
  panel: PanelState;
  setPanel: Dispatch<SetStateAction<PanelState | null>>;
  /** full width over the chat, with Chat to tuck it away: no room beside the transcript */
  cover: boolean;
  /** opens the TUI tab the way the Terminal button does (asking first while a turn runs) */
  onOpenTui: () => void;
  onClose: () => void;
  /** the question before handing a busy session to its TUI (asked from the agent's tab) */
  ask?: React.ReactNode;
  /** the harness's TUI joins the session beside Tether (capabilities.terminal "shared") rather than taking it over */
  shared: boolean;
}) {
  const [shells, setShells] = useState<ShellInfo[]>([]);
  const [shellsLoaded, setShellsLoaded] = useState(false);
  const tabNow = useRef(panel.tab);
  tabNow.current = panel.tab;
  const [error, setError] = useState<string>();
  const [askBack, setAskBack] = useState(false);
  const [line, setLine] = useState("");
  /** Copy: the terminal's text, scrollback included, shown where it can be selected */
  const [copy, setCopy] = useState<{ title: string; text: string; cut: boolean; /** Copy all: it worked, or it didn't (the text is left selected) */ copied?: boolean } | null>(null);
  const view = useRef<TermViewHandle>(null);
  const root = useRef<HTMLDivElement>(null);
  // On a phone the panel covers the screen: its key bar and line stay above the keyboard.
  useFitViewport(root);
  const linkOpen = useStore((s) => s.link === "open");
  const tuiRuns = state.mode === "terminal" || !!state.terminal;
  const handoff = state.mode === "terminal";
  const harness = HARNESS_LABELS[session.harness];
  const agent = AGENT_NAMES[session.harness];
  const showKeys = touch();

  const loadShells = useCallback(async () => {
    try {
      const { shells } = await rpc(runnerId, "listShells", { projectPath: session.projectPath });
      setShells(shells);
      setShellsLoaded(true);
    } catch (e) {
      // "Shell" waits on this: say why it can't open one.
      if (tabNow.current === SHELL_TAB) setError((e as Error).message);
    }
  }, [runnerId, session.projectPath]);

  // Shells come and go on other devices too: looked at again every few seconds while open.
  // Asked while the TUI drove: moot once it doesn't (another device went back, it exited).
  useEffect(() => {
    if (!handoff) setAskBack(false);
  }, [handoff]);
  useEffect(() => {
    if (!linkOpen) return;
    void loadShells();
    const t = setInterval(() => void loadShells(), 5000);
    return () => clearInterval(t);
  }, [loadShells, linkOpen]);

  const tab = panel.tab;
  const shellsNow = useRef(shells);
  shellsNow.current = shells;
  const tuiRunsNow = useRef(tuiRuns);
  tuiRunsNow.current = tuiRuns;
  /** Copy closes: the keys go back to the terminal (on a phone that would raise the keyboard). */
  const closeCopy = () => {
    setCopy(null);
    if (!narrow()) view.current?.focus();
  };
  const shell = tab === "tui" ? undefined : shells.find((s) => s.id === tab);
  const call = async (p: Promise<unknown>) => {
    setError(undefined);
    try {
      await p;
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /** `auto`: the shell ❯_ is waiting for, which only comes forward if you're still waiting for it. */
  const newShell = (auto = false) =>
    call(
      rpc(runnerId, "newShell", { projectPath: session.projectPath }).then((sh) => {
        setShells((list) => [...list.filter((x) => x.id !== sh.id), sh]);
        setPanel((p) => shellOpened(p, sh.id, auto));
      }),
    );
  /** A shell is gone (×, or `exit` in it). Another comes to the front; the last one closes the panel (shells come first: the agent's terminal opens only when asked for). */
  const shellGone = (id: string) => {
    const rest = shellsNow.current.filter((x) => x.id !== id);
    shellsNow.current = rest;
    setShells(rest);
    if (tabNow.current !== id) return;
    if (rest[0]) setPanel((p) => p && { ...p, tab: rest[0]!.id });
    else if (!tuiRunsNow.current) onClose();
    else setPanel((p) => p && { ...p, tab: "tui" });
  };
  const closeShell = (id: string) => call(rpc(runnerId, "closeShell", { shellId: id }).then(() => shellGone(id)));
  // "Shell": the project's first shell, or a new one (once; a failure says why and stays).
  const autoTried = useRef(false);
  useEffect(() => {
    if (tab !== SHELL_TAB || !shellsLoaded) return;
    if (shells[0]) return setPanel({ ...panel, tab: shells[0].id });
    if (autoTried.current) return;
    autoTried.current = true;
    void newShell(true);
  }, [tab, shellsLoaded, shells]);

  // The Copy sheet belongs to the terminal it was made from: another tab closes it.
  useEffect(() => {
    setCopy(null);
    setError(undefined);
  }, [tab]);
  // Esc closes it.
  useEffect(() => {
    if (!copy) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && closeCopy();
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [!!copy]);

  /** The agent's tab: its TUI when it runs (or is being opened), else open it (asking first when busy). */
  const toTui = () => {
    if (tuiRuns || panel.wantTui) return setPanel({ ...panel, tab: "tui" });
    onOpenTui();
  };

  const back = () => {
    setAskBack(false);
    void call(
      rpc(runnerId, "endTerminal", { sessionId: session.id }).then(() => {
        // Back in Tether: the transcript is where to look (unless a shell is in front).
        if (tabNow.current === "tui") onClose();
      }),
    );
  };
  const onTuiStatus = (s: TermStatus) => {
    if (s === "ended") setPanel((p) => p && { ...p, wantTui: false, stop: false });
  };
  const sendLine = async () => {
    const text = line.trim() ? line : "";
    // An empty line is just Enter (confirming a choice in the TUI).
    if (!text) return view.current?.input("\r");
    setLine("");
    // Typed into the terminal in front as keys, the way a keyboard would: the text, then (a beat
    // later, so a TUI doesn't take it as part of a paste) Enter.
    view.current?.input(text);
    await new Promise((r) => setTimeout(r, 150));
    view.current?.input("\r");
  };

  const returning = !!state.terminal?.returning;
  // The line goes where the tab is: the TUI (when it runs and isn't asking) or the shell.
  const lineOff =
    tab === "tui"
      ? !tuiRuns
        ? `Open ${harness} first`
        : returning
          ? "Going back to Tether…"
          : undefined
      : !shell
        ? "That shell has closed"
        : undefined;
  const agentState = handoff ? "driving" : state.terminal?.kind === "shared" ? "joined" : undefined;
  // The dock is behind the panel on a phone: Chat shows that something waits there.
  const needsYou = state.requests.length > 0 || state.status === "waiting" || !!state.terminal?.attention;
  const title = tab === "tui" ? harness : shell ? `Shell ${shell.n}` : "Shell";

  /** Copy: the text of the terminal in front (scrollback too), in a sheet where it can be selected. */
  const openCopy = () =>
    call(
      (async () => {
        const attachId = view.current?.attachId();
        if (!attachId) throw new Error("Nothing to copy: the terminal isn't attached yet.");
        const from = tab;
        const r = await rpc(runnerId, "terminalText", { attachId });
        // Another tab came forward meanwhile: this text is no longer what's in front.
        if (tabNow.current === from) setCopy({ title, text: r.text, cut: r.cut });
      })(),
    );
  const copyAll = async () => {
    if (!copy) return;
    let copied = true;
    try {
      await navigator.clipboard.writeText(copy.text);
    } catch {
      // No clipboard access (not a secure page): select it all, and the browser's copy takes it.
      const el = document.querySelector(".t-term-copytext");
      const range = document.createRange();
      if (el) range.selectNodeContents(el);
      const sel = getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      try {
        copied = document.execCommand("copy");
      } catch {
        copied = false;
      }
    }
    setCopy({ ...copy, copied });
  };

  return (
    <div className={`t-term-panel${panel.hidden ? " hidden" : ""}`} role="region" aria-label="Terminal" ref={root}>
      <div className="t-term-head">
        <span className="t-term-title">{title}</span>
        <div className="t-term-actions">
          {handoff && (
            <Button
              label={returning ? "Going back…" : "Back to Tether"}
              size="sm"
              variant="secondary"
              isDisabled={returning}
              onClick={() => setAskBack(true)}
            />
          )}
          {!handoff && state.terminal?.kind === "shared" && (
            // A shared TUI (SPEC §8): quitting it leaves Tether driving, as it was all along.
            <Button label={returning ? "Quitting…" : `Quit ${harness}`} size="sm" variant="secondary" isDisabled={returning} onClick={() => back()} />
          )}
          <IconButton
            label="Copy text"
            tooltip="Copy: this terminal's text, scrollback included (or drag to select and copy)"
            size="sm"
            variant="ghost"
            icon={<Icon icon={DocumentDuplicateIcon} />}
            onClick={() => void openCopy()}
          />
          {cover && (
            // Over the chat: the chat, with the terminal kept as it is behind it.
            <span className="t-term-chat">
              <Button label="Chat" size="sm" variant="secondary" icon={<Icon icon={ChatBubbleLeftRightIcon} size="sm" />} onClick={() => setPanel({ ...panel, hidden: true })} />
              {needsYou && <span className="t-dot waiting" role="img" aria-label="Needs you" />}
            </span>
          )}
          <IconButton label="Close terminal panel" tooltip="Close (the terminal keeps running)" size="sm" variant="ghost" icon={<Icon icon={XMarkIcon} />} onClick={onClose} />
        </div>
      </div>
      {ask}
      {askBack && (
        <div className="t-term-ask" role="group" aria-label="Back to Tether">
          <span>{backQuestion(harness, state.terminal?.background)}</span>
          <Button label="Close and go back" size="sm" variant="primary" onClick={() => back()} />
          <Button label="Stay" size="sm" variant="ghost" onClick={() => setAskBack(false)} />
        </div>
      )}
      {error && <div className="t-inline-status error t-term-error">{error}</div>}
      <div className="t-term-main">
        <div className="t-term-tabs" role="tablist" aria-label="Terminals" aria-orientation={cover ? "horizontal" : "vertical"}>
          {/* The shells scroll; the agent's entry stays put at the end, never clipped. */}
          <div className="t-term-shells" role="presentation">
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
            <span className="t-term-new-label">New shell</span>
          </button>
          </div>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "tui"}
            className={`t-term-tab t-term-agent${agentState ? ` ${agentState}` : ""}`}
            title={agentState ? undefined : shared ? `Opens ${harness}'s own terminal UI, joined to this session` : `Drives ${agent} from ${harness}'s own terminal UI (hands the session over until Back to Tether)`}
            onClick={toTui}
          >
            {harness}
            {agentState && (
              <span className={`t-term-state ${agentState}`}>
                <span className="t-term-state-text"> · {agentState}</span>
                <span className="t-term-state-dot" aria-hidden>
                  ●
                </span>
              </span>
            )}
            {state.terminal?.attention && <span className="t-dot waiting" aria-label="Needs you" />}
          </button>
        </div>
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
                  setPanel((p) => p && { ...p, wantTui: false, stop: false });
                }}
              />
            ) : (
              <div className="t-term-empty">
                <span>{agent} isn't open in the terminal.</span>
                <span className="t-term-empty-more">
                  {shared
                    ? `${harness}'s own terminal UI joins this session beside Tether. Both can drive ${agent}.`
                    : `Opening it drives ${agent} from ${harness}'s own terminal UI until you go Back to Tether; the chat follows along.`}
                </span>
                {!ask && <Button label={`Open ${harness}`} variant="primary" onClick={onOpenTui} />}
              </div>
            )
          ) : tab === SHELL_TAB ? (
            <div className="t-term-empty">
              <span>Opening a shell…</span>
            </div>
          ) : shell ? (
            <TermView key={shell.id} ref={view} runnerId={runnerId} target={{ shellId: shell.id }} onStatus={(s) => s === "ended" && shellGone(shell.id)} />
          ) : (
            <div className="t-term-empty">
              <span>That shell has closed.</span>
            </div>
          )}
          {copy && (
            <div className="t-term-copy" role="dialog" aria-label={`Copy from ${copy.title}`}>
              <div className="t-term-copy-head">
                <span className="t-term-copy-title">Copy text · {copy.title}</span>
                <span className="t-term-copy-note">{copy.cut ? "The newest text (older lines left out). Select some, or" : "Select some, or"}</span>
                <Button label={copy.copied === undefined ? "Copy all" : copy.copied ? "Copied" : "Couldn't copy: selected"} size="sm" variant="primary" onClick={() => void copyAll()} />
                <Button label="Done" size="sm" variant="secondary" onClick={closeCopy} />
              </div>
              <pre
                className="t-term-copytext"
                tabIndex={0}
                ref={(el) => {
                  // Opens at the end, where the newest lines are.
                  if (el && !el.dataset.placed) {
                    el.dataset.placed = "1";
                    el.scrollTop = el.scrollHeight;
                  }
                }}
              >
                {copy.text}
              </pre>
            </div>
          )}
        </div>
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
                // Keeps the keyboard up (the terminal keeps focus) with a mouse; a tap is never
                // cancelled (iOS Safari would drop the click).
                onMouseDown={(e) => e.preventDefault()}
                disabled={!!copy}
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
              placeholder={lineOff ?? (tab === "tui" ? `Message ${agent} in the terminal` : "A command for this shell")}
              disabled={!!lineOff || !!copy}
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
            <IconButton label="Send line" variant="primary" isDisabled={!!lineOff || !!copy} icon={<Icon icon={ArrowUpIcon} />} onClick={() => void sendLine()} />
          </div>
        </div>
      )}
    </div>
  );
}
