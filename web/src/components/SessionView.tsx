import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type ClipboardEvent, type CSSProperties, type DragEvent, type FocusEvent, type KeyboardEvent, type RefObject } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { ButtonGroup } from "@astryxdesign/core/ButtonGroup";
import {
  ChatComposer,
  ChatComposerDrawer,
  ChatComposerInput,
  ChatLayout,
  ChatMessage,
  ChatMessageBubble,
  type ChatComposerInputHandle,
} from "@astryxdesign/core/Chat";
import { ContextMenu } from "@astryxdesign/core/ContextMenu";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Item } from "@astryxdesign/core/Item";
import { Kbd } from "@astryxdesign/core/Kbd";
import { Layout } from "@astryxdesign/core/Layout";
import { MoreMenu } from "@astryxdesign/core/MoreMenu";
import { ScrollableArea } from "@astryxdesign/core/ScrollableArea";
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
import { GUARD_MODES, STARTS_ON_OPEN, type GuardMode, type HarnessId, type LiveState, type Msg, type Ops, type PendingMessage, type SlashCommand } from "../shared/protocol";
import { slashGroups, slashQuery } from "../slash";
import { act, rpc, selectSession, useStore } from "../store";
import { composerHistory } from "../composerHistory";
import { fmtClock, harnessLabel } from "../util";
import { opensByStarting } from "../sessionStart";
import { ActivityButton, ActivityPanel, ActivityStrip } from "./Activity";
import { ChangesButton, ChangesDialog, turnChangeMarkers } from "./Changes";
import { FilePanel, FileSheet, takeScrollAnchor, useFileTarget } from "./FilePanel";
import { FileRefScope, refreshFileChecks } from "./FileRefs";
import { FindBar, modalOpen, type FindBarHandle } from "./FindBar";
import { findMatches, latestUnmounted, MIN_TERM } from "../find";
import { GoalLine } from "./GoalLine";
import { ScheduleLine } from "./ScheduleLine";
import { ContextMeter } from "./ContextMeter";
import { ModelMenu, PickMenu } from "./ModelMenu";
import { SessionConflicts } from "./MemoryConflicts";
import { LinkBanner, setProjectRoot, Transcript } from "./Transcript";
import { withReviews } from "./ReviewCard";
import { UiRequests } from "./UiRequests";
import { UsagePill } from "./Usage";
import { commandRunsHow } from "../library";
import { create } from "zustand";
// opencode, Kiro and Antigravity can't take a message mid-turn: what you send waits for the turn's end (README, "Steer and queue").
import { canSteer, completesSlash, composerKeyAction, fullAccessLeft } from "../composerKeys";

/** Phones: Enter makes a new line, and the less important settings hide. */
const NARROW = "(max-width: 760px)";
const useNarrow = () => useMediaQuery(NARROW);

const fill: CSSProperties = { flex: 1, minHeight: 0 };
/** The chat column in the Layout content slot (which scrolls): exactly its height, so the transcript
 *  scrolls and a tall composer drawer (the `/` menu, waiting messages) never pushes the composer out. */
const chatColumn: CSSProperties = { ...fill, height: "100%" };
const preWrap: CSSProperties = { whiteSpace: "pre-wrap", wordBreak: "break-word", cursor: "text" };
const composerDock: CSSProperties ={ paddingBlockEnd: "env(safe-area-inset-bottom)" };
const pendingScroll: CSSProperties = { maxHeight: "30vh", overflowY: "auto" };
/** Docked requests stay reachable without taking the whole screen (a long plan scrolls inside). */
const dockedRequests: CSSProperties = { maxHeight: "50dvh", overflowY: "auto" };
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

const harnessOf = (sessionId: string) => sessionId.split(":")[0] as HarnessId;

