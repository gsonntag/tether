/**
 * Swipe gestures for the phone sidebar drawer (Astryx MobileNav, pinned to the start side).
 *
 * - Swipe right from the left edge (or a clearly horizontal swipe that starts in the left third
 *   of the screen) opens the drawer. It follows the finger and snaps open or shut on release.
 * - Swipe left on the open drawer or its backdrop closes it, also following the finger.
 *
 * The decisions (where a swipe may start, when it counts as horizontal, where it settles) are pure
 * functions below and unit-tested in swipe.test.ts. `useDrawerSwipe` wires them to touch events.
 *
 * Following the finger: the drawer panel stays mounted (hidden) inside AppShell's <Activity>, so
 * the hook puts an inline transform on it while dragging and drops it on release; Astryx's own
 * transform transition then carries the panel the rest of the way. Under prefers-reduced-motion
 * nothing moves with the finger: the drawer just opens or closes on release.
 */
import { useEffect } from "react";
import { flushSync } from "react-dom";

/** A touch that starts this close to the left edge can open the drawer with a looser angle. */
export const EDGE_PX = 24;
/** Movement before we decide whether a touch is a horizontal swipe. */
export const SLOP_PX = 10;
/** Release speed (px/ms) that settles the drawer in the swipe's direction, whatever the distance. */
export const FLING_PX_PER_MS = 0.35;

/** What a touch may turn into: "edge"/"zone" open the drawer, "close" closes it. */
export type SwipeKind = "edge" | "zone" | "close";

/** Can a touch starting at `x` open the closed drawer, and how strict should the angle be? */
export function openKind(x: number, viewportWidth: number): "edge" | "zone" | null {
  if (x <= EDGE_PX) return "edge";
  if (x < viewportWidth / 3) return "zone";
  return null;
}

/**
 * After the finger has moved (dx, dy) from where it started: "wait" for more movement, "drag" the
 * drawer, or "cancel" and leave the touch to the page (it's a scroll, or goes the wrong way).
 * Edge swipes and closing swipes need dx to be the larger component; mid-screen swipes need it to
 * be clearly dominant (2:1), so a slightly slanted vertical scroll never grabs the drawer.
 */
export function lockAxis(kind: SwipeKind, dx: number, dy: number): "wait" | "drag" | "cancel" {
  if (Math.hypot(dx, dy) < SLOP_PX) return "wait";
  const along = kind === "close" ? -dx : dx;
  if (along <= 0) return "cancel";
  const ratio = kind === "zone" ? 2 : 1;
  return along >= ratio * Math.abs(dy) ? "drag" : "cancel";
}

/** How open the drawer is (0 shut, 1 open) after the finger moved dx px while dragging. */
export function dragProgress(kind: SwipeKind, dx: number, width: number): number {
  if (width <= 0) return kind === "close" ? 1 : 0;
  const p = kind === "close" ? 1 + dx / width : dx / width;
  return Math.min(1, Math.max(0, p));
}

export type Sample = { t: number; x: number };

/** Horizontal speed in px/ms over the last `windowMs` of samples (0 if there's too little). */
export function velocity(samples: Sample[], windowMs = 100): number {
  if (samples.length < 2) return 0;
  const last = samples[samples.length - 1]!;
  let first = samples[0]!;
  for (let i = samples.length - 2; i >= 0; i--) {
    first = samples[i]!;
    if (last.t - first.t >= windowMs) break;
  }
  const dt = last.t - first.t;
  return dt > 0 ? (last.x - first.x) / dt : 0;
}

/** Should the drawer end up open, given how open it is and how fast the finger was moving? */
export function settleOpen(progress: number, v: number): boolean {
  if (v >= FLING_PX_PER_MS) return true;
  if (v <= -FLING_PX_PER_MS) return false;
  return progress >= 0.5;
}

// ---------------------------------------------------------------------------------------------
// DOM wiring
// ---------------------------------------------------------------------------------------------

const DRAWER_DIALOG = "dialog.astryx-mobile-nav";
/** The ::backdrop can't take an inline style, so it follows the drag through this one rule. */
const BACKDROP_RULE = `${DRAWER_DIALOG}[data-swiping]::backdrop{opacity:var(--tether-swipe,1)!important;transition:none!important}`;

function drawerDialog(): HTMLDialogElement | null {
  return document.querySelector<HTMLDialogElement>(DRAWER_DIALOG);
}

function drawerPanel(dialog: HTMLDialogElement | null): HTMLElement | null {
  return (dialog?.firstElementChild as HTMLElement | null) ?? null;
}

function isEditable(el: Element): boolean {
  return el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
}

/**
 * A right swipe that starts here belongs to the page, not the drawer: inside a horizontal
 * scroller that can still scroll back left (code blocks, the diff viewer), inside another dialog,
 * or — for mid-screen swipes — in a text field or over a text selection.
 */
function pageOwnsSwipe(target: EventTarget | null, kind: "edge" | "zone"): boolean {
  if (kind === "zone") {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return true;
  }
  for (let el = target instanceof Element ? target : null; el && el !== document.body; el = el.parentElement) {
    if (el.tagName === "DIALOG") return true;
    if (kind === "zone" && isEditable(el)) return true;
    if (el.scrollLeft > 0 && el.scrollWidth > el.clientWidth) {
      const ox = getComputedStyle(el).overflowX;
      if (ox === "auto" || ox === "scroll") return true;
    }
  }
  return false;
}

