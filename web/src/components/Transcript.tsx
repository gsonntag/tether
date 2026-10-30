// The transcript: a bounded slice of the loaded messages mounted plainly (scrollKeep.ts nextWindow),
// following the bottom until the reader scrolls up, paging older messages in as they near the top,
// and keeping the reader's place by hand when rows above them are added or dropped. It writes
// scrollTop only while no finger is down and no scroll is in flight: on iOS any write ends a fling.

import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { ArrowDownIcon } from "@heroicons/react/24/outline";
import type { TranscriptWindow } from "../../../shared/window";
import { FOLLOW_KEEP, following, Gesture, nextWindow, remap, restoreTop, rowAt, scrollInFlight, type Anchor } from "../scrollKeep";
import { Message } from "./Message";

const NEAR_BOTTOM = 40;
/** Fetch or mount older messages this far from the top, so a page is usually in before a fling gets there. */
const NEAR_TOP = 2000;
/** Mount newer messages this far from the end of what's mounted. */
const NEAR_END = 2000;
/** A first page shorter than the screen plus this fetches older ones at once. */
const FILL = 600;
/** A scroll has settled after this long with no finger down and no scroll event. */
const QUIET = 150;

export function Transcript({ window: w, onOlder, footer }: { window: TranscriptWindow; onOlder: () => Promise<boolean>; footer?: React.ReactNode }) {
  const scroller = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  /** the scroll position the last scroll event saw */
  const lastTop = useRef(0);
  /** the scrollTop we last wrote: its scroll event is ours, not the reader's */
  const own = useRef(NaN);
  const touchY = useRef(0);
  const gesture = useRef(new Gesture(QUIET)).current;
  /** the row at the top of the viewport and where it was, as of the last scroll */
  const anchor = useRef<Anchor | undefined>(undefined);
  /** the slice mounted last render, by its first and last ids */
  const shown = useRef<{ first?: string; last?: string; tail: boolean }>({ tail: true });
  const near = useRef({ top: false, end: false });
  /** scrollTop before this render's rows go in: dropping rows above can clamp it, and that isn't the reader */
  const preTop = useRef<number | undefined>(undefined);
  /** the scrollbar is pressed */
  const bar = useRef(false);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** nodes first touched: touchend goes to them even once a render took them out of the document */
  const touched = useRef(new Set<EventTarget>());
  /** the reader's last move was down: reaching the real bottom follows, even with no scroll event left */
  const goingDown = useRef(false);
  const liftRef = useRef<() => void>(() => {});
  const keepRef = useRef<(el: HTMLDivElement) => void>(() => {});
  const onTouchEnd = useRef((e: Event) => (e as TouchEvent).touches.length === 0 && liftRef.current()).current;
  const forget = () => {
    for (const t of touched.current) {
      t.removeEventListener("touchend", onTouchEnd);
      t.removeEventListener("touchcancel", onTouchEnd);
    }
    touched.current.clear();
  };
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const [atBottom, setAtBottom] = useState(true);
  const [paging, setPaging] = useState(false);

  const msgs = w.messages;
  const ids = useMemo(() => msgs.map((m) => m.id), [msgs]);
  const win = nextWindow(remap(ids, shown.current.first, shown.current.last, shown.current.tail), {
    n: ids.length,
    settled: gesture.idle(performance.now()),
    stick: stick.current,
    nearTop: near.current.top,
    nearEnd: near.current.end,
    anchor: anchor.current ? ids.indexOf(anchor.current.id) : -1,
  });

  if (!stick.current) preTop.current = scroller.current?.scrollTop;

  const follow = (on: boolean) => {
    stick.current = on;
    setAtBottom(on);
  };
  /** Write scrollTop, remembering it was us. */
  const write = (el: HTMLDivElement, top: number) => {
    el.scrollTop = top;
    own.current = lastTop.current = el.scrollTop;
  };
  const pin = (el: HTMLDivElement) => {
    if (el.scrollHeight - el.scrollTop - el.clientHeight > 0.5) write(el, el.scrollHeight);
  };

  /** Remember the row at the top of the viewport (rows are the list's children, in order). */
  const capture = (el: HTMLDivElement) => {
    near.current = { top: el.scrollTop < NEAR_TOP, end: el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_END };
    const rows = list.current?.children;
    if (!rows) return;
    const i = rowAt(rows.length, (k) => (rows[k] as HTMLElement).offsetTop + (rows[k] as HTMLElement).offsetHeight, el.scrollTop);
    const row = rows[i] as HTMLElement | undefined;
    anchor.current = row?.dataset.id ? { id: row.dataset.id, top: row.offsetTop - el.scrollTop } : undefined;
  };

  /**
   * Follow the bottom (not under a finger: on a busy phone the finger's first move can arrive
   * after several pins, each yanking the view back), or put the reader's row back if something
   * above it moved it: rows shown or dropped above, an image above sizing. Never while a finger
   * is down or a fling runs: there a write would stop the fling, so the move is accepted and
   * becomes the new place.
   */
  const keep = (el: HTMLDivElement, before = el.scrollTop) => {
    if (stick.current) {
      if (!gesture.down) pin(el);
    } else if (anchor.current && gesture.idle(performance.now()) && !scrollInFlight(before, lastTop.current, el.scrollTop, el.scrollHeight - el.clientHeight)) {
      const row = list.current?.querySelector<HTMLElement>(`:scope > [data-id="${CSS.escape(anchor.current.id)}"]`);
      const top = row ? restoreTop(anchor.current, row.offsetTop, el.scrollTop) : undefined;
      if (top !== undefined) write(el, top);
    }
    // Down at the real bottom by now (the last rows were mounted, the slice was trimmed), with no
    // scroll event left to say so: follow.
    if (!stick.current && goingDown.current && shown.current.tail && el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM) follow(true);
    capture(el);
  };

  // After every render (a delta, rows mounted or dropped, a reset): stay at the bottom or in place.
  useLayoutEffect(() => {
    shown.current = { first: ids[win.lo], last: ids[win.hi - 1], tail: win.tail };
    if (!win.tail && stick.current) follow(false);
    const el = scroller.current;
    if (el) keep(el, preTop.current);
    preTop.current = undefined;
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
  /** Older messages to fetch: the slice reaches the oldest loaded one and the reader is near it. */
  const wantOlder = () => w.hasOlder && shown.current.first === ids[0] && near.current.top;

  /** Re-render once the scroll settles: rows above can be shown or dropped then. */
  const settleLater = () => {
    if (settleTimer.current) return;
    settleTimer.current = setTimeout(() => {
      settleTimer.current = undefined;
      if (!gesture.idle(performance.now())) settleLater();
      else bump();
    }, QUIET + 20);
  };
  useEffect(
    () => () => {
      clearTimeout(settleTimer.current);
      forget();
    },
    [],
  );

  /** The reader asked to go up (wheel, finger, keys, scrollbar): stop following before anything pins again. */
  const unstick = () => {
    goingDown.current = false;
    if (stick.current) follow(false);
  };

  const onScroll = () => {
    const el = scroller.current!;
    const top = el.scrollTop;
    const ours = Math.abs(top - own.current) < 1;
    own.current = NaN;
    if (!ours) {
      gesture.scrolled(performance.now());
      if (Math.abs(top - lastTop.current) >= 1) goingDown.current = top > lastTop.current;
      const f = following({ stick: stick.current, bar: bar.current, top, lastTop: lastTop.current, fromBottom: el.scrollHeight - top - el.clientHeight, tail: shown.current.tail }, NEAR_BOTTOM);
      if (f !== stick.current) follow(f);
      settleLater();
    }
    lastTop.current = top;
    capture(el);
    // Newer rows mount below at once (nothing on screen moves); older ones once it settles.
    if (near.current.end && !shown.current.tail) bump();
    if (wantOlder()) void older();
  };

  // The viewport's size (rotation, the keyboard on a phone, the composer growing), and the
  // content's: streaming markdown grows between renders, a card opens.
  useEffect(() => {
    const el = scroller.current!;
    const ro = new ResizeObserver(() => keepRef.current(el));
    ro.observe(el);
    if (track.current) ro.observe(track.current);
    return () => ro.disconnect();
  }, []);

  // A short first page that doesn't fill the screen: fetch older until it does.
  useEffect(() => {
    const el = scroller.current;
    if (el && w.hasOlder && shown.current.first === ids[0] && el.scrollHeight <= el.clientHeight + FILL) void older();
  }, [w.hasOlder, msgs.length]);

  const jump = () => {
    follow(true);
    if (!shown.current.tail) {
      // newer messages aren't mounted: mount the newest, and the render pins
      shown.current = { first: ids[Math.max(0, ids.length - FOLLOW_KEEP)], tail: true };
      bump();
    } else pin(scroller.current!);
  };

  // Any finger lifted anywhere: another finger's touchend may land outside the transcript (on the
  // composer, say), and `touches` counts every finger on the screen. Hiding the page ends a touch
  // without a word.
  useEffect(() => {
    const hidden = () => document.visibilityState === "hidden" && liftRef.current();
    const gone = () => liftRef.current();
    document.addEventListener("touchend", onTouchEnd, true);
    document.addEventListener("touchcancel", onTouchEnd, true);
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", gone);
    return () => {
      document.removeEventListener("touchend", onTouchEnd, true);
      document.removeEventListener("touchcancel", onTouchEnd, true);
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", gone);
    };
  }, []);

  /** The finger (or the scrollbar's pointer) is off: catch up with the bottom if following. */
  const lift = () => {
    forget();
    bar.current = false;
    if (!gesture.down) return;
    gesture.touch(false, performance.now());
    const el = scroller.current;
    if (el && stick.current) pin(el);
    settleLater();
  };
  liftRef.current = lift;
  keepRef.current = keep;
  const onTouchStart = (e: React.TouchEvent) => {
    gesture.touch(true, performance.now());
    touchY.current = e.touches[0]?.clientY ?? 0;
    // A touchend goes to the node first touched, and a streaming render may have taken that node
    // out of the document, where it no longer reaches the document's listener below. So each
    // finger's node is heard directly, until the last finger is off. (No timeout: a finger resting
    // still sends nothing at all, however long it rests, and must keep everything still under it.)
    e.target.addEventListener("touchend", onTouchEnd);
    e.target.addEventListener("touchcancel", onTouchEnd);
    touched.current.add(e.target);
  };

  return (
    <div className="t-scroll-wrap">
      <div
        className="t-scroll"
        ref={scroller}
        onScroll={onScroll}
        onWheel={(e) => e.deltaY < 0 && unstick()}
        onTouchStart={onTouchStart}
        onTouchMove={(e) => (e.touches[0]?.clientY ?? 0) > touchY.current + 2 && unstick()}
        onPointerDown={(e) => {
          // the scrollbar (a press on the scroller itself): like a finger, until released
          if (e.pointerType !== "mouse" || e.target !== e.currentTarget) return;
          gesture.touch(true, performance.now());
          bar.current = true;
          window.addEventListener("pointerup", lift, { once: true });
        }}
        onKeyDown={(e) => ["PageUp", "ArrowUp", "Home"].includes(e.key) && unstick()}
        role="log"
        aria-label="Transcript"
        aria-live="off"
      >
        <div className="t-track" ref={track}>
          {(w.hasOlder || win.lo > 0) && <div className="t-paging">{paging || (win.lo > 0 && near.current.top) ? "Loading earlier messages…" : "Earlier messages"}</div>}
          <div ref={list}>
            {msgs.slice(win.lo, win.hi).map((m) => (
              <div key={m.id} data-id={m.id}>
                <Message msg={m} />
              </div>
            ))}
          </div>
          {win.tail ? footer : <div className="t-paging">Newer messages</div>}
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
