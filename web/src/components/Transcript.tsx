// The transcript: a bounded slice of the loaded messages mounted plainly (scrollKeep.ts nextWindow),
// following the bottom until the reader moves up (scrollKeep.ts Follow), paging older messages in as
// they near the top, and keeping the reader's place by hand when rows above them are added or
// dropped. It writes scrollTop only while no finger or mouse button is down and no scroll is in
// flight: on iOS any write ends a fling, and a drag selecting text autoscrolls by itself.

import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { ArrowDownIcon } from "@heroicons/react/24/outline";
import type { TranscriptWindow } from "../../../shared/window";
import { Follow, FOLLOW_KEEP, Gesture, nextWindow, remap, restoreTop, rowAt, scrollInFlight, type Anchor } from "../scrollKeep";
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

/** A mouse: clicking text gives the transcript the keys. On a touch screen it'd close the keyboard. */
const MOUSE = matchMedia("(pointer: fine)").matches;

export function Transcript({ window: w, onOlder, footer }: { window: TranscriptWindow; onOlder: () => Promise<boolean>; footer?: React.ReactNode }) {
  const scroller = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const f = useRef(new Follow()).current;
  /** the scroll range following last caught up with: only a change of size pins */
  const fit = useRef(NaN);
  /** the scroll position the last scroll event saw */
  const lastTop = useRef(0);
  /** the scrollTop we last wrote: its scroll event is ours, not the reader's */
  const own = useRef(NaN);
  const gesture = useRef(new Gesture(QUIET)).current;
  /** the row at the top of the viewport and where it was, as of the last scroll */
  const anchor = useRef<Anchor | undefined>(undefined);
  /** the slice mounted last render, by its first and last ids */
  const shown = useRef<{ first?: string; last?: string; tail: boolean }>({ tail: true });
  const near = useRef({ top: false, end: false });
  /** scrollTop before this render's rows go in: dropping rows above can clamp it, and that isn't the reader */
  const preTop = useRef<number | undefined>(undefined);
  /** a mouse button is down on the transcript */
  const press = useRef(false);
  /** that press is selecting text */
  const selecting = useRef(false);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** nodes first touched: touchend goes to them even once a render took them out of the document */
  const touched = useRef(new Set<EventTarget>());
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
    stick: f.on,
    nearTop: near.current.top,
    nearEnd: near.current.end,
    anchor: anchor.current ? ids.indexOf(anchor.current.id) : -1,
  });

  if (!f.on) preTop.current = scroller.current?.scrollTop;

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
   * Follow the bottom when the size changed (not under a finger or a press, nor while the reader's
   * input is live: on a busy phone the finger's first move can arrive after several pins, each
   * yanking the view back), or put the reader's row back if something
   * above it moved it: rows shown or dropped above, an image above sizing. Never while a finger
   * is down or a fling runs: there a write would stop the fling, so the move is accepted and
   * becomes the new place.
   */
  const keep = (el: HTMLDivElement, before = el.scrollTop) => {
    const now = performance.now();
    if (f.on) {
      const range = el.scrollHeight - el.clientHeight;
      if (!gesture.down && !f.live(now) && range !== fit.current) {
        fit.current = range;
        pin(el);
      }
    } else if (anchor.current && gesture.idle(now) && !f.live(now) && !scrollInFlight(before, lastTop.current, el.scrollTop, el.scrollHeight - el.clientHeight)) {
      const row = list.current?.querySelector<HTMLElement>(`:scope > [data-id="${CSS.escape(anchor.current.id)}"]`);
      const top = row ? restoreTop(anchor.current, row.offsetTop, el.scrollTop) : undefined;
      if (top !== undefined) write(el, top);
    }
    if (!selecting.current) f.arrived(el.scrollHeight - el.scrollTop - el.clientHeight, shown.current.tail, NEAR_BOTTOM);
    setAtBottom(f.on);
    capture(el);
  };

  // After every render (a delta, rows mounted or dropped, a reset): stay at the bottom or in place.
  useLayoutEffect(() => {
    shown.current = { first: ids[win.lo], last: ids[win.hi - 1], tail: win.tail };
    if (!win.tail && f.on) f.stop();
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
      const now = performance.now();
      if (!gesture.idle(now) || f.live(now)) settleLater();
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

  /**
   * The reader may be moving the view: `onScroll` judges by what really moves. From `lastTop`: by
   * the time an engine reports the wheel, scrollTop may already hold that wheel's move.
   */
  const reaching = (held = false) => {
    f.input(lastTop.current, performance.now(), held);
    settleLater();
  };

  const onScroll = () => {
    const el = scroller.current!;
    const top = el.scrollTop;
    const ours = Math.abs(top - own.current) < 1;
    own.current = NaN;
    if (!ours) {
      const now = performance.now();
      gesture.scrolled(now);
      f.scrolled({ top, lastTop: lastTop.current, fromBottom: el.scrollHeight - top - el.clientHeight, tail: shown.current.tail, now, selecting: selecting.current }, NEAR_BOTTOM);
      setAtBottom(f.on);
      // Following, moved up, and nobody moved it: something shrank and grew within a frame and the
      // browser clamped scrollTop, with no size change left to say so. Back before it's painted.
      if (f.on && !gesture.down && !f.live(now) && top < lastTop.current - 1) pin(el);
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
    f.jumped(performance.now());
    fit.current = NaN;
    setAtBottom(true);
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
    const mouseOff = () => press.current && liftRef.current();
    // Selecting text stops following, and nothing writes scrollTop until the button is up: the
    // browser is autoscrolling. A press that selects nothing (a click) stops nothing.
    const selection = () => {
      const s = document.getSelection();
      if (!press.current || !s || s.isCollapsed || !scroller.current?.contains(s.anchorNode)) return;
      selecting.current = true;
      f.stop();
      setAtBottom(false);
    };
    const offs = ["pointerup", "pointercancel", "dragend", "contextmenu", "blur"];
    for (const t of offs) window.addEventListener(t, mouseOff, t !== "blur");
    document.addEventListener("selectionchange", selection);
    document.addEventListener("touchend", onTouchEnd, true);
    document.addEventListener("touchcancel", onTouchEnd, true);
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", gone);
    return () => {
      for (const t of offs) window.removeEventListener(t, mouseOff, t !== "blur");
      document.removeEventListener("selectionchange", selection);
      document.removeEventListener("touchend", onTouchEnd, true);
      document.removeEventListener("touchcancel", onTouchEnd, true);
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", gone);
    };
  }, []);

  /** The finger or the mouse button is off: catch up with the bottom if following. */
  const lift = () => {
    forget();
    press.current = false;
    if (!gesture.down) return;
    const now = performance.now();
    gesture.touch(false, now);
    f.release(now);
    const el = scroller.current;
    if (selecting.current) {
      selecting.current = false;
      // a selection that ended at the very bottom left nothing behind
      if (el && shown.current.tail && el.scrollHeight - el.scrollTop - el.clientHeight < 2) f.on = true;
      setAtBottom(f.on);
    }
    if (el) keep(el);
    settleLater();
  };
  liftRef.current = lift;
  keepRef.current = keep;
  const onTouchStart = (e: React.TouchEvent) => {
    gesture.touch(true, performance.now());
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
        onWheel={(e) => {
          f.wheel(e.deltaX, e.deltaY, lastTop.current, performance.now());
          settleLater();
        }}
        onTouchStart={onTouchStart}
        onTouchMove={() => reaching(true)}
        onPointerDown={(e) => {
          // A press holds everything still, like a finger: what's under it stays there. On the
          // scroller itself it's the scrollbar, which moves the view by itself.
          if (e.pointerType === "touch" || e.button !== 0) return;
          gesture.touch(true, performance.now());
          press.current = true;
          if (e.target === e.currentTarget) reaching(true);
        }}
        onKeyDown={() => reaching()}
        onFocus={() => reaching()}
        tabIndex={MOUSE ? 0 : undefined}
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
          {win.tail ? <div className="t-foot">{footer}</div> : <div className="t-paging">Newer messages</div>}
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
