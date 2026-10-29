// The transcript: every loaded message rendered plainly (the snapshot's page, plus the older pages
// the reader scrolled up to), following the bottom unless the reader scrolled up, paging older
// messages in as they near the top, and keeping the reader's place by hand (scrollKeep.ts) when
// older messages arrive above them. It writes scrollTop only while no finger is down and no
// scroll is in flight: on iOS any write ends a fling.

import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { ArrowDownIcon } from "@heroicons/react/24/outline";
import type { TranscriptWindow } from "../../../shared/window";
import { firstShown, Gesture, restoreTop, rowAt, type Anchor } from "../scrollKeep";
import { Message } from "./Message";

const NEAR_BOTTOM = 40;
/** Fetch older messages this far from the top, so a page is usually in before a fling gets there. */
const NEAR_TOP = 2000;
/** A first page shorter than the screen plus this fetches older ones at once. */
const FILL = 600;
/** A scroll has settled after this long with no finger down and no scroll event. */
const QUIET = 150;

export function Transcript({ window: w, onOlder, footer }: { window: TranscriptWindow; onOlder: () => Promise<boolean>; footer?: React.ReactNode }) {
  const scroller = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  /** the scroll position the last scroll event saw: only a move up means the reader left the bottom */
  const lastTop = useRef(0);
  const touchY = useRef(0);
  const gesture = useRef(new Gesture(QUIET)).current;
  /** the row at the top of the viewport and where it was, as of the last scroll */
  const anchor = useRef<Anchor | undefined>(undefined);
  /** the first message rendered: older ones that arrive in front wait for the scroll to settle */
  const shownFrom = useRef<string | undefined>(undefined);
  const firstId = useRef<string | undefined>(undefined);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const [atBottom, setAtBottom] = useState(true);
  const [paging, setPaging] = useState(false);

  const msgs = w.messages;
  const ids = useMemo(() => msgs.map((m) => m.id), [msgs]);
  const from = firstShown(ids, shownFrom.current, stick.current || gesture.idle(performance.now()));

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

  /** Remember the row at the top of the viewport (rows are the list's children, in order). */
  const capture = (el: HTMLDivElement) => {
    const rows = list.current?.children;
    if (!rows) return;
    const i = rowAt(rows.length, (k) => (rows[k] as HTMLElement).offsetTop + (rows[k] as HTMLElement).offsetHeight, el.scrollTop);
    const row = rows[i] as HTMLElement | undefined;
    anchor.current = row?.dataset.id ? { id: row.dataset.id, top: row.offsetTop - el.scrollTop } : undefined;
  };

  /**
   * Follow the bottom, or put the reader's row back if something above it moved it (older
   * messages shown, an image above loading). Never while a finger is down or a fling runs: there
   * a write would stop the fling, so the move is accepted and becomes the new place.
   */
  const keep = (el: HTMLDivElement) => {
    if (stick.current) pin(el);
    else if (anchor.current && gesture.idle(performance.now())) {
      const row = list.current?.querySelector<HTMLElement>(`:scope > [data-id="${CSS.escape(anchor.current.id)}"]`);
      const top = row ? restoreTop(anchor.current, row.offsetTop, el.scrollTop) : undefined;
      if (top !== undefined) {
        el.scrollTop = top;
        lastTop.current = el.scrollTop;
      }
    }
    capture(el);
  };

  // After every render (a delta, older messages shown, a reset): stay at the bottom or in place.
  useLayoutEffect(() => {
    shownFrom.current = ids[from];
    firstId.current = ids[0];
    const el = scroller.current;
    if (el) keep(el);
  });

  const older = async () => {
    if (paging) return;
    setPaging(true);
    try {
      await onOlder();
    } finally {
      setPaging(false);
    }
  };

  /** Show older messages held back during a scroll, once it settles (checked again until then). */
  const settleLater = () => {
    if (settleTimer.current) return;
    settleTimer.current = setTimeout(() => {
      settleTimer.current = undefined;
      if (!gesture.idle(performance.now())) settleLater();
      else if (shownFrom.current !== firstId.current) bump();
    }, QUIET + 20);
  };
  useEffect(() => () => clearTimeout(settleTimer.current), []);

  const onScroll = () => {
    const el = scroller.current!;
    gesture.scrolled(performance.now());
    const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    // Any move up leaves the bottom, however small. Content growing below (streaming text) also
    // opens a gap until it's pinned again; that isn't the reader, so it never unsticks. Coming
    // back down to the bottom follows again.
    if (movedUp(el)) stick.current = false;
    else if (fromBottom < NEAR_BOTTOM) stick.current = true;
    lastTop.current = el.scrollTop;
    setAtBottom(stick.current);
    capture(el);
    // (not while a page waits to be shown: one page at a time, as the reader gets to it)
    if (from > 0) settleLater();
    else if (el.scrollTop < NEAR_TOP && w.hasOlder) void older();
  };

  // The viewport's size (rotation, the keyboard on a phone, the composer growing), and the
  // content's: streaming markdown grows between renders, an image decodes, a card opens.
  useEffect(() => {
    const el = scroller.current!;
    const ro = new ResizeObserver(() => keep(el));
    ro.observe(el);
    if (list.current) ro.observe(list.current);
    return () => ro.disconnect();
  }, []);

  // A short first page that doesn't fill the screen: fetch older until it does.
  useEffect(() => {
    const el = scroller.current;
    if (el && w.hasOlder && el.scrollHeight <= el.clientHeight + FILL) void older();
  }, [w.hasOlder, msgs.length]);

  // Older messages arrived while the reader was scrolling: show them once it settles.
  useEffect(() => {
    if (from > 0) settleLater();
  }, [from]);

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

  const touchEnd = () => {
    gesture.touch(false, performance.now());
    settleLater();
  };

  return (
    <div className="t-scroll-wrap">
      <div
        className="t-scroll"
        ref={scroller}
        onScroll={onScroll}
        onWheel={(e) => e.deltaY < 0 && unstick()}
        onTouchStart={(e) => {
          gesture.touch(true, performance.now());
          touchY.current = e.touches[0]?.clientY ?? 0;
        }}
        onTouchMove={(e) => (e.touches[0]?.clientY ?? 0) > touchY.current + 2 && unstick()}
        onTouchEnd={touchEnd}
        onTouchCancel={touchEnd}
        onKeyDown={(e) => ["PageUp", "ArrowUp", "Home"].includes(e.key) && unstick()}
        role="log"
        aria-label="Transcript"
        aria-live="off"
      >
        <div className="t-track">
          {(w.hasOlder || from > 0) && <div className="t-paging">{paging || from > 0 ? "Loading earlier messages…" : "Earlier messages"}</div>}
          <div ref={list}>
            {msgs.slice(from).map((m) => (
              <div key={m.id} data-id={m.id}>
                <Message msg={m} />
              </div>
            ))}
          </div>
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
