import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type ClipboardEvent, type CSSProperties, type DragEvent, type KeyboardEvent } from "react";
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
import { Layout } from "@astryxdesign/core/Layout";
import { Spinner } from "@astryxdesign/core/Spinner";
import { StackItem } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { Token } from "@astryxdesign/core/Token";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { VStack } from "@astryxdesign/core/VStack";
import { CameraIcon, EllipsisVerticalIcon, PaperClipIcon } from "@heroicons/react/24/outline";
import { addFiles, clearDrafts, takeBack, useDrafts } from "../attachments";
import { splitAttachments, withAttachments } from "../shared/attachments";
import { AttachmentChips, DraftChips } from "./Attachments";
import { effortLabel } from "../models";
import { MODE_DESCRIPTIONS, modeLabel, pickerModes } from "../modes";
import { GUARD_MODES, type LiveState, type Ops, type PendingMessage, type SlashCommand } from "../shared/protocol";
import { slashGroups, slashQuery } from "../slash";
import { act, rpc, selectSession, useStore } from "../store";
import { fmtClock } from "../util";
import { ActivityButton, ActivityPanel } from "./Activity";
import { ChangesButton, ChangesDialog, turnChangeMarkers } from "./Changes";
import { ContextMeter } from "./ContextMeter";
import { HarnessBadge } from "./HarnessBadge";
import { ModelMenu, PickMenu } from "./ModelMenu";
import { SessionConflicts } from "./MemoryConflicts";
import { LinkBanner, setProjectRoot, Transcript } from "./Transcript";
import { UiRequests } from "./UiRequests";
import { UsagePill } from "./Usage";

/** Phones: Enter makes a new line, and the less important settings hide. */
const NARROW = "(max-width: 760px)";
const useNarrow = () => useMediaQuery(NARROW);

const fill: CSSProperties = { flex: 1, minHeight: 0 };
/** The chat column in the Layout content slot (which scrolls): exactly its height, so the transcript
 *  scrolls and a tall composer drawer (the `/` menu, waiting messages) never pushes the composer out. */
