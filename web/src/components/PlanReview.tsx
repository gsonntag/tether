// Plan review: a plan opens as a document; selecting text (or clicking a paragraph) offers a Comment
// button, and comments (with their threads) sit in the right-hand margin (a bottom sheet on phones).
// The draft is kept on the runner, so it follows you across devices. From there:
//  - Discuss: the agent answers each comment in its thread and leaves the plan as it is;
//  - Revise plan: the plan goes back with the comments (declining a waiting ExitPlanMode);
//  - Approve: the agent starts, the comments follow as notes.
// A revised plan shows what changed and whether each earlier comment was addressed.

import { BottomSheet } from "@astryxdesign/core/BottomSheet";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { HStack, Layout, LayoutContent, LayoutFooter, StackItem, VStack } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { Markdown } from "@astryxdesign/core/Markdown";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { ToggleButton } from "@astryxdesign/core/ToggleButton";
import { Token } from "@astryxdesign/core/Token";
import { ChatBubbleLeftEllipsisIcon, ClipboardDocumentListIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { create } from "zustand";
import {
  approveNotes,
  cleanDraft,
  discussionIds,
  EMPTY_DRAFT,
  formatPlanFeedback,
  isEmptyDraft,
  mergeDrafts,
  repliesOf,
  reviseMessage,
  type PlanComment,
  type PlanDraft,
  type PlanReply,
  type PlanReviewState,
  type PlanVerdict,
} from "../shared/plan";
import type { Msg, Part, UiRequest } from "../shared/protocol";
import { findPlan } from "../shared/reducer";
import { act, NARROW_QUERY, rpc, toast, useStore } from "../store";
import { FileRefScope, fileRefMarkdown } from "./FileRefs";
import { ModelName } from "./ModelName";
import { Diff } from "./Transcript";

type PlanPart = Extract<Part, { type: "plan" }>;
type Action = "discuss" | "revise" | "approve";
/** Where a new comment would go (the selection or the clicked paragraph). */
type Spot = Pick<PlanComment, "quote" | "offset"> & { anchor: string };

const HIGHLIGHT = "tether-plan-comment";
const HIGHLIGHT_ACTIVE = "tether-plan-active";
// Astryx's Markdown renders paragraphs as <div role="paragraph">, not <p>.
const BLOCKS = "p, [role='paragraph'], li, h1, h2, h3, h4, h5, h6, pre, blockquote, td, th";

const previewBox: CSSProperties = { maxHeight: "40vh" };
const docPane: CSSProperties = { minWidth: 0, cursor: "text" };
const marginPane: CSSProperties = { position: "relative", alignSelf: "stretch", width: "calc(var(--spacing-12) * 6)", flexShrink: 0 };
const marginCard: CSSProperties = { position: "absolute", insetInline: 0, transition: "top 120ms ease" };
const quoteText: CSSProperties = {
  display: "block",
  borderInlineStart: "var(--border-width) solid var(--color-border)",
  paddingInlineStart: "var(--spacing-2)",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};
const agentBox: CSSProperties = { background: "var(--color-background-muted)", borderRadius: "var(--radius-inner)", padding: "var(--spacing-2)" };
const preWrap: CSSProperties = { whiteSpace: "pre-wrap", wordBreak: "break-word" };
const minZero: CSSProperties = { minWidth: 0 };
const hidden: CSSProperties = { display: "none" };
// The CSS Custom Highlight API marks commented text without touching the rendered markdown.
const highlightCss = `::highlight(${HIGHLIGHT}){background-color:var(--color-warning-muted)}::highlight(${HIGHLIGHT_ACTIVE}){background-color:var(--color-accent-muted)}`;

// ---------------- drafts (kept on the runner, so every device has them) ----------------

const draftKey = (sessionId: string, planId: string) => `tether.plan.${sessionId}.${planId}`;
/** Edits the runner doesn't have yet (the last moments of typing; all of them with a runner too old to keep drafts). */
const useLocal = create<Record<string, PlanDraft>>(() => ({}));
const saves = new Map<string, { sessionId: string; planId: string; timer: ReturnType<typeof setTimeout> }>();
const SAVE_MS = 600;

const reviewOf = (sessionId: string, planId: string) => useStore.getState().open[sessionId]?.state.plans?.[planId];
/** Older runners don't keep plan reviews (no LiveState.plans): drafts stay in this browser, as before. */
const keepsPlans = (sessionId: string) => !!useStore.getState().open[sessionId]?.state.plans;

function stored(key: string): PlanDraft | undefined {
  try {
    return cleanDraft(JSON.parse(localStorage.getItem(key) ?? "null"));
  } catch {
    return undefined;
  }
}

function store(key: string, d: PlanDraft) {
  try {
    if (isEmptyDraft(d)) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(d));
  } catch {}
}

const dropLocal = (key: string) =>
  useLocal.setState((s) => {
    const { [key]: _, ...rest } = s;
    return rest;
  }, true);

