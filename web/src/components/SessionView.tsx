import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import {
  ChatComposer,
  ChatComposerDrawer,
  ChatComposerInput,
  ChatLayout,
  ChatMessage,
  ChatMessageBubble,
  type ChatComposerInputHandle,
} from "@astryxdesign/core/Chat";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Item } from "@astryxdesign/core/Item";
import { Spinner } from "@astryxdesign/core/Spinner";
import { StackItem } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { Token } from "@astryxdesign/core/Token";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { VStack } from "@astryxdesign/core/VStack";
import { EllipsisVerticalIcon } from "@heroicons/react/24/outline";
import { effortLabel } from "../models";
import { GUARD_MODES, type LiveState, type Ops, type PendingMessage, type SlashCommand } from "../shared/protocol";
import { slashGroups, slashQuery } from "../slash";
import { act, rpc, selectSession, useStore } from "../store";
import { fmtClock } from "../util";
import { ChangesButton, ChangesDialog, turnChangeMarkers } from "./Changes";
import { ContextMeter } from "./ContextMeter";
import { HarnessBadge } from "./HarnessBadge";
import { ModelMenu, PickMenu } from "./ModelMenu";
import { LinkBanner, setProjectRoot, Transcript } from "./Transcript";
import { UiRequests } from "./UiRequests";
import { UsagePill } from "./Usage";

/** Phones: Enter makes a new line, and the less important settings hide. */
const NARROW = "(max-width: 760px)";
const useNarrow = () => useMediaQuery(NARROW);

const fill: CSSProperties = { flex: 1, minHeight: 0 };
const preWrap: CSSProperties = { whiteSpace: "pre-wrap", wordBreak: "break-word", cursor: "text" };
const composerDock: CSSProperties = { paddingBlockEnd: "env(safe-area-inset-bottom)" };
const pendingScroll: CSSProperties = { maxHeight: "30vh", overflowY: "auto" };
/** Fills the drawer's row without letting long menu rows widen it (they truncate instead). */
const drawerBody: CSSProperties = { flex: "1 1 100%", width: 0, minWidth: 0 };
const queuedRow = (dragging: boolean): CSSProperties => ({
  border: "var(--border-width) solid var(--color-border)",
  borderRadius: "var(--radius-element)",
  opacity: dragging ? 0.4 : 1,
  cursor: "grab",
});
const steerBubble = (blocked: boolean): CSSProperties => ({
  background: "transparent",
  border: "var(--border-width) dashed var(--color-border-emphasized)",
  opacity: blocked ? 0.5 : 0.85,
});
/** Bash mode types in the code font: the input reads its family from this token. */
const shellFont = { "--font-family-body": "var(--font-family-code)" } as CSSProperties;

