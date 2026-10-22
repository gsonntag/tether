import { useEffect, useImperativeHandle, useRef, useState, type CSSProperties, type KeyboardEvent, type Ref, type RefObject } from "react";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Spinner } from "@astryxdesign/core/Spinner";
import { StackItem } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { ChevronDownIcon, ChevronUpIcon } from "@heroicons/react/24/outline";
import { MIN_TERM, nearestIndex } from "../find";
import { useStore } from "../store";

export interface FindBarHandle {
  /** Cmd+F while the bar is open: back to the box, its text selected. */
  focus(): void;
}

/** The most matches the bar keeps on the page at once (the latest ones); the count shows "1000+". */
export const MAX_RANGES = 1000;

/** A modal is up (one of the app's dialogs, or any open native dialog): find's keys leave it alone. */
export function modalOpen(): boolean {
  return !!useStore.getState().dialog || !!document.querySelector("dialog[open]") || !!document.activeElement?.closest('[role="dialog"], [aria-modal="true"]');
}

const minZero: CSSProperties = { minWidth: 0 };
const noWrap: CSSProperties = { whiteSpace: "nowrap" };

/**
 * Find in the open session (Cmd+F): a compact row above the transcript. "n of m" counts the term's
 * occurrences in the conversation (the data), while the matches it walks are the ones in the
 * rendered text, marked with the CSS Custom Highlight API where it exists. Enter and Shift+Enter,
 * Cmd+G and F3 step through them; stepping back past the first one on the page asks for the next
 * earlier matching message to be mounted. A step centres its match, which stops the end following.
 */