function readDraft(sessionId: string, planId: string): PlanDraft {
  const key = draftKey(sessionId, planId);
  return useLocal.getState()[key] ?? reviewOf(sessionId, planId)?.draft ?? stored(key) ?? EMPTY_DRAFT;
}

function useDraft(sessionId: string, planId: string): PlanDraft {
  const key = draftKey(sessionId, planId);
  const local = useLocal((s) => s[key]);
  const remote = useStore((s) => s.open[sessionId]?.state.plans?.[planId]?.draft);
  return useMemo(() => local ?? remote ?? stored(key) ?? EMPTY_DRAFT, [local, remote, key]);
}

/** The runner's draft revision each local edit started from (sent with the save, see setPlanDraft). */
const bases = new Map<string, { rev: number; draft?: PlanDraft }>();
const forget = (key: string) => (dropLocal(key), bases.delete(key));
const baseOf = (sessionId: string, planId: string) => {
  const r = reviewOf(sessionId, planId);
  return { rev: r?.rev ?? 0, draft: r?.draft };
};

/** Shows at once here; reaches the runner (and every other device) once typing pauses. */
function writeDraft(sessionId: string, planId: string, d: PlanDraft) {
  const key = draftKey(sessionId, planId);
  if (!useLocal.getState()[key]) bases.set(key, baseOf(sessionId, planId));
  useLocal.setState({ [key]: d });
  if (!keepsPlans(sessionId)) return store(key, d);
  clearTimeout(saves.get(key)?.timer);
  saves.set(key, { sessionId, planId, timer: setTimeout(() => saveDraft(key), SAVE_MS) });
}

async function saveDraft(key: string) {
  const s = saves.get(key);
  const d = useLocal.getState()[key];
  if (s) clearTimeout(s.timer);
  saves.delete(key);
  if (!s || !d) return;
  try {
    const r = await rpc("setPlanDraft", { sessionId: s.sessionId, planId: s.planId, draft: isEmptyDraft(d) ? null : d, base: bases.get(key)?.rev ?? 0 });
    if (r.stale) return rebase(key, s, { rev: r.rev ?? 0, draft: r.draft });
    // The runner's copy (pushed to every device, this one first) takes over, unless typing went on.
    if (useLocal.getState()[key] === d) forget(key);
    else bases.set(key, { rev: r.rev ?? 0, draft: d });
  } catch (e: any) {
    const msg = e?.message ?? "";
    // A runner that doesn't keep drafts: this browser does. Offline: tried again. Anything else
    // (the session was removed): the edit stays on screen only.
    if (/doesn't know/.test(msg)) store(key, d);
    else if (/Not connected|Connection lost|No runner/.test(msg) && !saves.has(key)) saves.set(key, { ...s, timer: setTimeout(() => saveDraft(key), 5_000) });
  }
}

/**
 * The draft moved on since this edit started (another device, the agent's answers, a Revise or
 * Approve). On a plan that has been dealt with the edit is dropped; otherwise it's merged with
 * the runner's copy (three ways, against the draft it started from) and saved again.
 */
function rebase(key: string, s: { sessionId: string; planId: string }, now: { rev: number; draft?: PlanDraft }) {
  const local = useLocal.getState()[key];
  const review = reviewOf(s.sessionId, s.planId);
  const outcome = findPlan(useStore.getState().open[s.sessionId]?.messages ?? [], s.planId)?.part.outcome;
  if (!local || (!now.draft && (review?.revised || review?.approved || outcome))) return forget(key);
  const merged = mergeDrafts(bases.get(key)?.draft, local, now.draft);
  bases.set(key, now);
  useLocal.setState({ [key]: merged });
  saves.set(key, { ...s, timer: setTimeout(() => saveDraft(key), 0) });
}

/** Typing not saved yet goes now: the plan closes, the page goes away. */
const flushDrafts = () => [...saves.keys()].forEach((key) => void saveDraft(key));
window.addEventListener("pagehide", flushDrafts);
document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && flushDrafts());

/** A draft this browser kept before the runner kept them goes up to the runner, once. */
function useMigrate(sessionId: string, planId: string) {
  const ready = useStore((s) => {
    const o = s.open[sessionId];
    return !!o?.state.plans && !o.loading && !o.syncing;
  });
  useEffect(() => {
    const key = draftKey(sessionId, planId);
    const old = ready ? stored(key) : undefined;
    if (!old) return;
    const cur = reviewOf(sessionId, planId)?.draft;
    const draft = cur
      ? { ...cur, comments: [...cur.comments, ...old.comments.filter((c) => !cur.comments.some((x) => x.id === c.id))], general: cur.general.trim() ? cur.general : old.general }
      : old;
    rpc("setPlanDraft", { sessionId, planId, draft }).then(
      () => localStorage.removeItem(key),
      () => {},
    );
  }, [ready, sessionId, planId]);
}

/** Which plan's document is open (one at a time). */
const useOpenPlan = create<{ id?: string }>(() => ({}));
export const openPlan = (id: string) => useOpenPlan.setState({ id });
const closePlan = () => (flushDrafts(), useOpenPlan.setState({ id: undefined }));

