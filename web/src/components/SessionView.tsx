import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { LiveState, Ops, PendingMessage } from "../shared/protocol";
import { act, rpc, selectSession, useStore } from "../store";
import { badge, fmtClock, harnessLabel, tildify } from "../util";
import { ModelMenu, PickMenu } from "./ModelMenu";
import { archive, PencilIcon, RenameInput } from "./Sidebar";
import { LinkBanner, setProjectRoot, Transcript } from "./Transcript";
import { UiRequests } from "./UiRequests";
import { UsagePill } from "./Usage";
import { ChangesPanel } from "./Changes";

export function SessionView({ sessionId }: { sessionId: string }) {
  const o = useStore((s) => s.open[sessionId]);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [showChanges, setShowChanges] = useState(false);
  const toggleChanges = () => {
    stick.current = true;
    setShowChanges((v) => !v);
  };

  // Follow a handoff that happens while this session is on screen.
  const handoffTo = o?.state?.handoffTo?.sessionId;
  const seenHandoff = useRef(handoffTo);
  useEffect(() => {
    if (handoffTo && handoffTo !== seenHandoff.current) selectSession(handoffTo);
    seenHandoff.current = handoffTo;
  }, [handoffTo]);

  // Stay pinned to the bottom unless the reader scrolled up.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current && !showChanges) el.scrollTop = el.scrollHeight;
  });

  if (!o || o.loading || !o.session)
    return (
      <>
        <Header sessionId={sessionId} showChanges={showChanges} onToggleChanges={toggleChanges} />
        <div className="empty">Loading session…</div>
      </>
    );

  const st = o.state;
  setProjectRoot(o.session.projectPath, sessionId);
  return (
    <>
      <Header sessionId={sessionId} showChanges={showChanges} onToggleChanges={toggleChanges} />
      {o.syncing && (
        <div className="syncbar">
          <span className="spin" />
          Connecting… showing the last copy this browser saw
        </div>
      )}
      <div
        className="scroll"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        <div className="col">
          {showChanges ? (
            <ChangesPanel sessionId={sessionId} />
          ) : (
            <>
              <LinkBanner from={st.handoffFrom} />
              {o.messages.length === 0 && <div className="hint">No messages yet.</div>}
              <Transcript messages={o.messages} running={st.status === "running"} amendable={st.amendable} />
              {st.handoffTo && <LinkBanner to={st.handoffTo} />}
              {!o.syncing && <UiRequests sessionId={sessionId} requests={st.pendingUi} />}
            </>
          )}
        </div>
      </div>
      <Composer sessionId={sessionId} state={st} />
    </>
  );
}

function Header({ sessionId, showChanges, onToggleChanges }: { sessionId: string; showChanges: boolean; onToggleChanges: () => void }) {
  const o = useStore((s) => s.open[sessionId]);
  const [editing, setEditing] = useState(false);
  const st = o?.state;
  const sess = o?.session;
  const busy = st?.status === "running" || st?.status === "waiting";
  return (
    <header className="top">
      <button className="menu-btn" onClick={() => useStore.setState({ sidebarOpen: true })} aria-label="Menu">
        ☰
      </button>
      <div className="ttl">
        {editing && sess ? (
          <RenameInput session={sess} onDone={() => setEditing(false)} />
        ) : (
          <div className="title editable" onClick={() => sess && setEditing(true)} title={sess ? "Rename" : undefined}>
            <span className="tt">{sess?.title ?? "Session"}</span>
            {sess && <PencilIcon />}
          </div>
        )}
        {sess && <div className="path mono">{tildify(sess.projectPath)}</div>}
      </div>
      {sess && (
        <span className="pill hide-m" title={harnessLabel(sess.harness)}>
          <span className={`h ${sess.harness}`}>{badge(sess.harness)}</span>
        </span>
      )}
      {sess && st && <ModelMenu sessionId={sessionId} harness={sess.harness} state={st} />}
      {sess && st && <ThinkingMenu sessionId={sessionId} harness={sess.harness} state={st} />}
      {st?.modes && st.modes.length > 0 && (
        <PickMenu
          className="hide-m"
          label="mode"
          value={st.permissionMode ?? "default"}
          options={st.modes}
          onPick={(mode) => act("setPermissionMode", { sessionId, mode })}
        />
      )}
      {st && (
        <PickMenu
          label="guard"
          value={st.guard ?? "auto"}
          options={["ask", "auto", "full"]}
          describe={{
            ask: "Ask me before anything the safety rules don't clearly allow",
            auto: "Rules + a safety judge decide; never waits for me",
            full: "Allow everything (sandbox and checkpoints only)",
          }}
          onPick={(mode) => act("setGuard", { sessionId, mode: mode as any })}
        />
      )}
      {sess && (
        <button className={`pill changes-toggle${showChanges ? " active" : ""}`} onClick={onToggleChanges}>
          {showChanges ? "Transcript" : "Changes"}
        </button>
      )}
      {sess && <UsagePill harness={sess.harness} model={st?.model} />}
      {st?.checkpoints && st.checkpoints.length > 0 && <Checkpoints sessionId={sessionId} state={st} />}
      {sess && (
        <MoreMenu
          items={[
            { label: "Rename", run: () => setEditing(true) },
            { label: sess.archived ? "Unarchive" : "Archive", run: () => archive(sess, !sess.archived), disabled: busy },
            { label: "Stop the agent process", run: () => act("closeSession", { sessionId }), disabled: busy || !sess.live },
          ]}
        />
      )}
      {busy && (
        <button className="pill stop" onClick={() => act("abort", { sessionId })}>
          ■ Stop
        </button>
      )}
    </header>
  );
}

