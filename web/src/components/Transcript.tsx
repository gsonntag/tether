// The transcript: windowed (only messages near the viewport are in the DOM), following the bottom
// unless the reader scrolled up, paging older messages in as they near the top, and keeping the
// reader's place by hand (virtual.ts) when anything above them changes.

import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { ArrowDownIcon } from "@heroicons/react/24/outline";
import type { Msg } from "../../../shared/transcript";
import type { TranscriptWindow } from "../../../shared/window";
import { anchorAt, offsets, restore, visibleRange, type Anchor } from "../virtual";
import { Message } from "./Message";

/** A guess before a message is measured: roughly by how much text it holds. */
function estimate(m: Msg): number {
  if (m.role === "notice") return 32;
  let h = 24;
  for (const p of m.parts) h += p.type === "tool" ? 40 : p.type === "text" ? 24 + Math.min(1200, (p.text.length / 90) * 22) : p.type === "image" ? 240 : 30;
  return h;
}

const OVERSCAN = 800;
const NEAR_BOTTOM = 40;
const NEAR_TOP = 600;

export function Transcript({ window: w, onOlder, footer }: { window: TranscriptWindow; onOlder: () => Promise<boolean>; footer?: React.ReactNode }) {
  const scroller = useRef<HTMLDivElement>(null);
  /** the top spacer: where the list starts inside the scroller (below "Earlier messages") */
  const listTop = useRef<HTMLDivElement>(null);
  const observed = useRef(new Set<HTMLElement>());
  const heights = useRef(new Map<string, number>());
  const stick = useRef(true);
  /** the scroll position the last scroll event saw: only a move up means the reader left the bottom */
  const lastTop = useRef(0);
  const track = useRef<HTMLDivElement>(null);
  const touchY = useRef(0);
  const anchor = useRef<Anchor | undefined>(undefined);
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const [view, setView] = useState({ top: 0, height: 800 });
  const [atBottom, setAtBottom] = useState(true);
  const [paging, setPaging] = useState(false);

  const msgs = w.messages;
  const ids = useMemo(() => msgs.map((m) => m.id), [msgs]);
  const byId = useMemo(() => new Map(msgs.map((m) => [m.id, m])), [msgs]);
  const offs = offsets(ids, (id) => heights.current.get(id) ?? estimate(byId.get(id)!));
  const total = offs[offs.length - 1]!;
  const base = () => listTop.current?.offsetTop ?? 0;
  const [start, end] = visibleRange(offs, view.top - base(), view.height, OVERSCAN);

  /**
   * The view went up and isn't at the very bottom: the reader's doing. (Content that shrinks also
   * lowers scrollTop, but the browser clamps it to the bottom exactly.)
   */
  const movedUp = (el: HTMLDivElement) => el.scrollTop < lastTop.current - 1 && el.scrollHeight - el.scrollTop - el.clientHeight > 1;

  /**
   * The reader moved the view up since we last looked (even by a few pixels: a finger drag moves a
   * little per event). Checked before every pin too, so a pin that lands between the move and its
   * scroll event can't undo it.
   */
  const leftBottom = (el: HTMLDivElement) => {
    if (stick.current && movedUp(el)) {
      stick.current = false;
      setAtBottom(false);
    }
    return !stick.current;
  };
  const pin = (el: HTMLDivElement) => {
    if (!leftBottom(el)) el.scrollTop = el.scrollHeight;
    lastTop.current = el.scrollTop;
  };

  // After every render: stay at the bottom, or put the anchor back where the reader had it.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (stick.current) pin(el);
    else if (anchor.current) {
      const top = restore(ids, offs, anchor.current);
      if (top !== undefined && Math.abs(el.scrollTop - base() - top) > 1) el.scrollTop = top + base();
    }
    anchor.current = anchorAt(ids, offs, el.scrollTop - base());
    // Stop measuring messages that scrolled out of the window.
    for (const t of observed.current)
      if (!t.isConnected) {
        observer.unobserve(t);
        observed.current.delete(t);
      }
  });

  // Measure what is rendered; a change re-renders (and the effect above re-anchors).
  const observer = useMemo(
    () =>
      new ResizeObserver((entries) => {
        let changed = false;
        for (const e of entries) {
          const id = (e.target as HTMLElement).dataset.id!;
          const h = Math.round((e.target as HTMLElement).offsetHeight);
          if (h && heights.current.get(id) !== h) {
            heights.current.set(id, h);
            changed = true;
          }
        }
        if (changed) bump();
      }),
    [],
  );
  useEffect(() => () => observer.disconnect(), [observer]);
  const measure = useCallback(
    (el: HTMLDivElement | null) => {
      if (el && !observed.current.has(el)) {
        observed.current.add(el);
        observer.observe(el);
      }
    },
    [observer],
  );

  const older = async () => {
    if (paging) return;
    setPaging(true);
    try {
      await onOlder();
    } finally {
      setPaging(false);
    }
  };

  const onScroll = () => {
    const el = scroller.current!;
    const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    // Any move up leaves the bottom, however small. Content growing below (streaming text) also
    // opens a gap until it's pinned again; that isn't the reader, so it never unsticks. Coming
    // back down to the bottom follows again.
    if (movedUp(el)) stick.current = false;
    else if (fromBottom < NEAR_BOTTOM) stick.current = true;
    lastTop.current = el.scrollTop;
    setAtBottom(stick.current);
    anchor.current = anchorAt(ids, offs, el.scrollTop - base());
    setView({ top: el.scrollTop, height: el.clientHeight });
    if (el.scrollTop < NEAR_TOP && w.hasOlder) void older();
  };

  // The viewport's size (rotation, the keyboard on a phone, the composer growing), and the content's:
  // streaming markdown grows between renders, and the bottom is pinned again at once.
  useEffect(() => {
    const el = scroller.current!;
    const ro = new ResizeObserver(() => {
      if (stick.current) pin(el);
      setView({ top: el.scrollTop, height: el.clientHeight });
    });
    ro.observe(el);
    if (track.current) ro.observe(track.current);
    return () => ro.disconnect();
  }, []);

  // A short first page that doesn't fill the screen: fetch older until it does.
  useEffect(() => {
    const el = scroller.current;
    if (el && w.hasOlder && el.scrollHeight <= el.clientHeight + NEAR_TOP) void older();
  }, [w.hasOlder, msgs.length]);

  /** The reader asked to go up (wheel, finger, keys): stop following before anything pins again. */
  const unstick = () => {
    if (!stick.current) return;
    stick.current = false;
    setAtBottom(false);
  };

  const jump = () => {
    stick.current = true;
    lastTop.current = 0;
    setAtBottom(true);
    const el = scroller.current!;
    el.scrollTop = el.scrollHeight;
  };

  return (
    <div className="t-scroll-wrap">
      <div
        className="t-scroll"
        ref={scroller}
        onScroll={onScroll}
        onWheel={(e) => e.deltaY < 0 && unstick()}
        onTouchStart={(e) => (touchY.current = e.touches[0]?.clientY ?? 0)}
        onTouchMove={(e) => (e.touches[0]?.clientY ?? 0) > touchY.current + 2 && unstick()}
        onKeyDown={(e) => ["PageUp", "ArrowUp", "Home"].includes(e.key) && unstick()} role="log" aria-label="Transcript" aria-live="off">
        <div className="t-track" ref={track}>
          {w.hasOlder && <div className="t-paging">{paging ? "Loading earlier messages…" : "Earlier messages"}</div>}
          <div ref={listTop} />
          <div style={{ height: offs[start] }} />
          {msgs.slice(start, end).map((m) => (
            <div key={m.id} data-id={m.id} ref={measure}>
              <Message msg={m} />
            </div>
          ))}
          <div style={{ height: total - offs[end]! }} />
          {footer}
        </div>
      </div>
      {!atBottom && (
        <div className="t-jump">
          <Button label="Jump to latest" size="sm" variant="secondary" icon={<Icon icon={ArrowDownIcon} size="sm" />} onClick={jump} />
        </div>
      )}
    </div>
  );
}