export function SessionView({ sessionId }: { sessionId: string }) {
  const o = useStore((s) => s.open[sessionId]);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const narrow = useNarrow();

  // Follow a handoff that happens while this session is on screen.
  const handoffTo = o?.state?.handoffTo?.sessionId;
  const seenHandoff = useRef(handoffTo);
  useEffect(() => {
    if (handoffTo && handoffTo !== seenHandoff.current) selectSession(handoffTo);
    seenHandoff.current = handoffTo;
  }, [handoffTo]);

  // No header: the tab shows which session this is.
  const title = o?.session?.title;
  useEffect(() => {
    document.title = title ? `${title} · Tether` : "Tether";
    return () => void (document.title = "Tether");
  }, [title]);

  // Stay pinned to the bottom unless the reader scrolled up. ChatLayout follows growth of the
  // transcript on its own; this also covers what sits after it (pending steers, prompts, the dock).
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });

  if (!o || o.loading || !o.session)
    return (
      <VStack style={fill} vAlign="center" hAlign="center">
        <EmptyState title="Loading session…" icon={<Spinner />} isCompact />
      </VStack>
    );

  const st = o.state;
  setProjectRoot(o.session.projectPath, sessionId);
  return (
    <>
      {o.syncing && <Banner status="info" container="section" icon={<Spinner size="sm" />} title="Connecting… showing the last copy this browser saw" />}
      <ChatLayout
        ref={scroller}
        density="spacious"
        style={{ overscrollBehavior: "contain" }}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        composer={<Composer sessionId={sessionId} state={st} />}
      >
        {/* Room at the top on phones for the floating sidebar button. */}
        <VStack gap={4} paddingBlockStart={narrow ? 10 : 6} paddingBlockEnd={2}>
          <LinkBanner from={st.handoffFrom} />
          {o.messages.length === 0 && <Text type="supporting">No messages yet.</Text>}
          <Transcript
            messages={o.messages}
            running={st.status === "running"}
            amendable={st.amendable}
            after={turnChangeMarkers(sessionId, o.messages, st)}
          />
          <PendingSteers sessionId={sessionId} state={st} />
          {st.handoffTo && <LinkBanner to={st.handoffTo} />}
          {!o.syncing && <UiRequests sessionId={sessionId} requests={st.pendingUi} />}
        </VStack>
      </ChatLayout>
      <ChangesDialog sessionId={sessionId} state={st} />
    </>
  );
}

/** Under the message box: what the session runs on and how, plus context and plan usage. */
function SettingsBar({ sessionId, state: st }: { sessionId: string; state: LiveState }) {
  const sess = useStore((s) => s.open[sessionId]?.session);
  const narrow = useNarrow();
  if (!sess) return null;
  return (
    <HStack gap={1} vAlign="center" wrap="wrap" paddingInline={1}>
      <HarnessBadge harness={sess.harness} />
      <ModelMenu sessionId={sessionId} harness={sess.harness} state={st} />
      {!narrow && <ThinkingMenu sessionId={sessionId} harness={sess.harness} state={st} />}
      <PickMenu
        label=""
        value={GUARD_MODES.find((g) => g.id === (st.guard ?? "auto"))?.label ?? st.guard!}
        options={GUARD_MODES.map((g) => g.label)}
        onPick={(label) => act("setGuard", { sessionId, mode: GUARD_MODES.find((g) => g.label === label)!.id })}
      />
      <ChangesButton sessionId={sessionId} state={st} />
      <StackItem size="fill" />
      {!narrow &&
        Object.entries(st.statuses).map(([k, v]) => (
          <Tooltip key={k} content={k}>
            <Text type="code" color="secondary">
              {v}
            </Text>
          </Tooltip>
        ))}
      <ContextMeter state={st} />
      {!narrow && st.cost != null && st.cost > 0 && (
        <Text type="supporting" hasTabularNumbers>
          ${st.cost.toFixed(2)}
        </Text>
      )}
      <UsagePill harness={sess.harness} model={st.model} />
    </HStack>
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
      label={harness === "claude-code" || harness === "codex" ? "Effort" : "Thinking"}
      value={state.thinking ?? "default"}
      options={levels}
      format={effortLabel}
      onPick={(level) => act("setThinking", { sessionId, level })}
    />
  );
}

type EditPending = (id: string, change: Omit<Ops["editPending"]["args"], "sessionId" | "id">) => void;

/** A waiting message's text; click to edit it until it goes out. */
function PendingText({ p, edit, clamp }: { p: PendingMessage; edit: EditPending; clamp?: boolean }) {
  const [draft, setDraft] = useState<string>();
  const save = () => {
    if (draft !== undefined && draft !== p.text) edit(p.id, { text: draft });
    setDraft(undefined);
  };
  if (draft === undefined)
    return (
      <Tooltip content="Click to edit" hasHoverIndication={false}>
        <Text display="block" maxLines={clamp ? 3 : 0} hasTruncateTooltip={false} style={preWrap} onClick={() => setDraft(p.text)}>
          {p.text.split("\n\n<bash-input>")[0]}
        </Text>
      </Tooltip>
    );
  return (
    <TextArea
      label="Edit message"
      isLabelHidden
      size="sm"
      hasAutoFocus
      value={draft}
      rows={Math.min(8, draft.split("\n").length + 1)}
      onChange={(v) => setDraft(v)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === "Escape") setDraft(undefined);
        if (e.key === "Enter" && !e.shiftKey) (e.preventDefault(), save());
      }}
    />
  );
}

