// Plan review (SPEC §7): a plan the agent proposes opens as a document. Select any text, or click a
// paragraph, and Comment: comments sit in the margin beside their text (in a sheet on phones), and
// can be edited or removed until they're sent. Approve lets the agent go ahead (comments go along as
// notes); Send feedback sends the plan back, each comment under the text it quotes (shared/plan.ts).
// Drafts stay in this browser, per session and plan, until they're sent.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { approveNotes, cleanDraft, EMPTY_DRAFT, inPlanOrder, locateAnchor, planKey, reviseMessage, type PlanComment, type PlanDraft } from "../../../shared/plan";
import { agentOf, type Request, type RequestAnswer } from "../../../shared/transcript";
import { rpc } from "../connection";
import { Markdown } from "./Markdown";

/** Where a new comment would go: the selection, or the clicked paragraph. */
type Spot = Pick<PlanComment, "quote" | "offset"> & { anchor: string };

const PHONE = "(max-width: 767px)";
const HIGHLIGHT = "tether-plan-comment";
const HIGHLIGHT_ACTIVE = "tether-plan-active";
// Astryx's Markdown renders paragraphs as <div role="paragraph">, not <p>.
const BLOCKS = "p, [role='paragraph'], li, h1, h2, h3, h4, h5, h6, pre, blockquote, td, th";

// ---------------- drafts (this browser) ----------------

const draftKey = (sessionId: string, plan: string) => `tether.plan.${sessionId}.${planKey(plan)}`;
const useDrafts = create<Record<string, PlanDraft>>(() => ({}));

function stored(key: string): PlanDraft | undefined {
  try {
    return cleanDraft(JSON.parse(localStorage.getItem(key) ?? "null"));
  } catch {
    return undefined;
  }
}

const readDraft = (key: string): PlanDraft => useDrafts.getState()[key] ?? stored(key) ?? EMPTY_DRAFT;

function writeDraft(key: string, d: PlanDraft) {
  useDrafts.setState({ [key]: d });
  try {
    if (!d.comments.length && !d.general.trim()) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(d));
  } catch {}
}

const clearDraft = (key: string) => writeDraft(key, EMPTY_DRAFT);

function useDraft(key: string): PlanDraft {
  const d = useDrafts((s) => s[key]);
  return useMemo(() => d ?? stored(key) ?? EMPTY_DRAFT, [d, key]);
}

// ---------------- which plan is open ----------------

const useOpen = create<{ id?: string }>(() => ({}));
const openPlan = (requestId: string) => useOpen.setState({ id: requestId });
const closePlan = () => useOpen.setState({ id: undefined });

/** Plans that opened by themselves once in this tab: they don't again (a reload, another visit). */
function firstSight(requestId: string): boolean {
  const key = "tether.plan.seen";
  try {
    const seen: string[] = JSON.parse(sessionStorage.getItem(key) ?? "[]");
    if (seen.includes(requestId)) return false;
    sessionStorage.setItem(key, JSON.stringify([...seen.slice(-50), requestId]));
  } catch {}
  return true;
}

