import { useLayoutEffect, useState } from "react";
import { panelCovers, panelFloor } from "../widths";

let cell: number | undefined;

/** One terminal cell's width at the panel's font size (TermView), in px. */
export function cellWidth() {
  if (cell) return cell;
  const ctx = typeof document === "object" ? document.createElement("canvas").getContext?.("2d") : null;
  if (!ctx) return 7.83;
  const family = getComputedStyle(document.documentElement).getPropertyValue("--t-mono").trim() || "ui-monospace, Menlo, monospace";
  ctx.font = `13px ${family}`;
  // xterm rounds a cell up to whole device pixels.
  const dpr = devicePixelRatio || 1;
  return (cell = Math.ceil((ctx.measureText("W").width || 7.83) * dpr) / dpr);
}

/**
 * Whether the terminal panel goes over the chat rather than beside it: from the room there is now,
 * so rotating, resizing and dragging the sidebar all count. The row also gets the side panel's
 * least width, which a width dragged or stored earlier can't go under.
 */
export function useTermCover(row: HTMLElement | null) {
  const [cover, setCover] = useState(false);
  useLayoutEffect(() => {
    if (!row) return;
    const check = () => {
      const c = cellWidth();
      row.style.setProperty("--t-panel-min", `${panelFloor(c)}px`);
      setCover(panelCovers({ row: row.clientWidth, width: innerWidth, height: innerHeight, cell: c }));
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(row);
    addEventListener("resize", check);
    return () => {
      ro.disconnect();
      removeEventListener("resize", check);
    };
  }, [row]);
  return cover;
}