export function SessionView({ sessionId }: { sessionId: string }) {
  const o = useStore((s) => s.open[sessionId]);
  // Opening a session whose process has stopped shows its stored conversation; only harnesses that
  // can't (STARTS_ON_OPEN) start the process for it.
  const knownLive = useStore((s) => (s.open[sessionId]?.session ?? Object.values(s.sessions).flat().find((x) => x.id === sessionId) ?? s.recent?.find((x) => x.id === sessionId))?.live);
  const scroller = useRef<HTMLDivElement>(null);
  // Following the end of the conversation. SessionView alone decides this: `stick` turns off only
  // when a scroll lands above the last position we set or saw (the reader went up), and on again
  // when one lands at the bottom. Our own downward writes never turn it off.
  const stick = useRef(true);
  const lastTop = useRef(0);
  const atBottom = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight < 2;
  /** Moves the scroller and keeps the follow state in step with where it landed. */
  const scrollTo = (top: number) => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTop = top;
    lastTop.current = el.scrollTop;
    stick.current = atBottom(el);
  };
  const toBottom = () => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    lastTop.current = el.scrollTop;
  };
  const narrow = useNarrow();
  const sidebarHidden = useStore((s) => s.sidebarHidden);

  // Find in this session (Cmd/Ctrl+F): the bar is open while `find` is a string. The conversation
  // (not the page) says how many matches there are. The transcript mounts back to one more matching
  // message (`revealFrom`, the latest it hasn't got) only when the bar asks: it has nothing to show
  // for the term, or the reader walked back past the first match on the page. A new term withdraws
  // the wish, so the window stops growing.
  const [find, setFind] = useState<string>();
  const [revealFrom, setRevealFrom] = useState<number>();
  const [revealed, setRevealed] = useState(true);
  const findBar = useRef<FindBarHandle>(null);
  const composerInput = useRef<ChatComposerInputHandle>(null);
  const term = find && find.length >= MIN_TERM ? find : "";
  const messages = o?.messages;
  const matches = useMemo(() => (term && messages ? findMatches(messages, term) : { indices: [], total: 0 }), [term, messages]);
  const matchesRef = useRef(matches);
  matchesRef.current = matches;
  const startRef = useRef(0);
  const onStart = useCallback((start: number) => void (startRef.current = start), []);
  const earlier = useCallback(() => {
    const at = latestUnmounted(matchesRef.current.indices, startRef.current);
    if (at === undefined) return false;
    setRevealFrom(at);
    return true;
  }, []);
  // A new term withdraws the wish at once (not in an effect: the bar's own effects may ask again in
  // the same commit, and that request must stand).
  const onTerm = (t: string) => {
    setFind(t);
    setRevealFrom(undefined);
  };
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== "f") return;
      if (modalOpen()) return;
      e.preventDefault();
      setFind((f) => f ?? "");
      findBar.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const closeFind = () => {
    setFind(undefined);
    setRevealFrom(undefined);
    composerInput.current?.focus();
  };

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

  // Stay pinned to the bottom unless the reader scrolled up: after every render of this view…
  useLayoutEffect(() => {
    if (stick.current) toBottom();
  });
  // …and whenever the message area changes size without one (earlier rows mounting, an image
  // decoding, a bubble from another store). ChatLayout's own hook springs toward the bottom from
  // the position it read in its observer callback, which ran before ours; its next frames would
  // write that stale position back, so the bottom is asserted again each frame until nothing else
  // has moved the scroller for two frames. A reader's wheel still wins: its scroll event fires
  // before that frame's animation callbacks and turns `stick` off first.
  const loaded = !!o && !o.loading && !!o.session;
  useEffect(() => {
    const el = scroller.current;
    const area = el?.firstElementChild;
    if (!el || !area) return;
    let frame = 0;
    let settled = 0;
    const hold = () => {
      frame = 0;
      if (!stick.current) return;
      if (atBottom(el)) settled++;
      else {
        toBottom();
        settled = 0;
      }
      if (settled < 2) frame = requestAnimationFrame(hold);
    };
    const ro = new ResizeObserver(() => {
      if (!stick.current) return;
      toBottom();
      settled = 0;
      if (!frame) frame = requestAnimationFrame(hold);
    });
    ro.observe(area);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [loaded, sessionId]);

  // File references in the transcript belong to this session; they're checked again when a turn ends.
  const refScope = useMemo(() => ({ sessionId }), [sessionId]);
  const ost = o?.state;
  const filesStamp = `${ost?.diffStat?.additions}/${ost?.diffStat?.deletions}/${ost?.diffStat?.files}/${ost?.checkpoints?.length}/${ost?.status === "idle"}`;
  useEffect(() => {
    refreshFileChecks(sessionId);
  }, [sessionId, filesStamp]);
  const fileTarget = useFileTarget(sessionId);

  // The file panel narrows the chat and the transcript reflows: keep what was on screen in place
  // (the clicked reference, else the line at the top), or the bottom when following the end.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let anchor: { node: Element; top: number } | undefined;
    const capture = () => {
      const r = el.getBoundingClientRect();
      const node = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(48, r.height / 2));
      anchor = node && node !== el && el.contains(node) ? { node, top: node.getBoundingClientRect().top } : undefined;
    };
    let width = el.clientWidth;
    let height = el.clientHeight;
    const ro = new ResizeObserver(() => {
      // A shorter scroller (the keyboard, a smaller window) leaves a gap under the end unless re-pinned.
      if (el.clientHeight !== height) {
        height = el.clientHeight;
        if (stick.current) toBottom();
      }
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      const a = takeScrollAnchor() ?? anchor;
      if (stick.current) toBottom();
      else if (a?.node.isConnected) scrollTo(el.scrollTop + a.node.getBoundingClientRect().top - a.top);
      capture();
    });
    capture();
    el.addEventListener("scroll", capture, { passive: true });
    ro.observe(el);
    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", capture);
    };
  }, [loaded, sessionId]);

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
        <EmptyState title={opensByStarting(harnessOf(sessionId), knownLive) ? `Starting ${harnessLabel(harnessOf(sessionId))} process…` : "Loading session…"} icon={<Spinner />} isCompact />
      </VStack>
    );

  const st = o.state;
  setProjectRoot(o.session.projectPath, sessionId);
  const chat = (
    <VStack style={chatColumn} {...dropHandlers}>
      {dropping && <Banner status="info" container="section" title="Drop to attach to your message" />}
      <GoalLine goal={st.goal} inset={narrow || sidebarHidden} />
      <ScheduleLine sessionId={sessionId} schedules={st.schedules} inset={narrow || sidebarHidden} />
      {find !== undefined && (
        <FindBar
          ref={findBar}
          scroller={scroller}
          term={find}
          onTerm={onTerm}
          onClose={closeFind}
          scrollTo={scrollTo}
          total={matches.total}
          pending={!revealed}
          onEarlier={earlier}
          inset={narrow || sidebarHidden}
        />
      )}
      <ChatLayout
        ref={scroller}
        density="spacious"
        style={{ overscrollBehavior: "contain" }}
        onScroll={(e) => {
          const el = e.currentTarget;
          if (atBottom(el)) stick.current = true;
          else if (el.scrollTop < lastTop.current - 1) stick.current = false;
          lastTop.current = el.scrollTop;
        }}
        composer={
          <Composer
            sessionId={sessionId}
            state={st}
            messages={o.messages}
            harness={o.session.harness}
            live={o.session.live}
            opening={!!o.syncing && STARTS_ON_OPEN.has(o.session.harness)}
            syncing={!!o.syncing}
            inputRef={composerInput}
          />
        }
      >
        {/* Room at the top on phones for the floating sidebar button. */}
        <VStack gap={4} paddingBlockStart={narrow ? 10 : 6} paddingBlockEnd={2}>
          <LinkBanner from={st.handoffFrom} forked={st.forkedFrom} reviewOf={st.reviewOf} startedBy={st.startedBy} />
          {o.messages.length === 0 && <Text type="supporting">No messages yet.</Text>}
          <FileRefScope value={refScope}>
            <Transcript
              key={sessionId}
              messages={o.messages}
              running={st.status === "running"}
              amendable={st.amendable}
              after={withReviews(turnChangeMarkers(sessionId, o.messages, st), sessionId, o.messages, st.reviews)}
              revealFrom={revealFrom}
              onRevealed={setRevealed}
              onStart={onStart}
            />
          </FileRefScope>
          <PendingSteers sessionId={sessionId} state={st} steerable={canSteer(o.session.harness)} />
          <Sending sessionId={sessionId} starting={!o.session.live ? harnessLabel(o.session.harness) : undefined} />
          {st.checking && (
            <HStack gap={2} vAlign="center">
              <Spinner size="sm" />
              <Text type="supporting" color="secondary">
                {st.checking}
              </Text>
            </HStack>
          )}
          {st.handoffTo && <LinkBanner to={st.handoffTo} />}
          <SessionConflicts sessionId={sessionId} />
        </VStack>
      </ChatLayout>
    </VStack>
  );
  return (
    <>
      <Layout
        padding={0}
        content={chat}
        end={fileTarget && !narrow ? <FilePanel target={fileTarget} state={st} /> : <ActivityPanel sessionId={sessionId} state={st} harness={o.session.harness} />}
      />
      {narrow && <FileSheet target={fileTarget} state={st} />}
      <ChangesDialog sessionId={sessionId} state={st} />
    </>
  );
}