export function FindBar({
  ref,
  scroller,
  term,
  onTerm,
  onClose,
  scrollTo,
  total,
  pending,
  onEarlier,
  inset,
}: {
  ref?: Ref<FindBarHandle>;
  /** the chat's scroll container; its first child is the message area that is searched */
  scroller: RefObject<HTMLDivElement | null>;
  term: string;
  onTerm: (term: string) => void;
  onClose: () => void;
  /** moves the scroller (SessionView's writer, so following the end is told) */
  scrollTo: (top: number) => void;
  /** occurrences in the whole conversation */
  total: number;
  /** an earlier matching message is still mounting */
  pending: boolean;
  /** mount the next earlier matching message; false when there is none */
  onEarlier: () => boolean;
  /** room on the left for the floating sidebar button */
  inset: boolean;
}) {
  const needle = term.length >= MIN_TERM ? term.toLowerCase() : "";
  const input = useRef<HTMLInputElement>(null);
  // Matches by the element they sit in (a chat message, else the text's own parent), so a change
  // to one row re-walks that row only. Static ranges: a live Range is updated by the browser on
  // every DOM change, and the transcript changes a lot.
  const buckets = useRef(new Map<Element, StaticRange[]>());
  const hits = useRef<{ flat: StaticRange[]; current: number }>({ flat: [], current: 0 });
  /** what the next collection should do: start a new term near the reader, or step to a match that mounts earlier */
  const want = useRef<"nearest" | "earlier">(undefined);
  const [view, setView] = useState({ n: 0 });

  /** Shows and scrolls to match `i` (wrapping); `ifHidden` leaves a match already in view where it is. */
  const go = (i: number, ifHidden = false) => {
    const { flat } = hits.current;
    if (!flat.length) return;
    const idx = ((i % flat.length) + flat.length) % flat.length;
    hits.current.current = idx;
    setView({ n: flat.length });
    paint(flat, idx);
    const el = scroller.current;
    const live = toRange(flat[idx]!);
    if (!el || !live) return;
    const r = live.getBoundingClientRect();
    const s = el.getBoundingClientRect();
    if (ifHidden && r.top >= s.top && r.bottom <= s.bottom) return;
    scrollTo(el.scrollTop + centreOffset(live, el));
  };
  const next = () => go(hits.current.current + 1);
  const prev = () => {
    if (hits.current.current === 0 && onEarlier()) want.current = "earlier";
    else go(hits.current.current - 1);
  };
  const latest = useRef({ next, prev, onEarlier, pending, total });
  latest.current = { next, prev, onEarlier, pending, total };

  // --- collection: a full walk for a new term, else only the rows that changed ---
  const frame = useRef(0);
  const dirty = useRef<Set<Element> | "all">("all");
  const collect = () => {
    const root = scroller.current?.firstElementChild;
    const job = dirty.current;
    dirty.current = new Set();
    const map = buckets.current;
    if (!root || !needle) map.clear();
    else if (job === "all") {
      map.clear();
      walk(root, root, needle, map);
    } else {
      for (const k of [...map.keys()]) if (!k.isConnected) map.delete(k);
      for (const d of job) {
        for (const k of [...map.keys()]) if (d === k || d.contains(k)) map.delete(k);
        if (d.isConnected && root.contains(d)) walk(d, root, needle, map);
      }
    }
    const was = hits.current.flat[hits.current.current];
    let flat = [...map.keys()].sort(docOrder).flatMap((k) => map.get(k)!);
    if (flat.length > MAX_RANGES) flat = flat.slice(-MAX_RANGES);
    let current = was ? flat.findIndex((r) => r.startContainer === was.startContainer && r.startOffset === was.startOffset) : -1;
    const el = scroller.current;
    if (current < 0 && want.current === "nearest" && el) {
      const bottom = el.getBoundingClientRect().bottom;
      current = nearestIndex(flat.map((r) => toRange(r)?.getBoundingClientRect().top ?? Infinity), bottom);
    }
    if (current < 0) current = Math.min(hits.current.current, Math.max(0, flat.length - 1));
    hits.current = { flat, current };
    if (want.current === "nearest" && flat.length) {
      want.current = undefined;
      go(current, true);
    } else if (want.current === "earlier" && current > 0) {
      want.current = undefined;
      go(current - 1);
    } else {
      if (!needle) want.current = undefined;
      setView({ n: flat.length });
      paint(flat, current);
      // Nothing on the page for a term the conversation does have: ask for its latest earlier message.
      const l = latest.current;
      if (want.current === "nearest" && !flat.length && l.total && !l.pending && !l.onEarlier()) want.current = undefined;
    }
  };
  const latestCollect = useRef(collect);
  latestCollect.current = collect;
  const schedule = (what: Set<Element> | "all") => {
    if (what === "all") dirty.current = "all";
    else if (dirty.current !== "all") for (const d of what) dirty.current.add(d);
    if (frame.current) return;
    frame.current = requestAnimationFrame(flush);
  };
  const flush = () => {
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    latestCollect.current();
  };

  useEffect(() => {
    want.current = needle ? "nearest" : undefined;
    schedule("all");
  }, [needle]);
  useEffect(() => {
    const root = scroller.current?.firstElementChild;
    if (!root) return;
    const mo = new MutationObserver((records) => {
      const rows = new Set<Element>();
      for (const r of records) {
        if (r.type === "characterData") {
          const b = bucketOf(r.target, root);
          if (b) rows.add(b);
        } else if (r.type === "attributes") {
          // Visibility may have changed under this element; containers of many rows are left alone.
          const el = r.target as Element;
          const msg = el.closest(ROW);
          if (msg) rows.add(msg);
          else if (!el.querySelector(ROW)) rows.add(el);
        } else {
          const msg = (r.target as Element).closest?.(ROW);
          if (msg) rows.add(msg);
          else for (const n of r.addedNodes) rows.add(n instanceof Element ? (n.closest(ROW) ?? n) : (bucketOf(n, root) ?? root));
        }
        if (rows.size > 40 || rows.has(root)) return schedule("all");
      }
      if (rows.size) schedule(rows);
    });
    mo.observe(root, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ["hidden", "style", "class"] });
    return () => mo.disconnect();
  }, []);
  // An earlier message finished mounting for a step that is still waiting: the step completes, or
  // asks for the next one when that message showed nothing (its match is folded away).
  useEffect(() => {
    if (pending || !want.current) return;
    flush();
    const w = want.current;
    if (!w) return;
    const { flat, current } = hits.current;
    if (w === "earlier" ? current === 0 : !flat.length) {
      if (!latest.current.onEarlier()) {
        want.current = undefined;
        if (w === "earlier" && flat.length) go(flat.length - 1);
      }
    }
  }, [pending]);
  useEffect(() => {
    input.current?.focus();
    const onKey = (e: globalThis.KeyboardEvent) => {
      const g = (e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "g";
      if (!g && e.key !== "F3") return;
      if (modalOpen()) return;
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
  }));

  const onInputKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (e.shiftKey) prev();
    else next();
  };
  const onBarKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    onClose();
  };

  const n = view.n;
  const count = !needle ? undefined : total === 0 && n === 0 ? "No matches" : `${n ? hits.current.current + 1 : 0} of ${total > MAX_RANGES ? `${MAX_RANGES}+` : total}`;
  return (
    <HStack gap={1} vAlign="center" paddingInlineStart={inset ? 10 : 2} paddingInlineEnd={2} paddingBlock={1} onKeyDown={onBarKey}>
      <StackItem size="fill" style={minZero}>
        <TextInput ref={input} label="Find in session" isLabelHidden placeholder="Find in session" size="sm" width="100%" value={term} onChange={onTerm} onKeyDown={onInputKey} hasClear />
      </StackItem>
      {pending && <Spinner size="sm" aria-label="Loading earlier messages" />}
      {count && (
        <Text type="supporting" color="secondary" hasTabularNumbers style={noWrap}>
          {count}
        </Text>
      )}
      <IconButton label="Previous match" tooltip="Previous match (Shift+Enter)" variant="ghost" size="sm" icon={<Icon icon={ChevronUpIcon} />} isDisabled={!n && !total} onClick={prev} />
      <IconButton label="Next match" tooltip="Next match (Enter)" variant="ghost" size="sm" icon={<Icon icon={ChevronDownIcon} />} isDisabled={!n} onClick={next} />
      <IconButton label="Close find" tooltip="Close (Esc)" variant="ghost" size="sm" icon={<Icon icon="close" />} onClick={onClose} />
    </HStack>
  );
}

