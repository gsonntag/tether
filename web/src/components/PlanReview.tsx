// Plan review: a plan opens as a document; selecting text (or clicking a paragraph) adds a comment
// in the right-hand margin (a bottom sheet on phones). The comments go back to the agent as one
// message of quote + reply pairs: as the feedback that declines the plan when the agent waits for
// approval (Claude Code's ExitPlanMode), otherwise as an ordinary message.

import { BottomSheet } from "@astryxdesign/core/BottomSheet";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack, Layout, LayoutContent, LayoutFooter, StackItem, VStack } from "@astryxdesign/core/Layout";
import { Markdown } from "@astryxdesign/core/Markdown";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { Token } from "@astryxdesign/core/Token";
import { ChatBubbleLeftEllipsisIcon, ClipboardDocumentListIcon } from "@heroicons/react/24/outline";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { create } from "zustand";
import { formatPlanFeedback, type PlanComment } from "../shared/plan";
import type { Part, UiRequest } from "../shared/protocol";
import { act, NARROW_QUERY, useStore } from "../store";

type PlanPart = Extract<Part, { type: "plan" }>;
/** A comment in the browser: `anchor` is the raw text its offset points at, to find it again. */
type Comment = PlanComment & { anchor: string };
interface Draft {
  comments: Comment[];
  general: string;
}
/** Where a new comment would go (the selection or the clicked paragraph). */
type Spot = Omit<Comment, "id" | "text">;

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
const preWrap: CSSProperties = { whiteSpace: "pre-wrap", wordBreak: "break-word" };
// The CSS Custom Highlight API marks commented text without touching the rendered markdown.
const highlightCss = `::highlight(${HIGHLIGHT}){background-color:var(--color-warning-muted)}::highlight(${HIGHLIGHT_ACTIVE}){background-color:var(--color-accent-muted)}`;

// ---------------- drafts (kept in localStorage until sent) ----------------

const EMPTY: Draft = { comments: [], general: "" };
const draftKey = (sessionId: string, planId: string) => `tether.plan.${sessionId}.${planId}`;
const useDrafts = create<Record<string, Draft>>(() => ({}));

function readDraft(key: string): Draft {
  const live = useDrafts.getState()[key];
  if (live) return live;
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? "null");
    if (v && Array.isArray(v.comments)) return { comments: v.comments, general: v.general ?? "" };
  } catch {}
  return EMPTY;
}

function writeDraft(key: string, d: Draft) {
  useDrafts.setState({ [key]: d });
  try {
    if (d.comments.length || d.general.trim()) localStorage.setItem(key, JSON.stringify(d));
    else localStorage.removeItem(key);
  } catch {}
}

function useDraft(key: string): Draft {
  const live = useDrafts((s) => s[key]);
  return useMemo(() => live ?? readDraft(key), [live, key]);
}

/** Which plan's document is open (one at a time). */
const useOpenPlan = create<{ id?: string }>(() => ({}));
export const openPlan = (id: string) => useOpenPlan.setState({ id });
const closePlan = () => useOpenPlan.setState({ id: undefined });

