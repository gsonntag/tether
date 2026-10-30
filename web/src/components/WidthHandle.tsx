// The drag handles on the sidebar's and the terminal panel's inner edges (desktop): Astryx's handle
// (pointer capture, cursor, arrow keys) over widths kept per device. A double click goes back to the
// default. Each writes its width straight onto the layout, so a drag re-renders only the handle.

import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { ResizeHandle } from "@astryxdesign/core/Resizable";
import { clampWidth, panelMax, PANEL_MIN, readWidth, sidebarMax, SIDEBAR_MIN, writeWidth } from "../widths";

const phoneQuery = "(pointer: coarse), (max-width: 767px)";
const useDesktop = () =>
  useSyncExternalStore(
    (fn) => {
      const q = matchMedia(phoneQuery);
      q.addEventListener("change", fn);
      return () => q.removeEventListener("change", fn);
    },
    () => !matchMedia(phoneQuery).matches,
  );

function WidthHandle({
  storageKey,
  label,
  min,
  max,
  sized,
  apply,
  ...handle
}: {
  storageKey: string;
  label: string;
  min: number;
  /** the largest width right now */
  max: (el: HTMLElement) => number;
  /** the width now: the element it sizes */
  sized: (el: HTMLElement) => HTMLElement | null | undefined;
  /** puts a width on the layout; undefined takes it off (the default layout) */
  apply: (el: HTMLElement, width: number | undefined) => void;
  position?: "inline" | "overlay";
  pillPlacement?: "center" | "end";
  isReversed?: boolean;
  hasDivider?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(() => readWidth(localStorage, storageKey));
  const from = useRef(0);
  /** the width to store: arrow keys start, move and end before any render */
  const moved = useRef<number>(undefined);
  useLayoutEffect(() => {
    const el = ref.current!;
    apply(el, width);
    return () => apply(el, undefined);
  }, [width]);

  const now = () => (ref.current && sized(ref.current)?.offsetWidth) || width || min;
  const end = () => {
    if (moved.current !== undefined) writeWidth(localStorage, storageKey, moved.current);
  };
  return (
    <ResizeHandle
      ref={ref}
      label={label}
      isAlwaysVisible={false}
      {...handle}
      resizable={{
        _isResizableProps: true,
        _direction: "horizontal",
        get _size() {
          return now();
        },
        get _maxSizePx() {
          return ref.current ? Math.max(min, max(ref.current)) : min;
        },
        _minSizePx: min,
        _isCollapsed: false,
        _collapsible: false,
        _collapsedSize: 0,
        _snaps: [],
        _onResizeStart: () => {
          from.current = now();
          moved.current = undefined;
        },
        _onResizeMove: (delta) => {
          const next = clampWidth(from.current + delta, min, max(ref.current!));
          moved.current = next;
          setWidth(next);
        },
        _onResizeEnd: end,
        _onResizeCancel: end,
      }}
      onDoubleClick={() => {
        setWidth(undefined);
        writeWidth(localStorage, storageKey, undefined);
      }}
    />
  );
}

const inFrame = (el: HTMLElement) => el.parentElement;

/** Lives beside the SideNav in `.t-side-frame`. */
export function SidebarHandle() {
  if (!useDesktop()) return null;
  return (
    <WidthHandle
      storageKey="tether.width.sidebar"
      label="Resize sidebar"
      min={SIDEBAR_MIN}
      max={() => sidebarMax(innerWidth)}
      sized={inFrame}
      apply={(el, w) => (w ? el.parentElement?.style.setProperty("--t-side-w", `${w}px`) : el.parentElement?.style.removeProperty("--t-side-w"))}
      position="overlay"
      pillPlacement="end"
    />
  );
}

/** Lives between the transcript and the panel in `.t-session-split`. */
export function PanelHandle() {
  if (!useDesktop()) return null;
  return (
    <WidthHandle
      storageKey="tether.width.panel"
      label="Resize terminal"
      min={PANEL_MIN}
      max={(el) => panelMax(el.parentElement?.clientWidth ?? 0)}
      sized={(el) => el.nextElementSibling as HTMLElement | null}
      apply={(el, w) => {
        const row = el.parentElement;
        if (w) {
          row?.style.setProperty("--t-panel-w", `${w}px`);
          row?.setAttribute("data-panel-sized", "");
        } else {
          row?.style.removeProperty("--t-panel-w");
          row?.removeAttribute("data-panel-sized");
        }
      }}
      isReversed
      hasDivider
      pillPlacement="center"
      className="t-term-handle"
    />
  );
}
