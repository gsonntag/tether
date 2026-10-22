import { useEffect, useImperativeHandle, useRef, useState, type CSSProperties, type KeyboardEvent, type Ref, type RefObject } from "react";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Spinner } from "@astryxdesign/core/Spinner";
import { StackItem } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { ChevronDownIcon, ChevronUpIcon } from "@heroicons/react/24/outline";
import type { Msg } from "../shared/protocol";
import { useStore } from "../store";

export interface FindBarHandle {
  /** Cmd+F while the bar is open: back to the box, its text selected. */
  focus(): void;
  next(): void;
  prev(): void;
}

const minZero: CSSProperties = { minWidth: 0 };
const noWrap: CSSProperties = { whiteSpace: "nowrap" };

/**
 * Find in the open session (Cmd+F): a compact row above the transcript. Matches are the term's
 * occurrences in the transcript's text as rendered, marked with the CSS Custom Highlight API (where
 * it exists; elsewhere the bar still counts and walks them). Enter and Shift+Enter, Cmd+G and F3
 * step through them; a step centres the match in the scroller, which stops it following the end.
 */
export function FindBar({
  ref,
  scroller,
  term,
  onTerm,
  onClose,
  scrollTo,
  pending,
  inset,
  messages,
}: {
  ref?: Ref<FindBarHandle>;
  /** the chat's scroll container; its first child is the message area that is searched */
  scroller: RefObject<HTMLDivElement | null>;
  term: string;
  onTerm: (term: string) => void;
  onClose: () => void;
  /** moves the scroller (SessionView's writer, so following the end is told) */
  scrollTo: (top: number) => void;
  /** earlier messages that match are still mounting */
  pending: boolean;
  /** room on the left for the floating sidebar button */
  inset: boolean;
  /** the transcript: a new list re-collects the matches */
  messages: Msg[];
}) {
  const input = useRef<HTMLInputElement>(null);
  // Static ranges: a live Range is updated by the browser on every DOM change, and the transcript
  // changes a lot (rows mounting, text streaming); hundreds of them would make each change dearer.
  const hits = useRef<{ ranges: StaticRange[]; current: number }>({ ranges: [], current: 0 });
  const [view, setView] = useState({ n: 0, current: 0 });

  /** Shows and scrolls to match `i` (wrapping). */
  const go = (i: number) => {
    const { ranges } = hits.current;
    if (!ranges.length) return;
    const idx = ((i % ranges.length) + ranges.length) % ranges.length;
    hits.current.current = idx;
    setView({ n: ranges.length, current: idx });
    paint(ranges, idx);
    const el = scroller.current;
    const live = toRange(ranges[idx]!);
    if (el && live) scrollTo(el.scrollTop + centreOffset(live, el));
  };
  const next = () => go(hits.current.current + 1);
  const prev = () => go(hits.current.current - 1);
  const latest = useRef({ next, prev });
  latest.current = { next, prev };

  // Matches are collected one frame after whatever changed them (the term, the list, the DOM),
  // at most once a frame. The current match stays the same text when it still exists.
  const frame = useRef(0);
  const jump = useRef(false);
  const collect = () => {
    const root = scroller.current?.firstElementChild;
    const was = hits.current.ranges[hits.current.current];
    const ranges = root && term ? collectRanges(root, term) : [];
    let current = -1;
    if (was) {
      current = ranges.findIndex((r) => r.startContainer === was.startContainer && r.startOffset === was.startOffset);
      // A new term: the first match from where the reader was, so typing on doesn't jump about.
      const from = current < 0 && jump.current ? toRange(was) : undefined;
      if (from) current = ranges.findIndex((r) => toRange(r)!.compareBoundaryPoints(Range.START_TO_START, from) >= 0);
    }
    if (current < 0) current = Math.min(hits.current.current, Math.max(0, ranges.length - 1));
    hits.current = { ranges, current };
    // A new term goes to its match; one with none yet (earlier messages still mounting) goes
    // to the first that appears.
    if (jump.current && ranges.length) {
      jump.current = false;
      go(current);
    } else {
      if (!term) jump.current = false;
      setView({ n: ranges.length, current });
      paint(ranges, current);
    }
  };
  const latestCollect = useRef(collect);
  latestCollect.current = collect;
  const schedule = (andJump = false) => {
    jump.current ||= andJump;
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      latestCollect.current();
    });
  };

  useEffect(() => schedule(true), [term]);
  useEffect(() => schedule(), [messages]);
  useEffect(() => {
    const area = scroller.current?.firstElementChild;
    if (!area) return;
    const mo = new MutationObserver(() => schedule());
    mo.observe(area, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ["hidden", "style", "class"] });
    return () => mo.disconnect();
  }, []);
  useEffect(() => {
    input.current?.focus();
    const onKey = (e: globalThis.KeyboardEvent) => {
      const g = (e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "g";
      if (!g && e.key !== "F3") return;
      if (useStore.getState().dialog) return;
      e.preventDefault();
      if (e.shiftKey) latest.current.prev();
      else latest.current.next();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      cancelAnimationFrame(frame.current);
      clearHighlights();
    };
  }, []);

  useImperativeHandle(ref, () => ({
    focus: () => {
      input.current?.focus();
      input.current?.select();
    },
    next: () => latest.current.next(),
    prev: () => latest.current.prev(),
  }));

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) prev();
      else next();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <HStack gap={1} vAlign="center" paddingInlineStart={inset ? 10 : 2} paddingInlineEnd={2} paddingBlock={1}>
      <StackItem size="fill" style={minZero}>
        <TextInput ref={input} label="Find in session" isLabelHidden placeholder="Find in session" size="sm" width="100%" value={term} onChange={onTerm} onKeyDown={onKeyDown} hasClear />
      </StackItem>
      {pending && <Spinner size="sm" aria-label="Loading earlier messages" />}
      {term && (
        <Text type="supporting" color="secondary" hasTabularNumbers style={noWrap}>
          {view.n ? `${view.current + 1} of ${view.n}` : "No matches"}
        </Text>
      )}
      <IconButton label="Previous match" tooltip="Previous match (Shift+Enter)" variant="ghost" size="sm" icon={<Icon icon={ChevronUpIcon} />} isDisabled={!view.n} onClick={prev} />
      <IconButton label="Next match" tooltip="Next match (Enter)" variant="ghost" size="sm" icon={<Icon icon={ChevronDownIcon} />} isDisabled={!view.n} onClick={next} />
      <IconButton label="Close find" tooltip="Close (Esc)" variant="ghost" size="sm" icon={<Icon icon="close" />} onClick={onClose} />
    </HStack>
  );
}