// ---------------- matching ----------------

/** A transcript row: matches inside one are kept together, so a change to it re-walks it alone. */
const ROW = ".astryx-chat-message";

/** The element a text node's matches are filed under: its chat message, else its own parent. */
function bucketOf(node: Node, root: Element): Element | undefined {
  const el = node instanceof Element ? node : node.parentElement;
  if (!el || !root.contains(el)) return undefined;
  const msg = el.closest(ROW);
  return msg && root.contains(msg) ? msg : el;
}

const docOrder = (a: Element, b: Element) => (a === b ? 0 : a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);

/** A live range for a static one, or nothing once its text has left the page or shrunk. */
function toRange(s: StaticRange): Range | undefined {
  const node = s.startContainer;
  if (!node.isConnected || s.endOffset > (node as Text).length) return undefined;
  const r = document.createRange();
  r.setStart(node, s.startOffset);
  r.setEnd(s.endContainer, s.endOffset);
  return r;
}

/** Files every occurrence of `needle` (lower-case) in the visible text under `from` into `map`, in document order. */
function walk(from: Element, root: Element, needle: string, map: Map<Element, StaticRange[]>) {
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
  const walker = document.createTreeWalker(from, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue ?? "";
    const lower = text.toLowerCase();
    // Lower-casing changes the length of a few scripts' strings: offsets would be wrong, so skip.
    if (lower.length !== text.length) continue;
    let i = lower.indexOf(needle);
    if (i < 0 || !node.parentElement || !visible(node.parentElement)) continue;
    const key = bucketOf(node, root)!;
    let list = map.get(key);
    if (!list) map.set(key, (list = []));
    while (i >= 0) {
      list.push(new StaticRange({ startContainer: node, startOffset: i, endContainer: node, endOffset: i + needle.length }));
      i = lower.indexOf(needle, i + needle.length);
    }
  }
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