function usePlanRequest(sessionId: string, planId: string): UiRequest | undefined {
  return useStore((s) => s.open[sessionId]?.state.pendingUi.find((r) => r.kind === "plan" && r.planId === planId));
}

/** The newest plan in the transcript. */
function latestPlanId(messages: Msg[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const plans = messages[i]!.parts.filter((x) => x.type === "plan");
    if (plans.length) return plans[plans.length - 1]!.id;
  }
}

const useReview = (sessionId: string, planId: string): PlanReviewState | undefined => useStore((s) => s.open[sessionId]?.state.plans?.[planId]);

/**
 * Discuss, Revise or Approve with the comments as this device has them. The runner sends them and
 * keeps the review; with an older runner Revise and Approve go from here, as before (it can't
 * discuss). False when something failed (reported as a toast); if only the notes after an approval
 * failed, the plan is approved but the draft is kept, so they can still be sent.
 */
async function planAct(sessionId: string, planId: string, action: Action, request?: UiRequest): Promise<boolean> {
  const key = draftKey(sessionId, planId);
  const d = readDraft(sessionId, planId);
  clearTimeout(saves.get(key)?.timer);
  saves.delete(key);
  if (keepsPlans(sessionId)) {
    const base = useLocal.getState()[key] ? bases.get(key)?.rev : reviewOf(sessionId, planId)?.rev;
    try {
      await rpc("planAction", { sessionId, planId, action, draft: d, base: base ?? 0 });
      if (useLocal.getState()[key] === d) forget(key);
      return true;
    } catch (e: any) {
      if (!/doesn't know/.test(e?.message ?? "")) {
        // Changed elsewhere meanwhile: merged here (and saved) to look over before sending again.
        if (/another device/.test(e?.message ?? "") && useLocal.getState()[key]) rebase(key, { sessionId, planId }, baseOf(sessionId, planId));
        else if (useLocal.getState()[key]) writeDraft(sessionId, planId, useLocal.getState()[key]!);
        toast("error", e?.message ?? String(e));
        return false;
      }
    }
  }
  if (action === "discuss") return toast("error", "This runner can't discuss plans yet. Restart it to update."), false;
  if (action === "approve") {
    const notes = approveNotes(d);
    if (!request || !(await act("uiRespond", { sessionId, response: { id: request.id, allow: true } }))) return false;
    if (notes && !(await act("prompt", { sessionId, text: notes, mode: "steer" }))) return false;
  } else {
    const text = reviseMessage(d);
    const running = useStore.getState().open[sessionId]?.state.status === "running";
    const ok = request
      ? await act("uiRespond", { sessionId, response: { id: request.id, allow: false, value: text } })
      : await act("prompt", { sessionId, text, mode: running ? "steer" : undefined });
    if (!ok) return false;
  }
  forget(key);
  store(key, EMPTY_DRAFT);
  return true;
}

/**
 * Escape inside a comment box closes just that box. Astryx's layer stack listens on the document and
 * skips a press that's already defaultPrevented; stopPropagation alone doesn't reach it, so the
 * plan dialog (or, on phones, the dialog behind the comments sheet) closed too.
 *
 * The box then unmounts, which would drop focus to <body>; from there the stack's next Escape closes
 * the comments sheet and the dialog behind it together. Focus goes to the layer's panel instead.
 */
const claimEscape = (e: { preventDefault(): void; stopPropagation(): void; currentTarget: Element }) => {
  e.preventDefault();
  e.stopPropagation();
  const panel = e.currentTarget.parentElement?.closest<HTMLElement>("[tabindex='-1']");
  if (panel && e.currentTarget.closest("dialog")?.contains(panel)) panel.focus({ preventScroll: true });
};

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

const VERDICT: Record<PlanVerdict["status"], { label: string; color: "green" | "yellow" | "red" }> = {
  addressed: { label: "Addressed", color: "green" },
  partly: { label: "Partly", color: "yellow" },
  not: { label: "Not addressed", color: "red" },
};

// ---------------- transcript card ----------------

export function PlanCard({ part }: { part: PlanPart }) {
  const sessionId = useStore((s) => s.selected) ?? "";
  const request = usePlanRequest(sessionId, part.id);
  const draft = useDraft(sessionId, part.id);
  const review = useReview(sessionId, part.id);
  const isOpen = useOpenPlan((s) => s.id === part.id);
  useMigrate(sessionId, part.id);
  const n = draft.comments.length;
  return (
    <Card width="100%" padding={3} variant={request ? "blue" : "default"}>
      <VStack gap={2}>
        <HStack gap={2} vAlign="center" wrap="wrap">
          <Icon icon={ClipboardDocumentListIcon} size="sm" color="secondary" />
          <Text type="label" weight="semibold">
            {part.checklist ? "Plan checklist" : "Plan"}
          </Text>
          {request && <Token size="sm" label="Waiting for your review" color="blue" />}
          {!request && part.outcome === "approved" && <Token size="sm" label="Approved" color="green" />}
          {!request && part.outcome === "feedback" && <Token size="sm" label="Sent back with feedback" color="yellow" />}
          {!request && review?.held && <Token size="sm" label="Under discussion" color="blue" />}
          <StackItem size="fill" />
          {n > 0 && <Text type="supporting">{plural(n, "draft comment")}</Text>}
          <Button label="Open plan" size="sm" variant={request ? "primary" : "secondary"} onClick={() => openPlan(part.id)} />
        </HStack>
        <VStack isScrollable style={previewBox}>
          <Markdown density="compact" contentWidth="100%" {...fileRefMarkdown}>
            {part.text || "_(empty plan)_"}
          </Markdown>
        </VStack>
      </VStack>
      {isOpen && <PlanReview sessionId={sessionId} part={part} request={request} />}
    </Card>
  );
}