function usePhone() {
  const q = () => typeof matchMedia === "function" && matchMedia(PHONE).matches;
  const [phone, setPhone] = useState(q);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const m = matchMedia(PHONE);
    const on = () => setPhone(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return phone;
}

// ---------------- the card in the dock ----------------

/**
 * A plan waiting for review, in the requests dock: Open plan (it also opens by itself the first time
 * it's seen here), Approve (with the draft's comments as notes) and Deny. `answer` is the dock's.
 */
export function PlanRequest({ r, sessionId, title, busy, answer, onNote, runnerId }: { r: Request; sessionId: string; title: string; busy: boolean; answer: (a: RequestAnswer) => Promise<boolean>; onNote: (n: string) => void; runnerId: string }) {
  const key = draftKey(sessionId, r.plan ?? "");
  const draft = useDraft(key);
  const isOpen = useOpen((s) => s.id === r.id);
  useEffect(() => {
    if (firstSight(r.id)) openPlan(r.id);
  }, [r.id]);
  const notes = approveNotes(draft);
  const settle = async (a: RequestAnswer) => {
    if (await answer(a)) clearDraft(key);
  };
  return (
    <>
      <div className="t-req-title">{title}</div>
      {/* The plan in brief; a click opens it (the Open plan button is the accessible way). */}
      <div className="t-req-plan t-plan-preview" onClick={() => openPlan(r.id)}>
        <Markdown density="compact" contentWidth="100%">
          {r.plan || "(No plan text.)"}
        </Markdown>
      </div>
      <div className="t-req-actions">
        <Button label="Open plan" variant="primary" isDisabled={busy} onClick={() => openPlan(r.id)} />
        <Button label={notes ? "Approve with notes" : "Approve"} variant="secondary" isDisabled={busy} onClick={() => void settle({ allow: true, ...(notes ? { notes } : {}) })} />
        <Button label="Deny" variant="ghost" isDisabled={busy} onClick={() => void answer({ allow: false })} />
      </div>
      {isOpen && <PlanReview r={r} draftKey={key} runnerId={runnerId} sessionId={sessionId} onNote={onNote} />}
    </>
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

/** A comment's text in the rendering as it is now. */
function locate(root: HTMLElement, c: { offset: number; anchor?: string }): Range | undefined {
  const at = locateAnchor(root.textContent ?? "", c);
  return at < 0 ? undefined : rangeAt(root, at, c.anchor!.length);
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

/**
 * Escape in a comment box closes just that box: the dialog's layer stack listens on the document and
 * skips a press that's already handled. Focus goes back to the dialog, not <body> (from where the
 * next Escape would close everything).
 */
function claimEscape(e: { preventDefault(): void; stopPropagation(): void; currentTarget: Element }) {
  e.preventDefault();
  e.stopPropagation();
  e.currentTarget.closest<HTMLElement>(".t-plan")?.focus({ preventScroll: true });
}

function PlanReview({ r, draftKey: key, runnerId, sessionId, onNote }: { r: Request; draftKey: string; runnerId: string; sessionId: string; onNote: (n: string) => void }) {
  const phone = usePhone();
  const draft = useDraft(key);
  const plan = r.plan ?? "";
  const [spot, setSpot] = useState<Spot>();
  /** the box for a new comment is open (until then a spot only offers Comment) */
  const [writing, setWriting] = useState(false);
  const [composing, setComposing] = useState("");
  const [editing, setEditing] = useState<string>();
  const [active, setActive] = useState<string>();
  const [sheet, setSheet] = useState(false);
  const [busy, setBusy] = useState<"approve" | "revise" | string>();
  const [error, setError] = useState<string>();
  const [, rerender] = useState(0);
  const docRef = useRef<HTMLDivElement>(null);
  const cards = useRef(new Map<string, HTMLElement>());
  const [tops, setTops] = useState<Record<string, number>>({});

  const comments = useMemo(() => inPlanOrder(draft.comments), [draft.comments]);
  const save = (d: Partial<PlanDraft>) => writeDraft(key, { ...readDraft(key), ...d });
  const feedback = reviseMessage(draft);
  const notes = approveNotes(draft);
  const who = agentOf(sessionId);

  const cancelSpot = () => (setSpot(undefined), setWriting(false), setComposing(""));
  const addComment = () => {
    if (!spot || !composing.trim()) return;
    const id = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    save({ comments: [...readDraft(key).comments, { ...spot, id, text: composing.trim() }] });
    cancelSpot();
    setActive(id);
    window.getSelection()?.removeAllRanges();
  };
  const updateComment = (id: string, text: string) => save({ comments: readDraft(key).comments.map((c) => (c.id === id ? { ...c, text } : c)) });
  const removeComment = (id: string) => save({ comments: readDraft(key).comments.filter((c) => c.id !== id) });
  const finishEdit = (id: string) => {
    setEditing(undefined);
    if (!readDraft(key).comments.find((c) => c.id === id)?.text.trim()) removeComment(id);
  };

  // A selection or a clicked paragraph marks the spot; Comment (beside it, or in the sheet on a
  // phone) opens the box, so reading and selecting don't open boxes.
  const pick = (target: EventTarget | null) => {
    const root = docRef.current;
    if (!root || (writing && composing.trim())) return;
    const s = spotFromSelection(root) ?? (window.getSelection()?.isCollapsed !== false ? spotFromBlock(root, target) : undefined);
    setSpot(s);
    setWriting(false);
    if (s) setActive(undefined);
  };

  // Phones select with a long press, which fires no click.
  useEffect(() => {
    if (!phone) return;
    const onSel = () => {
      const root = docRef.current;
      const s = root && spotFromSelection(root);
      if (s && !(writing && composing.trim())) setSpot(s);
    };
    document.addEventListener("selectionchange", onSel);
    return () => document.removeEventListener("selectionchange", onSel);
  }, [phone, writing, composing]);

  useEffect(() => {
    const root = docRef.current;
    if (!root || typeof ResizeObserver !== "function") return;
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
      const range = locate(root, c);
      if (range) ranges.set(c.id, range);
    }
    const spotRange = spot ? locate(root, spot) : undefined;
    const reg = (globalThis.CSS as any)?.highlights;
    const HighlightCtor = (globalThis as any).Highlight;
    if (reg && HighlightCtor) {
      reg.set(HIGHLIGHT, new HighlightCtor(...[...ranges].filter(([id]) => id !== active).map(([, x]) => x)));
      reg.set(HIGHLIGHT_ACTIVE, new HighlightCtor(...[active && ranges.get(active), spotRange].filter(Boolean)));
    }
    if (phone) return;
    // Each card sits level with its text; a card pushes the ones under it down.
    const base = root.getBoundingClientRect().top;
    const want = (x?: Range) => (x ? x.getBoundingClientRect().top - base : 0);
    const items = comments.map((c) => ({ id: c.id, y: ranges.has(c.id) ? want(ranges.get(c.id)) : 0 }));
    if (spot) items.push({ id: "new", y: want(spotRange) });
    items.sort((a, b) => a.y - b.y);
    const next: Record<string, number> = {};
    let floor = 0;
    for (const it of items) {
      const top = Math.max(it.y, floor);
      next[it.id] = top;
      floor = top + (cards.current.get(it.id)?.offsetHeight ?? 60) + 8;
    }
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

  const send = async (what: string, a: RequestAnswer) => {
    if (busy) return;
    setBusy(what);
    setError(undefined);
    try {
      await rpc(runnerId, "answerRequest", { sessionId, requestId: r.id, ...a });
      clearDraft(key);
      closePlan();
    } catch (e) {
      const m = (e as Error).message;
      // Someone else was first: the plan is about to go; say so in the dock.
      if (/already answered|no longer open/i.test(m)) {
        onNote(m);
        closePlan();
      } else setError(m);
    } finally {
      setBusy(undefined);
    }
  };

  const setRef = (id: string) => (el: HTMLElement | null) => {
    if (el) cards.current.set(id, el);
    else cards.current.delete(id);
  };

  const composer = spot && writing && (
    <div className="t-plan-card t-plan-composer">
      <blockquote className="t-plan-quote">{spot.quote}</blockquote>
      <textarea
        className="t-input"
        rows={3}
        autoFocus
        aria-label="Comment"
        placeholder="Comment"
        value={composing}
        onChange={(e) => setComposing(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") (claimEscape(e), cancelSpot());
          else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) (e.preventDefault(), addComment());
        }}
      />
      <div className="t-plan-card-actions">
        <Button label="Cancel" size="sm" variant="ghost" onClick={cancelSpot} />
        <Button label="Comment" size="sm" variant="primary" isDisabled={!composing.trim()} onClick={addComment} />
      </div>
    </div>
  );

  const commentCard = (c: PlanComment, style?: React.CSSProperties) => {
    const found = !docRef.current || !!locate(docRef.current, c);
    return (
      <div key={c.id} ref={setRef(c.id)} className={`t-plan-card${active === c.id ? " active" : ""}`} style={style} onClick={() => setActive(c.id)} data-comment={c.id}>
        <blockquote className="t-plan-quote">{c.quote}</blockquote>
        {!found && <div className="t-plan-gone">Not in this plan</div>}
        {editing === c.id ? (
          <textarea
            className="t-input"
            rows={3}
            autoFocus
            aria-label="Edit comment"
            value={c.text}
            onChange={(e) => updateComment(c.id, e.target.value)}
            onBlur={() => finishEdit(c.id)}
            onKeyDown={(e) => {
              if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) (claimEscape(e), finishEdit(c.id));
            }}
          />
        ) : (
          <div className="t-plan-text">{c.text}</div>
        )}
        <div className="t-plan-card-actions">
          <Button label="Edit" size="sm" variant="ghost" onClick={() => setEditing(c.id)} />
          <Button label="Delete" size="sm" variant="ghost" onClick={() => removeComment(c.id)} />
        </div>
      </div>
    );
  };

  const general = (
    <textarea
      className="t-input t-plan-general"
      rows={phone ? 3 : 2}
      aria-label="General comment"
      placeholder="General comment"
      value={draft.general}
      onChange={(e) => save({ general: e.target.value })}
      onKeyDown={(e) => e.key === "Escape" && claimEscape(e)}
    />
  );

  const doc = (
    <div ref={docRef} className="t-plan-doc" onMouseUp={(e) => pick(e.target)}>
      <Markdown contentWidth="100%">{plan || "(No plan text.)"}</Markdown>
    </div>
  );

  const actions = (
    <div className="t-plan-actions">
      {phone && (
        <Button
          label={spot && !writing ? "Comment" : comments.length ? `Comments (${comments.length})` : "Comments"}
          variant={spot && !writing ? "primary" : "secondary"}
          onClick={() => {
            if (spot && !writing) setWriting(true);
            setSheet(spot && !writing ? true : !sheet);
          }}
        />
      )}
      <span className="t-plan-fill" />
      {(r.approveAs ?? []).map((m) => (
        <Button key={m.id} label={m.label} variant="secondary" tooltip={m.description} isDisabled={!!busy} isLoading={busy === m.id} onClick={() => void send(m.id, { allow: true, mode: m.id, ...(notes ? { notes } : {}) })} />
      ))}
      <Button label={notes ? "Approve with notes" : "Approve"} variant={feedback ? "secondary" : "primary"} isDisabled={!!busy} isLoading={busy === "approve"} onClick={() => void send("approve", { allow: true, ...(notes ? { notes } : {}) })} />
      <Button label="Send feedback" variant={feedback ? "primary" : "secondary"} isDisabled={!feedback || !!busy} isLoading={busy === "revise"} onClick={() => void send("revise", { allow: false, reason: feedback })} />
    </div>
  );

  return (
    <Dialog
      isOpen
      onOpenChange={(o) => !o && closePlan()}
      purpose="form"
      variant={phone ? "fullscreen" : "standard"}
      width={phone ? undefined : "min(1120px, calc(100vw - 32px))"}
      maxHeight="94dvh"
      aria-label={`${who}'s plan`}
    >
      <DialogHeader title={r.title ?? `${who}'s plan`} onOpenChange={(o) => !o && closePlan()} />
      <div className="t-plan" tabIndex={-1} data-phone={phone || undefined}>
        <div className="t-plan-scroll">
          {phone ? (
            doc
          ) : (
            <div className="t-plan-body">
              {doc}
              <div className="t-plan-margin" style={{ minHeight: tops.end ?? 0 }}>
                {comments.map((c) => commentCard(c, { top: tops[c.id] ?? 0 }))}
                {spot && (
                  <div ref={setRef("new")} className="t-plan-slot" style={{ top: tops.new ?? 0 }}>
                    {composer || <Button label="Comment" size="sm" variant="primary" onClick={() => setWriting(true)} />}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
        <div className="t-plan-foot">
          {phone && sheet && (
            <div className="t-plan-sheet" role="region" aria-label="Comments">
              {composer}
              {comments.map((c) => commentCard(c))}
              {general}
            </div>
          )}
          {!phone && general}
          {error && <div className="t-inline-status error">{error}</div>}
          {actions}
        </div>
      </div>
    </Dialog>
  );
}