/** Under the message box: what the session runs on and how, plus context and plan usage. One row
 *  that scrolls sideways on phones instead of wrapping to three. */
function SettingsBar({ sessionId, state: st }: { sessionId: string; state: LiveState }) {
  const sess = useStore((s) => s.open[sessionId]?.session);
  const narrow = useNarrow();
  if (!sess) return null;
  const items = (
    <>
      <ModelMenu sessionId={sessionId} harness={sess.harness} state={st} />
      <ThinkingMenu sessionId={sessionId} harness={sess.harness} state={st} />
      <ModeMenu sessionId={sessionId} state={st} />
      <GuardMenu sessionId={sessionId} state={st} />
      <ChangesButton sessionId={sessionId} state={st} />
      <ActivityButton state={st} />
      <StackItem size="fill" />
      <ContextMeter state={st} />
      <UsagePill harness={sess.harness} model={st.model} statuses={st.statuses} cost={st.cost} />
    </>
  );
  if (narrow)
    return (
      <ScrollableArea axis="inline" label="Session settings">
        <HStack gap={1} vAlign="center" wrap="nowrap" paddingInline={1}>
          {items}
        </HStack>
      </ScrollableArea>
    );
  return (
    <HStack gap={1} vAlign="center" wrap="wrap" paddingInline={1}>
      {items}
    </HStack>
  );
}

/** Approvals, in the picker's words (GUARD_MODES' ids, shorter labels). */
const GUARD_LABEL: Record<GuardMode, string> = { ask: "Ask", edits: "Accept edits", auto: "Auto", full: "Full access" };
const TIMED_FULL_MINUTES = 15;

/** The time left before `until`; re-renders at each whole minute left and once more at `until`. */
function useTimeLeft(until: number | undefined): number | undefined {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!until) return;
    const left = until - Date.now();
    if (left <= 0) return;
    const t = setTimeout(() => setNow(Date.now()), (left % 60_000) + 50);
    return () => clearTimeout(t);
  }, [until, now]);
  return until ? Math.max(0, until - Date.now()) : undefined;
}