/** The approval prompt in the dock under the transcript. */
export function PlanRequestCard({ sessionId, r }: { sessionId: string; r: UiRequest }) {
  const draft = useDraft(sessionId, r.planId ?? "");
  const n = draft.comments.length;
  const notes = !!approveNotes(draft);
  return (
    <Card width="100%" padding={3} variant="blue">
      <VStack gap={2}>
        <Text type="label" weight="semibold">
          {r.title}
        </Text>
        <Text type="supporting">
          Open it to comment on any part, talk your comments over with the agent, or send it back for revision. Approve lets the agent start.
          {n > 0 ? ` You have ${plural(n, "draft comment")}.` : ""}
        </Text>
        <HStack gap={2} wrap="wrap">
          <Button label="Open plan" variant="primary" onClick={() => r.planId && openPlan(r.planId)} />
          <Button
            label={notes ? "Approve with notes" : "Approve"}
            tooltip={notes ? "Approve the plan; your draft comments follow as notes for the work" : undefined}
            clickAction={async () => void (r.planId && (await planAct(sessionId, r.planId, "approve", r)))}
          />
        </HStack>
      </VStack>
    </Card>
  );
}

// ---------------- the document ----------------

/** Characters from the start of `root` to (node, offset), counted the way Range.toString() does. */
function textOffset(root: Node, node: Node, offset: number): number {
  const r = document.createRange();
  r.setStart(root, 0);
  r.setEnd(node, offset);
  return r.toString().length;
}

function rangeAt(root: HTMLElement, start: number, length: number): Range | undefined {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let pos = 0;
  let started = false;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const len = n.nodeValue?.length ?? 0;
    if (!started && start < pos + len) {
      range.setStart(n, start - pos);
      started = true;
    }
    if (started && start + length <= pos + len) {
      range.setEnd(n, start + length - pos);
      return range;
    }
    pos += len;
  }
  return undefined;
}

/** The comment's text in the current rendering; it follows the quote if the plan was revised. */
function locate(root: HTMLElement, c: { offset: number; anchor?: string }): Range | undefined {
  if (!c.anchor) return undefined;
  const text = root.textContent ?? "";
  let start = c.offset;
  if (text.slice(start, start + c.anchor.length) !== c.anchor) {
    start = text.indexOf(c.anchor);
    if (start < 0) return undefined;
  }
  return rangeAt(root, start, c.anchor.length);
}

function spotFromSelection(root: HTMLElement): Spot | undefined {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return undefined;
  const r = sel.getRangeAt(0);
  if (!root.contains(r.commonAncestorContainer)) return undefined;
  const quote = sel.toString().trim();
  if (!quote) return undefined;
  return { quote, offset: textOffset(root, r.startContainer, r.startOffset), anchor: r.toString() };
}

function spotFromBlock(root: HTMLElement, target: EventTarget | null): Spot | undefined {
  if (!(target instanceof Element) || target.closest("a, button, input, textarea")) return undefined;
  const block = target.closest(BLOCKS);
  if (!block || !root.contains(block)) return undefined;
  const quote = ((block as HTMLElement).innerText ?? block.textContent ?? "").trim();
  if (!quote) return undefined;
  return { quote, offset: textOffset(root, block, 0), anchor: block.textContent ?? "" };
}

/** The earlier comments a revision answers, each with whether it was addressed (once checked). */
function EarlierComments({ prev, check }: { prev: NonNullable<PlanReviewState["previous"]>; check?: PlanReviewState["check"] }) {
  const comments = [...prev.comments].sort((a, b) => a.offset - b.offset);
  return (
    <List density="compact">
      {comments.map((c) => {
        const v = check?.verdicts?.[c.id];
        return (
          <ListItem
            key={c.id}
            label={c.text.trim() || repliesOf(c).at(-1)?.text || "(no text)"}
            description={
              <VStack gap={0.5}>
                {c.quote.trim() && (
                  <Text type="supporting" color="secondary" maxLines={2} style={quoteText}>
                    {c.quote}
                  </Text>
                )}
                {v?.reason && <Text type="supporting">{v.reason}</Text>}
              </VStack>
            }
            endContent={
              v ? <Token size="sm" label={VERDICT[v.status].label} color={VERDICT[v.status].color} /> : check?.status === "checking" ? <Text type="supporting">Checking…</Text> : undefined
            }
          />
        );
      })}
      {prev.general.trim() && <ListItem label={prev.general.trim()} description="General comment" />}
    </List>
  );
}