const usePendingEdit = (sessionId: string): EditPending => (id, change) => act("editPending", { sessionId, id, ...change });

/**
 * Steers that haven't reached the agent yet: dashed user bubbles at the end of the chat. They go into
 * the running turn at its next step (one behind a queued message waits for that message's turn).
 */
function PendingSteers({ sessionId, state }: { sessionId: string; state: LiveState }) {
  const edit = usePendingEdit(sessionId);
  const list = state.pending ?? [];
  const firstQueued = list.findIndex((p) => p.mode === "followUp");
  return (
    <>
      {list.map((p, i) =>
        p.mode !== "steer" ? null : (
          <ChatMessage key={p.id} sender="user">
            <ChatMessageBubble
              style={steerBubble(firstQueued >= 0 && i > firstQueued)}
              metadata={
                <HStack gap={0.5} hAlign="end" vAlign="center">
                  <Button label="Queue instead" variant="ghost" size="sm" tooltip="Send after this turn instead" onClick={() => edit(p.id, { mode: "followUp" })} />
                  <IconButton label="Cancel this message" tooltip="Cancel this message" variant="ghost" size="sm" icon={<Icon icon="close" />} onClick={() => edit(p.id, { remove: true })} />
                </HStack>
              }
            >
              <PendingText p={p} edit={edit} />
            </ChatMessageBubble>
          </ChatMessage>
        ),
      )}
    </>
  );
}

/** Queued messages wait in the box and go out one per turn, top first. */
function QueuedList({ sessionId, state }: { sessionId: string; state: LiveState }) {
  const edit = usePendingEdit(sessionId);
  const list = state.pending ?? [];
  const [drag, setDrag] = useState<string>();
  const queued = list.map((p, i) => ({ p, i })).filter((x) => x.p.mode === "followUp");
  if (!queued.length && !state.pendingHeld) return null;
  return (
    <VStack gap={1.5} style={pendingScroll}>
      {state.pendingHeld && list.length > 0 && (
        <HStack gap={2} vAlign="center">
          <StackItem size="fill">
            <Text type="supporting">Stopped. Waiting messages hold until you send them.</Text>
          </StackItem>
          <Button label="Send" variant="primary" size="sm" onClick={() => edit(list[0]!.id, { now: true })} />
        </HStack>
      )}
      {queued.map(({ p, i }) => (
        <HStack
          key={p.id}
          gap={1.5}
          vAlign="start"
          padding={1.5}
          style={queuedRow(drag === p.id)}
          draggable
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
          <Icon icon={EllipsisVerticalIcon} size="sm" color="secondary" label="Drag to reorder" />
          <StackItem size="fill">
            <PendingText p={p} edit={edit} clamp />
          </StackItem>
          <HStack gap={0.5} vAlign="center">
            <Button label="Steer now" variant="ghost" size="sm" tooltip="Send it into the running turn now" onClick={() => edit(p.id, { now: true })} />
            <IconButton label="Cancel this message" tooltip="Cancel this message" variant="ghost" size="sm" icon={<Icon icon="close" />} onClick={() => edit(p.id, { remove: true })} />
          </HStack>
        </HStack>
      ))}
    </VStack>
  );
}