/** Who approves tool calls; "Full access for 15 minutes" counts down in the trigger ("Full · 12m"). */
function GuardMenu({ sessionId, state }: { sessionId: string; state: LiveState }) {
  const mode = state.guard ?? "auto";
  const timed = !!state.guardUntil && mode === "full";
  const left = useTimeLeft(timed ? state.guardUntil : undefined);
  const shown = timed ? `Full · ${fullAccessLeft(left ?? 0)}` : GUARD_LABEL[mode];
  const set = (args: Omit<Ops["setGuard"]["args"], "sessionId">) => act("setGuard", { sessionId, ...args });
  return (
    <DropdownMenu
      button={{ label: `Approvals: ${shown}`, variant: "ghost", size: "sm", children: shown }}
      placement="above"
      presentation="adaptive"
      menuWidth={240}
      items={[
        ...GUARD_MODES.map((g) => ({
          id: g.id,
          label: GUARD_LABEL[g.id],
          endContent: g.id === mode && !timed ? <Icon icon="check" size="sm" color="accent" /> : undefined,
          onClick: () => (g.id !== mode || timed) && set({ mode: g.id }),
        })),
        // Untimed full access has nothing to go back to: no timed item then.
        ...(timed
          ? // The runner puts back the mode from before; "auto" when it can't tell.
            [{ type: "divider" as const }, { id: "end", label: "End full access", onClick: () => set({ mode: "auto" }) }]
          : mode === "full"
            ? []
            : [
                { type: "divider" as const },
                {
                  id: "timed",
                  label: `Full access for ${TIMED_FULL_MINUTES} minutes`,
                  description: `Then back to ${GUARD_LABEL[mode]}`,
                  onClick: () => set({ mode: "full", minutes: TIMED_FULL_MINUTES }),
                },
              ]),
      ]}
    />
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

/** No label in front: the value says what it is ("High effort", "Low thinking"). */
function ThinkingMenu({ sessionId, harness, state }: { sessionId: string; harness: string; state: LiveState }) {
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
  const noun = harness === "claude-code" || harness === "codex" || harness === "antigravity" ? "effort" : "thinking";
  return <PickMenu label="" value={state.thinking ?? "default"} options={levels} format={effortLabel} formatValue={(l) => `${effortLabel(l)} ${noun}`} onPick={(level) => act("setThinking", { sessionId, level })} />;
}

type EditPending = (id: string, change: Omit<Ops["editPending"]["args"], "sessionId" | "id">) => void;

/** A waiting message's text; click it (or Enter on it) to edit it until it goes out. `editAsk`
 *  changing (a menu's "Edit") opens the editor too. */
function PendingText({
  p,
  edit,
  clamp,
  editAsk,
  onEditingChange,
}: {
  p: PendingMessage;
  edit: EditPending;
  clamp?: boolean;
  editAsk?: number;
  onEditingChange?: (editing: boolean) => void;
}) {
  const [draft, setDraft] = useState<string>();
  // Only the words are edited; the attached files stay with the message.
  const { text: body, files } = useMemo(() => splitAttachments(p.text), [p.text]);
  const box = useRef<HTMLTextAreaElement>(null);
  const asked = useRef(editAsk);
  useEffect(() => {
    if (editAsk === asked.current) return;
    asked.current = editAsk;
    setDraft(body);
    // A menu's sheet or popover hands focus back to its trigger as it closes, after the editor
    // mounted: take it back once the menu is gone, so the editor can be typed in (and blurs to save).
    const timers = [0, 150, 400].map((ms) =>
      setTimeout(() => {
        if (box.current && document.activeElement !== box.current) box.current.focus();
      }, ms),
    );
    return () => timers.forEach(clearTimeout);
  }, [editAsk, body]);
  const editing = draft !== undefined;
  useEffect(() => onEditingChange?.(editing), [editing]);
  const save = () => {
    if (draft !== undefined && draft !== body) edit(p.id, { text: withAttachments(draft, files) });
    setDraft(undefined);
  };
  if (draft === undefined)
    return (
      <VStack gap={1}>
        {body.trim() && (
          <Tooltip content="Click to edit" hasHoverIndication={false}>
            <Text
              display="block"
              maxLines={clamp ? 3 : 0}
              hasTruncateTooltip={false}
              style={preWrap}
              role="button"
              tabIndex={0}
              aria-label={`Edit: ${body.slice(0, 80)}`}
              onClick={() => setDraft(body)}
              onKeyDown={(e) => {
                if (e.key !== "Enter" && e.key !== " ") return;
                e.preventDefault();
                setDraft(body);
              }}
            >
              {body.split("\n\n<bash-input>")[0]}
            </Text>
          </Tooltip>
        )}
        <AttachmentChips files={files} />
      </VStack>
    );
  return (
    <TextArea
      ref={box}
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

/** Messages sent from this device that the runner hasn't confirmed yet, by session. */
const useSending = create<Record<string, { id: string; text: string }[]>>(() => ({}));
let sendingSeq = 0;
function addSending(sessionId: string, text: string): string {
  const id = `sending-${++sendingSeq}`;
  useSending.setState((s) => ({ [sessionId]: [...(s[sessionId] ?? []), { id, text }] }));
  return id;
}
function dropSending(sessionId: string, id: string) {
  useSending.setState((s) => ({ [sessionId]: (s[sessionId] ?? []).filter((x) => x.id !== id) }));
}

/** What you just sent, until the runner confirms it: no wait for the server (or a starting agent). */
function Sending({ sessionId, starting }: { sessionId: string; starting?: string }) {
  const list = useSending((s) => s[sessionId]);
  if (!list?.length) return null;
  return (
    <>
      {list.map((m) => (
        <ChatMessage key={m.id} sender="user">
          <ChatMessageBubble
            style={steerBubble(false)}
            metadata={
              <HStack gap={1} hAlign="end" vAlign="center">
                <Spinner size="sm" />
                <Text type="supporting">{starting ? `Starting ${starting} process…` : "Sending…"}</Text>
              </HStack>
            }
          >
            <Text style={preWrap}>{m.text}</Text>
          </ChatMessageBubble>
        </ChatMessage>
      ))}
    </>
  );
}

/** Re-renders each second while `until` is ahead (a steer's grace period counting down). */
function useSecondsLeft(until: number | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  const ahead = !!until && until > now;
  useEffect(() => {
    if (!ahead) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [ahead, until]);
  return until ? Math.max(0, Math.ceil((until - Date.now()) / 1000)) : 0;
}

/** Hover or keyboard focus inside a row: its quieter actions show. Touch screens always show them. */
function useReveal() {
  const [on, setOn] = useState(false);
  const handlers = {
    onMouseEnter: () => setOn(true),
    onMouseLeave: () => setOn(false),
    onFocus: () => setOn(true),
    onBlur: (e: FocusEvent<HTMLElement>) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setOn(false),
  };
  return [on, handlers] as const;
}
const shown = (on: boolean): CSSProperties => ({ opacity: on ? 1 : 0 });

/**
 * A long press opens the context menu's sheet while the finger is still down; lifting it can then
 * land a click on the sheet's backdrop, which closes it at once. On touch screens the click right
 * after that lift (the first one only, within 400 ms) is swallowed.
 */
function keepSheetOpenAfterLongPress() {
  if (!window.matchMedia("(hover: none)").matches) return;
  let liftedAt = 0;
  const lift = () => {
    liftedAt = Date.now();
    window.removeEventListener("touchend", lift, true);
    setTimeout(done, 400);
  };
  const click = (e: MouseEvent) => {
    if (liftedAt && Date.now() - liftedAt < 400) {
      e.preventDefault();
      e.stopPropagation();
    }
    done();
  };
  const done = () => {
    window.removeEventListener("touchend", lift, true);
    window.removeEventListener("click", click, true);
  };
  window.addEventListener("touchend", lift, true);
  window.addEventListener("click", click, true);
  setTimeout(done, 3000);
}

/**
 * Steers that haven't reached the agent yet: dashed user bubbles at the end of the chat. They go into
 * the running turn at its next step (one behind a queued message waits for that message's turn).
 * At rest: the text, when it goes, and ×. Hover adds "Queue instead"; right-click or a long press
 * opens the rest.
 */
function PendingSteers({ sessionId, state, steerable }: { sessionId: string; state: LiveState; steerable: boolean }) {
  const list = state.pending ?? [];
  const firstQueued = list.findIndex((p) => p.mode === "followUp");
  return (
    <>
      {list.map((p, i) =>
        p.mode !== "steer" ? null : <SteerBubble key={p.id} sessionId={sessionId} state={state} p={p} behindQueued={firstQueued >= 0 && i > firstQueued} steerable={steerable} />,
      )}
    </>
  );
}

function SteerBubble({ sessionId, state, p, behindQueued, steerable }: { sessionId: string; state: LiveState; p: PendingMessage; behindQueued: boolean; steerable: boolean }) {
  const edit = usePendingEdit(sessionId);
  const touch = useMediaQuery("(hover: none)");
  const [hover, reveal] = useReveal();
  const [editAsk, setEditAsk] = useState(0);
  const [editing, setEditing] = useState(false);
  const running = state.status === "running";
  const secs = useSecondsLeft(steerable && running && !behindQueued && !state.pendingHeld ? p.readyAt : undefined);
  const when = state.pendingHeld
    ? "Held"
    : !steerable
      ? "Goes in when this turn ends"
      : behindQueued
        ? "Waits for the queued message"
        : secs > 0
          ? `Steering in ${secs}s`
          : "Steering";
  const queueInstead = () => edit(p.id, { mode: "followUp" });
  const items = [
    ...(steerable ? [{ label: "Queue instead", onClick: queueInstead }] : []),
    ...(running ? [{ label: "Stop and send now", onClick: () => void act("forceSend", { sessionId, id: p.id }) }] : []),
    { label: "Edit", onClick: () => setEditAsk((n) => n + 1) },
    { label: "Cancel", onClick: () => edit(p.id, { remove: true }) },
  ];
  return (
    <ChatMessage sender="user" {...reveal}>
      <ChatMessageBubble
        style={steerBubble(behindQueued)}
        metadata={
          <HStack gap={1} hAlign="end" vAlign="center">
            {steerable && !touch && (
              <HStack style={shown(hover)}>
                <Button label="Queue instead" variant="ghost" size="sm" tooltip="Send after this turn instead" onClick={queueInstead} />
              </HStack>
            )}
            <Text type="supporting" color="secondary" hasTabularNumbers>
              {when}
            </Text>
            <IconButton label="Cancel this message" tooltip="Cancel" variant="ghost" size="sm" icon={<Icon icon="close" />} onClick={() => edit(p.id, { remove: true })} />
          </HStack>
        }
      >
        {/* Off while editing: a long press or right-click in the editor gets the native select/paste menu. */}
        <ContextMenu
          items={items}
          presentation="adaptive"
          label="Waiting message"
          menuWidth={200}
          isDisabled={editing}
          onOpenChange={(on) => on && keepSheetOpenAfterLongPress()}
        >
          <PendingText p={p} edit={edit} editAsk={editAsk} onEditingChange={setEditing} />
        </ContextMenu>
      </ChatMessageBubble>
    </ChatMessage>
  );
}

/** A queued run of a loop or schedule (/loop, /schedule): which one it came from. */
function ScheduledToken({ id, state }: { id: string; state: LiveState }) {
  const s = state.schedules?.find((x) => x.id === id);
  const label = !s ? "Scheduled" : s.kind === "loop" ? "Loop" : "Schedule";
  return (
    <Tooltip content={s ? `${label} ${s.label}; it goes when the agent is free` : "From a loop or schedule; it goes when the agent is free"}>
      <Token size="sm" color="blue" label={label} />
    </Tooltip>
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
            <Text type="supporting">{`Held · ${list.length} ${list.length === 1 ? "message" : "messages"}`}</Text>
          </StackItem>
          <StackItem>
            <Button label="Send" variant="primary" size="sm" tooltip="Send the waiting messages now" onClick={() => edit(list[0]!.id, { now: true })} />
          </StackItem>
        </HStack>
      )}
      {queued.map(({ p, i }, n) => (
        <QueuedRow
          key={p.id}
          sessionId={sessionId}
          state={state}
          p={p}
          dragging={drag === p.id}
          // editPending takes the place in the whole list: the row above's, or the row below's (it moves up once this one is out).
          up={n > 0 ? queued[n - 1]!.i : undefined}
          down={n < queued.length - 1 ? queued[n + 1]!.i : undefined}
          drag={{
            draggable: true,
            onDragStart: (e: DragEvent<HTMLElement>) => {
              setDrag(p.id);
              e.dataTransfer.effectAllowed = "move";
            },
            onDragEnd: () => setDrag(undefined),
            onDragOver: (e: DragEvent<HTMLElement>) => drag && drag !== p.id && e.preventDefault(),
            onDrop: (e: DragEvent<HTMLElement>) => {
              e.preventDefault();
              if (drag && drag !== p.id) edit(drag, { index: i });
              setDrag(undefined);
            },
          }}
        />
      ))}
    </VStack>
  );
}

/** One queued message: grip (on hover) · text (click to edit) · loop/schedule · ⋯ · ×. */
function QueuedRow({
  sessionId,
  state,
  p,
  dragging,
  up,
  down,
  drag,
}: {
  sessionId: string;
  state: LiveState;
  p: PendingMessage;
  dragging: boolean;
  up?: number;
  down?: number;
  drag: Record<string, unknown>;
}) {
  const edit = usePendingEdit(sessionId);
  const touch = useMediaQuery("(hover: none)");
  const [hover, reveal] = useReveal();
  const [menuOpen, setMenuOpen] = useState(false);
  const [editAsk, setEditAsk] = useState(0);
  const items = [
    { label: "Steer now", onClick: () => edit(p.id, { now: true }) },
    ...(state.status === "running" ? [{ label: "Stop and send now", onClick: () => void act("forceSend", { sessionId, id: p.id }) }] : []),
    ...(up !== undefined ? [{ label: "Move up", onClick: () => edit(p.id, { index: up }) }] : []),
    ...(down !== undefined ? [{ label: "Move down", onClick: () => edit(p.id, { index: down }) }] : []),
    { label: "Edit", onClick: () => setEditAsk((n) => n + 1) },
    { label: "Cancel", onClick: () => edit(p.id, { remove: true }) },
  ];
  return (
    <HStack gap={1.5} vAlign="start" padding={1.5} style={queuedRow(dragging)} {...drag} {...reveal}>
      {/* Dragging is a mouse thing: touch screens reorder with the menu's Move up / Move down. */}
      {!touch && (
        <HStack style={shown(hover)}>
          <Icon icon={EllipsisVerticalIcon} size="sm" color="secondary" label="Drag to reorder" />
        </HStack>
      )}
      <StackItem size="fill">
        <PendingText p={p} edit={edit} clamp editAsk={editAsk} />
      </StackItem>
      {p.scheduleId && <ScheduledToken id={p.scheduleId} state={state} />}
      <HStack gap={0.5} vAlign="center">
        <HStack style={shown(hover || touch || menuOpen)}>
          <MoreMenu label="Message actions" size="sm" placement="above" alignment="end" presentation="adaptive" items={items} onOpenChange={setMenuOpen} />
        </HStack>
        <IconButton label="Cancel this message" tooltip="Cancel" variant="ghost" size="sm" icon={<Icon icon="close" />} onClick={() => edit(p.id, { remove: true })} />
      </HStack>
    </HStack>
  );
}

/** One row of the `/` menu: a skill (with where it comes from), one of Tether's commands, or one of the harness's. */
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
    ) : c.kind === "tether" ? (
      <Token size="sm" color="blue" label="Tether" />
    ) : c.sources ? (
      // One of your commands (Tether's library)
      <HStack gap={0.5} vAlign="center">
        {c.sources.slice(0, narrow ? 1 : 3).map((s) => (
          <Token key={s} size="sm" label={s} />
        ))}
        {c.native === false && (
          <Tooltip content={commandRunsHow(false)}>
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

function Composer({
  sessionId,
  state,
  messages,
  harness,
  live,
  opening,
  syncing,
  inputRef: input,
}: {
  sessionId: string;
  state: LiveState;
  messages: Msg[];
  harness: HarnessId;
  live: boolean;
  opening: boolean;
  /** still catching up with the runner: requests may already be answered */
  syncing: boolean;
  /** the message box, so the session view can put focus back in it */
  inputRef: RefObject<ChatComposerInputHandle | null>;
}) {
  /** a message went to a session whose process had stopped: it starts again first */
  const [waking, setWaking] = useState(false);
  const [text, setText] = useState(() => localStorage.getItem(`tether.draft.${sessionId}`) ?? "");
  const [cmds, setCmds] = useState<SlashCommand[] | null>(null);
  const [cmdIdx, setCmdIdx] = useState(0);
  const [menuClosed, setMenuClosed] = useState(false);
  const historyPosition = useRef<number | null>(null);
  const historySnapshot = useRef<string[]>([]);
  const historyDraft = useRef("");
  const narrow = useNarrow();
  const touch = useMediaQuery("(pointer: coarse)");
  const running = state.status === "running";
  const steerable = canSteer(harness);

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
  // What you typed, as typed (not what Tether sent for you: composerHistory.ts).
  const history = useMemo(() => composerHistory(messages), [messages]);

  const clearHistoryNavigation = () => {
    historyPosition.current = null;
    historySnapshot.current = [];
    historyDraft.current = "";
  };

  /** force: stop the running turn and send this now, ahead of anything waiting */
  const send = async (mode?: "steer" | "followUp" | "force") => {
    const t = text.trim();
    if (!canSend || (mode === "force" && shell)) return;
    const files = ready.map((d) => d.attachment!);
    clearHistoryNavigation();
    setText("");
    const attach = files.length ? { attachments: files } : {};
    if (!live) setWaking(true);
    // Shown at once; the real message (or its place in the waiting list) replaces it when the
    // runner has it, which can take seconds while the agent's process starts.
    const id = addSending(sessionId, t);
    const r =
      mode === "force" && running
        ? await act("forceSend", { sessionId, text: t, ...attach })
        : await act("prompt", { sessionId, text: t, mode: running ? (mode === "force" ? "steer" : (mode ?? "steer")) : undefined, ...attach });
    dropSending(sessionId, id);
    setWaking(false);
    if (r === undefined) setText(t);
    else if (files.length) clearDrafts(sessionId);
  };
  /** Queue for after this turn: offered only where a send would otherwise steer. */
  const canQueue = running && steerable && !shell;
  const stop = () => act("abort", { sessionId });

  // A pasted screenshot or copied file is attached; rich content (a spreadsheet's cells, a web
  // page) pastes as text even when the clipboard also carries a picture of it.
  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    // A request's own fields (a deny reason, an answer) keep their paste.
    if ((e.target as Element).closest?.("[data-docked-requests]")) return;
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
    clearHistoryNavigation();
    setText(`/${name} `);
    input.current?.focus();
  };

  // Keys (desktop): Enter sends (steers while running), Tab queues while running, ⌘/Ctrl+Enter stops
  // and sends now, Shift+Enter is a new line, Esc closes the `/` menu or leaves history, else stops
  // an agent from an empty box. Alt+Enter still queues (the old key, for one release). Phones:
  // Enter is a new line and the buttons send.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const composing = e.nativeEvent.isComposing;
    // A recalled "/cmd" opens the menu; while stepping through history the arrows stay history's.
    if (matches.length && historyPosition.current === null) {
      const idx = Math.min(cmdIdx, matches.length - 1);
      if (e.key === "ArrowDown") return (e.preventDefault(), setCmdIdx((idx + 1) % matches.length));
      if (e.key === "ArrowUp") return (e.preventDefault(), setCmdIdx((idx - 1 + matches.length) % matches.length));
      if (e.key === "Escape") return (e.preventDefault(), setMenuClosed(true));
      if (completesSlash({ key: e.key, shift: e.shiftKey }, `/${matches[idx]!.name}` === text)) {
        e.preventDefault();
        setText(`/${matches[idx]!.name} `);
        return;
      }
    }
    if (e.key === "Escape" && !composing) {
      if (menuNote) return (e.preventDefault(), setMenuClosed(true));
      if (historyPosition.current !== null) {
        e.preventDefault();
        setText(historyDraft.current);
        clearHistoryNavigation();
        return;
      }
    }
    if (e.key === "ArrowUp" && !text && state.pending?.length) {
      // Like the Claude Code CLI: pull everything still waiting back into the box to rewrite.
      e.preventDefault();
      rpc("takePending", { sessionId })
        .then((r) => {
          if (!r.text) return;
          clearHistoryNavigation();
          setText(takeBack(sessionId, r.text));
        })
        .catch(() => {});
      return;
    }
    // Only from the first line up / the last line down, so the caret still moves inside a message.
    const box = e.target as HTMLTextAreaElement;
    const plain = !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey && !composing;
    const onFirst = !box.value?.slice(0, box.selectionStart ?? 0).includes("\n");
    const onLast = !box.value?.slice(box.selectionEnd ?? 0).includes("\n");
    if (e.key === "ArrowUp" && plain && onFirst && (historyPosition.current !== null || !text) && history.length) {
      e.preventDefault();
      if (historyPosition.current === null) {
        historySnapshot.current = history;
        historyDraft.current = text;
        historyPosition.current = historySnapshot.current.length - 1;
      } else {
        historyPosition.current = Math.max(0, historyPosition.current - 1);
      }
      setText(historySnapshot.current[historyPosition.current]!);
      return;
    }
    if (e.key === "ArrowDown" && plain && onLast && historyPosition.current !== null) {
      e.preventDefault();
      const next = historyPosition.current + 1;
      if (next >= historySnapshot.current.length) {
        setText(historyDraft.current);
        clearHistoryNavigation();
      } else {
        historyPosition.current = next;
        setText(historySnapshot.current[next]!);
      }
      return;
    }
    // Enter is always ours (the input's own submit doesn't know steer from queue); Tab only when it queues.
    const action = composerKeyAction(
      { key: e.key, shift: e.shiftKey, alt: e.altKey, mod: e.metaKey || e.ctrlKey, composing },
      { running, steerable, shell, narrow, text },
    );
    if (!action) return;
    e.preventDefault();
    if (action === "stop") return void stop();
    // Phones: Enter is a new line; the button sends.
    if (action === "newline") return void (document.execCommand("insertLineBreak") || input.current?.insertText("\n"));
    send(action);
  };

  const legacyQueued = !state.pending?.length && !state.pending && state.queued.length > 0;
  // Steers wait in the chat, not here: only queued messages (or the held row) open the drawer.
  const hasQueued = !!state.pending?.some((p) => p.mode === "followUp") || (!!state.pendingHeld && !!state.pending?.length);
  const hasDrawer = matches.length > 0 || !!menuNote || hasQueued || legacyQueued || drafts.length > 0;
  const placeholder = shell ? "" : running && steerable ? "Steer the agent" : "Message the agent";
  // Pending requests (approvals, questions, plans) wait here, above the box, so they never scroll away.
  const requests = syncing ? [] : state.pendingUi;

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
        {hasQueued && <QueuedList sessionId={sessionId} state={state} />}
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

  // The primary button: Send, Steer (into the running turn) or Run (bash mode). Its tooltip carries the keys.
  const primaryLabel = shell ? "Run" : running && steerable ? "Steer" : "Send";
  const why = uploading ? "Waiting for attachments to upload" : shell && ready.length ? "Bash mode can't take attachments" : undefined;
  const keyRows: KeyHint[] = shell
    ? [["Run on the runner", "enter"]]
    : running
      ? [
          [steerable ? "Steer into this turn" : "Goes in when this turn ends", "enter"],
          ...(canQueue ? [["Queue for after this turn", "tab"] as KeyHint] : []),
          ["Stop and send now", "mod+enter"],
          ["New line", "shift+enter"],
        ]
      : [
          ["Send", "enter"],
          ["New line", "shift+enter"],
          ["Bash mode", "!"],
        ];
  // Narrow windows: Enter is a new line there, so no key list.
  const narrowTip = running && !shell ? (steerable ? "Goes into the running turn" : "Goes in when this turn ends") : undefined;
  const primaryTip = why ?? (narrow ? narrowTip : <KeyHints rows={keyRows} />);
  const primary = (
    // Touch screens get no key tooltips (no keys, and a tooltip can stick after a tap).
    <Tooltip content={primaryTip} isEnabled={!!primaryTip && (!touch || !!why)}>
      <Button label={narrow ? primaryLabel : `${primaryLabel} ↵`} variant="primary" size="sm" isDisabled={!canSend} onClick={() => send("steer")} />
    </Tooltip>
  );
  const more =
    running && !shell ? (
      <DropdownMenu
        button={{ label: "More ways to send", isIconOnly: true, icon: <Icon icon="chevronDown" />, variant: "primary", size: "sm", isDisabled: !canSend }}
        hasChevron={false}
        placement="above"
        alignment="end"
        presentation="adaptive"
        menuWidth={260}
        items={[
          ...(canQueue ? [{ id: "queue", label: "Queue for after this turn", endContent: narrow ? undefined : <Kbd keys="tab" />, onClick: () => void send("followUp") }] : []),
          { id: "force", label: "Stop and send now", endContent: narrow ? undefined : <Kbd keys="mod+enter" />, onClick: () => void send("force") },
        ]}
      />
    ) : null;

  return (
    <VStack gap={2} style={composerDock} onPasteCapture={onPaste}>
      {/* While sending, the message's own bubble says the agent is starting. */}
      {!live && opening && !waking && (
        <HStack gap={1.5} vAlign="center">
          <Spinner size="sm" />
          <Text type="supporting">{`Starting ${harnessLabel(harness)} process…`}</Text>
        </HStack>
      )}
      {requests.length > 0 && (
        <VStack gap={2} style={dockedRequests} data-docked-requests>
          <UiRequests sessionId={sessionId} requests={requests} />
        </VStack>
      )}
      <ActivityStrip sessionId={sessionId} state={state} />
      {state.status === "waiting" && (
        <Banner
          status="warning"
          title={`${state.waitingReason ?? "Waiting"}${state.waitingUntil ? ` · resumes ${fmtClock(state.waitingUntil)}` : ""}`}
          endContent={<Button label="Cancel" size="sm" onClick={stop} />}
        />
      )}
      <ChatComposer
        value={text}
        onChange={(v) => {
          clearHistoryNavigation();
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
        footerActions={shell ? undefined : attach}
        sendActions={
          running ? (
            <Tooltip content={<KeyHints rows={[["Stop the agent (from an empty box)", "esc"]]} />} isEnabled={!touch}>
              <Button label="Stop" variant="secondary" size="sm" icon={<Icon icon="stop" />} onClick={stop} />
            </Tooltip>
          ) : undefined
        }
        sendButton={
          more ? (
            <ButtonGroup label="Send" size="sm">
              {primary}
              {more}
            </ButtonGroup>
          ) : (
            primary
          )
        }
      />
      <SettingsBar sessionId={sessionId} state={state} />
    </VStack>
  );
}

type KeyHint = [label: string, keys?: string];
/** Tooltip rows: what a key does, and the key (Kbd, ⌘ on a Mac and Ctrl elsewhere). */
function KeyHints({ rows }: { rows: KeyHint[] }) {
  return (
    <VStack gap={1}>
      {rows.map(([label, keys]) => (
        <HStack key={label} gap={3} vAlign="center" hAlign="between">
          <Text type="inherit">{label}</Text>
          {keys && <Kbd keys={keys} />}
        </HStack>
      ))}
    </VStack>
  );
}