function MoreMenu({ items }: { items: { label: string; run: () => void; disabled?: boolean }[] }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="pill" style={{ cursor: "pointer", padding: "4px 8px" }} onClick={() => setOpen(!open)} aria-label="More">
      ⋯
      {open && (
        <div className="pop" style={{ width: 220 }} onClick={(e) => e.stopPropagation()}>
          {items.map((it) => (
            <button
              key={it.label}
              className="item"
              disabled={it.disabled}
              style={it.disabled ? { opacity: 0.45 } : undefined}
              onClick={() => {
                setOpen(false);
                it.run();
              }}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

function Checkpoints({ sessionId, state }: { sessionId: string; state: LiveState }) {
  const [open, setOpen] = useState(false);
  const cps = [...(state.checkpoints ?? [])].reverse();
  return (
    <span className="pill hide-m" style={{ cursor: "pointer" }} onClick={() => setOpen(!open)} title="Undo: restore files to before a turn">
      ⟲ {cps.length}
      {open && (
        <div className="pop" onClick={(e) => e.stopPropagation()}>
          <h4>Restore files to before…</h4>
          <div className="list">
            {cps.map((c) => (
              <div key={c.id} className="chainrow">
                <span className="grow" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={c.label}>
                  {c.label}
                </span>
                <span className="ago">{fmtClock(c.ts)}</span>
                <button
                  className="btn"
                  style={{ padding: "2px 8px" }}
                  disabled={state.status !== "idle"}
                  onClick={() => {
                    if (confirm(`Restore the project files to how they were before "${c.label}"? The current state is saved as a checkpoint first.`)) {
                      act("restoreCheckpoint", { sessionId, id: c.id });
                      setOpen(false);
                    }
                  }}
                >
                  Restore
                </button>
              </div>
            ))}
          </div>
          {state.status !== "idle" && <div className="hint" style={{ padding: 6 }}>Stop the agent to restore.</div>}
        </div>
      )}
    </span>
  );
}

function ThinkingMenu({ sessionId, harness, state }: { sessionId: string; harness: string; state: LiveState }) {
  const [fetched, setLevels] = useState<string[]>([]);
  useEffect(() => {
    if (state.thinkingLevels) return;
    rpc("listModels", { harness: harness as any, sessionId })
      .then((r) => setLevels(r.thinkingLevels))
      .catch(() => {});
  }, [harness, sessionId, state.model, state.thinkingLevels]);
  const levels = state.thinkingLevels ?? fetched;
  if (!levels.length) return null;
  return (
    <PickMenu
      className="hide-m"
      label={harness === "claude-code" || harness === "codex" ? "effort" : "thinking"}
      value={state.thinking ?? "default"}
      options={levels}
      onPick={(level) => act("setThinking", { sessionId, level })}
    />
  );
}

/**
 * Messages Tether holds until they go to the agent, top first. Steers at the top go into the
 * running turn after a short grace period; a queued message holds back everything below it until
 * the turn ends. Until then any device can edit, reorder, switch or cancel them.
 */
function PendingList({ sessionId, state }: { sessionId: string; state: LiveState }) {
  const list = state.pending ?? [];
  const [editing, setEditing] = useState<{ id: string; text: string }>();
  const [drag, setDrag] = useState<string>();
  const [, tick] = useState(0);
  const counting = list.some((p) => p.mode === "steer" && (p.readyAt ?? 0) > Date.now());
  useEffect(() => {
    if (!counting) return;
    const t = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, [counting]);

  const edit = (id: string, change: Omit<Ops["editPending"]["args"], "sessionId" | "id">) => act("editPending", { sessionId, id, ...change });
  const blockedAt = list.findIndex((p) => p.mode === "followUp");
  const label = (p: PendingMessage, i: number) => {
    if (state.pendingHeld) return "Held · the agent was stopped";
    if (p.mode === "followUp") return "Queued · after this turn";
    if (blockedAt >= 0 && i > blockedAt) return "Steer · waits behind a queued message (drag it above)";
    const left = Math.ceil(((p.readyAt ?? 0) - Date.now()) / 1000);
    return left > 0 ? `Steer · goes in ${left}s` : "Steer · goes in at the agent's next step";
  };
  const save = () => {
    if (editing) edit(editing.id, { text: editing.text });
    setEditing(undefined);
  };

  return (
    <div className="pending">
      {state.pendingHeld && (
        <div className="heldbar">
          <span className="grow">Stopped. These messages wait until you send them.</span>
          <button className="btn pri" onClick={() => edit(list[0]!.id, { now: true })}>
            Send all
          </button>
        </div>
      )}
      {list.map((p, i) => (
        <div
          key={p.id}
          className={`pend ${p.mode}${drag === p.id ? " dragging" : ""}`}
          draggable={editing?.id !== p.id}
          onDragStart={(e) => {
            setDrag(p.id);
            e.dataTransfer.effectAllowed = "move";
          }}
          onDragEnd={() => setDrag(undefined)}
          onDragOver={(e) => drag && drag !== p.id && e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            if (drag && drag !== p.id) edit(drag, { index: i });
            setDrag(undefined);
          }}
        >
          <div className="phd">
            <span className="grip" title="Drag to reorder">
              ⋮⋮
            </span>
            <span className="lbl grow">{label(p, i)}</span>
            {i > 0 && (
              <button title="Move up" onClick={() => edit(p.id, { index: i - 1 })}>
                ▲
              </button>
            )}
            <button
              title={p.mode === "steer" ? "Make it queued: runs after this turn" : "Make it a steer: goes into the running turn"}
              onClick={() => edit(p.id, { mode: p.mode === "steer" ? "followUp" : "steer" })}
            >
              {p.mode === "steer" ? "→ queue" : "→ steer"}
            </button>
            <button title="Send now" onClick={() => edit(p.id, { now: true })}>
              ⏵
            </button>
            <button title="Cancel this message" onClick={() => edit(p.id, { remove: true })}>
              ✕
            </button>
          </div>
          {editing?.id === p.id ? (
            <textarea
              autoFocus
              value={editing.text}
              rows={Math.min(8, editing.text.split("\n").length + 1)}
              onChange={(e) => setEditing({ id: p.id, text: e.target.value })}
              onBlur={save}
              onKeyDown={(e) => {
                if (e.key === "Escape") setEditing(undefined);
                if (e.key === "Enter" && !e.shiftKey) (e.preventDefault(), save());
              }}
            />
          ) : (
            <div className="txt" title="Click to edit" onClick={() => setEditing({ id: p.id, text: p.text })}>
              {p.text.split("\n\n<bash-input>")[0]}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function Composer({ sessionId, state }: { sessionId: string; state: LiveState }) {
  const [text, setText] = useState(() => localStorage.getItem(`tether.draft.${sessionId}`) ?? "");
  const [cmds, setCmds] = useState<{ name: string; description?: string }[] | null>(null);
  const [cmdIdx, setCmdIdx] = useState(0);
  const ta = useRef<HTMLTextAreaElement>(null);
  const running = state.status === "running";

  useEffect(() => {
    try {
      text ? localStorage.setItem(`tether.draft.${sessionId}`, text) : localStorage.removeItem(`tether.draft.${sessionId}`);
    } catch {}
  }, [text, sessionId]);

  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, window.innerHeight * 0.4) + "px";
  }, [text]);

  // Slash commands: load once when the user types "/" at the start.
  const slash = text.startsWith("/") && !text.includes(" ") ? text.slice(1).toLowerCase() : null;
  useEffect(() => {
    if (slash !== null && cmds === null)
      rpc("listCommands", { sessionId })
        .then(setCmds)
        .catch(() => setCmds([]));
  }, [slash, cmds, sessionId]);
  const matches = slash !== null && cmds ? cmds.filter((c) => c.name.toLowerCase().includes(slash)).slice(0, 12) : [];

  const send = async (mode?: "steer" | "followUp") => {
    const t = text.trim();
    if (!t) return;
    setText("");
    const r = await act("prompt", { sessionId, text: t, mode: running ? (mode ?? "steer") : undefined });
    if (r === undefined) setText(t);
  };

  const shell = text.startsWith("!");
  const ctx = state.contextPercent;
  return (
    <div className="composer">
      {state.status === "waiting" && (
        <div className="waitbar">
          <span className="wait" />
          <span className="grow">
            {state.waitingReason ?? "Waiting"}
            {state.waitingUntil ? ` · resumes ${fmtClock(state.waitingUntil)}` : ""}
          </span>
          <button className="btn" onClick={() => act("abort", { sessionId })}>
            Cancel
          </button>
        </div>
      )}
      <div className={`box${shell ? " shell" : ""}`} style={{ position: "relative" }}>
        {shell && (
          <div className="shellbar" title="Runs on the runner in the project folder, not through the agent or the guard. The agent sees the output with your next message.">
            <span className="mono">!</span> Bash mode: runs directly, outside the guard
          </div>
        )}
        {matches.length > 0 && (
          <div className="cmds">
            {matches.map((c, i) => (
              <button
                key={c.name}
                className={i === cmdIdx ? "on" : ""}
                onMouseDown={(e) => {
                  e.preventDefault();
                  setText(`/${c.name} `);
                  ta.current?.focus();
                }}
              >
                <span className="mono">/{c.name}</span>
                <small>{c.description}</small>
              </button>
            ))}
          </div>
        )}
        {state.background?.length ? (
          <div className="bgtasks" title="Work the agent keeps running between turns">
            <span className="spin" />
            <span className="grow">
              {state.background.length} background task{state.background.length > 1 ? "s" : ""}: {state.background.map((b) => b.description).join(" · ")}
            </span>
          </div>
        ) : null}
        {state.pending?.length ? (
          <PendingList sessionId={sessionId} state={state} />
        ) : (
          !state.pending &&
          state.queued.length > 0 && (
            <div className="queued">
              {state.queued.map((q, i) => (
                <span key={i} className="chip" title={q}>
                  queued: {q}
                </span>
              ))}
            </div>
          )
        )}
        <textarea
          ref={ta}
          rows={1}
          value={text}
          placeholder={shell ? "" : running ? "Steer the agent… (Enter to steer, Alt+Enter to queue for after)" : "Message the agent… (/ for commands)"}
          onChange={(e) => {
            setText(e.target.value);
            setCmdIdx(0);
          }}
          onKeyDown={(e) => {
            if (matches.length) {
              if (e.key === "ArrowDown") return (e.preventDefault(), setCmdIdx((cmdIdx + 1) % matches.length));
              if (e.key === "ArrowUp") return (e.preventDefault(), setCmdIdx((cmdIdx - 1 + matches.length) % matches.length));
              if (e.key === "Tab" || (e.key === "Enter" && !text.includes(" ") && `/${matches[cmdIdx]!.name}` !== text)) {
                e.preventDefault();
                setText(`/${matches[cmdIdx]!.name} `);
                return;
              }
            }
            if (e.key === "ArrowUp" && !text && state.pending?.length) {
              // Like the Claude Code CLI: pull everything still waiting back into the box to rewrite.
              e.preventDefault();
              rpc("takePending", { sessionId })
                .then((r) => r.text && setText(r.text))
                .catch(() => {});
              return;
            }
            if (e.key === "Enter" && !e.shiftKey && !(e.nativeEvent as any).isComposing && window.innerWidth > 760) {
              e.preventDefault();
              send(e.altKey ? "followUp" : "steer");
            }
          }}
        />
        <div className="row">
          <span className="hide-m">{shell ? "Enter to run · output goes to the agent with your next message" : "Shift+Enter for a new line · ! for bash mode"}</span>
          <span className="send">
            {running && !shell && (
              <button className="btn" onClick={() => send("followUp")} disabled={!text.trim()}>
                Queue
              </button>
            )}
            <button className="btn pri" onClick={() => send("steer")} disabled={!text.trim()}>
              {shell ? "Run ↵" : running ? "Steer ↵" : "Send ↵"}
            </button>
          </span>
        </div>
      </div>
      <div className="status">
        {ctx != null && (
          <span>
            context {Math.round(ctx)}%
            <span className="bar">
              <i style={{ width: `${Math.min(100, ctx)}%` }} />
            </span>
          </span>
        )}
        {state.cost != null && state.cost > 0 && <span>${state.cost.toFixed(2)}</span>}
        {Object.entries(state.statuses).map(([k, v]) => (
          <span key={k} className="hide-m" title={k}>
            {v}
          </span>
        ))}
      </div>
    </div>
  );
}