const chatColumn: CSSProperties = { ...fill, height: "100%" };
const preWrap: CSSProperties = { whiteSpace: "pre-wrap", wordBreak: "break-word", cursor: "text" };
const statusText: CSSProperties = { maxWidth: "calc(var(--spacing-12) * 4)" };
const composerDock: CSSProperties ={ paddingBlockEnd: "env(safe-area-inset-bottom)" };
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

  // Files dragged anywhere onto the session attach to the message being written. (Reordering
  // queued messages is a drag too, but carries no files.)
  const [dropping, setDropping] = useState(false);
  const dragDepth = useRef(0);
  const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes("Files");
  const dropHandlers = {
    onDragEnter: (e: DragEvent<HTMLDivElement>) => {
      if (!hasFiles(e)) return;
      dragDepth.current++;
      setDropping(true);
    },
    onDragOver: (e: DragEvent<HTMLDivElement>) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    },
    onDragLeave: (e: DragEvent<HTMLDivElement>) => {
      if (!hasFiles(e)) return;
      if (--dragDepth.current <= 0) (dragDepth.current = 0), setDropping(false);
    },
    onDrop: (e: DragEvent<HTMLDivElement>) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth.current = 0;
      setDropping(false);
      if (e.dataTransfer.files.length) addFiles(sessionId, e.dataTransfer.files);
    },
  };

  if (!o || o.loading || !o.session)
    return (
      <VStack style={fill} vAlign="center" hAlign="center">
        <EmptyState title="Loading session…" icon={<Spinner />} isCompact />
      </VStack>
    );

  const st = o.state;
  setProjectRoot(o.session.projectPath, sessionId);
  const chat = (
    <VStack style={chatColumn} {...dropHandlers}>
      {dropping && <Banner status="info" container="section" title="Drop to attach to your message" />}
      {o.syncing &&<Banner status="info" container="section" icon={<Spinner size="sm" />} title="Connecting… showing the last copy this browser saw" />}
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
          <SessionConflicts sessionId={sessionId} />
        </VStack>
      </ChatLayout>
    </VStack>
  );
  return (
    <>
      <Layout padding={0} content={chat} end={<ActivityPanel sessionId={sessionId} state={st} harness={o.session.harness} />} />
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
      <ThinkingMenu sessionId={sessionId} harness={sess.harness} state={st} compact={narrow} />
      <ModeMenu sessionId={sessionId} state={st} />
      <PickMenu
        label=""
        value={GUARD_MODES.find((g) => g.id === (st.guard ?? "auto"))?.label ?? st.guard!}
        options={GUARD_MODES.map((g) => g.label)}
        onPick={(label) => act("setGuard", { sessionId, mode: GUARD_MODES.find((g) => g.label === label)!.id })}
      />
      <ChangesButton sessionId={sessionId} state={st} />
      <ActivityButton state={st} />
      <StackItem size="fill" />
      {!narrow &&
        Object.entries(st.statuses).map(([k, v]) => (
          // Extension statuses can be long (pi's usage lines); one short line each keeps the bar on one row.
          <Tooltip key={k} content={`${k}: ${v}`}>
            <Text type="code" color="secondary" maxLines={1} style={statusText}>
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

/** Plan mode and the harness's other modes (src/modes.ts); approvals stay with the guard picker. */
function ModeMenu({ sessionId, state }: { sessionId: string; state: LiveState }) {
  const options = pickerModes(state);
  if (!options.length) return null;
  const value = state.permissionMode ?? options[0]!;
  return (
    <PickMenu
      label=""
      value={value}
      options={options}
      format={modeLabel}
      describe={Object.fromEntries(options.flatMap((m) => (MODE_DESCRIPTIONS[m] ? [[m, MODE_DESCRIPTIONS[m]!]] : [])))}
      onPick={(mode) => mode !== value && act("setPermissionMode", { sessionId, mode })}
    />
  );
}

/** `compact` (phones): no label in front, the value says what it is ("High effort"). */
function ThinkingMenu({ sessionId, harness, state, compact }: { sessionId: string; harness: string; state: LiveState; compact?: boolean }) {
  const [fetched, setLevels] = useState<string[]>([]);
  // A deep link shows the saved copy before the runner is connected; ask again once it is.
  const online = useStore((s) => s.connected && !!s.runnerId);
  useEffect(() => {
    if (state.thinkingLevels || !online) return;
    rpc("listModels", { harness: harness as any, sessionId })
      .then((r) => setLevels(r.thinkingLevels))
      .catch(() => {});
  }, [harness, sessionId, state.model, state.thinkingLevels, online]);
  const levels = state.thinkingLevels ?? fetched;
  if (!levels.length) return null;
  const label = harness === "claude-code" || harness === "codex" || harness === "antigravity" ? "Effort" : "Thinking";
  return (
    <PickMenu
      label={compact ? "" : label}
      value={state.thinking ?? "default"}
      options={levels}
      format={compact ? (l) => `${effortLabel(l)} ${label.toLowerCase()}` : effortLabel}
      onPick={(level) => act("setThinking", { sessionId, level })}
    />
  );
}

type EditPending = (id: string, change: Omit<Ops["editPending"]["args"], "sessionId" | "id">) => void;

/** A waiting message's text; click to edit it until it goes out. */
function PendingText({ p, edit, clamp }: { p: PendingMessage; edit: EditPending; clamp?: boolean }) {
  const [draft, setDraft] = useState<string>();
  // Only the words are edited; the attached files stay with the message.
  const { text: body, files } = useMemo(() => splitAttachments(p.text), [p.text]);
  const save = () => {
    if (draft !== undefined && draft !== body) edit(p.id, { text: withAttachments(draft, files) });
    setDraft(undefined);
  };
  if (draft === undefined)
    return (
      <VStack gap={1}>
        {body.trim() && (
          <Tooltip content="Click to edit" hasHoverIndication={false}>
            <Text display="block" maxLines={clamp ? 3 : 0} hasTruncateTooltip={false} style={preWrap} onClick={() => setDraft(body)}>
              {body.split("\n\n<bash-input>")[0]}
            </Text>
          </Tooltip>
        )}
        <AttachmentChips files={files} />
      </VStack>
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
          <StackItem>
            <Button label="Send" variant="primary" size="sm" onClick={() => edit(list[0]!.id, { now: true })} />
          </StackItem>
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
  const touch = useMediaQuery("(pointer: coarse)");
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
  // A new query starts at its best match.
  useEffect(() => setCmdIdx(0), [slash]);
  // Open with nothing to show: say so (loading, or no match) rather than hide the menu.
  const menuNote = open && !menuClosed && !matches.length ? (cmds === null ? "Loading skills and commands…" : slash ? `No skill or command matches “/${slash}”` : "No skills or commands here") : undefined;

  const drafts = useDrafts(sessionId);
  const ready = drafts.filter((d) => d.attachment && !d.error);
  const uploading = drafts.some((d) => !d.attachment && !d.error);
  const fileInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  const shell = text.startsWith("!");
  const canSend = (!!text.trim() || (ready.length > 0 && !shell)) && !uploading && !(shell && ready.length > 0);

  const send = async (mode?: "steer" | "followUp") => {
    const t = text.trim();
    if (!canSend) return;
    const files = ready.map((d) => d.attachment!);
    setText("");
    const r = await act("prompt", { sessionId, text: t, mode: running ? (mode ?? "steer") : undefined, ...(files.length ? { attachments: files } : {}) });
    if (r === undefined) setText(t);
    else if (files.length) clearDrafts(sessionId);
  };

  // A pasted screenshot or copied file is attached; rich content (a spreadsheet's cells, a web
  // page) pastes as text even when the clipboard also carries a picture of it.
  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    const files = [...e.clipboardData.files];
    if (!files.length || e.clipboardData.types.includes("text/html")) return;
    e.preventDefault();
    e.stopPropagation();
    addFiles(sessionId, files);
  };

  const picked = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.length) addFiles(sessionId, e.target.files);
    e.target.value = "";
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
        .then((r) => r.text && setText(takeBack(sessionId, r.text)))
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

  const legacyQueued = !state.pending?.length && !state.pending && state.queued.length > 0;
  const hasDrawer = matches.length > 0 || !!menuNote || !!state.pending?.length || legacyQueued || drafts.length > 0;
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
        {menuNote && (
          <HStack paddingInline={2} gap={2} vAlign="center">
            {cmds === null && <Spinner size="sm" />}
            <Text type="supporting" color="secondary">
              {menuNote}
            </Text>
          </HStack>
        )}
        {state.pending?.length ? <QueuedList sessionId={sessionId} state={state} /> : null}
        {drafts.length > 0 && <DraftChips sessionId={sessionId} drafts={drafts} />}
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

  const attach = (
    <HStack gap={0.5} vAlign="center">
      <IconButton label="Attach files or images" tooltip="Attach files or images (or paste, or drop them here)" variant="ghost" size="sm" icon={<Icon icon={PaperClipIcon} size="sm" />} onClick={() => fileInput.current?.click()} />
      {touch && <IconButton label="Take a photo" tooltip="Take a photo" variant="ghost" size="sm" icon={<Icon icon={CameraIcon} size="sm" />} onClick={() => cameraInput.current?.click()} />}
      {/* The native pickers: any file (on phones this also offers the photo library and camera), or the camera directly. */}
      <input ref={fileInput} type="file" multiple hidden onChange={picked} />
      <input ref={cameraInput} type="file" accept="image/*" capture="environment" hidden onChange={picked} />
    </HStack>
  );

  return (
    <VStack gap={2} style={composerDock} onPasteCapture={onPaste}>
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
          <HStack gap={1} vAlign="center">
            {!shell && attach}
            {!narrow && (
              <Text type="supporting">
                {shell
                  ? ready.length
                    ? "Bash mode can't take attachments"
                    : "Enter to run · output goes to the agent with your next message"
                  : uploading
                    ? "Uploading…"
                    : "Shift+Enter for a new line · ! for bash mode"}
              </Text>
            )}
          </HStack>
        }
        sendActions={
          <>
            {running && <Button label="Stop" variant="destructive" size="sm" icon={<Icon icon="stop" />} onClick={() => act("abort", { sessionId })} />}
            {running && !shell && <Button label="Queue" size="sm" isDisabled={!canSend} onClick={() => send("followUp")} />}
          </>
        }
        sendButton={
          <Button
            label={shell ? "Run ↵" : running ? "Steer ↵" : "Send ↵"}
            variant="primary"
            size="sm"
            isDisabled={!canSend}
            tooltip={uploading ? "Waiting for attachments to upload" : undefined}
            onClick={() => send("steer")}
          />
        }
      />
      <SettingsBar sessionId={sessionId} state={state} />
    </VStack>
  );
}