// ---------------- matching ----------------

/** A live range for a static one, or nothing once its text has left the page. */
function toRange(s: StaticRange): Range | undefined {
  if (!s.startContainer.isConnected) return undefined;
  const r = document.createRange();
  r.setStart(s.startContainer, s.startOffset);
  r.setEnd(s.endContainer, s.endOffset);
  return r;
}

/** Every occurrence of `term` in the visible text under `root`, in document order (one text node each). */
function collectRanges(root: Element, term: string): StaticRange[] {
  const needle = term.toLowerCase();
  const out: StaticRange[] = [];
  if (!needle) return out;
  // Visibility is checked only around text that matches, once per element, up to the root.
  const seen = new Map<Element, boolean>();
  const visible = (el: Element): boolean => {
    const known = seen.get(el);
    if (known !== undefined) return known;
    const tag = el.tagName;
    const v = tag !== "SCRIPT" && tag !== "STYLE" && tag !== "NOSCRIPT" && getComputedStyle(el).display !== "none" && (el === root || !el.parentElement || visible(el.parentElement));
    seen.set(el, v);
    return v;
  };
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue ?? "";
    const lower = text.toLowerCase();
    let i = lower.indexOf(needle);
    if (i < 0 || !node.parentElement || !visible(node.parentElement)) continue;
    while (i >= 0) {
      // Lower-casing can change a string's length for a few scripts: never point past the node.
      out.push(new StaticRange({ startContainer: node, startOffset: Math.min(i, text.length), endContainer: node, endOffset: Math.min(i + needle.length, text.length) }));
      i = lower.indexOf(needle, i + needle.length);
    }
  }
  return out;
}

/** How far `scroller` must move to centre `range`; boxes that scroll inside it (a diff, a tool's output) are scrolled first. */
function centreOffset(range: Range, scroller: HTMLElement): number {
  for (let el = range.startContainer.parentElement; el && el !== scroller; el = el.parentElement) {
    if (el.scrollHeight <= el.clientHeight + 1) continue;
    const oy = getComputedStyle(el).overflowY;
    if (oy !== "auto" && oy !== "scroll") continue;
    const r = range.getBoundingClientRect();
    const b = el.getBoundingClientRect();
    el.scrollTop += r.top - b.top - (b.height - r.height) / 2;
  }
  const r = range.getBoundingClientRect();
  const s = scroller.getBoundingClientRect();
  return r.top - s.top - (s.height - r.height) / 2;
}

// ---------------- highlights ----------------

const ALL = "tether-find";
const CURRENT = "tether-find-current";
const STYLE_ATTR = "data-tether-find-style";

const canHighlight = () => typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined";

/** The highlight colours, installed once (the way Astryx's chat scroll installs its rule). */
function ensureStyle() {
  if (document.head.querySelector(`[${STYLE_ATTR}]`)) return;
  const style = document.createElement("style");
  style.setAttribute(STYLE_ATTR, "");
  style.textContent = `::highlight(${ALL}){background-color:var(--color-warning-muted)}::highlight(${CURRENT}){background-color:var(--color-warning);color:var(--color-on-warning)}`;
  document.head.appendChild(style);
}

function paint(ranges: StaticRange[], current: number) {
  if (!canHighlight()) return;
  if (!ranges.length) return clearHighlights();
  ensureStyle();
  const all = new Highlight();
  for (const r of ranges) all.add(r);
  CSS.highlights.set(ALL, all);
  CSS.highlights.set(CURRENT, new Highlight(ranges[current]!));
}

function clearHighlights() {
  if (!canHighlight()) return;
  CSS.highlights.delete(ALL);
  CSS.highlights.delete(CURRENT);
}