function usePlanRequest(sessionId: string, planId: string): UiRequest | undefined {
  return useStore((s) => s.open[sessionId]?.state.pendingUi.find((r) => r.kind === "plan" && r.planId === planId));
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

/** The draft as the message the agent gets: quoted comments in document order, then the general note. */
const draftMessage = (d: Draft) => formatPlanFeedback([...d.comments].sort((a, b) => a.offset - b.offset), d.general);

/**
 * Approves a waiting plan. Draft comments are never left behind: they follow the approval as notes
 * for the work, and the draft is cleared. The dock's Approve and the dialog's both come here.
 * False when something failed (reported as a toast); if only the notes failed to send, the plan is
 * approved but the draft is kept, so they can be sent from the plan as comments.
 */
async function approvePlan(sessionId: string, requestId: string, key: string): Promise<boolean> {
  const message = draftMessage(readDraft(key));
  if (!(await act("uiRespond", { sessionId, response: { id: requestId, allow: true } }))) return false;
  if (message && !(await act("prompt", { sessionId, text: message, mode: "steer" }))) return false;
  writeDraft(key, EMPTY);
  return true;
}

// ---------------- transcript card ----------------

export function PlanCard({ part }: { part: PlanPart }) {
  const sessionId = useStore((s) => s.selected) ?? "";
  const request = usePlanRequest(sessionId, part.id);
  const draft = useDraft(draftKey(sessionId, part.id));
  const isOpen = useOpenPlan((s) => s.id === part.id);
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
          <StackItem size="fill" />
          {n > 0 && <Text type="supporting">{plural(n, "draft comment")}</Text>}
          <Button label="Open plan" size="sm" variant={request ? "primary" : "secondary"} onClick={() => openPlan(part.id)} />
        </HStack>
        <VStack isScrollable style={previewBox}>
          <Markdown density="compact" contentWidth="100%">
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
  const key = draftKey(sessionId, r.planId ?? "");
  const draft = useDraft(key);
  const n = draft.comments.length;
  const notes = !!draftMessage(draft);
  return (
    <Card width="100%" padding={3} variant="blue">
      <VStack gap={2}>
        <Text type="label" weight="semibold">
          {r.title}
        </Text>
        <Text type="supporting">
          Open it to comment on any part. Feedback sends the plan back for revision; Approve lets the agent start.
          {n > 0 ? ` You have ${plural(n, "draft comment")}.` : ""}
        </Text>
        <HStack gap={2} wrap="wrap">
          <Button label="Open plan" variant="primary" onClick={() => r.planId && openPlan(r.planId)} />
          <Button
            label={notes ? "Approve with notes" : "Approve"}
            tooltip={notes ? "Approve the plan; your draft comments follow as notes for the work" : undefined}
            clickAction={async () => void (await approvePlan(sessionId, r.id, key))}
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
function locate(root: HTMLElement, c: { offset: number; anchor: string }): Range | undefined {
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

function PlanReview({ sessionId, part, request }: { sessionId: string; part: PlanPart; request?: UiRequest }) {
  const narrow = useMediaQuery(NARROW_QUERY);
  const key = draftKey(sessionId, part.id);
  const draft = useDraft(key);
  const running = useStore((s) => s.open[sessionId]?.state.status === "running");
  const [spot, setSpot] = useState<Spot>();
  const [composing, setComposing] = useState("");
  const [editing, setEditing] = useState<string>();
  const [active, setActive] = useState<string>();
  const [listOpen, setListOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [, rerender] = useState(0);
  const docRef = useRef<HTMLElement>(null);
  const cardRefs = useRef(new Map<string, HTMLElement>());
  const [tops, setTops] = useState<Record<string, number>>({});

  const comments = useMemo(() => [...draft.comments].sort((a, b) => a.offset - b.offset), [draft.comments]);
  const save = (d: Partial<Draft>) => writeDraft(key, { ...readDraft(key), ...d });
  const message = formatPlanFeedback(comments, draft.general);

  const addComment = () => {
    if (!spot || !composing.trim()) return;
    save({ comments: [...readDraft(key).comments, { ...spot, id: `c${Date.now().toString(36)}`, text: composing.trim() }] });
    setSpot(undefined);
    setComposing("");
    window.getSelection()?.removeAllRanges();
  };
  const updateComment = (id: string, text: string) => save({ comments: readDraft(key).comments.map((c) => (c.id === id ? { ...c, text } : c)) });
  const removeComment = (id: string) => save({ comments: readDraft(key).comments.filter((c) => c.id !== id) });

  // Desktop: a selection or a clicked paragraph starts a comment right away. Phones: a tap only
  // marks the spot, and "Comment" opens the composer, so reading by tapping doesn't open sheets.
  const pick = (target: EventTarget | null) => {
    const root = docRef.current;
    if (!root || (composing.trim() && spot)) return;
    const s = spotFromSelection(root) ?? (window.getSelection()?.isCollapsed !== false ? spotFromBlock(root, target) : undefined);
    if (s) {
      setSpot(s);
      setActive(undefined);
    }
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
    if (narrow) return;

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

  const finish = () => {
    writeDraft(key, EMPTY);
    closePlan();
  };
  const send = async (approve: boolean) => {
    setBusy(true);
    try {
      if (request) {
        const ok = approve
          ? await approvePlan(sessionId, request.id, key)
          : await act("uiRespond", { sessionId, response: { id: request.id, allow: false, value: message } });
        if (!ok) return;
      } else {
        const ok = await act("prompt", { sessionId, text: message, mode: running ? "steer" : undefined });
        if (!ok) return;
      }
      finish();
    } finally {
      setBusy(false);
    }
  };

  const setRef = (id: string) => (el: HTMLElement | null) => {
    if (el) cardRefs.current.set(id, el);
    else cardRefs.current.delete(id);
  };

  const composer = spot && (
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
            if (e.key === "Escape") (claimEscape(e), setSpot(undefined), setComposing(""));
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) (e.preventDefault(), addComment());
          }}
          width="100%"
        />
        <HStack gap={1.5} hAlign="end">
          <Button label="Cancel" size="sm" variant="ghost" onClick={() => (setSpot(undefined), setComposing(""))} />
          <Button label="Comment" size="sm" variant="primary" isDisabled={!composing.trim()} onClick={addComment} />
        </HStack>
      </VStack>
    </Card>
  );

  const commentCard = (c: Comment, style?: CSSProperties) => {
    const found = !docRef.current || !!locate(docRef.current, c);
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
          <HStack gap={1} hAlign="end">
            <Button label="Edit" size="sm" variant="ghost" onClick={() => setEditing(c.id)} />
            <Button label="Delete" size="sm" variant="ghost" onClick={() => removeComment(c.id)} />
          </HStack>
        </VStack>
      </Card>
    );
  };

  const doc = (
    <VStack ref={docRef} style={docPane} onMouseUp={(e) => pick(e.target)}>
      <Markdown contentWidth="100%">{part.text || "_(empty plan)_"}</Markdown>
    </VStack>
  );

  const n = comments.length;
  const canSend = !!message && !busy;
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
              onClick={() => setListOpen(true)}
            />
          ) : (
            <Text type="supporting">{n ? plural(n, "comment") : "Select text or click a paragraph to comment."}</Text>
          )}
          <StackItem size="fill" />
          {request ? (
            <>
              <Button
                label={message ? "Approve with notes" : "Approve"}
                tooltip={message ? "Approve the plan; your comments follow as notes for the work" : undefined}
                isDisabled={busy}
                onClick={() => send(true)}
              />
              <Button label="Send feedback" variant="primary" isDisabled={!canSend} tooltip="Send the plan back with your comments" onClick={() => send(false)} />
            </>
          ) : (
            <Button label="Send comments" variant="primary" isDisabled={!canSend} onClick={() => send(false)} />
          )}
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
        header={
          <DialogHeader
            title={part.checklist ? "Plan checklist" : "Plan"}
            subtitle={request ? "The agent is waiting for your review" : part.outcome === "approved" ? "Approved" : undefined}
            onOpenChange={(o) => !o && closePlan()}
          />
        }
        content={
          <LayoutContent>
            {narrow ? (
              doc
            ) : (
              <HStack gap={6} vAlign="start">
                <StackItem size="fill" style={docPane}>
                  {doc}
                </StackItem>
                <VStack style={{ ...marginPane, minHeight: tops.end ?? 0 }}>
                  {comments.map((c) => commentCard(c, { ...marginCard, top: tops[c.id] ?? 0 }))}
                  {composer && (
                    <VStack ref={setRef("new")} style={{ ...marginCard, top: tops.new ?? 0 }}>
                      {composer}
                    </VStack>
                  )}
                </VStack>
              </HStack>
            )}
          </LayoutContent>
        }
        footer={footer}
      />
      {narrow && (
        <BottomSheet isOpen={listOpen} onOpenChange={(o) => (setListOpen(o), !o && !composing.trim() && setSpot(undefined))} label="Comments" height="tall" padding={3}>
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