/** One row of the `/` menu: a skill (with where it comes from) or one of the harness's commands. */
function SlashItem({ c, highlighted, narrow, onPick }: { c: SlashCommand; highlighted: boolean; narrow: boolean; onPick: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (highlighted) ref.current?.scrollIntoView({ block: "nearest" });
  }, [highlighted]);
  const badges =
    c.kind === "skill" ? (
      <HStack gap={0.5} vAlign="center">
        {(c.sources ?? []).slice(0, narrow ? 1 : 3).map((s) => (
          <Token key={s} size="sm" label={s} />
        ))}
        {c.native === false && (
          <Tooltip content="This harness can't run it by name, so Tether sends SKILL.md along with your message">
            <Token size="sm" color="purple" label="inline" />
          </Tooltip>
        )}
      </HStack>
    ) : undefined;
  return (
    <Item
      ref={ref}
      density="compact"
      layout={narrow ? "stacked" : "inline"}
      descriptionLines={1}
      isHighlighted={highlighted}
      label={<Text type="code">/{c.name}</Text>}
      description={c.description}
      endContent={badges}
      onClick={onPick}
    />
  );
}

function Composer({ sessionId, state }: { sessionId: string; state: LiveState }) {
  const [text, setText] = useState(() => localStorage.getItem(`tether.draft.${sessionId}`) ?? "");
  const [cmds, setCmds] = useState<SlashCommand[] | null>(null);
  const [cmdIdx, setCmdIdx] = useState(0);
  const [menuClosed, setMenuClosed] = useState(false);
  const input = useRef<ChatComposerInputHandle>(null);
  const narrow = useNarrow();
  const running = state.status === "running";

  useEffect(() => {
    try {
      text ? localStorage.setItem(`tether.draft.${sessionId}`, text) : localStorage.removeItem(`tether.draft.${sessionId}`);
    } catch {}
  }, [text, sessionId]);

  // The `/` menu: skills and the harness's commands, fetched each time it opens (skills change).
  const slash = slashQuery(text);
  const open = slash !== null;
  useEffect(() => {
    setMenuClosed(false);
    if (!open) return;
    let current = true;
    rpc("listCommands", { sessionId })
      .then((r) => current && setCmds(r))
      .catch(() => current && setCmds((c) => c ?? []));
    return () => void (current = false);
  }, [open, sessionId]);
  const groups = useMemo(() => slashGroups(cmds ?? [], slash ?? ""), [cmds, slash]);
  const matches = open && !menuClosed ? groups.flat : [];

  const send = async (mode?: "steer" | "followUp") => {
    const t = text.trim();
    if (!t) return;
    setText("");
    const r = await act("prompt", { sessionId, text: t, mode: running ? (mode ?? "steer") : undefined });
    if (r === undefined) setText(t);
  };

  const pick = (name: string) => {
    setText(`/${name} `);
    input.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (matches.length) {
      const idx = Math.min(cmdIdx, matches.length - 1);
      if (e.key === "ArrowDown") return (e.preventDefault(), setCmdIdx((idx + 1) % matches.length));
      if (e.key === "ArrowUp") return (e.preventDefault(), setCmdIdx((idx - 1 + matches.length) % matches.length));
      if (e.key === "Escape") return (e.preventDefault(), setMenuClosed(true));
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && `/${matches[idx]!.name}` !== text)) {
        e.preventDefault();
        setText(`/${matches[idx]!.name} `);
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
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      // Always ours: the input's own submit doesn't know steer from queue.
      e.preventDefault();
      if (window.innerWidth <= 760) {
        // Phones: Enter is a new line; the button sends.
        if (!document.execCommand("insertLineBreak")) input.current?.insertText("\n");
        return;
      }
      send(e.altKey ? "followUp" : "steer");
    }
  };

  const shell = text.startsWith("!");
  const bg = state.background ?? [];
  const legacyQueued = !state.pending?.length && !state.pending && state.queued.length > 0;
  const hasDrawer = matches.length > 0 || bg.length > 0 || !!state.pending?.length || legacyQueued;
  const placeholder = shell ? "" : running ? "Steer the agent… (Enter to steer, Alt+Enter to queue for after)" : "Message the agent… (/ for skills and commands)";

  const drawer = hasDrawer ? (
    <ChatComposerDrawer>
      {/* The drawer lays its content out in a wrapping row: without a width, long rows overflow it. */}
      <VStack gap={2} style={drawerBody}>
        {matches.length > 0 && (
          <VStack style={pendingScroll}>
            {[
              { label: "Skills", list: groups.skills, offset: 0 },
              { label: "Commands", list: groups.commands, offset: groups.skills.length },
            ].map(
              (g) =>
                g.list.length > 0 && (
                  <VStack key={g.label}>
                    <HStack paddingInline={2} paddingBlockStart={1}>
                      <Text type="label" color="secondary">
                        {g.label}
                      </Text>
                    </HStack>
                    {g.list.map((c, i) => (
                      <SlashItem key={`${c.kind}:${c.name}`} c={c} narrow={narrow} highlighted={g.offset + i === Math.min(cmdIdx, matches.length - 1)} onPick={() => pick(c.name)} />
                    ))}
                  </VStack>
                ),
            )}
          </VStack>
        )}
        {bg.length > 0 && (
          <Tooltip content="Work the agent keeps running between turns">
            <HStack gap={2} vAlign="center">
              <Spinner size="sm" />
              <StackItem size="fill">
                <Text type="supporting" maxLines={1}>
                  {bg.length} background task{bg.length > 1 ? "s" : ""}: {bg.map((b) => b.description).join(" · ")}
                </Text>
              </StackItem>
            </HStack>
          </Tooltip>
        )}
        {state.pending?.length ? <QueuedList sessionId={sessionId} state={state} /> : null}
        {legacyQueued && (
          <HStack gap={1.5} wrap="wrap">
            {state.queued.map((q, i) => (
              <Token key={i} size="sm" label={`queued: ${q}`} />
            ))}
          </HStack>
        )}
      </VStack>
    </ChatComposerDrawer>
  ) : undefined;

  return (
    <VStack gap={2} style={composerDock}>
      {state.status === "waiting" && (
        <Banner
          status="warning"
          title={`${state.waitingReason ?? "Waiting"}${state.waitingUntil ? ` · resumes ${fmtClock(state.waitingUntil)}` : ""}`}
          endContent={<Button label="Cancel" size="sm" onClick={() => act("abort", { sessionId })} />}
        />
      )}
      <ChatComposer
        value={text}
        onChange={(v) => {
          setText(v);
          setCmdIdx(0);
        }}
        onSubmit={() => send("steer")}
        placeholder={placeholder}
        status={shell ? { type: "warning", message: "Bash mode: runs directly on the runner in the project folder, outside the agent and the guard" } : undefined}
        statusPosition="top"
        drawer={drawer}
        input={
          <ChatComposerInput
            handleRef={input}
            label={shell ? "Bash command" : "Message"}
            placeholder={placeholder}
            hasHistory={false}
            pasteAsToken={false}
            maxRows={12}
            onKeyDown={onKeyDown}
            style={shell ? shellFont : undefined}
          />
        }
        footerActions={
          narrow ? undefined : (
            <Text type="supporting">{shell ? "Enter to run · output goes to the agent with your next message" : "Shift+Enter for a new line · ! for bash mode"}</Text>
          )
        }
        sendActions={
          <>
            {running && <Button label="Stop" variant="destructive" size="sm" icon={<Icon icon="stop" />} onClick={() => act("abort", { sessionId })} />}
            {running && !shell && <Button label="Queue" size="sm" isDisabled={!text.trim()} onClick={() => send("followUp")} />}
          </>
        }
        sendButton={<Button label={shell ? "Run ↵" : running ? "Steer ↵" : "Send ↵"} variant="primary" size="sm" isDisabled={!text.trim()} onClick={() => send("steer")} />}
      />
      <SettingsBar sessionId={sessionId} state={state} />
    </VStack>
  );
}