type Gesture = {
  kind: SwipeKind;
  x0: number;
  y0: number;
  id: number;
  state: "pending" | "dragging";
  width: number;
  progress: number;
  samples: Sample[];
};

/**
 * Opens and closes the phone sidebar drawer with swipes. Active only while `enabled` (narrow).
 * `isOpen`/`onOpenChange` read and set the drawer's state (the store's sidebarOpen).
 */
export function useDrawerSwipe(enabled: boolean, isOpen: () => boolean, onOpenChange: (open: boolean) => void) {
  useEffect(() => {
    if (!enabled) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const style = document.createElement("style");
    style.textContent = BACKDROP_RULE;
    document.head.appendChild(style);
    let g: Gesture | null = null;

    const setOpen = (open: boolean) => {
      if (isOpen() !== open) flushSync(() => onOpenChange(open));
    };

    const paint = (progress: number) => {
      if (reduced.matches || !g) return;
      const dialog = drawerDialog();
      const panel = drawerPanel(dialog);
      if (!dialog || !panel) return;
      dialog.dataset.swiping = "";
      dialog.style.setProperty("--tether-swipe", String(progress));
      panel.style.transition = "none";
      panel.style.transform = `translateX(${(progress - 1) * g.width}px)`;
    };

    const unpaint = () => {
      const dialog = drawerDialog();
      const panel = drawerPanel(dialog);
      if (dialog) {
        delete dialog.dataset.swiping;
        dialog.style.removeProperty("--tether-swipe");
      }
      if (panel) {
        panel.style.transition = "";
        panel.style.transform = "";
      }
    };

    // A finished drag mustn't also land as a tap on whatever was under the finger.
    const swallowClick = () => {
      const stop = (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
      };
      window.addEventListener("click", stop, { capture: true, once: true });
      setTimeout(() => window.removeEventListener("click", stop, { capture: true }), 400);
    };

    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) {
        if (g?.state === "dragging") finish(false);
        g = null;
        return;
      }
      const t = e.touches[0]!;
      const open = isOpen();
      let kind: SwipeKind | null;
      if (open) {
        const dialog = drawerDialog();
        kind = dialog && e.target instanceof Node && dialog.contains(e.target) ? "close" : null;
      } else {
        kind = openKind(t.clientX, window.innerWidth);
        if (kind && pageOwnsSwipe(e.target, kind)) kind = null;
      }
      g = kind
        ? { kind, x0: t.clientX, y0: t.clientY, id: t.identifier, state: "pending", width: 0, progress: kind === "close" ? 1 : 0, samples: [{ t: e.timeStamp, x: t.clientX }] }
        : null;
    };

    const onMove = (e: TouchEvent) => {
      if (!g) return;
      const t = Array.from(e.touches).find((x) => x.identifier === g!.id);
      if (!t || e.touches.length !== 1) return;
      const dx = t.clientX - g.x0;
      const dy = t.clientY - g.y0;
      if (g.state === "pending") {
        const lock = lockAxis(g.kind, dx, dy);
        if (lock === "wait") return;
        // Once the browser has started scrolling, the touch is the page's.
        if (lock === "cancel" || !e.cancelable) {
          g = null;
          return;
        }
        g.state = "dragging";
        g.width = drawerPanel(drawerDialog())?.getBoundingClientRect().width || Math.min(window.innerWidth, 320);
        // Reduced motion: nothing shows until the release decides.
        if (g.kind !== "close" && !reduced.matches) {
          paint(0);
          setOpen(true);
        }
      }
      e.preventDefault();
      g.samples.push({ t: e.timeStamp, x: t.clientX });
      if (g.samples.length > 20) g.samples.shift();
      g.progress = dragProgress(g.kind, dx, g.width);
      paint(g.progress);
    };

    const finish = (cancelled: boolean) => {
      if (!g || g.state !== "dragging") return;
      const open = cancelled ? g.kind === "close" : settleOpen(g.progress, velocity(g.samples));
      g = null;
      unpaint();
      setOpen(open);
      swallowClick();
    };

    const onEnd = (e: TouchEvent) => {
      if (!g) return;
      if (Array.from(e.touches).some((x) => x.identifier === g!.id)) return;
      // The lift counts as a sample too: a finger that stopped before lifting has no fling.
      const lift = Array.from(e.changedTouches).find((x) => x.identifier === g!.id);
      if (lift) g.samples.push({ t: e.timeStamp, x: lift.clientX });
      if (g.state === "dragging") finish(e.type === "touchcancel");
      g = null;
    };

    const opts = { capture: true, passive: true } as const;
    window.addEventListener("touchstart", onStart, opts);
    window.addEventListener("touchmove", onMove, { capture: true, passive: false });
    window.addEventListener("touchend", onEnd, opts);
    window.addEventListener("touchcancel", onEnd, opts);
    return () => {
      window.removeEventListener("touchstart", onStart, opts);
      window.removeEventListener("touchmove", onMove, { capture: true });
      window.removeEventListener("touchend", onEnd, opts);
      window.removeEventListener("touchcancel", onEnd, opts);
      if (g?.state === "dragging") unpaint();
      g = null;
      style.remove();
    };
    // Pass stable callbacks: the listeners only re-attach when `enabled` changes.
  }, [enabled]);
}