function PlanReview({ sessionId, part, request }: { sessionId: string; part: PlanPart; request?: UiRequest }) {
  const narrow = useMediaQuery(NARROW_QUERY);
  const draft = useDraft(sessionId, part.id);
  const review = useReview(sessionId, part.id);
  const keeps = useStore((s) => !!s.open[sessionId]?.state.plans);
  const harness = useStore((s) => s.open[sessionId]?.session.harness);
  const idle = useStore((s) => s.open[sessionId]?.state.status === "idle");
  const latest = useStore((s) => latestPlanId(s.open[sessionId]?.messages ?? []));
  const [spot, setSpot] = useState<Spot>();
  /** the composer is open for `spot` (until then the spot only offers a Comment button) */
  const [writing, setWriting] = useState(false);
  const [composing, setComposing] = useState("");
  const [editing, setEditing] = useState<string>();
  /** a reply being written: under a comment, or ("general") under the agent's general answers */
  const [replying, setReplying] = useState<{ id: string; text: string }>();
  const [active, setActive] = useState<string>();
  const [listOpen, setListOpen] = useState(false);
  const [changes, setChanges] = useState(false);
  const [earlierOpen, setEarlierOpen] = useState(false);
  const [busy, setBusy] = useState<Action>();
  const [, rerender] = useState(0);
  /** the reply box was cancelled (Escape): its blur doesn't save */
  const cancelled = useRef(false);
  const docRef = useRef<HTMLElement>(null);
  const cardRefs = useRef(new Map<string, HTMLElement>());
  const [tops, setTops] = useState<Record<string, number>>({});

  const comments = useMemo(() => [...draft.comments].sort((a, b) => a.offset - b.offset), [draft.comments]);
  const save = (d: Partial<PlanDraft>) => writeDraft(sessionId, part.id, { ...readDraft(sessionId, part.id), ...d });
  const message = formatPlanFeedback(comments, draft.general, draft.thread);
  // A waiting approval means the agent is done answering (it may have answered with a new plan alone).
  const discussing = !!review?.discussing && !request;

  const addComment = () => {
    if (!spot || !composing.trim()) return;
    save({ comments: [...readDraft(sessionId, part.id).comments, { ...spot, id: `c${Date.now().toString(36)}`, text: composing.trim() }] });
    cancelSpot();
    window.getSelection()?.removeAllRanges();
  };
  const cancelSpot = () => (setSpot(undefined), setWriting(false), setComposing(""));
  const patchComment = (id: string, f: (c: PlanComment) => PlanComment) =>
    save({ comments: readDraft(sessionId, part.id).comments.map((c) => (c.id === id ? f(c) : c)) });
  const updateComment = (id: string, text: string) => patchComment(id, (c) => ({ ...c, text }));
  const removeComment = (id: string) => save({ comments: readDraft(sessionId, part.id).comments.filter((c) => c.id !== id) });
  const addReply = () => {
    if (!replying?.text.trim()) return setReplying(undefined);
    // An id, so another device's copy of the thread merges with this one (mergeDrafts).
    const r: PlanReply = { author: "user", text: replying.text.trim(), id: `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}` };
    if (replying.id === "general") save({ thread: [...(readDraft(sessionId, part.id).thread ?? []), r] });
    else patchComment(replying.id, (c) => ({ ...c, replies: [...repliesOf(c), r] }));
    setReplying(undefined);
  };
  const removeReply = (id: string, i: number) =>
    id === "general"
      ? save({ thread: readDraft(sessionId, part.id).thread?.filter((_, j) => j !== i) })
      : patchComment(id, (c) => ({ ...c, replies: repliesOf(c).filter((_, j) => j !== i) }));

  // A selection or a clicked paragraph only marks the spot; "Comment" (next to it in the margin, in
  // the footer on phones) opens the composer, so reading and selecting don't open boxes.
  const pick = (target: EventTarget | null) => {
    const root = docRef.current;
    if (!root || (composing.trim() && spot)) return;
    const s = spotFromSelection(root) ?? (window.getSelection()?.isCollapsed !== false ? spotFromBlock(root, target) : undefined);
    setSpot(s);
    setWriting(false);
    if (s) setActive(undefined);
  };

  // Phones select text with a long press, which fires no click.
  useEffect(() => {
    if (!narrow) return;
    const onSel = () => {
      const root = docRef.current;
      const s = root && spotFromSelection(root);
      if (s) setSpot(s);
    };
    document.addEventListener("selectionchange", onSel);
    return () => document.removeEventListener("selectionchange", onSel);
  }, [narrow]);

  useEffect(() => {
    const root = docRef.current;
    if (!root) return;
    const ro = new ResizeObserver(() => rerender((n) => n + 1));
    ro.observe(root);
    return () => ro.disconnect();
  }, []);

  // Highlights and margin positions follow the rendered text after every render.
  useLayoutEffect(() => {
    const root = docRef.current;
    if (!root) return;
    const ranges = new Map<string, Range>();
    for (const c of comments) {
      const r = locate(root, c);
      if (r) ranges.set(c.id, r);
    }
    const spotRange = spot ? locate(root, spot) : undefined;

    const reg = (globalThis.CSS as any)?.highlights;
    const HighlightCtor = (globalThis as any).Highlight;
    if (reg && HighlightCtor) {
      reg.set(HIGHLIGHT, new HighlightCtor(...[...ranges].filter(([id]) => id !== active).map(([, r]) => r)));
      const lit = [active && ranges.get(active), spotRange].filter(Boolean);
      reg.set(HIGHLIGHT_ACTIVE, new HighlightCtor(...lit));
    }
    if (narrow || changes) return;

    // Each card wants to sit level with its text; cards push the ones below them down.
    const base = root.getBoundingClientRect().top;
    const want = (r?: Range) => (r ? r.getBoundingClientRect().top - base : 0);
    const items = comments.map((c) => ({ id: c.id, y: ranges.has(c.id) ? want(ranges.get(c.id)) : -1 }));
    if (spot) items.push({ id: "new", y: want(spotRange) });
    items.sort((a, b) => a.y - b.y);
    const next: Record<string, number> = {};
    let floor = 0;
    for (const it of items) {
      const top = Math.max(it.y, floor);
      next[it.id] = top;
      floor = top + (cardRefs.current.get(it.id)?.offsetHeight ?? 80) + 8;
    }
    // Cards are positioned out of flow; the margin keeps their height so the dialog scrolls to them.
    next.end = floor;
    if (JSON.stringify(next) !== JSON.stringify(tops)) setTops(next);
  });

  useEffect(
    () => () => {
      const reg = (globalThis.CSS as any)?.highlights;
      reg?.delete(HIGHLIGHT);
      reg?.delete(HIGHLIGHT_ACTIVE);
    },
    [],
  );

  const send = async (action: Action) => {
    setBusy(action);
    try {
      if ((await planAct(sessionId, part.id, action, request)) && action !== "discuss") closePlan();
    } finally {
      setBusy(undefined);
    }
  };

  const setRef = (id: string) => (el: HTMLElement | null) => {
    if (el) cardRefs.current.set(id, el);
    else cardRefs.current.delete(id);
  };

  const composer = spot && writing && (
    <Card padding={2} variant="blue" width="100%">
      <VStack gap={2}>
        <Text type="supporting" color="secondary" maxLines={3} style={quoteText}>
          {spot.quote}
        </Text>
        <TextArea
          label="Comment"
          isLabelHidden
          hasAutoFocus
          rows={3}
          placeholder="Your comment"
          value={composing}
          onChange={(v) => setComposing(v)}
          onKeyDown={(e) => {
            if (e.key === "Escape") (claimEscape(e), cancelSpot());
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) (e.preventDefault(), addComment());
          }}
          width="100%"
        />
        <HStack gap={1.5} hAlign="end">
          <Button label="Cancel" size="sm" variant="ghost" onClick={cancelSpot} />
          <Button label="Comment" size="sm" variant="primary" isDisabled={!composing.trim()} onClick={addComment} />
        </HStack>
      </VStack>
    </Card>
  );

  /** A thread's entries: the agent's answers marked with its model, the person's own deletable. */
  const thread = (id: string, replies: PlanReply[]) =>
    replies.map((r, i) =>
      r.author === "agent" ? (
        <VStack key={r.id ?? i} gap={1} style={agentBox}>
          <Text type="supporting" weight="semibold">
            <ModelName id={r.model} harness={harness} />
          </Text>
          <Markdown density="compact" contentWidth="100%">
            {r.text}
          </Markdown>
        </VStack>
      ) : (
        <HStack key={i} gap={1} vAlign="start">
          <StackItem size="fill" style={minZero}>
            <Text style={{ ...preWrap, ...quoteText }}>{r.text}</Text>
          </StackItem>
          <IconButton label="Delete reply" size="sm" variant="ghost" icon={<Icon icon={XMarkIcon} />} onClick={() => removeReply(id, i)} />
        </HStack>
      ),
    );

  const replyBox = (id: string, extra?: ReactNode) =>
    replying?.id === id ? (
      <TextArea
        label="Reply"
        isLabelHidden
        hasAutoFocus
        rows={2}
        placeholder="Reply"
        value={replying.text}
        onChange={(v) => setReplying({ id, text: v })}
        onBlur={() => (cancelled.current ? (cancelled.current = false) : addReply())}
        onKeyDown={(e) => {
          // Escape cancels: claimEscape moves focus away, and that blur mustn't save the reply.
          if (e.key === "Escape") ((cancelled.current = true), setReplying(undefined), claimEscape(e));
          if (e.key === "Enter" && !e.shiftKey) (e.preventDefault(), addReply());
        }}
        width="100%"
      />
    ) : (
      <HStack gap={1} hAlign="end">
        <Button label="Reply" size="sm" variant="ghost" onClick={() => ((cancelled.current = false), setReplying({ id, text: "" }))} />
        {extra}
      </HStack>
    );

  const setResolved = (id: string, resolved: boolean) => patchComment(id, ({ resolved: _, ...c }) => (resolved ? { ...c, resolved } : c));

  const commentCard = (c: PlanComment, style?: CSSProperties) => {
    const found = !docRef.current || !!locate(docRef.current, c);
    // Settled: folded down to a line, and left out of everything the agent gets.
    if (c.resolved)
      return (
        <Card key={c.id} ref={setRef(c.id)} padding={2} width="100%" style={style} onClick={() => setActive(c.id)}>
          <HStack gap={1.5} vAlign="center">
            <StackItem size="fill" style={minZero}>
              <Text type="supporting" color="secondary" maxLines={1}>
                {c.text || c.quote}
              </Text>
            </StackItem>
            <Token size="sm" label="Resolved" color="gray" />
            <Button label="Reopen" size="sm" variant="ghost" onClick={() => setResolved(c.id, false)} />
          </HStack>
        </Card>
      );
    const answered = repliesOf(c).some((r) => r.author === "agent");
    return (
      <Card key={c.id} ref={setRef(c.id)} padding={2} width="100%" variant={active === c.id ? "blue" : "default"} style={style} onClick={() => setActive(c.id)}>
        <VStack gap={1.5}>
          <Text type="supporting" color="secondary" maxLines={editing === c.id ? undefined : 3} style={quoteText}>
            {c.quote}
          </Text>
          {!found && <Text type="supporting">No longer in the current plan</Text>}
          {editing === c.id ? (
            <TextArea
              label="Edit comment"
              isLabelHidden
              hasAutoFocus
              rows={3}
              value={c.text}
              onChange={(v) => updateComment(c.id, v)}
              onBlur={() => setEditing(undefined)}
              onKeyDown={(e) => {
                if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) (claimEscape(e), setEditing(undefined));
              }}
              width="100%"
            />
          ) : (
            <Text style={preWrap}>{c.text}</Text>
          )}
          {thread(c.id, repliesOf(c))}
          {replyBox(
            c.id,
            answered ? (
              <Button label="Resolve" size="sm" variant="ghost" tooltip="Settled: kept here, no longer sent to the agent" onClick={() => setResolved(c.id, true)} />
            ) : (
              <>
                <Button label="Edit" size="sm" variant="ghost" onClick={() => setEditing(c.id)} />
                <Button label="Delete" size="sm" variant="ghost" onClick={() => removeComment(c.id)} />
              </>
            ),
          )}
        </VStack>
      </Card>
    );
  };

  // Answers about the plan as a whole (or a discussion answer that couldn't be split per comment).
  const general = !!draft.thread?.length && (
    <Card padding={2} width="100%">
      <VStack gap={1.5}>
        <Text type="label" weight="semibold">
          About the whole plan
        </Text>
        {thread("general", draft.thread)}
        {replyBox("general", <Button label="Resolve" size="sm" variant="ghost" tooltip="Clear this thread" onClick={() => save({ thread: undefined })} />)}
      </VStack>
    </Card>
  );

  // A revised plan: what changed, and whether the comments it was asked with were addressed.
  const prev = review?.previous;
  const check = review?.check;
  const verdicts = Object.values(check?.verdicts ?? {});
  const revision = prev && (
    <VStack gap={2}>
      <HStack gap={2} vAlign="center" wrap="wrap">
        <Text type="supporting">
          Revised after your comments
          {check?.status === "checking" ? " · Checking them…" : verdicts.length ? ` · ${verdicts.filter((v) => v.status === "addressed").length} of ${discussionIds(prev.comments).length} addressed` : ""}
        </Text>
        <StackItem size="fill" />
        {!!prev.text && <ToggleButton label="Changes" size="sm" isPressed={changes} onPressedChange={setChanges} />}
        <ToggleButton label="Your earlier comments" size="sm" isPressed={earlierOpen} onPressedChange={setEarlierOpen} />
      </HStack>
      {earlierOpen && <EarlierComments prev={prev} check={check} />}
    </VStack>
  );

  // A file reference in the plan opens the file panel, which sits under this dialog: close it first
  // (the draft comments are kept).
  const refScope = useMemo(() => ({ sessionId, beforeOpen: closePlan }), [sessionId]);
  const doc = (
    <VStack ref={docRef} style={docPane} onMouseUp={(e) => pick(e.target)}>
      <FileRefScope value={refScope}>
        <Markdown contentWidth="100%" {...fileRefMarkdown}>
          {part.text || "_(empty plan)_"}
        </Markdown>
      </FileRefScope>
    </VStack>
  );

  const n = comments.length;
  const approvable = !!request || !!review?.held;
  const notes = !!approveNotes(draft);
  // The answer has to be the agent's next turn: a waiting approval, a held plan, or the newest plan while idle.
  const discussable = !!request || !!review?.held || (idle && latest === part.id && part.outcome !== "approved");
  const canDiscuss = keeps && discussable && (discussionIds(comments).length > 0 || !!draft.general.trim()) && !discussing;
  const footer = (
    <LayoutFooter hasDivider>
      <VStack gap={2}>
        <TextArea
          label="General comment"
          isLabelHidden
          rows={2}
          placeholder="General comment (optional, goes after the quoted comments)"
          value={draft.general}
          onChange={(v) => save({ general: v })}
          width="100%"
        />
        <HStack gap={2} vAlign="center" wrap="wrap">
          {narrow ? (
            <Button
              label={spot ? "Comment" : `Comments (${n})`}
              size="sm"
              icon={<Icon icon={ChatBubbleLeftEllipsisIcon} />}
              onClick={() => (setWriting(!!spot), setListOpen(true))}
            />
          ) : discussing ? null : (
            <Text type="supporting">{n ? plural(n, "comment") : "Select text or click a paragraph, then Comment."}</Text>
          )}
          {discussing && (
            <HStack gap={1} vAlign="center">
              <Spinner size="sm" />
              <Text type="supporting">The agent is answering…</Text>
            </HStack>
          )}
          <StackItem size="fill" />
          {approvable && (
            <Button
              label={notes ? "Approve with notes" : "Approve"}
              tooltip={notes ? "Approve the plan; comments the agent hasn't answered follow as notes for the work" : undefined}
              isDisabled={!!busy || discussing}
              isLoading={busy === "approve"}
              onClick={() => send("approve")}
            />
          )}
          {keeps && (
            <Button
              label="Discuss"
              tooltip="The agent answers each comment in its thread and leaves the plan as it is"
              isDisabled={!canDiscuss || !!busy}
              isLoading={busy === "discuss"}
              onClick={() => send("discuss")}
            />
          )}
          <Button
            label="Revise plan"
            variant="primary"
            tooltip="Send the plan back with your comments for a revised one"
            isDisabled={!message || !!busy || discussing}
            isLoading={busy === "revise"}
            onClick={() => send("revise")}
          />
        </HStack>
      </VStack>
    </LayoutFooter>
  );

  return (
    <Dialog
      isOpen
      onOpenChange={(o) => !o && closePlan()}
      purpose="form"
      variant={narrow ? "fullscreen" : "standard"}
      width={narrow ? undefined : "min(calc(var(--spacing-12) * 25), calc(100vw - var(--spacing-8)))"}
      maxHeight="94dvh"
    >
      <style>{highlightCss}</style>
      <Layout
        height={narrow ? "fill" : "auto"}
        contentWidth="100%"
        header={
          <DialogHeader
            title={part.checklist ? "Plan checklist" : "Plan"}
            subtitle={request ? "The agent is waiting for your review" : part.outcome === "approved" ? "Approved" : undefined}
            onOpenChange={(o) => !o && closePlan()}
          />
        }
        content={
          <LayoutContent>
            <VStack gap={4}>
              {revision}
              {general}
              {changes && prev && <Diff pairs={[{ oldText: prev.text, newText: part.text }]} wrap />}
              {/* Hidden, not unmounted, while the changes show: the margin keeps measuring the same document. */}
              <VStack style={changes ? hidden : undefined}>
                {narrow ? (
                  doc
                ) : (
                  <HStack gap={6} vAlign="start">
                    <StackItem size="fill" style={docPane}>
                      {doc}
                    </StackItem>
                    <VStack style={{ ...marginPane, minHeight: tops.end ?? 0 }}>
                      {comments.map((c) => commentCard(c, { ...marginCard, top: tops[c.id] ?? 0 }))}
                      {spot && (
                        <VStack ref={setRef("new")} style={{ ...marginCard, top: tops.new ?? 0 }}>
                          {composer || (
                            <HStack>
                              <Button label="Comment" size="sm" icon={<Icon icon={ChatBubbleLeftEllipsisIcon} />} onClick={() => setWriting(true)} />
                            </HStack>
                          )}
                        </VStack>
                      )}
                    </VStack>
                  </HStack>
                )}
              </VStack>
            </VStack>
          </LayoutContent>
        }
        footer={footer}
      />
      {narrow && (
        <BottomSheet isOpen={listOpen} onOpenChange={(o) => (setListOpen(o), !o && !composing.trim() && cancelSpot())} label="Comments" height="tall" padding={3}>
          <VStack gap={2}>
            <Text type="label" weight="semibold">
              {plural(n, "comment")}
            </Text>
            {composer}
            {comments.map((c) => commentCard(c))}
            {!n && !spot && <Text type="supporting">Select text or tap a paragraph, then Comment.</Text>}
          </VStack>
        </BottomSheet>
      )}
    </Dialog>
  );
}
